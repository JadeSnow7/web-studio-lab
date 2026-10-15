import { randomUUID } from 'node:crypto';
import { WebContentsView, BrowserWindow, type WebContents } from 'electron';
import type {
  CdpState,
  PageCapture,
  PageConsoleEntry,
  PageIdentity,
  PageResourceSnapshot,
  PreviewFreezeResult,
  PreviewLayout,
  PreviewState,
} from '@wsl/protocol';
import { AgentControlLatch } from './app-ui';
import { EduAudioMonitor } from './edu-audio-monitor';
import { allowsEduAudio, type EduAudioBinding, type EduAudioRequest } from './edu-audio-policy';
import { readElementSummary } from './element-summary';
import { clampToViewport } from './geometry';
import { isAllowedPreviewUrl } from './navigation-policy';
import { parsePublicUrl, type PublicDocument } from './public-document';
import { PublicDocumentProtocol } from './public-protocol';

const CONSOLE_ISSUE_LIMIT = 20;
const CDP_PROTOCOL_VERSION = '1.3';

const PICK_HIGHLIGHT = {
  showInfo: true,
  showStyles: false,
  contentColor: { r: 10, g: 103, b: 209, a: 0.16 },
  borderColor: { r: 10, g: 103, b: 209, a: 0.9 },
  marginColor: { r: 10, g: 103, b: 209, a: 0.06 },
};

export interface PreviewControllerOptions {
  partition: string;
  homeUrl: string;
  allowedOrigins: readonly string[];
  managedAppOrigin?(): string | null;
  eduAudio?(): Omit<EduAudioBinding, 'webContentsId' | 'documentGeneration' | 'url' | 'visible' | 'monitorReady'> | null;
  onState(state: PreviewState): void;
  onCaptured(capture: PageCapture, requestId: string): void;
  onCaptureError?(error: Error, requestId: string, kind: 'failed' | 'cancelled'): void;
  onFocused?(): void;
}

/**
 * Browser 区页面：一个 WebContentsView，独立 session，无 preload。
 * 点选、截图都走这个 webContents 自己的 CDP 会话，保证与用户看到的是同一页面。
 */
export class PreviewController {
  private readonly view: WebContentsView;
  private readonly contents: WebContents;
  private lastEmittedState: PreviewState | null = null;
  private documentGeneration = 0;
  private audioReadyGeneration = -1;
  private audioInstalled = false;
  private audioEpoch = 0;
  private audioCleanup: Promise<unknown> = Promise.resolve();
  private readonly audioMonitor: EduAudioMonitor | null;
  private consoleIssues: PageConsoleEntry[] = [];
  private picking = false;
  private pickEpoch = 0;
  private activePick: { requestId: string; documentGeneration: number; navigationEpoch: number } | null = null;
  private cdp: CdpState = { state: 'idle' };
  private loadError: PreviewState['loadError'] = null;
  private blockedNavigation: string | null = null;
  private pickError: string | null = null;
  private visible = false;
  private devToolsWindow: BrowserWindow | null = null;
  private disposed = false;
  private navigationEpoch = 0;
  private loadRequestId = 0;
  private nativeNavigation: { done: Promise<void>; superseded: boolean; release: () => void } | null = null;
  private brokerFailureEpoch: number | null = null;
  private publicDocument: { document: PublicDocument; epoch: number } | null = null;
  private readonly publicProtocol: PublicDocumentProtocol;
  /** 控制面“AI 正在操控/已暂停”展示态；用户输入由本页面的 input-event 判定。 */
  readonly agentControl = new AgentControlLatch(() => this.emitState());

  constructor(
    private readonly window: BrowserWindow,
    private readonly options: PreviewControllerOptions,
  ) {
    this.view = new WebContentsView({
      webPreferences: {
        partition: options.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
      },
    });
    this.contents = this.view.webContents;
    this.audioMonitor = options.eduAudio ? new EduAudioMonitor((method, params) => this.send(method, params)) : null;
    if (this.audioMonitor) this.installAudioPermissions();
    let protocol: PublicDocumentProtocol | null = null;
    try {
      this.view.setVisible(false);
      this.view.setBackgroundColor('#FFFFFF');
      window.contentView.addChildView(this.view);
      protocol = new PublicDocumentProtocol(this.webContents.session, {
        allowedOrigins: options.allowedOrigins,
        managedAppOrigin: options.managedAppOrigin,
        webContentsId: this.webContents.id,
        devToolsWebContentsId: () => this.devToolsWindow?.webContents.id,
        epoch: () => this.navigationEpoch,
        onDocument: (document, epoch) => {
          this.publicDocument = { document, epoch };
        },
        onError: (error, url) => {
          this.brokerFailureEpoch = this.navigationEpoch;
          this.loadError = { code: -1, description: error.message, url };
          this.emitState();
        },
      });
      this.publicProtocol = protocol;
      this.attachListeners();
    } catch (error) {
      try {
        protocol?.dispose();
      } finally {
        try {
          window.contentView.removeChildView(this.view);
        } finally {
          this.webContents.close();
        }
      }
      throw error;
    }
  }

  private get webContents() {
    return this.contents;
  }

  private attachListeners(): void {
    const wc = this.webContents;
    wc.on('focus', () => {
      if (!this.disposed && this.visible) this.options.onFocused?.();
    });
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame) event.preventDefault();
    });
    wc.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) this.beginNavigation();
    });
    wc.on('will-navigate', (event) => {
      this.guardNavigation(event.url, () => event.preventDefault());
      if (this.audioMonitor && this.isAllowedNavigation(event.url)) {
        // loadURL does not emit will-navigate: resume once through the guarded path.
        event.preventDefault();
        void this.navigate(event.url).catch((error: unknown) => this.reportAudioFailure(error));
      }
    });
    wc.on('dom-ready', () => {
      if (this.audioMonitor && this.visible) void this.activateEduAudio().catch((error: unknown) => this.reportAudioFailure(error));
    });
    wc.on('will-redirect', (event) => this.guardNavigation(event.url, () => event.preventDefault()));
    wc.on('did-start-loading', () => this.emitState());
    wc.on('did-stop-loading', () => {
      this.emitState();
      if (this.audioMonitor && this.visible) void this.activateEduAudio().catch((error: unknown) => this.reportAudioFailure(error));
    });
    wc.on('page-title-updated', () => this.emitState());
    wc.on('did-navigate', () => this.onDocumentChanged());
    wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) {
        if (this.audioMonitor)
          void this.stopEduAudio()
            .then(() => this.activateEduAudio())
            .catch((error: unknown) => this.reportAudioFailure(error));
        this.onDocumentChanged();
      }
    });
    wc.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      // -3（ERR_ABORTED）是被拦截或被新导航取代，单独由 blockedNavigation 说明。
      if (!isMainFrame || code === -3) return;
      // Chromium 将协议失败归为 ERR_FAILED；保留同次、同地址 broker 给出的具体原因。
      if (this.brokerFailureEpoch !== this.navigationEpoch || this.loadError?.url !== url) {
        this.brokerFailureEpoch = null;
        this.loadError = { code, description, url };
      }
      this.emitState();
    });
    wc.on('render-process-gone', (_event, details) => {
      if (this.audioMonitor) {
        this.reportAudioFailure(new Error('录音文档进程已退出，无法核验音轨'));
        return;
      }
      this.loadError = { code: details.exitCode, description: `页面进程退出：${details.reason}`, url: wc.getURL() };
      this.invalidatePick('页面进程已退出');
      this.emitState();
    });
    wc.on('console-message', (event) => {
      if (event.level !== 'error' && event.level !== 'warning') return;
      this.consoleIssues.push({ level: event.level, message: event.message, source: event.sourceId, line: event.lineNumber });
      if (this.consoleIssues.length > CONSOLE_ISSUE_LIMIT) this.consoleIssues.shift();
      this.emitState();
    });
    wc.on('input-event', (_event, input) => this.agentControl.observeInput(input.type));
    wc.on('before-input-event', (event, input) => {
      if (this.picking && input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        void this.cancelPick();
      }
    });
    wc.debugger.on('detach', (_event, reason) => {
      if (this.audioMonitor && !this.disposed) {
        this.reportAudioFailure(new Error('音轨监视连接已断开'));
        return;
      }
      this.cdp = { state: 'detached', reason };
      this.invalidatePick('页面调试连接已断开');
      this.emitState();
    });
    wc.debugger.on('message', (_event, method, params) => {
      if (method === 'Overlay.inspectNodeRequested') {
        const { backendNodeId } = params as { backendNodeId: number };
        void this.captureNode(backendNodeId);
      }
    });
  }

  private guardNavigation(url: string, prevent: () => void): void {
    if (this.isAllowedNavigation(url)) return;
    prevent();
    this.blockedNavigation = url;
    this.emitState();
  }

  private isAllowedNavigation(url: string): boolean {
    if (isAllowedPreviewUrl(url, this.options.allowedOrigins)) return true;
    try {
      parsePublicUrl(url);
      return true;
    } catch {
      return false;
    }
  }

  private beginNavigation(): void {
    this.audioReadyGeneration = -1;
    this.invalidatePick('页面已导航，点选已取消，请重新开始选择');
    this.navigationEpoch += 1;
    this.brokerFailureEpoch = null;
    this.publicDocument = null;
    this.publicProtocol.invalidate();
    this.loadError = null;
  }

  private onDocumentChanged(): void {
    // 新文档：旧现场与旧元素引用全部失效，错误计数重新开始。
    this.invalidatePick('页面已导航，点选已取消，请重新开始选择');
    this.documentGeneration += 1;
    this.consoleIssues = [];
    this.brokerFailureEpoch = null;
    this.loadError = null;
    this.blockedNavigation = null;
    if (this.picking) {
      this.picking = false;
      this.pickError = '页面已导航，点选已取消，请重新开始选择';
      // 选择模式挂在调试目标上，跨导航仍然有效；必须显式退出，否则后续点击会被吞掉。
      void this.exitInspectMode();
    }
    this.emitState();
  }

  load(): void {
    if (!this.isAllowedNavigation(this.options.homeUrl)) {
      this.loadError = { code: -1, description: '仅允许演示页面和无凭据的公网 HTTPS 443 文档', url: this.options.homeUrl };
      this.emitState();
      return;
    }
    const requestId = this.loadRequestId + 1;
    this.navigate(this.options.homeUrl).catch((error: unknown) => {
      // 失败细节已由 did-fail-load 记录；这里只补上没有对应事件的情况。
      if (!this.disposed && requestId === this.loadRequestId && this.loadError === null) {
        this.loadError = { code: -1, description: error instanceof Error ? error.message : String(error), url: this.options.homeUrl };
        this.emitState();
      }
    });
  }

  pageIdentity(): PageIdentity {
    return {
      webContentsId: this.webContents.id,
      documentGeneration: this.documentGeneration,
      url: this.webContents.getURL(),
      title: this.webContents.getTitle(),
      partition: this.options.partition,
    };
  }

  get observationTarget() {
    return this.contents;
  }
  getState(): PreviewState {
    const history = this.webContents.navigationHistory;
    return {
      page: this.pageIdentity(),
      loading: this.webContents.isLoading(),
      canGoBack: history.canGoBack(),
      canGoForward: history.canGoForward(),
      picking: this.picking,
      cdp: this.cdp,
      consoleIssueCount: this.consoleIssues.length,
      loadError: this.loadError,
      blockedNavigation: this.blockedNavigation,
      pickError: this.pickError,
      agentControl: this.agentControl.state(),
    };
  }

  private emitState(): void {
    if (this.disposed) return;
    this.lastEmittedState = this.getState();
    this.options.onState(this.lastEmittedState);
  }

  setLayout(layout: PreviewLayout): void {
    this.view.setBounds(layout.bounds);
    const visible = layout.visible && layout.bounds.width > 0 && layout.bounds.height > 0;
    if (!visible && this.picking) void this.cancelPick();
    const changed = this.visible !== visible;
    this.visible = visible;
    this.view.setVisible(visible);
    if (this.audioMonitor && changed) {
      const action = visible ? this.activateEduAudio() : this.stopEduAudio();
      void action.catch((error: unknown) => this.reportAudioFailure(error));
    }
  }

  async freeze(): Promise<PreviewFreezeResult> {
    const cleanup = this.stopEduAudio();
    this.visible = false;
    await cleanup;
    const image = await this.webContents.capturePage();
    this.view.setVisible(false);
    return { dataUrl: image.isEmpty() ? '' : image.toDataURL() };
  }

  async navigate(url: string): Promise<void> {
    if (!this.isAllowedNavigation(url)) {
      throw new Error('仅允许演示页面和无凭据的公网 HTTPS 443 文档');
    }
    const target = isAllowedPreviewUrl(url, this.options.allowedOrigins) ? url : parsePublicUrl(url).href;
    await this.coordinateNavigation(() => this.webContents.loadURL(target));
  }

  private async coordinateNavigation(start: () => Promise<void> | void): Promise<void> {
    if (this.disposed) throw new Error('网页实例已销毁');
    const id = ++this.loadRequestId;
    if (this.audioMonitor) {
      await this.stopEduAudio();
      // A new WebContentsView has no renderer to answer CDP commands yet. Bootstrap
      // only an empty document; install the guard before any imported site loads.
      if (!this.webContents.getURL()) await this.webContents.loadURL('about:blank');
      await this.ensureCdp();
      await this.audioMonitor.install();
      this.audioInstalled = true;
      this.audioMonitor.releaseDocument();
    }
    const previous = this.nativeNavigation;
    if (previous) {
      previous.superseded = true;
      this.webContents.stop();
      // Electron may reject loadURL before its final loading events arrive. Both
      // boundaries must finish before another loadURL installs event observers.
      await Promise.allSettled([previous.done]);
    }
    if (this.disposed) throw new Error('网页实例已销毁');
    if (id !== this.loadRequestId) return;
    let release!: () => void;
    const stopped = new Promise<void>((resolve) => {
      release = resolve;
    });
    const wc = this.webContents;
    wc.once('did-stop-loading', release);
    wc.once('destroyed', release);
    let finish!: () => void;
    const operation = {
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      superseded: false,
      release,
    };
    this.nativeNavigation = operation;
    this.beginNavigation();
    try {
      try {
        await start();
      } catch (error) {
        const code = (error as { errno?: number; code?: string }).errno;
        if (!operation.superseded || (code !== -3 && (error as { code?: string }).code !== 'ERR_ABORTED')) throw error;
      }
      await stopped;
      if (this.disposed) throw new Error('网页实例已销毁');
    } finally {
      // Failed load promises can precede did-stop-loading too.
      await stopped;
      wc.removeListener('did-stop-loading', release);
      wc.removeListener('destroyed', release);
      if (this.nativeNavigation === operation) this.nativeNavigation = null;
      finish();
    }
  }

  reload(): Promise<void> {
    return this.coordinateNavigation(() => this.webContents.reload());
  }

  goBack(): Promise<void> {
    if (!this.webContents.navigationHistory.canGoBack()) return Promise.resolve();
    return this.coordinateNavigation(() => this.webContents.navigationHistory.goBack());
  }

  goForward(): Promise<void> {
    if (!this.webContents.navigationHistory.canGoForward()) return Promise.resolve();
    return this.coordinateNavigation(() => this.webContents.navigationHistory.goForward());
  }

  async captureResource(expectedPage: PageIdentity): Promise<PageResourceSnapshot> {
    const epoch = this.navigationEpoch;
    const page = this.pageIdentity();
    const current = this.publicDocument;
    if (this.disposed || this.webContents.isLoading() || this.loadError || !current || current.epoch !== epoch) {
      throw new Error('请等待公开文档成功加载后再加入空间；历史页面请先重新加载');
    }
    if (
      expectedPage.webContentsId !== page.webContentsId ||
      expectedPage.documentGeneration !== page.documentGeneration ||
      expectedPage.url !== page.url ||
      expectedPage.title !== page.title ||
      expectedPage.partition !== page.partition ||
      current.document.url !== page.url ||
      current.document.title !== page.title
    ) {
      throw new Error('页面已经变化，请确认当前文档后重试');
    }
    // 固定模板不运行网页脚本；快照来自实际显示的同一份已校验响应。
    return { page, ...current.document };
  }

  focus(): void {
    this.webContents.focus();
  }

  isPicking(): boolean {
    return this.picking;
  }

  getCdpState(): CdpState {
    return this.cdp;
  }

  private send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.webContents.debugger.sendCommand(method, params);
  }

  private async ensureCdp(): Promise<void> {
    if (!this.webContents.debugger.isAttached()) {
      this.webContents.debugger.attach(CDP_PROTOCOL_VERSION);
    }
    await this.send('DOM.enable');
    await this.send('Overlay.enable');
    this.cdp = { state: 'attached' };
  }

  async reattachCdp(): Promise<void> {
    await this.ensureCdp();
    this.pickError = null;
    this.emitState();
  }

  async startPick(requestId: string): Promise<void> {
    if (!this.visible || this.disposed) throw new Error('Browser 区页面当前不可见，不能开始选择');
    const request = { requestId, documentGeneration: this.documentGeneration, navigationEpoch: this.navigationEpoch };
    this.pickEpoch++;
    this.activePick = request;
    this.picking = false;
    try {
      await this.ensureCdp();
      if (this.activePick !== request) return;
      await this.send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: PICK_HIGHLIGHT });
    } catch (error) {
      if (this.activePick !== request) return;
      this.activePick = null;
      this.pickError = `无法开始选择：${error instanceof Error ? error.message : String(error)}`;
      this.options.onCaptureError?.(error instanceof Error ? error : new Error(String(error)), requestId, 'failed');
      this.emitState();
      throw error;
    }
    if (this.activePick !== request) return;
    this.picking = true;
    this.pickError = null;
    this.webContents.focus();
    this.emitState();
  }

  private invalidatePick(reason: string): void {
    const request = this.activePick;
    this.pickEpoch++;
    this.activePick = null;
    const wasPicking = this.picking;
    this.picking = false;
    if (request) this.options.onCaptureError?.(new Error(reason), request.requestId, 'cancelled');
    if (wasPicking) void this.exitInspectMode();
  }
  async cancelPick(requestId?: string): Promise<void> {
    if (requestId && this.activePick?.requestId !== requestId) return;
    const wasPicking = this.picking;
    this.invalidatePick('页面采集已取消');
    this.emitState();
    if (!wasPicking) await this.exitInspectMode();
  }

  /** 退出 CDP 选择模式并清除高亮。失败时如实登记，因为页面可能仍在拦截点击。 */
  private async exitInspectMode(request?: typeof this.activePick): Promise<void> {
    if (!this.webContents.debugger.isAttached()) return;
    const epoch = this.pickEpoch;
    try {
      await this.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: PICK_HIGHLIGHT });
      if (epoch !== this.pickEpoch || this.disposed) return;
      await this.send('Overlay.hideHighlight');
    } catch (error) {
      if (epoch !== this.pickEpoch || this.disposed || (request && this.activePick !== request)) return;
      this.pickError = `无法退出选择模式，页面点击可能仍被拦截：${error instanceof Error ? error.message : String(error)}`;
      this.emitState();
    }
  }

  private async captureNode(backendNodeId: number): Promise<void> {
    if (!this.picking) {
      // 不在选择流程中却收到点选事件，说明选择模式残留：退出它，不采集。
      await this.exitInspectMode();
      return;
    }
    const request = this.activePick;
    if (!request) throw new Error('选择流程缺少请求身份');
    this.picking = false;
    this.emitState();
    try {
      await this.exitInspectMode(request);
      if (this.activePick !== request || this.disposed) return;
      const element = await readElementSummary((method, params) => this.send(method, params), backendNodeId);
      const viewport = await this.webContents.capturePage();
      const size = this.view.getBounds();
      const clip = element.rect ? clampToViewport(element.rect, size) : null;
      const elementImage = clip ? await this.webContents.capturePage(clip) : null;
      if (
        this.activePick !== request ||
        this.disposed ||
        request.documentGeneration !== this.documentGeneration ||
        request.navigationEpoch !== this.navigationEpoch
      )
        return;
      this.activePick = null;
      this.pickError = null;
      this.options.onCaptured(
        {
          captureId: randomUUID(),
          capturedAt: new Date().toISOString(),
          page: this.pageIdentity(),
          element,
          screenshot: {
            viewport: viewport.toDataURL(),
            element: elementImage && !elementImage.isEmpty() ? elementImage.toDataURL() : null,
          },
          consoleIssues: [...this.consoleIssues],
        },
        request.requestId,
      );
    } catch (error) {
      if (this.activePick !== request || this.disposed) return;
      this.activePick = null;
      this.options.onCaptureError?.(error instanceof Error ? error : new Error(String(error)), request.requestId, 'failed');
      this.pickError = `采集失败：${error instanceof Error ? error.message : String(error)}`;
    }
    this.emitState();
  }

  openDevTools(): void {
    if (!this.devToolsWindow) {
      // Establish owner identity before the frontend's first request; Electron's builtin owner getter is populated after frontend load.
      const tools = new BrowserWindow({
        width: 900,
        height: 700,
        show: false,
        webPreferences: { partition: this.options.partition, sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      this.devToolsWindow = tools;
      tools.on('closed', () => {
        this.devToolsWindow = null;
      });
      this.webContents.setDevToolsWebContents(tools.webContents);
      this.webContents.openDevTools({ mode: 'detach' });
    }
    this.devToolsWindow.show();
    this.devToolsWindow.focus();
  }

  resumeEduAudio(): Promise<void> {
    return this.activateEduAudio();
  }

  hasEduAudio(): boolean {
    return this.audioMonitor !== null;
  }

  private audioBinding(): EduAudioBinding | null {
    const context = this.options.eduAudio?.();
    if (!context || this.disposed) return null;
    return {
      ...context,
      webContentsId: this.webContents.id,
      documentGeneration: this.documentGeneration,
      url: this.webContents.getURL(),
      visible: this.visible && this.window.isVisible() && !this.window.isMinimized(),
      monitorReady: this.audioReadyGeneration === this.documentGeneration,
    };
  }

  private installAudioPermissions(): void {
    const allowed = (request: EduAudioRequest) => allowsEduAudio(this.audioBinding(), request);
    this.webContents.session.setPermissionCheckHandler((wc, permission, requestingOrigin, details) =>
      allowed({
        webContentsId: wc?.id ?? null,
        permission,
        requestingOrigin,
        requestingUrl: details.requestingUrl,
        isMainFrame: details.isMainFrame,
        mediaTypes: details.mediaType ? [details.mediaType] : [],
      }),
    );
    this.webContents.session.setPermissionRequestHandler((wc, permission, callback, details) => {
      // The OS prompt belongs to native getUserMedia. Its late result is checked by
      // the document-start closure against the revoked epoch before exposing tracks.
      callback(
        allowed({
          webContentsId: wc.id,
          permission,
          requestingOrigin: undefined,
          requestingUrl: details.requestingUrl,
          isMainFrame: details.isMainFrame,
          mediaTypes: 'mediaTypes' in details ? (details.mediaTypes ?? []) : [],
        }),
      );
    });
  }

  private async activateEduAudio(): Promise<void> {
    if (!this.audioMonitor || !this.audioInstalled || this.disposed || this.webContents.isLoading()) return;
    const binding = this.audioBinding();
    if (
      !binding ||
      !allowsEduAudio(
        { ...binding, monitorReady: true },
        {
          webContentsId: binding.webContentsId,
          permission: 'media',
          isMainFrame: true,
          requestingUrl: binding.url,
          requestingOrigin: binding.origin,
          mediaTypes: ['audio'],
        },
      )
    )
      return;
    const epoch = this.audioEpoch;
    const generation = this.documentGeneration;
    await this.audioCleanup;
    if (epoch !== this.audioEpoch || this.disposed || !this.visible) return;
    await this.audioMonitor.activate();
    if (epoch === this.audioEpoch && generation === this.documentGeneration && this.visible && !this.disposed)
      this.audioReadyGeneration = generation;
  }

  stopEduAudio(): Promise<void> {
    // This is the permission linearization point; no asynchronous work precedes it.
    this.audioReadyGeneration = -1;
    this.audioEpoch++;
    if (!this.audioMonitor || this.disposed) return Promise.resolve();
    const cleanup = this.audioCleanup.then(() => this.audioMonitor!.stop()).then(() => undefined);
    this.audioCleanup = cleanup;
    return cleanup.catch((error: unknown) => {
      this.reportAudioFailure(error);
      throw error;
    });
  }

  private reportAudioFailure(error: unknown): void {
    if (this.disposed) return;
    this.audioReadyGeneration = -1;
    this.loadError = {
      code: -1,
      description: '录音清理未确认，预览已销毁：' + (error instanceof Error ? error.message : String(error)),
      url: this.lastEmittedState?.page.url ?? this.options.homeUrl,
    };
    if (this.webContents.isDestroyed()) {
      if (this.lastEmittedState) this.options.onState({ ...this.lastEmittedState, loadError: this.loadError });
    } else this.emitState();
    this.disposeNow();
  }

  async closeWithAudioCleanup(): Promise<void> {
    try {
      await this.stopEduAudio();
    } finally {
      this.disposeNow();
    }
  }

  /** 窗口关闭时显式释放页面：断开 CDP，关闭 webContents。 */
  dispose(): void {
    if (this.audioMonitor && !this.disposed) {
      void this.closeWithAudioCleanup().catch((error: unknown) => console.error('edu 录音清理失败', error));
      return;
    }
    this.disposeNow();
  }
  private disposeNow(): void {
    if (this.disposed) return;
    this.invalidatePick('网页实例已销毁');
    this.disposed = true;
    this.nativeNavigation?.release();
    this.devToolsWindow?.destroy();
    this.publicProtocol.dispose();
    const destroyed = this.audioMonitor ? this.webContents.isDestroyed() : false;
    if (!destroyed && this.webContents.debugger.isAttached()) this.webContents.debugger.detach();
    if (!this.audioMonitor || !this.window.isDestroyed()) this.window.contentView.removeChildView(this.view);
    if (!destroyed) this.webContents.close();
  }
}
