import { isAllowedPreviewUrl } from '../preview/navigation-policy';
import { parsePublicUrl } from '../preview/public-document';
import { app, session, type BrowserWindow } from 'electron';
import { readFile, readdir, lstat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { AppTarget, ManagedApp, AppSource } from '@wsl/protocol';
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
  private readonly appLeases = new Map<string, ManagedApp>();
  private readonly appEvents = new Map<string, ManagedApp>();
  private readonly appBrowserProjects = new Map<string, string>();
  async appGet(target: AppTarget) {
    return this.chat.appGet(target);
  }
  async appCreate(target: AppTarget) {
    const root = app.isPackaged
      ? path.join(process.resourcesPath, 'templates/standard-app')
      : path.resolve(app.getAppPath(), '../../templates/standard-app');
    const files: AppSource['files'] = [];
    const walk = async (directory: string, prefix = '') => {
      for (const name of (await readdir(directory)).sort()) {
        if (['node_modules', 'dist', '.data', '.git', 'coverage'].includes(name)) continue;
        const relative = prefix + name;
        const location = path.join(directory, name);
        const stat = await lstat(location);
        if (stat.isSymbolicLink()) throw new Error('模板包含符号链接');
        if (stat.isDirectory()) await walk(location, relative + '/');
        else if (stat.isFile()) files.push({ path: relative, base64: (await readFile(location)).toString('base64') });
      }
    };
    await walk(root);
    return this.chat.appCreate(target, files);
  }
  async appStart(target: AppTarget) {
    const returned = await this.chat.appStart(target);
    const last = this.appEvents.get(target.projectId);
    const result = last?.appInstanceId === returned.appInstanceId && last.state === 'failed' ? last : returned;
    if (result.state === 'running') {
      const url = new URL(result.url!);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password)
        throw new Error('invalid_input: 应用服务未返回受控回环地址');
      this.appLeases.set(target.projectId, result);
    }
    return result;
  }
  async appStop(target: AppTarget) {
    this.appLeases.delete(target.projectId);
    return this.chat.appStop(target);
  }
  async appExport(target: AppTarget) {
    const source = await this.chat.appExport(target);
    if (createHash('sha256').update(JSON.stringify(source.files)).digest('hex') !== source.sha256) throw new Error('源码导出散列不匹配');
    const directory = path.join(app.getPath('userData'), 'exports');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const exported = path.join(directory, target.projectId + '-' + randomUUID());
    await mkdir(exported, { mode: 0o700 });
    for (const sourceFile of source.files) {
      if (
        sourceFile.path.includes('\\') ||
        sourceFile.path.includes('\0') ||
        sourceFile.path.split('/').some((part) => !part || part === '.' || part === '..')
      )
        throw new Error('源码导出路径无效');
      const file = path.join(exported, sourceFile.path);
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, Buffer.from(sourceFile.base64, 'base64'), { flag: 'wx', mode: 0o600 });
    }
    await writeFile(`${exported}.manifest.json`, JSON.stringify({ ...target, ...source }, null, 2), {
      flag: 'wx',
      mode: 0o600,
    });
    return { path: exported, manifestPath: `${exported}.manifest.json`, sha256: source.sha256 };
  }
  releaseAppBrowser(resourceId: string) {
    this.observers.get(resourceId)?.dispose();
    this.observers.delete(resourceId);
    this.browsers.get(resourceId)?.dispose();
    this.browsers.delete(resourceId);
    this.browserBindings.delete(resourceId);
    this.appBrowserProjects.delete(resourceId);
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
  ) {
    chat.setAppListener((snapshot) => {
      this.appEvents.set(snapshot.projectId, snapshot);
      if (snapshot.state !== 'running' && this.appLeases.get(snapshot.projectId)?.appInstanceId === snapshot.appInstanceId) {
        this.appLeases.delete(snapshot.projectId);
        for (const [resourceId, binding] of this.browserBindings)
          if (binding.workspaceId === snapshot.workspaceId && this.appBrowserProjects.get(resourceId) === snapshot.projectId)
            this.releaseAppBrowser(resourceId);
      }
      void this.application?.onApp(snapshot);
    });
  }
  validateBrowserUrl(url: string) {
    if (isAllowedPreviewUrl(url, [DEMO_ORIGIN])) return;
    try {
      parsePublicUrl(url);
    } catch (error) {
      throw new Error('invalid_input: ' + (error as Error).message, { cause: error });
    }
  }
  ensureBrowser(workspaceId: string, resource: WorkbenchResource): void {
    const lease = resource.appProjectId ? this.appLeases.get(resource.appProjectId) : undefined;
    if (resource.appProjectId) {
      if (!lease || lease.workspaceId !== workspaceId || lease.state !== 'running' || resource.url !== lease.url)
        throw new Error('unavailable: 应用实例已停止或需要重新启动');
    } else this.validateBrowserUrl(resource.url ?? 'wsl-demo://taskflow/index.html');
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
      allowedOrigins: lease?.url ? [new URL(lease.url).origin] : [DEMO_ORIGIN],
      managedAppOrigin: lease
        ? () => {
            const active = this.appLeases.get(lease.projectId);
            return active?.state === 'running' && active.appInstanceId === lease.appInstanceId && active.url
              ? new URL(active.url).origin
              : null;
          }
        : undefined,
      onState: (state) => this.application?.onPreview(resourceId, state, instanceId, generation),
      onCaptured: (capture, requestId) => this.application?.onCapture(resourceId, capture, instanceId, generation, requestId),
      onCaptureError: (error, requestId, kind) =>
        this.application?.onCaptureError(resourceId, requestId, instanceId, generation, kind, error.message),
      onFocused: () => this.application?.onBrowserFocus(workspaceId, resourceId, instanceId, generation),
    });
    try {
      preview.load();
      this.browsers.set(resourceId, preview);
      if (resource.appProjectId) this.appBrowserProjects.set(resourceId, resource.appProjectId);
      if (!instanceId) throw new Error('网页缺少 Main 实例身份');
      const binding: ResourceInstanceIdentity = {
        workspaceId,
        environmentId: resource.environmentId ?? 'local',
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
