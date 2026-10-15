import { isAllowedManagedAppUrl, isAllowedPreviewUrl } from '../preview/navigation-policy';
import { parsePublicUrl } from '../preview/public-document';
import { app, dialog, session, type BrowserWindow } from 'electron';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import type {
  AppTarget,
  ManagedApp,
  AppSource,
  CatalogReferenceSnapshot,
  AppAgentOperation,
  EduTaskBinding,
  EduVerificationStatus,
  EduVerificationBegin,
  EduVerificationTarget,
  EduAdmissionRecoveryStatus,
  EduImport,
} from '@wsl/protocol';
import { exportAppSource } from './source-export';
import { collectEduSource } from './edu-source';
import type { ObservationRequest, ObservationTurnScope, ResourceInstanceIdentity, WorkbenchResource } from '@wsl/protocol';
import type { ChatService } from '../chat-service';
import { BrowserObservation } from '../preview/observation';
import { AppUiDriver } from '../preview/app-ui';
import type { AppUiPort } from './app-control';
import { AppControlFailure } from './app-control-failure';
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
  private readonly appStarts = new Map<string, { workspaceId: string; terminal: Map<string, ManagedApp> }>();
  private appIdentity(snapshot: ManagedApp) {
    return JSON.stringify([snapshot.appInstanceId, snapshot.profile ?? { projectKind: 'standard-app', profileVersion: 1 }]);
  }
  private readonly appBrowserProjects = new Map<string, string>();
  async appGet(target: AppTarget) {
    const current = await this.chat.appGet(target);
    if (this.currentAdmission?.phase === 'ended' && this.admissionHandover(current)) this.appLeases.set(current.projectId, current);
    return current;
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
  async appSelectEduSource(signal: AbortSignal) {
    signal.throwIfAborted();
    const selected = await dialog.showOpenDialog(this.window, {
      properties: ['openDirectory'],
      title: '导入 edu-web 工程',
      buttonLabel: '校验并导入',
      message: '选择本机 edu Git 根目录。只复制固定白名单源码，不复制环境文件、账号、数据库或依赖目录。',
    });
    signal.throwIfAborted();
    if (selected.canceled || !selected.filePaths[0] || this.window.isDestroyed()) return null;
    return collectEduSource(selected.filePaths[0], signal);
  }
  async appImportEdu(target: AppTarget, source: Pick<EduImport, 'source' | 'files'>) {
    return this.chat.appImportEdu({ ...target, ...source });
  }
  async appStart(target: AppTarget) {
    const request = { workspaceId: target.workspaceId, terminal: new Map<string, ManagedApp>() };
    this.appStarts.set(target.projectId, request);
    try {
      const returned = await this.chat.appStart(target);
      if (returned.workspaceId !== target.workspaceId || returned.projectId !== target.projectId)
        throw new Error('invalid_input: 应用服务返回的项目身份不匹配');
      const result = request.terminal.get(this.appIdentity(returned)) ?? returned;
      if (result.state === 'running' && this.appStarts.get(target.projectId) === request) {
        if (!result.appInstanceId || !isAllowedManagedAppUrl(result.url ?? '', result.url ?? ''))
          throw new Error('invalid_input: 应用服务未返回受控实例地址');
        this.appLeases.set(target.projectId, result);
      }
      return result;
    } finally {
      if (this.appStarts.get(target.projectId) === request) this.appStarts.delete(target.projectId);
    }
  }
  private readonly audioReleases = new Map<string, Promise<Error | null>[]>();
  private async confirmAudioReleases(projectId: string): Promise<void> {
    const pending = this.audioReleases.get(projectId) ?? [];
    this.audioReleases.delete(projectId);
    const results = await Promise.all(pending);
    const failure = results.find((result) => result !== null);
    if (failure) throw failure;
  }
  async appStop(target: AppTarget) {
    this.appStarts.delete(target.projectId);
    this.appLeases.delete(target.projectId);
    const results = await Promise.allSettled([this.confirmAudioReleases(target.projectId), this.chat.appStop(target)]);
    const errors = results.filter((result) => result.status === 'rejected').map((result) => result.reason as unknown);
    if (errors.length)
      throw new AggregateError(errors, errors.map((error) => (error instanceof Error ? error.message : String(error))).join('；'));
    const stopped = results[1];
    if (stopped.status !== 'fulfilled') throw new Error('应用停止结果缺失');
    return stopped.value;
  }
  eduTaskSource(target: AppTarget) {
    return this.chat.appEduTaskSource(target);
  }
  eduTaskPrepare(binding: EduTaskBinding) {
    return this.chat.appPrepareEduTask(binding);
  }
  eduTaskApply(binding: EduTaskBinding) {
    return this.chat.appApplyEduTask(binding);
  }
  async appExport(target: AppTarget) {
    const source = await this.chat.appExport(target);
    return exportAppSource(path.join(app.getPath('userData'), 'exports'), target, source);
  }
  private readonly appUis = new Map<string, AppUiDriver>();
  /** 只为受管 App 的 Browser 资源提供控制面端口；演示页与公开只读文档永远不可写。 */
  appUi(resourceId: string): AppUiPort {
    const projectId = this.appBrowserProjects.get(resourceId);
    const lease = projectId ? this.appLeases.get(projectId) : undefined;
    if (!projectId || !lease || lease.state !== 'running')
      throw new AppControlFailure('browser_unavailable', '不是当前运行的受管 App 网页');
    if (lease.profile?.projectKind === 'edu-web') throw new AppControlFailure('unsupported', 'edu profile 不授予标准应用控制面端口');
    const preview = this.browser(resourceId);
    let driver = this.appUis.get(resourceId);
    if (!driver) {
      driver = new AppUiDriver(
        preview.observationTarget,
        { identity: () => preview.pageIdentity(), cdp: () => preview.getCdpState(), picking: () => preview.isPicking() },
        preview.agentControl,
      );
      this.appUis.set(resourceId, driver);
    }
    const ui = driver;
    return {
      identity: () => ({
        documentGeneration: preview.pageIdentity().documentGeneration,
        url: preview.pageIdentity().url,
        cdp: preview.getCdpState(),
        agentControl: preview.agentControl.state(),
      }),
      snapshot: (appInstanceId, options, signal) => ui.snapshot(appInstanceId, options, signal),
      act: (action, binding, signal) => ui.act(action, binding, signal),
      query: (target, signal) => ui.query(target, signal),
      bridge: (request, signal) => ui.bridge(request, signal),
      screenshot: () => ui.screenshot(),
      consoleMark: () => ui.consoleMark(),
      consoleErrorsSince: (mark) => ui.consoleErrorsSince(mark),
      beginControl: (runId, label) => preview.agentControl.begin(runId, label),
      releaseRun: (runId) => preview.agentControl.release(runId),
    };
  }
  appAgent(target: AppTarget, appInstanceId: string | null, operation: AppAgentOperation, signal: AbortSignal) {
    return this.chat.appAgent(target, appInstanceId, operation, signal);
  }
  appLogs(target: AppTarget, maxBytes: number) {
    return this.chat.appLogs(target, maxBytes);
  }
  appLeaseValid(projectId: string, appInstanceId: string) {
    const lease = this.appLeases.get(projectId);
    return lease?.state === 'running' && lease.appInstanceId === appInstanceId;
  }
  releaseAppBrowser(resourceId: string) {
    this.appUis.get(resourceId)?.dispose();
    this.appUis.delete(resourceId);
    this.observers.get(resourceId)?.dispose();
    this.observers.delete(resourceId);
    const preview = this.browsers.get(resourceId);
    const projectId = this.appBrowserProjects.get(resourceId);
    let cleanup: Promise<void> | undefined;
    if (preview?.hasEduAudio()) {
      cleanup = preview.closeWithAudioCleanup();
      const result = cleanup.then(
        () => null,
        (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
      );
      if (projectId) this.audioReleases.set(projectId, [...(this.audioReleases.get(projectId) ?? []), result]);
    } else preview?.dispose();
    this.browsers.delete(resourceId);
    this.browserBindings.delete(resourceId);
    this.appBrowserProjects.delete(resourceId);
    return cleanup;
  }
  private readonly browsers = new Map<string, PreviewController>();
  private readonly observers = new Map<string, BrowserObservation>();
  private readonly browserBindings = new Map<string, ResourceInstanceIdentity>();
  private currentVerification: EduVerificationStatus | null = null;
  private currentAdmission: EduAdmissionRecoveryStatus | null = null;
  private restoredVerificationInstance: string | null = null;
  private workbench: WorkbenchApplication | null = null;
  get application(): WorkbenchApplication | null {
    return this.workbench;
  }
  set application(value: WorkbenchApplication | null) {
    this.workbench = value;
    if (value && this.currentVerification) this.publishVerification(this.currentVerification);
    if (value && this.currentAdmission) this.publishAdmission(this.currentAdmission);
  }
  private publishVerification(status: EduVerificationStatus): void {
    if (status.phase !== 'active') void this.deactivateAudio().catch((error: unknown) => console.error('撤销发音验证音频资格失败', error));
    void this.application
      ?.onVerification(status)
      .then(() => this.resumeAudio())
      .catch((error: unknown) => console.error('发音验证状态保存失败', error));
  }
  private publishAdmission(status: EduAdmissionRecoveryStatus): void {
    void this.deactivateAudio().catch((error: unknown) => console.error('默认维护恢复音轨核验失败', error));
    void this.application
      ?.onAdmissionRecovery(status)
      .then(() => this.resumeAudio())
      .catch((error: unknown) => console.error('默认维护恢复状态未确认', error));
  }
  async verificationRecoverAdmission(original: EduVerificationBegin) {
    const result = await this.chat.verificationRecoverAdmission(original);
    this.currentAdmission = result;
    this.publishAdmission(result);
    return result;
  }
  private admissionHandover(snapshot: ManagedApp): boolean {
    const status = this.currentAdmission;
    const restored = status?.restoredIdentity;
    return (
      !!status &&
      ['restoring', 'ended'].includes(status.phase) &&
      !!restored &&
      snapshot.workspaceId === restored.workspaceId &&
      snapshot.projectId === restored.projectId &&
      snapshot.appInstanceId === restored.appInstanceId &&
      snapshot.appInstanceId !== status.originalIdentity.appInstanceId &&
      snapshot.profile?.projectKind === 'edu-web' &&
      snapshot.sourceSha256 === status.sourceSha256
    );
  }
  verificationBegin(input: EduVerificationBegin) {
    return this.chat.verificationBegin(input);
  }
  verificationEnd(target: EduVerificationTarget) {
    return this.chat.verificationEnd(target);
  }
  verificationStatus(target: EduVerificationTarget) {
    return this.chat.verificationStatus(target);
  }
  verificationReconcile(target: EduVerificationTarget) {
    return this.chat.verificationReconcile(target);
  }
  private verificationHandover(snapshot: ManagedApp): boolean {
    if (this.admissionHandover(snapshot)) return true;
    const state = this.currentVerification;
    if (
      !state ||
      snapshot.workspaceId !== state.lease.identity.workspaceId ||
      snapshot.projectId !== state.lease.identity.projectId ||
      snapshot.profile?.projectKind !== 'edu-web' ||
      snapshot.sourceSha256 !== state.lease.sourceSha256 ||
      !snapshot.appInstanceId
    )
      return false;
    if (state.phase === 'restoring') {
      if (snapshot.appInstanceId === state.lease.identity.appInstanceId) return false;
      if (!this.restoredVerificationInstance && snapshot.state === 'starting') this.restoredVerificationInstance = snapshot.appInstanceId;
      return this.restoredVerificationInstance === snapshot.appInstanceId;
    }
    return (
      ['preparing', 'active', 'revoking', 'revoked', 'failed'].includes(state.phase) &&
      snapshot.appInstanceId === state.lease.identity.appInstanceId
    );
  }
  environmentsList() {
    return this.chat.environmentsList();
  }
  async releaseResource(identity: ResourceInstanceIdentity) {
    if (identity.kind === 'browser') {
      await this.releaseAppBrowser(identity.resourceId);
      return;
    }
    await this.chat.releaseResource(identity);
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
    chat.setVerificationGuard(() => this.application?.maintenanceLocked() ?? false);
    chat.setAdmissionRecoveryListener((status) => {
      const previous = this.currentAdmission;
      if (
        previous &&
        ((previous.recoveryId !== status.recoveryId && previous.maintenanceLocked) ||
          (previous.recoveryId === status.recoveryId && previous.phase === 'ended'))
      )
        return;
      this.currentAdmission = status;
      this.publishAdmission(status);
    });
    chat.setVerificationListener((status) => {
      if (
        this.currentVerification &&
        this.currentVerification.lease.sessionId !== status.lease.sessionId &&
        this.currentVerification.maintenanceLocked
      )
        return;
      if (this.currentVerification?.lease.sessionId !== status.lease.sessionId) this.restoredVerificationInstance = null;
      this.currentVerification = status;
      this.publishVerification(status);
    });
    chat.setAppListener((snapshot) => {
      const key = this.appIdentity(snapshot);
      const lease = this.appLeases.get(snapshot.projectId);
      const handover = this.verificationHandover(snapshot);
      if (lease && !handover && (lease.workspaceId !== snapshot.workspaceId || this.appIdentity(lease) !== key)) return;
      const pending = this.appStarts.get(snapshot.projectId);
      const previous = pending?.workspaceId === snapshot.workspaceId ? pending.terminal.get(key) : undefined;
      if (
        previous &&
        ['failed', 'stopped'].includes(previous.state) &&
        (!['failed', 'stopped'].includes(snapshot.state) || (previous.cleanupConfirmed && !snapshot.cleanupConfirmed))
      )
        return;
      if (pending?.workspaceId === snapshot.workspaceId && ['failed', 'stopped', 'stopping'].includes(snapshot.state))
        pending.terminal.set(key, snapshot);
      if (lease && snapshot.state !== 'running') {
        this.appLeases.delete(snapshot.projectId);
        for (const [resourceId, binding] of this.browserBindings)
          if (binding.workspaceId === snapshot.workspaceId && this.appBrowserProjects.get(resourceId) === snapshot.projectId)
            this.releaseAppBrowser(resourceId);
      }
      if (handover && snapshot.state === 'running') this.appLeases.set(snapshot.projectId, snapshot);
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
      if (
        !lease ||
        lease.workspaceId !== workspaceId ||
        lease.state !== 'running' ||
        !isAllowedManagedAppUrl(resource.url ?? '', lease.url ?? '')
      )
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
      eduAudio:
        lease?.profile?.projectKind === 'edu-web'
          ? () => {
              const current = this.appLeases.get(lease.projectId);
              const binding = this.browserBindings.get(resourceId);
              if (
                !binding ||
                binding.instanceId !== instanceId ||
                binding.instanceGeneration !== generation ||
                current?.appInstanceId !== lease.appInstanceId ||
                current.state !== 'running' ||
                !this.application?.verificationAllowsAudio(current.projectId, current.appInstanceId ?? '') ||
                !current.url ||
                !current.appInstanceId
              )
                return null;
              return {
                workspaceId,
                resourceId,
                instanceId: binding.instanceId,
                instanceGeneration: generation,
                appInstanceId: current.appInstanceId,
                origin: new URL(current.url).origin,
                activeWorkspace: this.application?.isActiveWorkspace(workspaceId) ?? false,
                running: true,
              };
            }
          : undefined,
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
      case 'resumeAgent':
        return p.agentControl.resume();
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
  async captureResource(resourceId: string) {
    const preview = this.browser(resourceId);
    return preview.captureResource(preview.getState().page);
  }
  send(
    sessionId: string,
    text: string,
    scope: ObservationTurnScope | undefined,
    references: CatalogReferenceSnapshot,
    eduTask?: EduTaskBinding,
  ) {
    return this.chat.send(sessionId, text, scope, references, eduTask);
  }
  cancel(sessionId: string) {
    return this.chat.cancel(sessionId);
  }
  resumeAudio(): Promise<void> {
    return Promise.all(
      [...this.browsers.values()].filter((preview) => preview.hasEduAudio()).map((preview) => preview.resumeEduAudio()),
    ).then(() => undefined);
  }
  deactivateAudio(): Promise<void> {
    // Revoke all qualification synchronously before waiting for any OS grant.
    return Promise.all(
      [...this.browsers.values()].filter((preview) => preview.hasEduAudio()).map((preview) => preview.stopEduAudio()),
    ).then(() => undefined);
  }
  dispose() {
    for (const driver of this.appUis.values()) driver.dispose();
    this.appUis.clear();
    this.appStarts.clear();
    this.appLeases.clear();
    for (const observer of this.observers.values()) observer.dispose();
    this.observers.clear();
    this.browserBindings.clear();
    this.appBrowserProjects.clear();
    for (const p of this.browsers.values()) p.dispose();
    this.browsers.clear();
  }
}
