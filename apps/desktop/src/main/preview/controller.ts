import { randomUUID } from 'node:crypto';
import { WebContentsView, type BrowserWindow } from 'electron';
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
  onState(state: PreviewState): void;
  onCaptured(capture: PageCapture): void;
}

/**
 * Browser 区页面：一个 WebContentsView，独立 session，无 preload。
 * 点选、截图都走这个 webContents 自己的 CDP 会话，保证与用户看到的是同一页面。
 */
export class PreviewController {
  private readonly view: WebContentsView;
  private documentGeneration = 0;
  private consoleIssues: PageConsoleEntry[] = [];
  private picking = false;
  private cdp: CdpState = { state: 'idle' };
  private loadError: PreviewState['loadError'] = null;
  private blockedNavigation: string | null = null;
  private pickError: string | null = null;
  private visible = false;
  private disposed = false;
  private navigationEpoch = 0;
  private brokerFailureEpoch: number | null = null;
  private publicDocument: { document: PublicDocument; epoch: number } | null = null;
  private readonly publicProtocol: PublicDocumentProtocol;

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
    this.view.setVisible(false);
    this.view.setBackgroundColor('#FFFFFF');
    window.contentView.addChildView(this.view);
    this.publicProtocol = new PublicDocumentProtocol(this.webContents.session, {
      allowedOrigins: options.allowedOrigins,
      webContentsId: this.webContents.id,
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
    this.attachListeners();
  }

  private get webContents() {
    return this.view.webContents;
  }

  private attachListeners(): void {
    const wc = this.webContents;
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-frame-navigate', (event) => {
      if (!event.isMainFrame) event.preventDefault();
    });
    wc.on('did-start-navigation', (event) => {
      if (event.isMainFrame && !event.isSameDocument) this.beginNavigation();
    });
    wc.on('will-navigate', (event) => this.guardNavigation(event.url, () => event.preventDefault()));
    wc.on('will-redirect', (event) => this.guardNavigation(event.url, () => event.preventDefault()));
    wc.on('did-start-loading', () => this.emitState());
    wc.on('did-stop-loading', () => this.emitState());
    wc.on('page-title-updated', () => this.emitState());
    wc.on('did-navigate', () => this.onDocumentChanged());
    wc.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) this.onDocumentChanged();
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
      this.loadError = { code: details.exitCode, description: `页面进程退出：${details.reason}`, url: wc.getURL() };
      this.picking = false;
      this.emitState();
    });
    wc.on('console-message', (event) => {
      if (event.level !== 'error' && event.level !== 'warning') return;
      this.consoleIssues.push({ level: event.level, message: event.message, source: event.sourceId, line: event.lineNumber });
      if (this.consoleIssues.length > CONSOLE_ISSUE_LIMIT) this.consoleIssues.shift();
      this.emitState();
    });
    wc.on('before-input-event', (event, input) => {
      if (this.picking && input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        void this.cancelPick();
      }
    });
    wc.debugger.on('detach', (_event, reason) => {
      this.cdp = { state: 'detached', reason };
      this.picking = false;
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
    this.navigationEpoch += 1;
    this.brokerFailureEpoch = null;
    this.publicDocument = null;
    this.publicProtocol.invalidate();
    this.loadError = null;
  }

  private onDocumentChanged(): void {
    // 新文档：旧现场与旧元素引用全部失效，错误计数重新开始。
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
    this.webContents.loadURL(this.options.homeUrl).catch((error: unknown) => {
      // 失败细节已由 did-fail-load 记录；这里只补上没有对应事件的情况。
      if (this.loadError === null) {
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
    };
  }

  private emitState(): void {
    if (this.disposed) return;
    this.options.onState(this.getState());
  }

  setLayout(layout: PreviewLayout): void {
    this.view.setBounds(layout.bounds);
    const visible = layout.visible && layout.bounds.width > 0 && layout.bounds.height > 0;
    if (!visible && this.picking) void this.cancelPick();
    this.visible = visible;
    this.view.setVisible(visible);
  }

  async freeze(): Promise<PreviewFreezeResult> {
    const image = await this.webContents.capturePage();
    this.visible = false;
    this.view.setVisible(false);
    return { dataUrl: image.isEmpty() ? '' : image.toDataURL() };
  }

  async navigate(url: string): Promise<void> {
    if (!this.isAllowedNavigation(url)) {
      throw new Error('仅允许演示页面和无凭据的公网 HTTPS 443 文档');
    }
    this.beginNavigation();
    const target = isAllowedPreviewUrl(url, this.options.allowedOrigins) ? url : parsePublicUrl(url).href;
    await this.webContents.loadURL(target);
  }

  reload(): void {
    this.beginNavigation();
    this.webContents.reload();
  }

  goBack(): void {
    this.beginNavigation();
    this.webContents.navigationHistory.goBack();
  }

  goForward(): void {
    this.beginNavigation();
    this.webContents.navigationHistory.goForward();
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

  async startPick(): Promise<void> {
    if (!this.visible) throw new Error('Browser 区页面当前不可见，不能开始选择');
    try {
      await this.ensureCdp();
      await this.send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: PICK_HIGHLIGHT });
    } catch (error) {
      this.pickError = `无法开始选择：${error instanceof Error ? error.message : String(error)}`;
      this.emitState();
      throw error;
    }
    this.picking = true;
    this.pickError = null;
    this.webContents.focus();
    this.emitState();
  }

  async cancelPick(): Promise<void> {
    if (!this.picking) return;
    this.picking = false;
    this.emitState();
    await this.exitInspectMode();
  }

  /** 退出 CDP 选择模式并清除高亮。失败时如实登记，因为页面可能仍在拦截点击。 */
  private async exitInspectMode(): Promise<void> {
    if (!this.webContents.debugger.isAttached()) return;
    try {
      await this.send('Overlay.setInspectMode', { mode: 'none', highlightConfig: PICK_HIGHLIGHT });
      await this.send('Overlay.hideHighlight');
    } catch (error) {
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
    const generation = this.documentGeneration;
    this.picking = false;
    this.emitState();
    try {
      await this.exitInspectMode();
      const element = await readElementSummary((method, params) => this.send(method, params), backendNodeId);
      const viewport = await this.webContents.capturePage();
      const size = this.view.getBounds();
      const clip = element.rect ? clampToViewport(element.rect, size) : null;
      const elementImage = clip ? await this.webContents.capturePage(clip) : null;
      if (generation !== this.documentGeneration) {
        throw new Error('采集过程中页面发生了导航，本次采集作废');
      }
      this.pickError = null;
      this.options.onCaptured({
        captureId: randomUUID(),
        capturedAt: new Date().toISOString(),
        page: this.pageIdentity(),
        element,
        screenshot: {
          viewport: viewport.toDataURL(),
          element: elementImage && !elementImage.isEmpty() ? elementImage.toDataURL() : null,
        },
        consoleIssues: [...this.consoleIssues],
      });
    } catch (error) {
      this.pickError = `采集失败：${error instanceof Error ? error.message : String(error)}`;
    }
    this.emitState();
  }

  openDevTools(): void {
    this.webContents.openDevTools({ mode: 'detach' });
  }

  /** 窗口关闭时显式释放页面：断开 CDP，关闭 webContents。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.publicProtocol.dispose();
    if (this.webContents.debugger.isAttached()) this.webContents.debugger.detach();
    this.window.contentView.removeChildView(this.view);
    this.webContents.close();
  }
}
