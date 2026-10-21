import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkbenchCommandSchema, type EduVerificationStatus, type ManagedApp, type PreviewState } from '@wsl/protocol';
import { ChatService } from '../chat-service';
import { WorkbenchApplication } from './application';
import { WorkbenchHost } from './host';
import { FileWorkbenchRepository } from './repository';

const audio = vi.hoisted(() => ({ stop: vi.fn<() => Promise<void>>(), close: vi.fn<() => Promise<void>>() }));
vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  dialog: {},
  session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }) },
}));
vi.mock('../preview/demo-protocol', () => ({ DEMO_ORIGIN: 'wsl-demo://taskflow', installDemoProtocol: vi.fn() }));
vi.mock('../preview/controller', () => ({
  PreviewController: class {
    private url: string;
    constructor(
      _window: unknown,
      private readonly options: { homeUrl: string; eduAudio?: unknown },
    ) {
      this.url = options.homeUrl;
    }
    load = vi.fn();
    dispose = vi.fn();
    setLayout = vi.fn();
    hasEduAudio = () => Boolean(this.options.eduAudio);
    stopEduAudio = () => audio.stop();
    closeWithAudioCleanup = () => audio.close();
    resumeEduAudio = async () => undefined;
    navigate = async (url: string) => {
      this.url = url;
    };
    getState = (): PreviewState => ({
      page: { webContentsId: 41, documentGeneration: 0, url: this.url, title: 'App', partition: 'fixture' },
      loading: false,
      picking: false,
      canGoBack: false,
      canGoForward: false,
      consoleIssueCount: 0,
      cdp: { state: 'attached' },
      pickError: null,
      loadError: null,
      blockedNavigation: null,
    });
  },
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('missing fixture value');
  return value;
};
async function fixture(edu = false) {
  audio.stop.mockReset().mockResolvedValue(undefined);
  audio.close.mockReset().mockResolvedValue(undefined);
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-onapp-save-'));
  roots.push(root);
  const file = path.join(root, 'workbench.json');
  const repository = new FileWorkbenchRepository(file);
  const save = vi.spyOn(repository, 'save');
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const chat = vi.mockObject(ChatService.prototype);
  let listener: ((value: ManagedApp) => void) | undefined;
  let verification: ((value: EduVerificationStatus) => void) | undefined;
  let current: ManagedApp | undefined;
  chat.setAppListener.mockImplementation((value) => {
    listener = value;
  });
  chat.setVerificationListener.mockImplementation((value) => {
    verification = value;
  });
  chat.environmentsList.mockResolvedValue([]);
  chat.registerResource.mockResolvedValue(undefined);
  chat.appCreate.mockImplementation(
    async (target) =>
      (current = {
        ...target,
        environmentId: 'sandbox',
        appInstanceId: null,
        state: 'created',
        url: null,
        guestCwd: '/guest/app',
        error: null,
        cleanupConfirmed: true,
      }),
  );
  chat.appStart.mockImplementation(
    async () =>
      (current = {
        ...required(current),
        appInstanceId: randomUUID(),
        state: 'running',
        url: 'http://127.0.0.1:49152',
        cleanupConfirmed: false,
      }),
  );
  chat.appGet.mockImplementation(async () => required(current));
  const host = new WorkbenchHost(new BrowserWindow(), chat, '/unused-demo');
  vi.spyOn(host, 'appCreate').mockImplementation((target) => chat.appCreate(target, []));
  const events = vi.fn();
  const application = new WorkbenchApplication(repository, host, events);
  host.application = application;
  await application.getSnapshot();
  const command = (value: Record<string, unknown>) =>
    application.command(
      WorkbenchCommandSchema.parse({
        workspaceId: 'taskflow-demo',
        commandId: randomUUID(),
        ...value,
      }),
    );
  if (edu) {
    const source = {
      repository: { commit: 'a'.repeat(40), dirty: false },
      sourceSha256: 'b'.repeat(64),
      files: [{ path: 'server/app.py', sha256: 'c'.repeat(64), bytes: 4 }],
    };
    const selected = { source, files: [{ path: 'server/app.py', base64: 'dGVzdA==' }] };
    vi.spyOn(host, 'appSelectImportSource').mockResolvedValue({
      ...selected,
      preview: {
        name: 'edu',
        profile: 'edu-web',
        profileVersion: 1,
        repository: source.repository,
        sourceSha256: source.sourceSha256,
        fileCount: 1,
        totalBytes: 4,
        warnings: [],
      },
      revalidate: async () => selected,
    });
    chat.appImportSource.mockImplementation(async (input) => {
      current = {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        profile: { projectKind: 'edu-web', profileVersion: 1, source },
        sourceSha256: source.sourceSha256,
        environmentId: 'sandbox',
        appInstanceId: null,
        state: 'created',
        url: null,
        guestCwd: '/guest/edu',
        error: null,
        cleanupConfirmed: true,
      };
      return { app: current, outcome: 'imported', retryable: false, errorCode: null };
    });
    expect((await command({ type: 'previewAppImport' })).ok).toBe(true);
    const preview = required((await application.getSnapshot()).workspaces[0]?.appImport);
    expect((await command({ type: 'confirmAppImport', previewId: preview.previewId, sourceSha256: source.sourceSha256 })).ok).toBe(true);
  } else {
    expect((await command({ type: 'createApp' })).ok).toBe(true);
    expect((await command({ type: 'startApp' })).ok).toBe(true);
  }
  const snapshot = () => application.getSnapshot();
  const owner = async () => required((await snapshot()).workspaces[0]);
  const emit = (value: ManagedApp) => {
    current = value;
    required(listener)(value);
  };
  const handover = async () => {
    const app = required((await owner()).managedApp);
    const status: EduVerificationStatus = {
      lease: {
        schemaVersion: 1,
        sessionId: randomUUID(),
        sourceSha256: required(app.sourceSha256),
        expiresAtMs: Date.now() + 60000,
        identity: { workspaceId: app.workspaceId, projectId: app.projectId, environmentId: app.environmentId, appInstanceId: randomUUID() },
      },
      phase: 'preparing',
      callsUsed: 0,
      maintenanceLocked: true,
      error: null,
    };
    required(verification)(status);
    await snapshot();
    return { ...app, appInstanceId: status.lease.identity.appInstanceId, url: 'http://127.0.0.1:49153' };
  };
  save.mockClear();
  diagnostic.mockClear();
  return { file, repository, save, diagnostic, application, host, events, snapshot, owner, emit, handover };
}

describe('onApp persistence through the Host listener', () => {
  it('persists an ordinary valid event without a diagnostic', async () => {
    const f = await fixture();
    const before = await f.owner();
    f.emit({ ...required(before.managedApp), sourceSha256: 'd'.repeat(64) });
    const after = await f.owner();
    expect(after.revision).toBe(before.revision + 1);
    expect(after.managedApp?.sourceSha256).toBe('d'.repeat(64));
    expect(f.save).toHaveBeenCalledOnce();
    expect(f.diagnostic).not.toHaveBeenCalled();
    expect((await f.repository.load())?.workspaces[0]?.managedApp?.sourceSha256).toBe('d'.repeat(64));
  });
  it('retains stop facts on real .pending EISDIR, then persists a later confirmed cleanup', async () => {
    const f = await fixture();
    const before = await f.snapshot();
    const old = required(before.workspaces[0]);
    const app = required(old.managedApp);
    const bytes = await readFile(f.file, 'utf8');
    await mkdir(f.file + '.pending');
    f.emit({ ...app, state: 'stopped', url: null, cleanupConfirmed: false });
    const failed = await f.snapshot();
    expect(failed.storageError).toContain('应用状态保存失败');
    expect(failed.seq).toBe(before.seq + 1);
    expect(failed.workspaces[0]?.revision).toBe(old.revision);
    expect(failed.workspaces[0]?.managedApp).toMatchObject({ state: 'stopped', cleanupConfirmed: false });
    expect(failed.workspaces[0]?.resources.find((r) => r.appProjectId === app.projectId)).toMatchObject({
      instanceId: null,
      preview: null,
    });
    expect(f.host.appLeaseValid(app.projectId, required(app.appInstanceId))).toBe(false);
    expect(await readFile(f.file, 'utf8')).toBe(bytes);
    await vi.waitFor(() => expect(f.diagnostic).toHaveBeenCalled());
    await rm(f.file + '.pending', { recursive: true });
    f.emit({ ...app, state: 'stopped', url: null, cleanupConfirmed: true });
    const recovered = await f.snapshot();
    expect(recovered.storageError).toBeNull();
    expect(recovered.workspaces[0]?.revision).toBe(old.revision + 1);
    expect((await f.repository.load())?.workspaces[0]?.managedApp).toMatchObject({ state: 'stopped', cleanupConfirmed: true });
  });
  it('keeps a normal running lease and visible source facts when saving rejects, then recovers', async () => {
    const f = await fixture();
    const before = await f.owner();
    const app = required(before.managedApp);
    const oldBytes = await readFile(f.file, 'utf8');
    f.save.mockRejectedValueOnce(new Error('synthetic save refusal'));
    f.emit({ ...app, sourceSha256: 'd'.repeat(64) });
    const failed = await f.owner();
    expect(failed.managedApp?.sourceSha256).toBe('d'.repeat(64));
    expect(failed.revision).toBe(before.revision);
    expect(f.host.appLeaseValid(app.projectId, required(app.appInstanceId))).toBe(true);
    expect(await readFile(f.file, 'utf8')).toBe(oldBytes);
    f.emit({ ...app, sourceSha256: 'e'.repeat(64) });
    expect((await f.snapshot()).storageError).toBeNull();
    expect((await f.repository.load())?.workspaces[0]?.managedApp?.sourceSha256).toBe('e'.repeat(64));
  });
  it('still rejects the original Application call rather than reporting a successful save', async () => {
    const f = await fixture();
    const failure = new Error('original repository rejection');
    f.save.mockRejectedValueOnce(failure);
    await expect(f.application.onApp(required((await f.owner()).managedApp))).rejects.toBe(failure);
    expect((await f.snapshot()).storageError).toContain(failure.message);
  });
  it('revokes an unpersisted handover and reports cleanup failure without hiding the save rejection', async () => {
    const f = await fixture(true);
    const candidate = await f.handover();
    const bytes = await readFile(f.file, 'utf8');
    const revoke = vi.spyOn(f.host, 'deactivateAudio').mockRejectedValueOnce(new Error('audio cleanup rejected'));
    const failure = new Error('handover save rejected');
    f.save.mockRejectedValueOnce(failure);
    f.emit(candidate);
    const snapshot = await f.snapshot();
    expect(snapshot.storageError).toContain(failure.message);
    expect(snapshot.eduVerification).toMatchObject({ recoveryRequired: true, error: expect.stringContaining('保存失败') });
    expect(snapshot.workspaces[0]?.managedApp?.appInstanceId).toBe(candidate.appInstanceId);
    expect(snapshot.workspaces[0]?.resources.find((r) => r.appProjectId === candidate.projectId)?.instanceId).toBeNull();
    expect(f.host.appLeaseValid(candidate.projectId, required(candidate.appInstanceId))).toBe(false);
    expect(revoke).toHaveBeenCalledOnce();
    expect(await readFile(f.file, 'utf8')).toBe(bytes);
    await vi.waitFor(() => expect(f.diagnostic).toHaveBeenCalledWith('应用状态保存失败', failure));
    expect(f.diagnostic).toHaveBeenCalledWith('应用接管保存失败后音频清理未确认', expect.any(Error));
  });
  it('a late handover rejection cannot revoke the next valid event lease', async () => {
    const f = await fixture(true);
    const candidate = await f.handover();
    f.save.mockClear();
    let rejectSave: ((error: Error) => void) | undefined;
    const blocked = new Promise<void>((_resolve, reject) => {
      rejectSave = reject;
    });
    f.save.mockImplementationOnce(async () => blocked);
    f.emit(candidate);
    await vi.waitFor(() => expect(f.save).toHaveBeenCalled());
    const later = { ...candidate, url: 'http://127.0.0.1:49154' };
    f.emit(later);
    required(rejectSave)(new Error('first event save rejected'));
    await vi.waitFor(async () => expect((await f.owner()).managedApp?.url).toBe(later.url));
    expect(f.host.appLeaseValid(later.projectId, required(later.appInstanceId))).toBe(true);
    expect((await f.snapshot()).storageError).toBeNull();
  });
});
