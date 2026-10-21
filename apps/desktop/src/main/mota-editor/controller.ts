import { randomUUID } from 'node:crypto';
import { WebContentsView, session, type BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { ManagedApp, WorkbenchResource, PreviewLayout, MotaEditorProjection } from '@wsl/protocol';
import { MOTA_EDITOR_URL, type MotaEditorFacts } from '../workbench/mota-editor';
import type { MotaEditorAssets } from './assets';

export class MotaEditorController {
  readonly view: WebContentsView;
  private readonly webContents: WebContents;
  private facts: MotaEditorFacts;
  private loaded = false;
  private assetsValid = true;
  private navigationFailed = false;
  private loading = true;
  private attached = false;
  private disposed = false;
  constructor(
    private readonly window: BrowserWindow,
    workspaceId: string,
    resource: WorkbenchResource,
    app: ManagedApp,
    theme: MotaEditorProjection['theme'],
    private readonly assets: MotaEditorAssets,
    preload: string,
    private readonly changed: (facts: MotaEditorFacts) => void,
  ) {
    if (!resource.instanceId || !app.appInstanceId) throw new Error('编辑器缺少原生实例身份');
    const partition = `mota-editor-${resource.instanceId}-${resource.generation}`;
    const nativeSession = session.fromPartition(partition);
    nativeSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    nativeSession.setPermissionCheckHandler(() => false);
    nativeSession.on('will-download', (event) => event.preventDefault());
    // Even a compromised editor cannot issue network or file requests outside its fixed assets.
    nativeSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('wsl-editor://mota/') }));
    this.view = new WebContentsView({
      webPreferences: { partition, preload, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true },
    });
    // Electron clears the View getter before this WebContents emits destroyed.
    this.webContents = this.view.webContents;
    const wc = this.webContents;
    this.facts = {
      workspaceId,
      projectId: app.projectId,
      appInstanceId: app.appInstanceId,
      resourceId: resource.resourceId,
      resourceInstanceId: resource.instanceId,
      resourceGeneration: resource.generation,
      browserInstanceId: randomUUID(),
      browserGeneration: 1,
      webContentsId: wc.id,
      processId: -1,
      routingId: -1,
      documentGeneration: 0,
      navigationEpoch: 0,
      url: '',
      assetVersion: assets.manifest.version,
      manifestDigest: assets.manifestDigest,
      trusted: false,
      visible: false,
      destroyed: false,
      theme,
    };
    const revoke = () => {
      this.loaded = false;
      this.facts.navigationEpoch++;
      this.facts.trusted = false;
      this.notify();
    };
    assets.install(nativeSession, () => {
      this.assetsValid = false;
      revoke();
    });
    wc.setWindowOpenHandler(() => {
      revoke();
      return { action: 'deny' };
    });
    const denied = (event: { preventDefault(): void }) => {
      this.loading = false;
      this.navigationFailed = true;
      revoke();
      event.preventDefault();
    };
    wc.on('will-navigate', denied);
    wc.on('will-frame-navigate', denied);
    wc.on('will-redirect', denied);
    wc.on('did-start-navigation', () => {
      this.loading = true;
      this.navigationFailed = false;
      revoke();
    });
    wc.on('did-navigate-in-page', () => {
      this.loading = false;
      revoke();
    });
    wc.on('did-fail-load', () => {
      this.loading = false;
      this.navigationFailed = true;
      revoke();
    });
    wc.on('render-process-gone', () => revoke());
    wc.on('destroyed', () => {
      this.facts.destroyed = true;
      revoke();
    });
    wc.on('did-finish-load', () => {
      if (this.disposed || wc.isDestroyed()) return;
      this.loading = false;
      if (!this.assetsValid || this.navigationFailed || wc.getURL() !== MOTA_EDITOR_URL || wc.mainFrame.url !== MOTA_EDITOR_URL) {
        revoke();
        return;
      }
      this.loaded = true;
      this.facts.documentGeneration++;
      this.facts.processId = wc.mainFrame.processId;
      this.facts.routingId = wc.mainFrame.routingId;
      this.facts.url = wc.getURL();
      this.facts.trusted = true;
      this.notify();
    });
    void assets
      .validate()
      .then(() => {
        if (!this.disposed && !wc.isDestroyed()) return wc.loadURL(MOTA_EDITOR_URL);
      })
      .catch((error: unknown) => {
        this.loading = false;
        this.assetsValid = false;
        revoke();
        console.error('可信魔塔编辑器加载失败', error);
      });
  }
  private notify() {
    this.changed(this.getFacts());
  }
  private hostVisible(): boolean {
    return !this.window.isDestroyed() && this.window.isVisible() && !this.window.isMinimized();
  }
  getFacts(): MotaEditorFacts {
    const wc = this.webContents;
    if (!wc.isDestroyed()) {
      // Always observe current native identity, not a cached renderer assertion.
      return {
        ...this.facts,
        visible: this.facts.visible && this.hostVisible(),
        url: wc.getURL(),
        processId: wc.mainFrame.processId,
        routingId: wc.mainFrame.routingId,
      };
    }
    return { ...this.facts, visible: false, destroyed: true, trusted: false };
  }
  accepts(event: IpcMainInvokeEvent): boolean {
    const wc = this.webContents;
    return (
      !this.disposed &&
      !wc.isDestroyed() &&
      this.loaded &&
      event.sender === wc &&
      event.senderFrame === wc.mainFrame &&
      !event.senderFrame.detached &&
      event.senderFrame.url === MOTA_EDITOR_URL &&
      wc.getURL() === MOTA_EDITOR_URL &&
      event.senderFrame.processId === this.facts.processId &&
      event.senderFrame.routingId === this.facts.routingId
    );
  }
  update(workspaceId: string, resource: WorkbenchResource, app: ManagedApp, theme: MotaEditorProjection['theme']) {
    if (!resource.instanceId || !app.appInstanceId) throw new Error('编辑器实例无效');
    this.facts = {
      ...this.facts,
      workspaceId,
      projectId: app.projectId,
      appInstanceId: app.appInstanceId,
      resourceInstanceId: resource.instanceId,
      resourceGeneration: resource.generation,
      theme,
    };
    this.notify();
  }
  layout(layout: PreviewLayout) {
    if (this.disposed || this.webContents.isDestroyed()) return;
    this.view.setBounds(layout.bounds);
    this.visibility(layout.visible && layout.bounds.width > 0 && layout.bounds.height > 0);
  }
  visibility(visible: boolean, projection?: MotaEditorProjection) {
    if (this.disposed || this.webContents.isDestroyed()) return;
    // Queued geometry cannot undo a native hide/minimize while the host remains unavailable.
    visible = visible && this.hostVisible();
    const changed = this.facts.visible !== visible;
    this.facts.visible = visible;
    if (visible && !this.attached) {
      this.window.contentView.addChildView(this.view);
      this.attached = true;
    }
    if (!visible && this.attached) {
      this.window.contentView.removeChildView(this.view);
      this.attached = false;
    }
    if (changed) this.notify();
    if (changed && visible && !this.loaded && !this.loading && this.assetsValid) {
      this.loading = true;
      void this.webContents.loadURL(MOTA_EDITOR_URL).catch((error: unknown) => {
        this.loading = false;
        this.facts.trusted = false;
        this.notify();
        console.error('重新打开魔塔编辑器失败', error);
      });
    }
    if (projection && !this.webContents.isDestroyed()) this.webContents.send('mota-editor:status', projection);
  }
  dispose() {
    if (this.disposed) return;
    // Native close completes asynchronously; revoke before that interval and never reopen this owner.
    this.disposed = true;
    this.loaded = false;
    this.facts.trusted = false;
    this.facts.visible = false;
    this.facts.navigationEpoch++;
    if (this.attached) {
      this.window.contentView.removeChildView(this.view);
      this.attached = false;
    }
    this.notify();
    if (!this.webContents.isDestroyed()) this.webContents.close();
  }
}
