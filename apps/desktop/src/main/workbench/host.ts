import { isAllowedPreviewUrl } from '../preview/navigation-policy';
import { parsePublicUrl } from '../preview/public-document';
import { session, type BrowserWindow } from 'electron';
import type { ObservationRequest, ObservationTurnScope, ResourceInstanceIdentity, WorkbenchResource } from '@wsl/protocol';
import type { ChatService } from '../chat-service';
import { BrowserObservation } from '../preview/observation';
import { PreviewController } from '../preview/controller';
import { DEMO_ORIGIN, installDemoProtocol } from '../preview/demo-protocol';
import type { WorkbenchRuntime } from './ports';
import type { WorkbenchApplication } from './application';
export class WorkbenchHost implements WorkbenchRuntime {
  async reload(): Promise<void> {
    await this.application?.performActiveBrowserAction('reload');
  }
  async openDevTools(): Promise<void> {
    await this.application?.performActiveBrowserAction('openDevTools');
  }
  private readonly browsers = new Map<string, PreviewController>();
  private readonly observers = new Map<string, BrowserObservation>();
  private readonly browserBindings = new Map<string, ResourceInstanceIdentity>();
  application: WorkbenchApplication | null = null;
  environmentsList() {
    return this.chat.environmentsList();
  }
  registerResource(identity: ResourceInstanceIdentity) {
    return this.chat.registerResource(identity);
  }
  async observe(request: ObservationRequest, signal: AbortSignal) {
    const target = request.target;
    if (!target) throw new Error('invalid_request: 缺少资源实例');
    if (target.kind === 'browser') {
      const binding = this.browserBindings.get(target.resourceId);
      if (!binding || (Object.keys(binding) as (keyof ResourceInstanceIdentity)[]).some((key) => binding[key] !== target[key]))
        return { error: 'unavailable' as const, message: '网页实例已失效' };
      let observer = this.observers.get(target.resourceId);
      if (!observer) {
        observer = new BrowserObservation(this.browser(target.resourceId).observationTarget, binding);
        this.observers.set(target.resourceId, observer);
      }
      return observer.observe(request.tool, request.args, request.workspaceId, signal);
    }
    await this.chat.registerResource(target);
    if (signal.aborted) return { error: 'cancelled' as const, message: '观察已取消' };
    let cancellation: Promise<void> | null = null;
    const abort = () => {
      cancellation = this.chat.cancelObservation(request.requestId);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      return await this.chat.observe(request);
    } finally {
      signal.removeEventListener('abort', abort);
      if (cancellation) await cancellation;
    }
  }
  constructor(
    private readonly window: BrowserWindow,
    private readonly chat: ChatService,
    private readonly demoRoot: string,
  ) {}
  validateBrowserUrl(url: string) {
    if (isAllowedPreviewUrl(url, [DEMO_ORIGIN])) return;
    try {
      parsePublicUrl(url);
    } catch (error) {
      throw new Error('invalid_input: ' + (error as Error).message, { cause: error });
    }
  }
  ensureBrowser(workspaceId: string, resource: WorkbenchResource): void {
    this.validateBrowserUrl(resource.url ?? 'wsl-demo://taskflow/index.html');
    if (this.browsers.has(resource.resourceId)) return;
    const partition = 'preview-' + workspaceId + '-' + resource.instanceId;
    const browserSession = session.fromPartition(partition);
    browserSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    browserSession.setPermissionCheckHandler(() => false);
    installDemoProtocol(browserSession, this.demoRoot);
    const { resourceId, instanceId, generation } = resource;
    const preview = new PreviewController(this.window, {
      partition,
      homeUrl: resource.url ?? 'wsl-demo://taskflow/index.html',
      allowedOrigins: [DEMO_ORIGIN],
      onState: (state) => this.application?.onPreview(resourceId, state, instanceId, generation),
      onCaptured: (capture, requestId) => this.application?.onCapture(resourceId, capture, instanceId, generation, requestId),
      onCaptureError: (error, requestId, kind) =>
        this.application?.onCaptureError(resourceId, requestId, instanceId, generation, kind, error.message),
      onFocused: () => this.application?.onBrowserFocus(workspaceId, resourceId, instanceId, generation),
    });
    try {
      preview.load();
      this.browsers.set(resourceId, preview);
      if (!instanceId) throw new Error('网页缺少 Main 实例身份');
      const binding: ResourceInstanceIdentity = {
        workspaceId,
        environmentId: 'local',
        resourceId,
        kind: 'browser',
        instanceId,
        instanceGeneration: generation,
      };
      this.browserBindings.set(resourceId, binding);
    } catch (error) {
      preview.dispose();
      throw error;
    }
  }
  private browser(resourceId: string) {
    const preview = this.browsers.get(resourceId);
    if (!preview) throw new Error('not_found: 网页实例不存在');
    return preview;
  }
  browserState(resourceId: string) {
    return this.browser(resourceId).getState();
  }
  browserLayout(resourceId: string, layout: Parameters<PreviewController['setLayout']>[0]) {
    this.browser(resourceId).setLayout(layout);
  }
  browserAction(resourceId: string, action: string, url?: string, requestId?: string) {
    const p = this.browser(resourceId);
    switch (action) {
      case 'navigate':
        if (!url) throw new Error('invalid_input: 请输入地址');
        return p.navigate(url);
      case 'openDevTools':
        return p.openDevTools();
      case 'reload':
        return p.reload();
      case 'back':
        return p.goBack();
      case 'forward':
        return p.goForward();
      case 'focus':
        return p.focus();
      case 'pick':
        if (!requestId) throw new Error('页面采集缺少请求身份');
        return p.startPick(requestId);
      case 'cancelPick':
        return p.cancelPick(requestId);
      case 'reattach':
        return p.reattachCdp();
      default:
        throw new Error('invalid_input: 未知网页操作');
    }
  }
  hideBrowsers() {
    for (const p of this.browsers.values()) p.setLayout({ bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false });
  }
  terminalOpen(resourceId: string, cols: number, rows: number) {
    return this.chat.terminalOpen(cols, rows, resourceId);
  }
  terminalWrite(resourceId: string, instanceId: string, data: string) {
    return this.chat.terminalWrite(instanceId, data, resourceId);
  }
  terminalResize(resourceId: string, instanceId: string, cols: number, rows: number) {
    return this.chat.terminalResize(instanceId, cols, rows, resourceId);
  }
  terminalStop(resourceId: string, instanceId: string) {
    return this.chat.terminalClose(instanceId, resourceId);
  }
  registerSession(sessionId: string, workspaceId: string) {
    return this.chat.register(sessionId, workspaceId);
  }
  publicResourcesList() {
    return this.chat.resourcesList('taskflow-demo');
  }
  async publicResourcesCapture(resourceId: string, savedResourceId?: string) {
    const p = this.browser(resourceId);
    return this.chat.resourcesSave('taskflow-demo', await p.captureResource(p.getState().page), savedResourceId);
  }
  publicResourcesRemove(savedResourceId: string) {
    return this.chat.resourcesRemove('taskflow-demo', savedResourceId);
  }
  send(sessionId: string, text: string, scope?: ObservationTurnScope) {
    return this.chat.send(sessionId, text, scope);
  }
  cancel(sessionId: string) {
    return this.chat.cancel(sessionId);
  }
  dispose() {
    for (const observer of this.observers.values()) observer.dispose();
    this.observers.clear();
    this.browserBindings.clear();
    for (const p of this.browsers.values()) p.dispose();
    this.browsers.clear();
  }
}
