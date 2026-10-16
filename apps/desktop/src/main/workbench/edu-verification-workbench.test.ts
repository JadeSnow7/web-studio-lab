import { AppTargetSchema } from '@wsl/protocol';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  WorkbenchCommandSchema,
  type EduVerificationStatus,
  type EduAdmissionRecoveryStatus,
  type ManagedApp,
  type PreviewState,
  type WorkbenchCommand,
  type WorkbenchSnapshot,
  type AppTarget,
  type AppImportOutcome,
  type WorkbenchResource,
} from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import { catalogForTestSnapshot } from './catalog-test-fixture';
import type { AppImportSelection, WorkbenchRuntime } from './ports';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function setup() {
  let saved: WorkbenchSnapshot | null = null;
  let current: ManagedApp | null = null;
  let status: EduVerificationStatus | null = null;
  const page: PreviewState = {
    page: { webContentsId: 41, documentGeneration: 0, url: '', title: 'Student', partition: 'fixture' },
    loading: false,
    picking: false,
    canGoBack: false,
    canGoForward: false,
    cdp: { state: 'attached' },
    consoleIssueCount: 0,
    pickError: null,
    loadError: null,
    blockedNavigation: null,
  };
  const source = {
    repository: { commit: 'a'.repeat(40), dirty: false },
    sourceSha256: 'b'.repeat(64),
    files: [{ path: 'server/app.py', sha256: 'c'.repeat(64), bytes: 4 }],
  };
  const events = vi.fn();
  const repository = {
    migrationPending: false,
    loadCatalog: catalogForTestSnapshot,
    load: async () => saved,
    save: vi.fn(async (snapshot: WorkbenchSnapshot) => {
      saved = structuredClone(snapshot);
    }),
    appendObservation: vi.fn(async () => ''),
  };
  const runtime = {
    appSelectImportSource: vi.fn(async (): Promise<AppImportSelection> => ({
      source,
      files: [{ path: 'server/app.py', base64: 'dGVzdA==' }],
      preview: {
        name: 'edu-web',
        profile: 'edu-web',
        profileVersion: 1,
        repository: source.repository,
        sourceSha256: source.sourceSha256,
        fileCount: source.files.length,
        totalBytes: source.files.reduce((total, file) => total + file.bytes, 0),
        warnings: [],
      },
      revalidate: vi.fn(async () => ({ source, files: [{ path: 'server/app.py', base64: 'dGVzdA==' }] })),
    })),
    appImportSource: vi.fn(async (target: AppTarget): Promise<AppImportOutcome> => {
      current = {
        ...target,
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
    }),
    appCancelImport: vi.fn(async (): Promise<AppImportOutcome> => ({
      app: null,
      outcome: 'cancelled',
      retryable: false,
      errorCode: null,
    })),
    appStart: vi.fn(
      async () =>
        (current = { ...current!, appInstanceId: randomUUID(), state: 'running', url: 'http://127.0.0.1:49152', cleanupConfirmed: false }),
    ),
    appStop: vi.fn(async () => (current = { ...current!, state: 'stopped', url: null, cleanupConfirmed: true })),
    validateBrowserUrl: vi.fn(async () => true),
    appGet: vi.fn(async (target: AppTarget) => {
      AppTargetSchema.parse(target);
      return current!;
    }),
    appLeaseValid: vi.fn(() => true),
    ensureBrowser: vi.fn((_workspaceId: string, resource: WorkbenchResource) => {
      page.page.url = resource.url!;
    }),
    browserState: vi.fn(() => structuredClone(page)),
    browserAction: vi.fn(async (_id: string, _action: string, url?: string) => {
      if (url) {
        page.page.url = url;
        page.page.documentGeneration++;
      }
    }),
    releaseAppBrowser: vi.fn(),
    hideBrowsers: vi.fn(),
    deactivateAudio: vi.fn(async () => {}),
    registerResource: vi.fn(),
    releaseResource: vi.fn(),
    environmentsList: vi.fn(async () => []),
    send: vi.fn(),
    terminalOpen: vi.fn(),
    terminalWrite: vi.fn(),
  } as unknown as WorkbenchRuntime;
  const app = new WorkbenchApplication(repository, runtime, events);
  await app.getSnapshot();
  const command = (type: WorkbenchCommand['type'], workspaceId = 'taskflow-demo') =>
    app.command({ type, workspaceId, commandId: randomUUID() } as WorkbenchCommand);
  expect((await command('previewAppImport')).ok).toBe(true);
  const preview = (await app.getSnapshot()).workspaces[0]!.appImport!;
  expect(
    (
      await app.command({
        type: 'confirmAppImport',
        workspaceId: 'taskflow-demo',
        commandId: randomUUID(),
        previewId: preview.previewId,
        sourceSha256: source.sourceSha256,
      })
    ).ok,
  ).toBe(true);
  await app.command({ type: 'openAppPage', workspaceId: 'taskflow-demo', commandId: randomUUID(), page: 'student' });
  const initial = (await app.getSnapshot()).workspaces[0]!.managedApp!;
  const leasedId = randomUUID();
  const state = (phase: EduVerificationStatus['phase'], callsUsed = 0, locked = phase !== 'ended'): EduVerificationStatus => ({
    lease: {
      schemaVersion: 1,
      sessionId: status?.lease.sessionId ?? randomUUID(),
      identity: { workspaceId: initial.workspaceId, projectId: initial.projectId, environmentId: 'sandbox', appInstanceId: leasedId },
      sourceSha256: source.sourceSha256,
      expiresAtMs: Date.now() + 300000,
    },
    phase,
    callsUsed,
    maintenanceLocked: locked,
    error: null,
  });
  runtime.verificationBegin = vi.fn(async () => {
    status = state('preparing');
    await app.onVerification(status);
    current = { ...initial, state: 'stopped', url: null, cleanupConfirmed: true };
    await app.onApp(current);
    current = { ...initial, appInstanceId: leasedId, state: 'starting', url: null };
    await app.onApp(current);
    current = { ...current, state: 'running', url: 'http://127.0.0.1:49153' };
    await app.onApp(current);
    status = { ...status, phase: 'active' };
    return status;
  });
  const finish = vi.fn(async () => {
    status = { ...status!, phase: 'restoring' };
    await app.onVerification(status);
    current = { ...initial, appInstanceId: randomUUID(), state: 'starting', url: null };
    await app.onApp(current);
    current = { ...current, state: 'running', url: 'http://127.0.0.1:49154' };
    await app.onApp(current);
    status = { ...status, phase: 'ended', maintenanceLocked: false };
    return status;
  });
  runtime.verificationEnd = finish;
  runtime.verificationReconcile = finish;
  return {
    app,
    runtime,
    repository,
    events,
    command,
    page,
    initial,
    leasedId,
    getStatus: () => status!,
    setCurrent: (value: ManagedApp) => {
      current = value;
    },
    getCurrent: () => current!,
    getSaved: () => saved!,
  };
}

describe('Main pronunciation verification authority', () => {
  it('freezes current student identity, persists recovery only and pauses every workspace', async () => {
    const t = await setup();
    await t.app.command({ type: 'createWorkspace', workspaceId: 'other', commandId: randomUUID(), name: 'Other' });
    await t.app.command({ type: 'switchWorkspace', workspaceId: 'taskflow-demo', commandId: randomUUID() });
    expect((await t.command('beginEduVerification')).ok).toBe(true);
    expect(t.runtime.verificationBegin).toHaveBeenCalledWith({
      workspaceId: t.initial.workspaceId,
      projectId: t.initial.projectId,
      appInstanceId: t.initial.appInstanceId,
      sourceSha256: t.initial.sourceSha256,
    });
    const live = (await t.app.getSnapshot()).eduVerification!;
    expect(live.status?.phase).toBe('active');
    expect(t.app.maintenanceLocked()).toBe(true);
    expect(t.getSaved().eduVerification).toMatchObject({
      status: null,
      recoveryRequired: true,
      target: live.target,
      original: live.original,
    });
    expect(t.app.verificationAllowsAudio(t.initial.projectId, t.leasedId)).toBe(true);
    expect(t.app.verificationAllowsAudio(t.initial.projectId, t.initial.appInstanceId!)).toBe(false);
    for (const type of ['startRun', 'terminalOpen', 'terminalWrite', 'createApp', 'importEduApp', 'previewAppImport', 'startApp'] as const)
      expect((await t.command(type, 'other')).ok).toBe(false);
    expect(t.runtime.send).not.toHaveBeenCalled();
    expect(t.runtime.terminalOpen).not.toHaveBeenCalled();
  });
  it('rejects navigation during audio cleanup before dispatching any lease or stopping an app', async () => {
    const t = await setup();
    const wait = deferred<void>();
    t.runtime.deactivateAudio = vi.fn(() => wait.promise);
    const pending = t.command('beginEduVerification');
    await vi.waitFor(() => expect(t.runtime.deactivateAudio).toHaveBeenCalled());
    t.page.page.documentGeneration++;
    wait.resolve();
    expect((await pending).ok).toBe(false);
    expect(t.runtime.verificationBegin).not.toHaveBeenCalled();
    expect(t.runtime.appStop).not.toHaveBeenCalled();
    expect(t.app.maintenanceLocked()).toBe(false);
  });
  it('refuses begin while another workspace import owns an app operation', async () => {
    const t = await setup();
    await t.app.command({ type: 'createWorkspace', workspaceId: 'other', commandId: randomUUID(), name: 'Other' });
    const wait = deferred<Awaited<ReturnType<NonNullable<WorkbenchRuntime['appSelectImportSource']>>>>();
    t.runtime.appSelectImportSource = vi.fn(() => wait.promise);
    const importing = t.command('previewAppImport', 'other');
    await vi.waitFor(() => expect(t.runtime.appSelectImportSource).toHaveBeenCalled());
    await t.app.command({ type: 'switchWorkspace', workspaceId: 'taskflow-demo', commandId: randomUUID() });
    expect((await t.command('beginEduVerification')).ok).toBe(false);
    expect(t.runtime.verificationBegin).not.toHaveBeenCalled();
    wait.resolve(null);
    await importing;
  });
  it('keeps the global lock until ended default-instance health is confirmed', async () => {
    const t = await setup();
    await t.command('beginEduVerification');
    const wait = deferred<ManagedApp>();
    t.runtime.appGet = vi.fn(() => wait.promise);
    const ended = { ...t.getStatus(), phase: 'ended' as const, maintenanceLocked: false };
    const pending = t.app.onVerification(ended);
    await vi.waitFor(() => expect(t.runtime.appGet).toHaveBeenCalled());
    expect(t.app.maintenanceLocked()).toBe(true);
    wait.resolve({ ...t.initial, appInstanceId: randomUUID(), state: 'running', url: 'http://127.0.0.1:49154' });
    await pending;
    expect(t.app.maintenanceLocked()).toBe(false);
    expect(t.getSaved().eduVerification).toBeNull();
  });
  it('does not unlock when an ended receipt returns the original instance instead of a fresh default', async () => {
    const t = await setup();
    await t.command('beginEduVerification');
    t.runtime.appGet = vi.fn(async () => t.initial);
    await expect(t.app.onVerification({ ...t.getStatus(), phase: 'ended', maintenanceLocked: false })).rejects.toThrow(
      '默认维护实例健康未确认',
    );
    expect(t.app.maintenanceLocked()).toBe(true);
    const fresh = { ...t.initial, appInstanceId: randomUUID(), url: 'http://127.0.0.1:49154' };
    t.runtime.appGet = vi.fn(async () => fresh);
    t.runtime.verificationReconcile = vi.fn(async () => ({ ...t.getStatus(), phase: 'ended' as const, maintenanceLocked: false }));
    expect((await t.command('reconcileEduVerification')).ok).toBe(true);
    expect(t.runtime.verificationReconcile).toHaveBeenCalledWith((await t.app.getSnapshot()).eduVerification!.target);
    expect(t.app.maintenanceLocked()).toBe(false);
  });
  it('failed ended health queries remain locked and publish recovery instead of success', async () => {
    const t = await setup();
    await t.command('beginEduVerification');
    t.runtime.appGet = vi.fn(async () => {
      throw new Error('query failed');
    });
    await expect(t.app.onVerification({ ...t.getStatus(), phase: 'ended', maintenanceLocked: false })).rejects.toThrow('query failed');
    expect(t.app.maintenanceLocked()).toBe(true);
    expect((await t.app.getSnapshot()).eduVerification).toMatchObject({ recoveryRequired: true });
    expect(t.runtime.appStop).not.toHaveBeenCalled();
  });
  it('ignores a duplicate ended receipt after normal default-source changes', async () => {
    const t = await setup();
    await t.command('beginEduVerification');
    await t.command('endEduVerification');
    const ended = t.getStatus();
    const changed = { ...t.getCurrent(), sourceSha256: 'd'.repeat(64) };
    await t.app.onApp(changed);
    vi.mocked(t.runtime.appGet!).mockClear();
    await t.app.onVerification(ended);
    expect(t.runtime.appGet).not.toHaveBeenCalled();
    expect(t.app.maintenanceLocked()).toBe(false);
    expect((await t.app.getSnapshot()).workspaces[0]!.managedApp?.sourceSha256).toBe(changed.sourceSha256);
  });
  it('ignores wrong-session and late active receipts after revocation', async () => {
    const t = await setup();
    await t.command('beginEduVerification');
    const active = t.getStatus();
    await t.app.onVerification({ ...active, lease: { ...active.lease, sessionId: randomUUID() }, phase: 'failed' });
    expect((await t.app.getSnapshot()).eduVerification?.status?.phase).toBe('active');
    await t.app.onVerification({ ...active, phase: 'revoked' });
    await t.app.onVerification({ ...active, callsUsed: 2 });
    expect((await t.app.getSnapshot()).eduVerification?.status?.phase).toBe('revoked');
  });
  it('publishes fail-closed state and keeps the durable marker when event saving fails', async () => {
    const t = await setup();
    await t.command('beginEduVerification');
    t.repository.save.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(t.app.onVerification({ ...t.getStatus(), callsUsed: 1 })).rejects.toThrow('disk unavailable');
    expect(t.app.maintenanceLocked()).toBe(true);
    expect(t.app.verificationAllowsAudio(t.initial.projectId, t.leasedId)).toBe(false);
    expect(t.events.mock.calls.at(-1)![0].snapshot.eduVerification.recoveryRequired).toBe(true);
    expect(t.getSaved().eduVerification?.status).toBeNull();
  });
  it('restores a saved marker as recovery-only and explicitly reconciles a journal target', async () => {
    const t = await setup();
    await t.command('beginEduVerification');
    t.setCurrent({ ...t.getCurrent(), state: 'stopped', url: null, cleanupConfirmed: true });
    const restarted = new WorkbenchApplication(t.repository, t.runtime, vi.fn());
    expect((await restarted.getSnapshot()).eduVerification).toMatchObject({ status: null, recoveryRequired: true });
    expect(restarted.maintenanceLocked()).toBe(true);
    const target = t.getSaved().eduVerification!.target!;
    t.runtime.verificationReconcile = vi.fn(async () => {
      t.setCurrent({ ...t.initial, appInstanceId: randomUUID(), state: 'running', url: 'http://127.0.0.1:49154' });
      return { ...t.getStatus(), phase: 'ended' as const, maintenanceLocked: false };
    });
    const result = await restarted.command({ type: 'reconcileEduVerification', workspaceId: 'taskflow-demo', commandId: randomUUID() });
    expect(result.ok).toBe(true);
    expect(t.runtime.verificationReconcile).toHaveBeenCalledWith(target);
    expect(restarted.maintenanceLocked()).toBe(false);
  });
  it('only the actual current student document leaving ends verification; stale preview does not', async () => {
    const t = await setup();
    await t.command('beginEduVerification');
    const w = (await t.app.getSnapshot()).workspaces[0]!;
    const r = w.resources.find((r) => r.appProjectId === t.initial.projectId)!;
    const student = structuredClone(t.page);
    student.page.url = 'http://127.0.0.1:49153/student';
    t.app.onPreview(r.resourceId, student, r.instanceId, r.generation);
    await t.app.getSnapshot();
    const admin = {
      ...student,
      page: { ...student.page, documentGeneration: student.page.documentGeneration + 1, url: 'http://127.0.0.1:49153/' },
    };
    t.app.onPreview(r.resourceId, admin, r.instanceId, r.generation - 1);
    await t.app.getSnapshot();
    expect(t.runtime.verificationEnd).not.toHaveBeenCalled();
    t.app.onPreview(r.resourceId, admin, r.instanceId, r.generation);
    await vi.waitFor(() => expect(t.runtime.verificationEnd).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(t.app.maintenanceLocked()).toBe(false));
  });
  it('switching workspace revokes scoring and restores maintenance automatically', async () => {
    const t = await setup();
    await t.app.command({ type: 'createWorkspace', workspaceId: 'other', commandId: randomUUID(), name: 'Other' });
    await t.app.command({ type: 'switchWorkspace', workspaceId: 'taskflow-demo', commandId: randomUUID() });
    await t.command('beginEduVerification');
    await t.app.command({ type: 'switchWorkspace', workspaceId: 'other', commandId: randomUUID() });
    await vi.waitFor(() => expect(t.runtime.verificationEnd).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(t.app.maintenanceLocked()).toBe(false));
  });
  it('normal reopen ignores historical terminal receipts while unfinished startup state still establishes recovery', async () => {
    const t = await setup();
    await t.command('beginEduVerification');
    await t.command('endEduVerification');
    const ended = t.getStatus();
    const defaultApp = t.getCurrent();
    t.setCurrent({ ...defaultApp, state: 'stopped', url: null, cleanupConfirmed: true });
    const restarted = new WorkbenchApplication(t.repository, t.runtime, vi.fn());
    await restarted.getSnapshot();
    expect(restarted.maintenanceLocked()).toBe(false);
    vi.mocked(t.runtime.appGet!).mockClear();
    await restarted.onVerification(ended);
    await restarted.onAdmissionRecovery({
      schemaVersion: 1,
      kind: 'admission-recovery',
      recoveryId: randomUUID(),
      originalIdentity: {
        workspaceId: t.initial.workspaceId,
        projectId: t.initial.projectId,
        environmentId: 'sandbox',
        appInstanceId: t.initial.appInstanceId!,
      },
      sourceSha256: t.initial.sourceSha256!,
      phase: 'ended',
      restoredIdentity: {
        workspaceId: defaultApp.workspaceId,
        projectId: defaultApp.projectId,
        environmentId: 'sandbox',
        appInstanceId: defaultApp.appInstanceId!,
      },
      maintenanceLocked: false,
      error: null,
    });
    expect(restarted.maintenanceLocked()).toBe(false);
    expect((await restarted.getSnapshot()).eduVerification).toBeNull();
    expect(t.runtime.appGet).not.toHaveBeenCalled();
    await restarted.onVerification({ ...ended, phase: 'failed', maintenanceLocked: true, error: 'verification_recovery_required' });
    expect(restarted.maintenanceLocked()).toBe(true);
    expect((await restarted.getSnapshot()).eduVerification?.target?.sessionId).toBe(ended.lease.sessionId);
  });
  it('an unconfirmed ended marker after restart explicitly reconciles a stopped default into a fresh healthy instance', async () => {
    const t = await setup();
    await t.command('beginEduVerification');
    const ended = { ...t.getStatus(), phase: 'ended' as const, maintenanceLocked: false };
    t.runtime.appGet = vi.fn(async () => {
      throw new Error('health response lost');
    });
    await expect(t.app.onVerification(ended)).rejects.toThrow();
    t.setCurrent({ ...t.initial, appInstanceId: randomUUID(), state: 'stopped', url: null, cleanupConfirmed: true });
    t.runtime.appGet = vi.fn(async () => t.getCurrent());
    const restarted = new WorkbenchApplication(t.repository, t.runtime, vi.fn());
    await restarted.getSnapshot();
    expect(restarted.maintenanceLocked()).toBe(true);
    t.runtime.verificationReconcile = vi.fn(async () => {
      t.setCurrent({ ...t.initial, appInstanceId: randomUUID(), url: 'http://127.0.0.1:49156' });
      return ended;
    });
    expect((await restarted.command({ type: 'reconcileEduVerification', workspaceId: 'taskflow-demo', commandId: randomUUID() })).ok).toBe(
      true,
    );
    expect(restarted.maintenanceLocked()).toBe(false);
  });
  it('app stop remains revoked and locked until explicit exit restores default mode', async () => {
    const t = await setup();
    await t.command('beginEduVerification');
    await t.command('stopApp');
    await t.app.onVerification({ ...t.getStatus(), phase: 'revoked' });
    expect(t.app.maintenanceLocked()).toBe(true);
    expect((await t.command('startApp')).ok).toBe(false);
    expect((await t.command('endEduVerification')).ok).toBe(true);
    expect(t.app.maintenanceLocked()).toBe(false);
  });
  it('renderer commands cannot choose instance, source or provider configuration', () => {
    for (const field of ['appInstanceId', 'sourceSha256', 'providerConfig', 'argv', 'sessionId'])
      expect(
        WorkbenchCommandSchema.safeParse({ type: 'beginEduVerification', workspaceId: 'ws', commandId: randomUUID(), [field]: 'untrusted' })
          .success,
      ).toBe(false);
  });
});

describe('Main no-target admission recovery', () => {
  async function lostBegin() {
    const t = await setup();
    t.runtime.verificationBegin = vi.fn(async () => {
      throw new Error('utility process exited before admission');
    });
    expect((await t.command('beginEduVerification')).ok).toBe(false);
    const marker = (await t.app.getSnapshot()).eduVerification!;
    expect(marker.original).toBeTruthy();
    expect(marker.target).toBeNull();
    expect(t.app.maintenanceLocked()).toBe(true);
    const restored = { ...t.initial, appInstanceId: randomUUID(), url: 'http://127.0.0.1:49154' };
    const status: EduAdmissionRecoveryStatus = {
      schemaVersion: 1,
      kind: 'admission-recovery',
      recoveryId: randomUUID(),
      originalIdentity: {
        workspaceId: t.initial.workspaceId,
        projectId: t.initial.projectId,
        environmentId: 'sandbox',
        appInstanceId: t.initial.appInstanceId!,
      },
      sourceSha256: t.initial.sourceSha256!,
      phase: 'ended',
      restoredIdentity: {
        workspaceId: restored.workspaceId,
        projectId: restored.projectId,
        environmentId: 'sandbox',
        appInstanceId: restored.appInstanceId!,
      },
      maintenanceLocked: false,
      error: null,
    };
    t.runtime.verificationRecoverAdmission = vi.fn(async () => {
      t.setCurrent(restored);
      return status;
    });
    return { ...t, marker, restored, recovery: status };
  }
  it('recovers a restarted original-only marker using frozen identity and a fresh healthy default', async () => {
    const t = await lostBegin();
    const restarted = new WorkbenchApplication(t.repository, t.runtime, vi.fn());
    await restarted.getSnapshot();
    expect((await restarted.command({ type: 'reconcileEduVerification', workspaceId: 'taskflow-demo', commandId: randomUUID() })).ok).toBe(
      true,
    );
    expect(t.runtime.verificationRecoverAdmission).toHaveBeenCalledWith(t.marker.original);
    expect(t.runtime.verificationReconcile).not.toHaveBeenCalled();
    expect(t.runtime.appStop).not.toHaveBeenCalled();
    expect(restarted.maintenanceLocked()).toBe(false);
    expect(t.getSaved().eduVerification).toBeNull();
    expect((await restarted.getSnapshot()).eduVerification).toMatchObject({
      status: null,
      target: null,
      admissionRecovery: { kind: 'admission-recovery', phase: 'ended' },
    });
    await restarted.onAdmissionRecovery({ ...t.recovery, phase: 'failed', maintenanceLocked: true, error: 'late' });
    expect(restarted.maintenanceLocked()).toBe(false);
  });
  it('ignores unrelated original identities before any recovery handover', async () => {
    const t = await lostBegin();
    await t.app.onAdmissionRecovery({ ...t.recovery, originalIdentity: { ...t.recovery.originalIdentity, appInstanceId: randomUUID() } });
    expect((await t.app.getSnapshot()).eduVerification?.admissionRecovery).toBeUndefined();
    expect(t.app.maintenanceLocked()).toBe(true);
    expect(t.runtime.appGet).not.toHaveBeenCalled();
  });
  it('keeps admission recovery locked until the exact returned default instance is healthy', async () => {
    const t = await lostBegin();
    const wait = deferred<ManagedApp>();
    t.runtime.appGet = vi.fn(() => wait.promise);
    const pending = t.command('reconcileEduVerification');
    await vi.waitFor(() => expect(t.runtime.appGet).toHaveBeenCalled());
    expect(t.app.maintenanceLocked()).toBe(true);
    wait.resolve(t.restored);
    expect((await pending).ok).toBe(true);
    expect(t.app.maintenanceLocked()).toBe(false);
  });
  it('refuses old-instance or source drift without stopping any app or unlocking', async () => {
    for (const candidate of ['old-instance', 'source-changed'] as const) {
      const t = await lostBegin();
      t.runtime.appGet = vi.fn(async () => (candidate === 'old-instance' ? t.initial : { ...t.restored, sourceSha256: 'f'.repeat(64) }));
      expect((await t.command('reconcileEduVerification')).ok).toBe(false);
      expect(t.runtime.verificationRecoverAdmission).toHaveBeenCalledOnce();
      expect(t.app.maintenanceLocked()).toBe(true);
      expect(t.runtime.appStop).not.toHaveBeenCalled();
    }
  });
  it('retries an unconfirmed admission-ended marker after restart without reviving a scoring lease', async () => {
    const t = await lostBegin();
    t.runtime.appGet = vi.fn(async () => {
      throw new Error('health response lost');
    });
    expect((await t.command('reconcileEduVerification')).ok).toBe(false);
    t.setCurrent({ ...t.restored, state: 'stopped', url: null, cleanupConfirmed: true });
    t.runtime.appGet = vi.fn(async () => t.getCurrent());
    const restarted = new WorkbenchApplication(t.repository, t.runtime, vi.fn());
    await restarted.getSnapshot();
    expect(restarted.maintenanceLocked()).toBe(true);
    const fresh = { ...t.restored, appInstanceId: randomUUID() };
    t.runtime.verificationRecoverAdmission = vi.fn(async () => {
      t.setCurrent(fresh);
      return { ...t.recovery, restoredIdentity: { ...t.recovery.restoredIdentity!, appInstanceId: fresh.appInstanceId! } };
    });
    expect((await restarted.command({ type: 'reconcileEduVerification', workspaceId: 'taskflow-demo', commandId: randomUUID() })).ok).toBe(
      true,
    );
    expect(restarted.maintenanceLocked()).toBe(false);
    expect((await restarted.getSnapshot()).eduVerification?.target).toBeNull();
  });
  it('retains the original marker when service rejects changed identity or source', async () => {
    const t = await lostBegin();
    t.runtime.verificationRecoverAdmission = vi.fn(async () => {
      throw new Error('verification_recovery_source_changed');
    });
    expect((await t.command('reconcileEduVerification')).ok).toBe(false);
    expect(t.runtime.verificationRecoverAdmission).toHaveBeenCalledWith(t.marker.original);
    expect(t.app.maintenanceLocked()).toBe(true);
    expect((await t.app.getSnapshot()).eduVerification?.original).toEqual(t.marker.original);
    expect(t.runtime.appStop).not.toHaveBeenCalled();
  });
});

describe('verification queued App event ordering', () => {
  it('binds queued running before active reply and duplicate running does not release/rebind preview', async () => {
    const t = await setup(),
      id = t.leasedId;
    t.runtime.verificationBegin = vi.fn(async () => {
      const status: EduVerificationStatus = {
        lease: {
          schemaVersion: 1,
          sessionId: randomUUID(),
          identity: { workspaceId: t.initial.workspaceId, projectId: t.initial.projectId, environmentId: 'sandbox', appInstanceId: id },
          sourceSha256: t.initial.sourceSha256!,
          expiresAtMs: Date.now() + 300000,
        },
        phase: 'preparing',
        callsUsed: 0,
        maintenanceLocked: true,
        error: null,
      };
      await t.app.onVerification(status);
      const starting = { ...t.initial, appInstanceId: id, state: 'starting' as const, url: null };
      const running = { ...starting, state: 'running' as const, url: 'http://127.0.0.1:49153' };
      // Production sends app events before the active event/RPC reply; it does not await Main listeners.
      void t.app.onApp(starting);
      void t.app.onApp(running);
      t.setCurrent(running);
      return { ...status, phase: 'active' as const };
    });
    const begun = await t.command('beginEduVerification');
    expect(begun.ok).toBe(true);
    expect(begun.snapshot.workspaces[0]!.managedApp).toMatchObject({ appInstanceId: id, state: 'running', url: 'http://127.0.0.1:49153' });
    const before = (await t.app.getSnapshot()).workspaces[0]!.resources.find((resource) => resource.appProjectId === t.initial.projectId)!;
    const releases = vi.mocked(t.runtime.releaseAppBrowser!).mock.calls.length;
    await t.app.onApp(t.getCurrent());
    const after = (await t.app.getSnapshot()).workspaces[0]!.resources.find((resource) => resource.resourceId === before.resourceId)!;
    expect(after.generation).toBe(before.generation);
    expect(after.instanceId).toBe(before.instanceId);
    expect(t.runtime.releaseAppBrowser).toHaveBeenCalledTimes(releases);
  });
});
