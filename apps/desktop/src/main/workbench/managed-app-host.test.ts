import { randomUUID } from 'node:crypto';
import { BrowserWindow } from 'electron';
import type { EduAdmissionRecoveryStatus, ManagedApp, WorkbenchResource } from '@wsl/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ChatService } from '../chat-service';
import { WorkbenchHost } from './host';

const audio = vi.hoisted(() => ({ enabled: false, close: vi.fn<() => Promise<void>>() }));
vi.mock('electron', () => ({
  app: {},
  BrowserWindow: class {},
  dialog: {},
  session: { fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }) },
}));
vi.mock('../preview/demo-protocol', () => ({ DEMO_ORIGIN: 'wsl-demo://taskflow', installDemoProtocol: vi.fn() }));
vi.mock('../preview/controller', () => ({
  PreviewController: class {
    hasEduAudio = () => audio.enabled;
    closeWithAudioCleanup = () => audio.close();
    load = vi.fn();
    dispose = vi.fn();
  },
}));

const target = { workspaceId: 'host-app-test', projectId: randomUUID() };
const running: ManagedApp = {
  ...target,
  environmentId: 'sandbox',
  appInstanceId: randomUUID(),
  state: 'running',
  url: 'http://127.0.0.1:49152',
  guestCwd: '/guest/app',
  error: null,
  cleanupConfirmed: false,
};
const stopped: ManagedApp = { ...running, state: 'stopped', url: null, cleanupConfirmed: true };
const foreignProfile: ManagedApp['profile'] = {
  projectKind: 'edu-web',
  profileVersion: 1,
  source: {
    repository: { commit: 'a'.repeat(40), dirty: false },
    sourceSha256: 'b'.repeat(64),
    files: [{ path: 'server/app.py', sha256: 'c'.repeat(64), bytes: 0 }],
  },
};
const resource = (): WorkbenchResource => ({
  resourceId: randomUUID(),
  title: 'App',
  kind: 'web',
  environmentId: 'sandbox',
  url: running.url,
  appProjectId: target.projectId,
  instanceId: randomUUID(),
  generation: 1,
  unavailableReason: null,
  preview: null,
  terminal: null,
});
function fixture(start = async () => running) {
  audio.enabled = false;
  audio.close.mockResolvedValue(undefined);
  let listener: ((snapshot: ManagedApp) => void) | null = null;
  let admissionListener: ((status: EduAdmissionRecoveryStatus) => void) | null = null;
  const chat = vi.mockObject(ChatService.prototype);
  chat.setAdmissionRecoveryListener.mockImplementation((value) => {
    admissionListener = value;
  });
  chat.appStart.mockImplementation(start);
  chat.appStop.mockResolvedValue(stopped);
  chat.setAppListener.mockImplementation((value) => {
    listener = value;
  });
  const host = new WorkbenchHost(new BrowserWindow(), chat, '/unused-demo');
  return {
    host,
    chat,
    emit: (snapshot: ManagedApp) => listener?.(snapshot),
    emitAdmission: (status: EduAdmissionRecoveryStatus) => admissionListener?.(status),
  };
}

describe('native browser app lease ownership', () => {
  it('still stops guest after audio proof fails and reports the audio failure', async () => {
    const { host, chat } = fixture();
    audio.enabled = true;
    await host.appStart(target);
    const view = resource();
    host.ensureBrowser(target.workspaceId, view);
    const error = new Error('actual audio end unconfirmed');
    audio.close.mockRejectedValueOnce(error);
    const release = expect(host.releaseAppBrowser(view.resourceId)).rejects.toThrow(error.message);
    await expect(host.appStop(target)).rejects.toThrow(error.message);
    await release;
    expect(chat.appStop).toHaveBeenCalledWith(target);
    expect(() => host.ensureBrowser(target.workspaceId, resource())).toThrow('unavailable');
    host.dispose();
  });
  it('keeps same-origin navigation bound to the project while rejecting foreign origins', async () => {
    const { host } = fixture();
    await host.appStart(target);
    const view = resource();
    expect(() => host.ensureBrowser(target.workspaceId, { ...view, url: running.url + '/student' })).not.toThrow();
    expect(() => host.ensureBrowser(target.workspaceId, { ...view, url: 'http://127.0.0.1:49153/student' })).toThrow('unavailable');
    host.dispose();
  });
  it('does not grant a browser lease to a start reply arriving after stop', async () => {
    let finish!: (snapshot: ManagedApp) => void;
    const { host } = fixture(
      () =>
        new Promise<ManagedApp>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = host.appStart(target);
    await host.appStop(target);
    finish(running);
    await pending;
    expect(() => host.ensureBrowser(target.workspaceId, resource())).toThrow('unavailable');
    host.dispose();
  });
  it.each([
    { name: 'old-instance', snapshot: { ...stopped, appInstanceId: randomUUID() } },
    { name: 'foreign-profile', snapshot: { ...stopped, profile: foreignProfile } },
    ...(['running', 'starting', 'stopping', 'failed'] as const).map((state) => ({
      name: `late-${state}`,
      snapshot: { ...running, state, error: state === 'failed' ? 'late startup failure' : null },
    })),
  ])('retains terminal authority despite a subsequent $name event during startup', async ({ snapshot }) => {
    let finish!: (snapshot: ManagedApp) => void;
    const { host, emit } = fixture(
      () =>
        new Promise<ManagedApp>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = host.appStart(target);
    emit(stopped);
    emit(snapshot);
    finish(running);
    expect(await pending).toEqual(stopped);
    expect(() => host.ensureBrowser(target.workspaceId, resource())).toThrow('unavailable');
    host.dispose();
  });
  it.each(['workspace', 'profile'] as const)('does not let a foreign %s event revoke a current lease', async (kind) => {
    const { host, emit } = fixture();
    await host.appStart(target);
    emit(kind === 'workspace' ? { ...stopped, workspaceId: 'foreign' } : { ...stopped, profile: foreignProfile });
    expect(() => host.ensureBrowser(target.workspaceId, resource())).not.toThrow();
    host.dispose();
  });
  it.each(['workspace', 'profile'] as const)('does not replace a start reply with a foreign %s terminal receipt', async (kind) => {
    let finish!: (snapshot: ManagedApp) => void;
    const { host, emit } = fixture(
      () =>
        new Promise<ManagedApp>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = host.appStart(target);
    emit(kind === 'workspace' ? { ...stopped, workspaceId: 'foreign' } : { ...stopped, profile: foreignProfile });
    finish(running);
    expect((await pending).state).toBe('running');
    expect(() => host.ensureBrowser(target.workspaceId, resource())).not.toThrow();
    host.dispose();
  });
  it('rejects a running RPC result for another project before installing a lease', async () => {
    const { host } = fixture(async () => ({ ...running, projectId: randomUUID() }));
    await expect(host.appStart(target)).rejects.toThrow('invalid_input');
    expect(() => host.ensureBrowser(target.workspaceId, resource())).toThrow('unavailable');
    host.dispose();
  });
  it('honors a stopped event delivered before a stale running RPC reply', async () => {
    let finish!: (snapshot: ManagedApp) => void;
    const { host, emit } = fixture(
      () =>
        new Promise<ManagedApp>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = host.appStart(target);
    emit(stopped);
    finish(running);
    expect(await pending).toEqual(stopped);
    expect(() => host.ensureBrowser(target.workspaceId, resource())).toThrow('unavailable');
    host.dispose();
  });
});

it('does not expose standard App UI control ports for edu leases', async () => {
  const { host } = fixture(async () => ({ ...running, profile: foreignProfile }));
  await host.appStart(target);
  const view = resource();
  host.ensureBrowser(target.workspaceId, view);
  expect(() => host.appUi(view.resourceId)).toThrow('不授予标准应用控制面端口');
  host.dispose();
});

it('rebinds admission recovery only to the service-reserved healthy default instance', async () => {
  const original = {
    ...running,
    profile: foreignProfile,
    sourceSha256: foreignProfile!.projectKind === 'edu-web' ? foreignProfile!.source.sourceSha256 : '',
  };
  const t = fixture(async () => original);
  await t.host.appStart(target);
  const restoredId = randomUUID();
  t.emitAdmission({
    schemaVersion: 1,
    kind: 'admission-recovery',
    recoveryId: randomUUID(),
    originalIdentity: { ...target, environmentId: 'sandbox', appInstanceId: original.appInstanceId! },
    sourceSha256: original.sourceSha256,
    phase: 'restoring',
    restoredIdentity: { ...target, environmentId: 'sandbox', appInstanceId: restoredId },
    maintenanceLocked: true,
    error: null,
  });
  t.emit({ ...original, state: 'stopped', url: null, cleanupConfirmed: true });
  t.emit({ ...original, appInstanceId: restoredId, state: 'starting', url: null });
  t.emit({ ...original, appInstanceId: restoredId, url: 'http://127.0.0.1:49154' });
  expect(t.host.appLeaseValid(target.projectId, restoredId)).toBe(true);
  expect(t.host.appLeaseValid(target.projectId, original.appInstanceId!)).toBe(false);
  t.emit({ ...original, appInstanceId: randomUUID(), url: 'http://127.0.0.1:49155' });
  expect(t.host.appLeaseValid(target.projectId, restoredId)).toBe(true);
});
