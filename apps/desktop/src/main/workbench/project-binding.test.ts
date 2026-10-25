import { codexHarnessRuntime, CODEX_TEST_REF } from './harness-test-fixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  WorkbenchCommandSchema,
  type AppSourceSnapshot,
  type AppSourceSnapshotResult,
  type AppTarget,
  type CapturedSourceChange,
  type ChatConversation,
  type ManagedApp,
  type PageCapture,
  type PreviewState,
  type WorkbenchResult,
  type WorkbenchSnapshot,
} from '@wsl/protocol';
import { WorkbenchApplication, validateSnapshot } from './application';
import type { WorkbenchRepository } from './repository';
import type { WorkbenchRuntime } from './ports';
import { catalogForTestSnapshot } from './catalog-test-fixture';

/*
 * OPS-1 B1（S2 的 Main 部分，R5）：会话草稿的工程选择与页面引用分开保存；confirmTask 只接收 appId | null 与 captureId | null，
 * Main 核对后冻结 appTarget（含 guestCwd）与页面证据。有工程、无页面的任务版本与带页面的一样获得工程绑定、项目写入登记与
 * 源码 baseline/diff；工程身份失效时阻止执行，不降级为无工程运行。O05c–O05g、O13b。
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const required = <T>(value: T | null | undefined): T => {
  if (value == null) throw new Error('missing fixture value');
  return value;
};
const baseTree = 'a'.repeat(40);
const patch = 'diff --git a/button.ts b/button.ts\n--- a/button.ts\n+++ b/button.ts\n@@ -1 +1 @@\n-old\n+new\n';
const captured: CapturedSourceChange = {
  state: 'captured',
  baseTree,
  afterTree: 'b'.repeat(40),
  files: [{ path: 'button.ts', change: 'modified', additions: 1, deletions: 1, binary: false }],
  additions: 1,
  deletions: 1,
  truncated: false,
  patchSha256: createHash('sha256').update(patch).digest('hex'),
};
const page: PreviewState = {
  page: { webContentsId: 42, documentGeneration: 0, url: 'http://127.0.0.1:49152', title: 'App', partition: 'fixture' },
  loading: false,
  picking: false,
  canGoBack: false,
  canGoForward: false,
  consoleIssueCount: 0,
  cdp: { state: 'attached' },
  pickError: null,
  loadError: null,
  blockedNavigation: null,
};
const unused = async (): Promise<never> => {
  throw new Error('unexpected runtime operation');
};
const pageCapture = (captureId: string): PageCapture => ({
  captureId,
  capturedAt: '2026-10-23T00:00:00.000Z',
  page: page.page,
  element: {
    tagName: 'button',
    id: null,
    classes: [],
    role: 'button',
    ariaLabel: null,
    testId: 'button',
    text: 'old',
    selector: 'button',
    rect: null,
  },
  screenshot: { viewport: 'data:image/png;base64,AA==', element: null },
  consoleIssues: [],
});

async function fixture(options: { guestCwd?: (projectId: string) => string } = {}) {
  let saved: WorkbenchSnapshot | null = null;
  const apps = new Map<string, ManagedApp>();
  const turns = new Map<string, ChatConversation>();
  const cwd = options.guestCwd ?? ((projectId: string) => `/home/agent/workspace/.wsl-apps/${projectId}`);
  const snapshots = vi.fn(async (target: AppTarget, _signal: AbortSignal): Promise<AppSourceSnapshotResult> => ({
    ok: true,
    cleanupConfirmed: true,
    snapshot: {
      ...target,
      files: [{ path: 'button.ts', mode: '100644', base64: Buffer.from('text\n').toString('base64') }],
      totalBytes: 5,
    },
  }));
  const send = vi.fn<WorkbenchRuntime['send']>(async (sessionId) => {
    const turn: ChatConversation = {
      conversationId: sessionId,
      generation: 'generation',
      turnId: randomUUID(),
      seq: (turns.get(sessionId)?.seq ?? 0) + 1,
      threadId: 'thread',
      state: 'running',
      messages: [],
      toolExecutions: [],
      warnings: [],
      cleanupPending: true,
      error: null,
    };
    turns.set(sessionId, turn);
    return turn;
  });
  const cancel = vi.fn(async (sessionId: string): Promise<ChatConversation> => {
    const turn = required(turns.get(sessionId));
    const result = { ...turn, state: 'cancelled' as const, cleanupPending: false, seq: turn.seq + 1 };
    turns.set(sessionId, result);
    return result;
  });
  const resolveHarness = vi.fn(codexHarnessRuntime.resolveHarness);
  const runtime: WorkbenchRuntime = {
    ...codexHarnessRuntime,
    resolveHarness,
    appSourceSnapshot: snapshots,
    appCreate: async (target) => {
      const app: ManagedApp = {
        ...target,
        environmentId: 'sandbox',
        appInstanceId: null,
        state: 'created',
        url: null,
        guestCwd: cwd(target.projectId),
        error: null,
        cleanupConfirmed: true,
      };
      apps.set(target.projectId, app);
      return app;
    },
    appStart: async (target) => {
      const app: ManagedApp = {
        ...required(apps.get(target.projectId)),
        appInstanceId: randomUUID(),
        state: 'running',
        url: page.page.url,
        cleanupConfirmed: false,
      };
      apps.set(target.projectId, app);
      return app;
    },
    appStop: async (target) => {
      const app: ManagedApp = {
        ...required(apps.get(target.projectId)),
        appInstanceId: null,
        state: 'stopped',
        url: null,
        cleanupConfirmed: true,
      };
      apps.set(target.projectId, app);
      return app;
    },
    releaseAppBrowser: () => undefined,
    appGet: async (target) => ({
      ...required(apps.get(target.projectId)),
      state: 'stopped',
      url: null,
      appInstanceId: null,
      cleanupConfirmed: true,
    }),
    environmentsList: async () => [],
    registerSession: async () => undefined,
    send,
    cancel,
    registerResource: async () => undefined,
    releaseResource: async () => undefined,
    observe: unused,
    captureResource: unused,
    validateBrowserUrl: () => undefined,
    ensureBrowser: () => undefined,
    browserState: () => page,
    browserLayout: () => undefined,
    browserAction: () => undefined,
    hideBrowsers: () => undefined,
    terminalOpen: unused,
    terminalStop: unused,
    terminalWrite: unused,
    terminalResize: unused,
  };
  const baseline = vi.fn(async (_runId: string, _snapshot: AppSourceSnapshot, _signal: AbortSignal) => ({ baseTree }));
  const capture = vi.fn(async (_runId: string, _baseTree: string, _snapshot: AppSourceSnapshot, _signal: AbortSignal) =>
    structuredClone(captured),
  );
  const save = vi.fn(async (snapshot: WorkbenchSnapshot) => {
    saved = structuredClone(snapshot);
  });
  const repository: WorkbenchRepository = {
    migrationPending: false,
    load: async () => structuredClone(saved),
    loadCatalog: catalogForTestSnapshot,
    save,
    appendObservation: unused,
    createSourceBaseline: baseline,
    captureSourceChange: capture,
    readRunPatch: async () => patch,
  };
  const app = new WorkbenchApplication(repository, runtime, vi.fn());
  await app.getSnapshot();
  return { app, runtime, repository, apps, send, snapshots, baseline, capture, save, resolveHarness, turns, saved: () => saved };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const commandOn =
  (application: WorkbenchApplication) =>
  (data: Record<string, unknown>, workspaceId = 'taskflow-demo') =>
    application.command(WorkbenchCommandSchema.parse({ commandId: randomUUID(), workspaceId, ...data }));
const spaceOf = (snapshot: WorkbenchSnapshot, workspaceId = 'taskflow-demo') =>
  required(snapshot.workspaces.find((space) => space.workspaceId === workspaceId));
const sessionOf = (result: WorkbenchResult | WorkbenchSnapshot, sessionId: string, workspaceId = 'taskflow-demo') =>
  required(spaceOf('snapshot' in result ? result.snapshot : result, workspaceId).sessions.find((s) => s.sessionId === sessionId));

/** 在空间中创建并启动 App；返回会话、App 与两个网页资源（受管 App 页面、普通网页）。 */
async function prepare(f: Fixture, workspaceId = 'taskflow-demo') {
  const command = commandOn(f.app);
  if (workspaceId !== 'taskflow-demo') {
    expect((await command({ type: 'createWorkspace', name: workspaceId }, workspaceId)).ok).toBe(true);
    expect((await command({ type: 'createTab', kind: 'session', title: '独立会话' }, workspaceId)).ok).toBe(true);
  }
  expect((await command({ type: 'createApp' }, workspaceId)).ok).toBe(true);
  expect((await command({ type: 'startApp' }, workspaceId)).ok).toBe(true);
  const space = spaceOf(await f.app.getSnapshot(), workspaceId);
  const session = required(space.sessions[0]);
  const appPage = required(space.resources.find((resource) => resource.appProjectId));
  const plainPage = space.resources.find((resource) => resource.kind === 'web' && !resource.appProjectId) ?? null;
  const terminal = space.resources.find((resource) => resource.kind === 'terminal') ?? null;
  return { space, session, sessionId: session.sessionId, app: required(space.app), appPage, plainPage, terminal };
}
async function captureOn(f: Fixture, sessionId: string, resourceId: string, workspaceId = 'taskflow-demo', application = f.app) {
  const requestId = randomUUID();
  expect((await commandOn(application)({ type: 'captureContext', sessionId, resourceId, requestId }, workspaceId)).ok).toBe(true);
  const resource = required(spaceOf(await application.getSnapshot(), workspaceId).resources.find((item) => item.resourceId === resourceId));
  const captureId = randomUUID();
  application.onCapture(resourceId, pageCapture(captureId), resource.instanceId, resource.generation, requestId);
  await application.getSnapshot();
  expect(sessionOf(await application.getSnapshot(), sessionId, workspaceId).context?.captureId).toBe(captureId);
  return captureId;
}
const setProject = async (f: Fixture, sessionId: string, appId: string | null, workspaceId = 'taskflow-demo') =>
  expect((await commandOn(f.app)({ type: 'saveTaskProject', sessionId, appId }, workspaceId)).ok).toBe(true);
const finish = (f: Fixture, sessionId: string, application = f.app) => {
  const before = required(f.turns.get(sessionId));
  const conversation = { ...before, state: 'idle' as const, cleanupPending: false, seq: before.seq + 1 };
  f.turns.set(sessionId, conversation);
  application.onConversation(conversation);
};
const cwdOf = (projectId: string) => `/home/agent/workspace/.wsl-apps/${projectId}`;
function deferred<T>() {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    complete = resolve;
  });
  return {
    promise,
    resolve(value: T) {
      if (!complete) throw new Error('uninitialized fixture promise');
      complete(value);
    },
  };
}

describe('session project selection (R5, O05e)', () => {
  it('stores {appId, projectId} only for the App of the session’s own space and persists it as a decision', async () => {
    const f = await fixture();
    const p = await prepare(f);
    const other = await prepare(f, 'other-space');
    const command = commandOn(f.app);
    const saves = f.save.mock.calls.length;
    const bound = await command({ type: 'saveTaskProject', sessionId: p.sessionId, appId: p.app.appId });
    expect(bound.ok).toBe(true);
    expect(sessionOf(bound, p.sessionId)).toMatchObject({
      taskProject: { appId: p.app.appId, projectId: p.app.projectId },
      taskProjectDecided: true,
    });
    expect(f.save.mock.calls.length).toBe(saves + 1);
    expect(sessionOf(required(f.saved()), p.sessionId).taskProject).toEqual({ appId: p.app.appId, projectId: p.app.projectId });
    // 他空间 App 与不存在的 appId 都以 conflict 拒绝；选择不变，不写持久化。
    for (const appId of [other.app.appId, randomUUID()]) {
      const before = f.save.mock.calls.length;
      const rejected = await command({ type: 'saveTaskProject', sessionId: p.sessionId, appId });
      expect(rejected).toMatchObject({ ok: false, error: { code: 'conflict' } });
      expect(sessionOf(rejected, p.sessionId).taskProject).toEqual({ appId: p.app.appId, projectId: p.app.projectId });
      expect(f.save.mock.calls.length).toBe(before);
    }
    // 会话必须属于命令所在空间：用本空间 App 也不能改他空间会话。
    const crossSpace = await command({ type: 'saveTaskProject', sessionId: other.sessionId, appId: p.app.appId });
    expect(crossSpace).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(sessionOf(crossSpace, other.sessionId, 'other-space')).toMatchObject({ taskProject: null, taskProjectDecided: false });
    // 关闭开关也是决定；再次开启只需同一个 appId。
    const off = await command({ type: 'saveTaskProject', sessionId: p.sessionId, appId: null });
    expect(sessionOf(off, p.sessionId)).toMatchObject({ taskProject: null, taskProjectDecided: true });
    const on = await command({ type: 'saveTaskProject', sessionId: p.sessionId, appId: p.app.appId });
    expect(sessionOf(on, p.sessionId).taskProject).toEqual({ appId: p.app.appId, projectId: p.app.projectId });
  });
  it('auto-enables on the first App-page capture in the same write, never after an explicit off, and ordinary captures do not change it', async () => {
    const f = await fixture();
    const p = await prepare(f);
    const command = commandOn(f.app);
    // 普通网页采集：仍未决定、未开启。
    await captureOn(f, p.sessionId, required(p.plainPage).resourceId);
    expect(sessionOf(await f.app.getSnapshot(), p.sessionId)).toMatchObject({ taskProject: null, taskProjectDecided: false });
    // 首次采集受管 App 页面：与采集结果在同一次持久化里开启工程。
    const captureId = await captureOn(f, p.sessionId, p.appPage.resourceId);
    const persisted = sessionOf(required(f.saved()), p.sessionId);
    expect(persisted.context?.captureId).toBe(captureId);
    expect(persisted).toMatchObject({ taskProject: { appId: p.app.appId, projectId: p.app.projectId }, taskProjectDecided: true });
    // 普通网页采集与移除引用不清空已开启的工程。
    await captureOn(f, p.sessionId, required(p.plainPage).resourceId);
    expect((await command({ type: 'saveTaskTarget', sessionId: p.sessionId, targetRef: null })).ok).toBe(true);
    expect(sessionOf(await f.app.getSnapshot(), p.sessionId).taskProject?.appId).toBe(p.app.appId);
    // 用户显式关闭后，再次采集 App 页面不重新开启；重启后同样。
    await setProject(f, p.sessionId, null);
    await captureOn(f, p.sessionId, p.appPage.resourceId);
    expect(sessionOf(await f.app.getSnapshot(), p.sessionId)).toMatchObject({ taskProject: null, taskProjectDecided: true });
    const restored = new WorkbenchApplication(f.repository, f.runtime, vi.fn());
    await restored.getSnapshot();
    expect((await commandOn(restored)({ type: 'startApp' })).ok).toBe(true);
    await captureOn(f, p.sessionId, p.appPage.resourceId, 'taskflow-demo', restored);
    expect(sessionOf(await restored.getSnapshot(), p.sessionId)).toMatchObject({ taskProject: null, taskProjectDecided: true });
    // 其他从未决定的会话仍会在首次采集 App 页面时自动开启。
    const created = await command({ type: 'createTab', kind: 'session', title: '新会话' });
    const fresh = required(spaceOf(created.snapshot).sessions.at(-1));
    await captureOn(f, fresh.sessionId, p.appPage.resourceId);
    expect(sessionOf(await f.app.getSnapshot(), fresh.sessionId).taskProject?.appId).toBe(p.app.appId);
  });
  it('keeps the project when the page reference is removed or an ordinary page is captured', async () => {
    const f = await fixture();
    const p = await prepare(f);
    const command = commandOn(f.app);
    const appCapture = await captureOn(f, p.sessionId, p.appPage.resourceId);
    expect(sessionOf(await f.app.getSnapshot(), p.sessionId).taskProject?.appId).toBe(p.app.appId);
    expect(
      (await command({ type: 'saveTaskTarget', sessionId: p.sessionId, targetRef: { kind: 'web', resourceId: p.appPage.resourceId } })).ok,
    ).toBe(true);
    const removed = await command({ type: 'saveTaskTarget', sessionId: p.sessionId, targetRef: null });
    expect(sessionOf(removed, p.sessionId).taskTargetRef).toBeNull();
    expect(sessionOf(removed, p.sessionId).taskProject).toEqual({ appId: p.app.appId, projectId: p.app.projectId });
    // 移除引用不删除已保存的采集证据。
    expect(sessionOf(removed, p.sessionId).context?.captureId).toBe(appCapture);
    await captureOn(f, p.sessionId, required(p.plainPage).resourceId);
    expect(sessionOf(await f.app.getSnapshot(), p.sessionId).taskProject).toEqual({ appId: p.app.appId, projectId: p.app.projectId });
    // 发送时没有页面引用：版本有工程绑定，没有页面证据。
    const confirmed = await command({
      type: 'confirmTask',
      sessionId: p.sessionId,
      goal: '只改工程',
      targetRef: null,
      appId: p.app.appId,
      captureId: null,
    });
    expect(confirmed.ok).toBe(true);
    expect(required(sessionOf(confirmed, p.sessionId).taskVersions.at(-1))).toMatchObject({
      targetRef: null,
      capture: null,
      captureBinding: null,
      appTarget: { ...p.app, guestCwd: cwdOf(p.app.projectId) },
    });
  });
});

describe('confirmTask freezes the visible project and page reference (O05c, O05f)', () => {
  it('binds project-without-page to the project write registration and source baseline/diff, like a page-bound task', async () => {
    const f = await fixture();
    const p = await prepare(f);
    const command = commandOn(f.app);
    const selection = { harnessId: 'claude-code', profileId: '40000000-0000-4000-8000-000000000001' };
    expect((await command({ type: 'setSessionHarness', sessionId: p.sessionId, selection })).ok).toBe(true);
    await setProject(f, p.sessionId, p.app.appId);
    const confirmed = await command({
      type: 'confirmTask',
      sessionId: p.sessionId,
      goal: '修改按钮文字',
      targetRef: null,
      appId: p.app.appId,
      captureId: null,
    });
    expect(confirmed.ok).toBe(true);
    const version = required(sessionOf(confirmed, p.sessionId).taskVersions.at(-1));
    expect(version.appTarget).toEqual({ ...p.app, guestCwd: cwdOf(p.app.projectId) });
    expect(version.capture).toBeNull();
    expect(version.targetRef).toBeNull();
    expect((await command({ type: 'startRun', sessionId: p.sessionId, taskVersionId: version.taskVersionId })).ok).toBe(true);
    // 源码基线在派发模型前采集并保存，目标是该空间的工程。
    expect(f.snapshots).toHaveBeenCalledOnce();
    expect(required(f.snapshots.mock.calls[0])[0]).toEqual({ workspaceId: 'taskflow-demo', projectId: p.app.projectId });
    expect(f.baseline.mock.invocationCallOrder[0]).toBeLessThan(required(f.send.mock.invocationCallOrder[0]));
    const run = required(spaceOf(await f.app.getSnapshot()).runs.at(-1));
    expect(run.sourceChange).toEqual({ state: 'baseline', baseTree });
    expect(required(f.send.mock.calls[0])[1]).toContain(cwdOf(p.app.projectId));
    // W4（O13b）：Profile 选择按会话解析并冻结进执行记录。
    expect(f.resolveHarness).toHaveBeenLastCalledWith(selection);
    expect(run.harness).toEqual(CODEX_TEST_REF);
    // 项目写入登记生效：同一工程的另一会话在本次执行结束前不能开始。
    const second = await command({ type: 'createTab', kind: 'session', title: '第二会话' });
    const secondSession = required(spaceOf(second.snapshot).sessions.at(-1));
    await setProject(f, secondSession.sessionId, p.app.appId);
    const secondVersion = await command({
      type: 'confirmTask',
      sessionId: secondSession.sessionId,
      goal: '同工程另一任务',
      targetRef: null,
      appId: p.app.appId,
      captureId: null,
    });
    const blocked = await command({
      type: 'startRun',
      sessionId: secondSession.sessionId,
      taskVersionId: required(sessionOf(secondVersion, secondSession.sessionId).taskVersions[0]).taskVersionId,
    });
    expect(blocked).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('同项目') } });
    // 执行结束后采集结束源码，diff 可读。
    finish(f, p.sessionId);
    await vi.waitFor(async () => expect(required(spaceOf(await f.app.getSnapshot()).runs.at(-1)).sourceChange).toEqual(captured));
    expect(await f.app.runPatch('taskflow-demo', run.runId)).toMatchObject({ runId: run.runId, patch });
    expect(f.capture).toHaveBeenCalledOnce();
  });
  it('allows a project together with an ordinary page capture or a terminal target, and keeps them valid for recovery', async () => {
    const f = await fixture();
    const p = await prepare(f);
    const command = commandOn(f.app);
    await setProject(f, p.sessionId, p.app.appId);
    const plain = required(p.plainPage);
    const captureId = await captureOn(f, p.sessionId, plain.resourceId);
    const withPage = await command({
      type: 'confirmTask',
      sessionId: p.sessionId,
      goal: '参考文档页改工程',
      targetRef: { kind: 'web', resourceId: plain.resourceId },
      appId: p.app.appId,
      captureId,
    });
    expect(withPage.ok).toBe(true);
    expect(required(sessionOf(withPage, p.sessionId).taskVersions.at(-1))).toMatchObject({
      targetRef: { kind: 'web', resourceId: plain.resourceId },
      capture: { captureId },
      appTarget: { appId: p.app.appId, projectId: p.app.projectId, guestCwd: cwdOf(p.app.projectId) },
    });
    const terminal = required(p.terminal);
    const withTerminal = await command({
      type: 'confirmTask',
      sessionId: p.sessionId,
      goal: '在终端里验证工程',
      targetRef: { kind: 'terminal', resourceId: terminal.resourceId },
      appId: p.app.appId,
      captureId: null,
    });
    expect(withTerminal.ok).toBe(true);
    expect(required(sessionOf(withTerminal, p.sessionId).taskVersions.at(-1))).toMatchObject({
      capture: null,
      appTarget: { projectId: p.app.projectId },
    });
    expect(() => validateSnapshot(required(f.saved()))).not.toThrow();
    const restored = new WorkbenchApplication(f.repository, f.runtime, vi.fn());
    expect(sessionOf(await restored.getSnapshot(), p.sessionId).taskVersions).toHaveLength(2);
  });
  it('without a project, the same task has no source evidence (the binding is what drives it)', async () => {
    const f = await fixture();
    const p = await prepare(f);
    const command = commandOn(f.app);
    const confirmed = await command({
      type: 'confirmTask',
      sessionId: p.sessionId,
      goal: '无工程',
      targetRef: null,
      appId: null,
      captureId: null,
    });
    const version = required(sessionOf(confirmed, p.sessionId).taskVersions.at(-1));
    expect(version.appTarget).toBeNull();
    expect((await command({ type: 'startRun', sessionId: p.sessionId, taskVersionId: version.taskVersionId })).ok).toBe(true);
    expect(required(spaceOf(await f.app.getSnapshot()).runs.at(-1)).sourceChange).toMatchObject({ state: 'unavailable' });
    expect(f.snapshots).not.toHaveBeenCalled();
  });
  it('freezes the page evidence with the project; an App-page reference with the project off is rejected, never run without it', async () => {
    const f = await fixture();
    const p = await prepare(f);
    const command = commandOn(f.app);
    const captureId = await captureOn(f, p.sessionId, p.appPage.resourceId);
    const targetRef = { kind: 'web', resourceId: p.appPage.resourceId };
    const withProject = await command({
      type: 'confirmTask',
      sessionId: p.sessionId,
      goal: '改页面',
      targetRef,
      appId: p.app.appId,
      captureId,
    });
    expect(withProject.ok).toBe(true);
    const version = required(sessionOf(withProject, p.sessionId).taskVersions.at(-1));
    expect(version.capture?.captureId).toBe(captureId);
    expect(version.captureBinding).not.toBeNull();
    expect(version.appTarget?.projectId).toBe(p.app.projectId);
    // 用户关闭工程后仍引用 App 页面：不兼容的引用不能静默沿用，以 conflict 拒绝并保留草稿。
    expect((await command({ type: 'saveDraft', sessionId: p.sessionId, draft: '只看页面' })).ok).toBe(true);
    await setProject(f, p.sessionId, null);
    const saves = f.save.mock.calls.length;
    const rejected = await command({ type: 'confirmTask', sessionId: p.sessionId, goal: '只看页面', targetRef, appId: null, captureId });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('引用的是 App 页面') } });
    expect(sessionOf(rejected, p.sessionId).taskVersions).toHaveLength(1);
    expect(sessionOf(rejected, p.sessionId).draft).toBe('只看页面');
    expect(f.save.mock.calls.length).toBe(saves);

    // 历史记录里“App 页面、无工程”的版本（重启前写入）：startRun 拒绝，不从页面补推工程，不采集源码、不派发。
    const legacy = structuredClone(required(f.saved()));
    required(sessionOf(legacy, p.sessionId).taskVersions[0]).appTarget = null;
    expect(() => validateSnapshot(legacy)).not.toThrow();
    const restored = new WorkbenchApplication({ ...f.repository, load: async () => structuredClone(legacy) }, f.runtime, vi.fn());
    await restored.getSnapshot();
    const started = await commandOn(restored)({ type: 'startRun', sessionId: p.sessionId, taskVersionId: version.taskVersionId });
    expect(started).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('引用的是 App 页面') } });
    expect(spaceOf(await restored.getSnapshot()).runs).toEqual([]);
    expect(f.snapshots).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('rejects confirming a project whose App has no guest working directory with conflict 「App 尚未启动」 and keeps the draft', async () => {
    const f = await fixture({ guestCwd: () => '' });
    const p = await prepare(f);
    const command = commandOn(f.app);
    expect((await command({ type: 'saveDraft', sessionId: p.sessionId, draft: '保留这段草稿' })).ok).toBe(true);
    await setProject(f, p.sessionId, p.app.appId);
    const saves = f.save.mock.calls.length;
    const rejected = await command({
      type: 'confirmTask',
      sessionId: p.sessionId,
      goal: '保留这段草稿',
      targetRef: null,
      appId: p.app.appId,
      captureId: null,
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('App 尚未启动') } });
    const session = sessionOf(rejected, p.sessionId);
    expect(session.draft).toBe('保留这段草稿');
    expect(session.taskVersions).toEqual([]);
    expect(session.taskProject).toEqual({ appId: p.app.appId, projectId: p.app.projectId });
    expect(f.save.mock.calls.length).toBe(saves);
  });
  it('refuses a guest working directory outside the managed workspace at confirm and in recovery', async () => {
    const f = await fixture({ guestCwd: () => '/etc' });
    const p = await prepare(f);
    const command = commandOn(f.app);
    await setProject(f, p.sessionId, p.app.appId);
    const rejected = await command({
      type: 'confirmTask',
      sessionId: p.sessionId,
      goal: '越界目录',
      targetRef: null,
      appId: p.app.appId,
      captureId: null,
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'denied', message: expect.stringContaining('受管工作区') } });
    expect(sessionOf(rejected, p.sessionId).taskVersions).toEqual([]);
    // 篡改过的持久记录（App 与任务版本都指向 /etc）在恢复校验时被拒绝。
    const crafted = structuredClone(required(f.saved()));
    const space = spaceOf(crafted);
    sessionOf(crafted, p.sessionId).taskVersions.push({
      taskVersionId: randomUUID(),
      version: 1,
      workspaceId: space.workspaceId,
      sessionId: p.sessionId,
      goal: '篡改',
      targetRef: null,
      capture: null,
      appTarget: { ...p.app, guestCwd: '/etc' },
      captureBinding: null,
      confirmedAt: '2026-10-23T00:00:00.000Z',
      acceptance: [],
      allowedScopes: [],
    });
    expect(() => validateSnapshot(crafted)).toThrow('受管工作区');
  });
  it('cross-checks appId against the session’s persisted project switch (remove-then-send race)', async () => {
    const f = await fixture();
    const p = await prepare(f);
    const command = commandOn(f.app);
    await setProject(f, p.sessionId, p.app.appId);
    await setProject(f, p.sessionId, null);
    const stale = await command({
      type: 'confirmTask',
      sessionId: p.sessionId,
      goal: '旧渲染',
      targetRef: null,
      appId: p.app.appId,
      captureId: null,
    });
    expect(stale).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('工程开关已变化') } });
    await setProject(f, p.sessionId, p.app.appId);
    const staleOff = await command({
      type: 'confirmTask',
      sessionId: p.sessionId,
      goal: '旧渲染',
      targetRef: null,
      appId: null,
      captureId: null,
    });
    expect(staleOff).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('工程开关已变化') } });
    expect(sessionOf(staleOff, p.sessionId).taskVersions).toEqual([]);
  });
  it('rejects forged or foreign appId and foreign, stale or mismatched captureId without any version, registration or persistence (O05f)', async () => {
    const f = await fixture();
    const p = await prepare(f);
    const other = await prepare(f, 'other-space');
    const command = commandOn(f.app);
    expect((await command({ type: 'createWorkspace', name: '无 App 空间' }, 'bare-space')).ok).toBe(true);
    const bareTab = await command({ type: 'createTab', kind: 'session', title: '空会话' }, 'bare-space');
    const bareSession = required(spaceOf(bareTab.snapshot, 'bare-space').sessions[0]);
    const helper = await command({ type: 'createTab', kind: 'session', title: '另一会话' });
    const neighbour = required(spaceOf(helper.snapshot).sessions.at(-1));
    const neighbourCapture = await captureOn(f, neighbour.sessionId, p.appPage.resourceId);
    const staleCapture = await captureOn(f, p.sessionId, p.appPage.resourceId);
    const currentCapture = await captureOn(f, p.sessionId, p.appPage.resourceId);
    const web = { kind: 'web', resourceId: p.appPage.resourceId };
    const cases: Array<[Record<string, unknown>, string, string?]> = [
      [{ targetRef: null, appId: other.app.appId, captureId: null }, 'conflict'],
      [{ targetRef: null, appId: randomUUID(), captureId: null }, 'conflict'],
      // 没有 App 的空间收到非空 appId 也拒绝，不静默忽略。
      [{ targetRef: null, appId: p.app.appId, captureId: null, sessionId: bareSession.sessionId }, 'conflict', 'bare-space'],
      [{ targetRef: web, appId: p.app.appId, captureId: neighbourCapture }, 'denied'],
      [{ targetRef: web, appId: p.app.appId, captureId: staleCapture }, 'conflict'],
      [{ targetRef: web, appId: p.app.appId, captureId: randomUUID() }, 'conflict'],
      [{ targetRef: null, appId: p.app.appId, captureId: currentCapture }, 'invalid_input'],
      [
        { targetRef: { kind: 'web', resourceId: required(p.plainPage).resourceId }, appId: p.app.appId, captureId: currentCapture },
        'invalid_input',
      ],
      // 网页目标必须带当前有效的页面引用，不能静默沿用会话里的采集。
      [{ targetRef: web, appId: p.app.appId, captureId: null }, 'conflict'],
    ];
    for (const [input, code, workspaceId = 'taskflow-demo'] of cases) {
      const saves = f.save.mock.calls.length;
      const sessionId = typeof input['sessionId'] === 'string' ? input['sessionId'] : p.sessionId;
      const rejected = await command({ type: 'confirmTask', sessionId, goal: '伪造', ...input }, workspaceId);
      expect(rejected, JSON.stringify(input)).toMatchObject({ ok: false, error: { code } });
      expect(sessionOf(rejected, sessionId, workspaceId).taskVersions).toEqual([]);
      expect(f.save.mock.calls.length).toBe(saves);
    }
    // 以上都没有登记项目写入：同工程的执行仍可开始。
    const ok = await command({
      type: 'confirmTask',
      sessionId: p.sessionId,
      goal: '真实',
      targetRef: web,
      appId: p.app.appId,
      captureId: currentCapture,
    });
    expect(ok.ok).toBe(true);
    const version = required(sessionOf(ok, p.sessionId).taskVersions.at(-1));
    expect((await command({ type: 'startRun', sessionId: p.sessionId, taskVersionId: version.taskVersionId })).ok).toBe(true);
    expect(f.snapshots).toHaveBeenCalledOnce();
  });
  it('validateSnapshot refuses a frozen project whose App-page target belongs to another project, and autoTitle on non-web tabs', async () => {
    const f = await fixture();
    const p = await prepare(f);
    const command = commandOn(f.app);
    const captureId = await captureOn(f, p.sessionId, p.appPage.resourceId);
    expect(
      (
        await command({
          type: 'confirmTask',
          sessionId: p.sessionId,
          goal: '页面',
          targetRef: { kind: 'web', resourceId: p.appPage.resourceId },
          appId: p.app.appId,
          captureId,
        })
      ).ok,
    ).toBe(true);
    const saved = required(f.saved());
    expect(() => validateSnapshot(saved)).not.toThrow();
    const otherProject = structuredClone(saved);
    required(spaceOf(otherProject).resources.find((resource) => resource.resourceId === p.appPage.resourceId)).appProjectId = randomUUID();
    expect(() => validateSnapshot(otherProject)).toThrow('任务 App 工程与目标不匹配');
    const titled = structuredClone(saved);
    required(spaceOf(titled).tabs.find((tab) => tab.targetRef.kind === 'session')).autoTitle = true;
    expect(() => validateSnapshot(titled)).toThrow('只有网页标签');
    const undecided = structuredClone(saved);
    sessionOf(undecided, p.sessionId).taskProjectDecided = false;
    expect(() => validateSnapshot(undecided)).toThrow('决定记录');
  });
});

describe('startRun admission for project-bound versions (boundary F1, F3; W4 S6)', () => {
  it.each(['stopApp', 'startApp'] as const)(
    'refuses a project-only run while %s is in flight, before any side effect',
    async (operation) => {
      const f = await fixture();
      const p = await prepare(f);
      const command = commandOn(f.app);
      await setProject(f, p.sessionId, p.app.appId);
      const confirmed = await command({
        type: 'confirmTask',
        sessionId: p.sessionId,
        goal: '构建中',
        targetRef: null,
        appId: p.app.appId,
        captureId: null,
      });
      const version = required(sessionOf(confirmed, p.sessionId).taskVersions.at(-1));
      if (operation === 'startApp') expect((await command({ type: 'stopApp' })).ok).toBe(true);
      const gate = deferred<ManagedApp>();
      const method = operation === 'stopApp' ? 'appStop' : 'appStart';
      const original = f.runtime[method];
      if (!original) throw new Error('fixture runtime lacks ' + method);
      f.runtime[method] = () => gate.promise;
      const pending = command({ type: operation });
      await vi.waitFor(async () =>
        expect(spaceOf(await f.app.currentSnapshot()).managedApp?.state).toBe(operation === 'stopApp' ? 'stopping' : 'starting'),
      );
      const blocked = await command({ type: 'startRun', sessionId: p.sessionId, taskVersionId: version.taskVersionId });
      expect(blocked).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('App 正在启动或停止') } });
      expect(f.snapshots).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
      gate.resolve(await original({ workspaceId: 'taskflow-demo', projectId: p.app.projectId }));
      expect((await pending).ok).toBe(true);
      expect(spaceOf(await f.app.getSnapshot()).runs).toEqual([]);
    },
  );
  it('does not trust the persisted guestCwd after an unconfirmed App restore until the service reports the App again', async () => {
    const f = await fixture();
    const p = await prepare(f);
    const command = commandOn(f.app);
    await setProject(f, p.sessionId, p.app.appId);
    const confirmed = await command({
      type: 'confirmTask',
      sessionId: p.sessionId,
      goal: '恢复后',
      targetRef: null,
      appId: p.app.appId,
      captureId: null,
    });
    const version = required(sessionOf(confirmed, p.sessionId).taskVersions.at(-1));
    const appGet = f.runtime.appGet;
    f.runtime.appGet = async () => {
      throw new Error('service restarted without the project');
    };
    const restored = new WorkbenchApplication(f.repository, f.runtime, vi.fn());
    const snapshot = await restored.getSnapshot();
    expect(spaceOf(snapshot).managedApp).toMatchObject({ state: 'failed', cleanupConfirmed: false, guestCwd: cwdOf(p.app.projectId) });
    const blocked = await commandOn(restored)({ type: 'startRun', sessionId: p.sessionId, taskVersionId: version.taskVersionId });
    expect(blocked).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('App 恢复未确认') } });
    expect(spaceOf(await restored.getSnapshot()).runs).toEqual([]);
    expect(f.snapshots).not.toHaveBeenCalled();
    // 服务重新报告 App（启动成功）后，冻结的 guestCwd 与服务事实一致，可以执行。
    f.runtime.appGet = appGet;
    expect((await commandOn(restored)({ type: 'startApp' })).ok).toBe(true);
    expect((await commandOn(restored)({ type: 'startRun', sessionId: p.sessionId, taskVersionId: version.taskVersionId })).ok).toBe(true);
    expect(f.snapshots).toHaveBeenCalledOnce();
  });
  it('leaks no project write registration when the Profile is busy or not logged in', async () => {
    const f = await fixture();
    const p = await prepare(f);
    const other = await prepare(f, 'other-space');
    const command = commandOn(f.app);
    // 另一空间、另一工程占用同一 Profile。
    await setProject(f, other.sessionId, other.app.appId, 'other-space');
    const busyVersion = await command(
      { type: 'confirmTask', sessionId: other.sessionId, goal: '占用 Profile', targetRef: null, appId: other.app.appId, captureId: null },
      'other-space',
    );
    const busyId = required(sessionOf(busyVersion, other.sessionId, 'other-space').taskVersions.at(-1)).taskVersionId;
    expect((await command({ type: 'startRun', sessionId: other.sessionId, taskVersionId: busyId }, 'other-space')).ok).toBe(true);
    await setProject(f, p.sessionId, p.app.appId);
    const confirmed = await command({
      type: 'confirmTask',
      sessionId: p.sessionId,
      goal: '本工程',
      targetRef: null,
      appId: p.app.appId,
      captureId: null,
    });
    const version = required(sessionOf(confirmed, p.sessionId).taskVersions.at(-1));
    const busy = await command({ type: 'startRun', sessionId: p.sessionId, taskVersionId: version.taskVersionId });
    expect(busy).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('codex:default') } });
    // 被拒绝的启动没有登记本工程写入：Profile 空出后同一版本直接开始，不报“同项目”。
    finish(f, other.sessionId);
    await vi.waitFor(async () => expect(required(spaceOf(await f.app.getSnapshot(), 'other-space').runs.at(-1)).state).toBe('completed'));
    // 启动前自检未登录：执行失败，之后同一工程仍可再次开始（登记已释放）。
    f.runtime.prepareHarness = vi.fn(async () => {
      throw new Error('Profile「默认」未登录：请登录后重新自检');
    });
    expect((await command({ type: 'startRun', sessionId: p.sessionId, taskVersionId: version.taskVersionId })).ok).toBe(true);
    await vi.waitFor(async () => expect(required(spaceOf(await f.app.getSnapshot()).runs.at(-1)).state).toBe('failed'));
    f.runtime.prepareHarness = async () => undefined;
    const retried = await command({ type: 'startRun', sessionId: p.sessionId, taskVersionId: version.taskVersionId });
    expect(retried.ok).toBe(true);
    expect(required(spaceOf(await f.app.getSnapshot()).runs.at(-1)).sourceChange).toEqual({ state: 'baseline', baseTree });
  });
});

describe('recovery and re-run of project-bound versions (O05d, O05b)', () => {
  it('accepts project-without-page across restart, and blocks execution when the project identity is no longer valid', async () => {
    const f = await fixture();
    const p = await prepare(f);
    const command = commandOn(f.app);
    await setProject(f, p.sessionId, p.app.appId);
    const confirmed = await command({
      type: 'confirmTask',
      sessionId: p.sessionId,
      goal: '重启后',
      targetRef: null,
      appId: p.app.appId,
      captureId: null,
    });
    const version = required(sessionOf(confirmed, p.sessionId).taskVersions.at(-1));
    const saved = required(f.saved());
    // 恢复不变量接受“有工程、无页面”；伪造的工程身份仍被拒绝。
    expect(() => validateSnapshot(saved)).not.toThrow();
    const forgedVersion = structuredClone(saved);
    required(required(sessionOf(forgedVersion, p.sessionId).taskVersions.at(-1)).appTarget).appId = randomUUID();
    expect(() => validateSnapshot(forgedVersion)).toThrow('任务 App 工程');
    const forgedSelection = structuredClone(saved);
    sessionOf(forgedSelection, p.sessionId).taskProject = { appId: randomUUID(), projectId: p.app.projectId };
    expect(() => validateSnapshot(forgedSelection)).toThrow('会话工程');

    const restored = new WorkbenchApplication(f.repository, f.runtime, vi.fn());
    const afterRestart = await restored.getSnapshot();
    expect(sessionOf(afterRestart, p.sessionId)).toMatchObject({
      taskProject: { appId: p.app.appId, projectId: p.app.projectId },
      taskProjectDecided: true,
    });
    expect(required(sessionOf(afterRestart, p.sessionId).taskVersions.at(-1)).appTarget).toEqual(version.appTarget);
    const restart = commandOn(restored);
    expect((await restart({ type: 'startRun', sessionId: p.sessionId, taskVersionId: version.taskVersionId })).ok).toBe(true);
    expect(f.snapshots).toHaveBeenCalledOnce();
    expect(required(spaceOf(await restored.getSnapshot()).runs.at(-1)).sourceChange).toEqual({ state: 'baseline', baseTree });
    finish(f, p.sessionId, restored);
    await vi.waitFor(async () => expect(required(spaceOf(await restored.getSnapshot()).runs.at(-1)).sourceChange).toEqual(captured));

    // 工程身份失效（App 的 guest 工作目录已变化）：在创建执行记录前以明确错误阻止，不降级为无工程运行。
    f.apps.set(p.app.projectId, { ...required(f.apps.get(p.app.projectId)), guestCwd: '/moved/elsewhere' });
    const moved = new WorkbenchApplication({ ...f.repository, load: async () => structuredClone(saved) }, f.runtime, vi.fn());
    const movedSnapshot = await moved.getSnapshot();
    const runsBefore = spaceOf(movedSnapshot).runs.length;
    const sends = f.send.mock.calls.length;
    const blocked = await commandOn(moved)({ type: 'startRun', sessionId: p.sessionId, taskVersionId: version.taskVersionId });
    expect(blocked).toMatchObject({ ok: false, error: { code: 'conflict', message: expect.stringContaining('工程身份已失效') } });
    expect(spaceOf(await moved.getSnapshot()).runs).toHaveLength(runsBefore);
    expect(f.send.mock.calls.length).toBe(sends);
    // 只有重启后那一次执行的基线与结束采集：被阻止的启动没有采集源码。
    expect(f.snapshots).toHaveBeenCalledTimes(2);
  });
  it('re-running a confirmed version keeps its frozen project even after the draft selection is turned off', async () => {
    const f = await fixture();
    const p = await prepare(f);
    const command = commandOn(f.app);
    await setProject(f, p.sessionId, p.app.appId);
    const confirmed = await command({
      type: 'confirmTask',
      sessionId: p.sessionId,
      goal: '首次',
      targetRef: null,
      appId: p.app.appId,
      captureId: null,
    });
    const version = required(sessionOf(confirmed, p.sessionId).taskVersions.at(-1));
    expect((await command({ type: 'startRun', sessionId: p.sessionId, taskVersionId: version.taskVersionId })).ok).toBe(true);
    finish(f, p.sessionId);
    await vi.waitFor(async () => expect(required(spaceOf(await f.app.getSnapshot()).runs.at(-1)).sourceChange).toEqual(captured));
    await setProject(f, p.sessionId, null);
    expect((await command({ type: 'startRun', sessionId: p.sessionId, taskVersionId: version.taskVersionId })).ok).toBe(true);
    const rerun = required(spaceOf(await f.app.getSnapshot()).runs.at(-1));
    expect(rerun.taskVersionId).toBe(version.taskVersionId);
    expect(rerun.sourceChange).toEqual({ state: 'baseline', baseTree });
    expect(f.snapshots).toHaveBeenCalledTimes(3);
    expect(sessionOf(await f.app.getSnapshot(), p.sessionId).taskVersions).toHaveLength(1);
  });
});

/*
 * OPS-1 B3（S1 / S2 界面部分在 Main 的落点）：采集完成即把该网页设为本会话的任务目标（修正 F3a），与采集结果同一次写入；
 * 协议仍只有一个任务目标（§9.1）：之后在任务设置中改选文件 / 终端 / SSH 目标会替换页面引用，再次采集又替换设置中的目标。
 * 自动新建的接收会话以 `createTab { activate: false }` 创建，不改变布局。
 */
describe('OPS-1 B3：采集即任务目标、单一目标与不占用窗格的新建', () => {
  it('采集完成在同一次写入中把网页设为任务目标，替换设置中的终端目标；改选终端再替换页面引用，证据与工程保留', async () => {
    const f = await fixture();
    const p = await prepare(f);
    const command = commandOn(f.app);
    const terminal = { kind: 'terminal' as const, resourceId: required(p.terminal).resourceId };
    expect((await command({ type: 'saveTaskTarget', sessionId: p.sessionId, targetRef: terminal })).ok).toBe(true);
    const captureId = await captureOn(f, p.sessionId, p.appPage.resourceId);
    const persisted = sessionOf(required(f.saved()), p.sessionId);
    expect(persisted.taskTargetRef).toEqual({ kind: 'web', resourceId: p.appPage.resourceId });
    expect(persisted.context?.captureId).toBe(captureId);
    expect((await command({ type: 'saveTaskTarget', sessionId: p.sessionId, targetRef: terminal })).ok).toBe(true);
    const replaced = sessionOf(await f.app.getSnapshot(), p.sessionId);
    expect(replaced.taskTargetRef).toEqual(terminal);
    expect(replaced.context?.captureId).toBe(captureId);
    expect(replaced.taskProject?.appId).toBe(p.app.appId);
    // 再次采集（普通网页）又替换设置中的目标；工程不被普通网页采集清空。
    await captureOn(f, p.sessionId, required(p.plainPage).resourceId);
    const again = sessionOf(await f.app.getSnapshot(), p.sessionId);
    expect(again.taskTargetRef).toEqual({ kind: 'web', resourceId: required(p.plainPage).resourceId });
    expect(again.taskProject?.appId).toBe(p.app.appId);
  });
  it('取消、失败与迟到的采集回执不改变任务目标', async () => {
    const f = await fixture();
    const p = await prepare(f);
    const command = commandOn(f.app);
    const terminal = { kind: 'terminal' as const, resourceId: required(p.terminal).resourceId };
    expect((await command({ type: 'saveTaskTarget', sessionId: p.sessionId, targetRef: terminal })).ok).toBe(true);
    const resourceId = p.appPage.resourceId;
    const cancelled = randomUUID();
    expect((await command({ type: 'captureContext', sessionId: p.sessionId, resourceId, requestId: cancelled })).ok).toBe(true);
    // 网页实例在第一次采集时建立；之后读取它的实例身份。
    const live = required(spaceOf(await f.app.getSnapshot()).resources.find((item) => item.resourceId === resourceId));
    const resource = () => live;
    expect((await command({ type: 'cancelCapture', resourceId, requestId: cancelled })).ok).toBe(true);
    // 取消之后才到的完成回执：请求已不在，不写证据也不改目标。
    f.app.onCapture(resourceId, pageCapture(randomUUID()), resource().instanceId, resource().generation, cancelled);
    const failed = randomUUID();
    expect((await command({ type: 'captureContext', sessionId: p.sessionId, resourceId, requestId: failed })).ok).toBe(true);
    f.app.onCaptureError(resourceId, failed, resource().instanceId, resource().generation, 'failed', '无法开始选择');
    const session = sessionOf(await f.app.getSnapshot(), p.sessionId);
    expect(session.taskTargetRef).toEqual(terminal);
    expect(session.context).toBeNull();
    expect(session.captureRequest).toMatchObject({ requestId: failed, state: 'failed' });
  });
  it('createTab { activate: false } 只新建标签，不改布局与活动窗格；缺省时仍在活动窗格打开', async () => {
    const f = await fixture();
    const command = commandOn(f.app);
    const before = spaceOf(await f.app.getSnapshot());
    const hidden = await command({ type: 'createTab', kind: 'session', title: 'TaskFlow 预览 · 会话', activate: false });
    expect(hidden.ok).toBe(true);
    const after = spaceOf(hidden.snapshot);
    const tab = required(after.tabs.at(-1));
    expect(tab).toMatchObject({ title: 'TaskFlow 预览 · 会话', targetRef: { kind: 'session' } });
    expect(after.layout).toEqual(before.layout);
    expect(after.activePaneId).toBe(before.activePaneId);
    expect(after.sessions.at(-1)?.title).toBe('TaskFlow 预览 · 会话');
    const shown = await command({ type: 'createTab', kind: 'session', title: '会话 2' });
    const visible = spaceOf(shown.snapshot);
    expect(visible.layout).toMatchObject({ kind: 'pane', tabId: required(visible.tabs.at(-1)).tabId });
    // 只接受布尔值；多余或错误类型的字段在 IPC 边界被拒绝。
    expect(() =>
      WorkbenchCommandSchema.parse({
        commandId: 'c',
        workspaceId: 'taskflow-demo',
        type: 'createTab',
        kind: 'session',
        title: 'x',
        activate: 'no',
      }),
    ).toThrow();
  });
});
