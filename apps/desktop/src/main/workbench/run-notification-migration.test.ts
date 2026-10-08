import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { ChatConversation, WorkbenchCommand, WorkbenchSnapshot } from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import { FileWorkbenchRepository } from './repository';
import type { WorkbenchRuntime } from './ports';
const conversation = (sessionId: string, turnId: string, seq: number, messages: ChatConversation['messages']): ChatConversation => ({
  conversationId: sessionId,
  generation: 'same-generation',
  seq,
  state: 'idle',
  turnId,
  threadId: 'thread',
  messages,
  toolExecutions: [],
  warnings: [],
  cleanupPending: false,
  error: null,
});
async function setup() {
  let saved: WorkbenchSnapshot | null = null;
  const repository = {
    load: async () => saved,
    save: async (snapshot: WorkbenchSnapshot) => {
      saved = structuredClone(snapshot);
    },
  };
  const runtime = {
    publicResourcesList: vi.fn().mockResolvedValue({ spaceId: 'taskflow-demo', revision: 0, resources: [] }),
    validateBrowserUrl: vi.fn(),
    registerSession: vi.fn(),
    send: vi.fn(),
    hideBrowsers: vi.fn(),
  } as unknown as WorkbenchRuntime;
  const app = new WorkbenchApplication(repository, runtime, vi.fn());
  const initial = await app.getSnapshot();
  const session = initial.workspaces[0]!.sessions[0]!;
  const command = (payload: Record<string, unknown>) =>
    app.command({ commandId: crypto.randomUUID(), workspaceId: 'taskflow-demo', ...payload } as WorkbenchCommand);
  await command({ type: 'confirmTask', sessionId: session.sessionId, goal: 'fixture', targetRef: null });
  const version = (await app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions[0]!;
  return { app, runtime, repository, command, session, version };
}
describe('run and notification identity', () => {
  it('extracts only the current turn from cumulative same-generation messages and tools', async () => {
    const { app, command, runtime, session, version } = await setup();
    const first = conversation(session.sessionId, 'one', 1, [
      { id: 'one', role: 'user', text: 'first request' },
      { id: 'one:reply', role: 'assistant', text: 'first reply' },
    ]);
    first.toolExecutions = [{ id: 'tool', turnId: 'one', command: 'first', output: 'first output', exitCode: 0, truncated: false }];
    const second = conversation(session.sessionId, 'two', 2, [
      ...first.messages,
      { id: 'two', role: 'user', text: 'second request' },
      { id: 'two:reply', role: 'assistant', text: 'second reply' },
    ]);
    second.toolExecutions = [
      ...first.toolExecutions,
      { id: 'tool', turnId: 'two', command: 'second', output: 'second output', exitCode: 0, truncated: false },
    ];
    vi.mocked(runtime.send).mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    await command({ type: 'startRun', sessionId: session.sessionId, taskVersionId: version.taskVersionId });
    await command({ type: 'startRun', sessionId: session.sessionId, taskVersionId: version.taskVersionId });
    const runs = (await app.getSnapshot()).workspaces[0]!.runs;
    expect(runs[0]!.conversation?.messages.map((m) => m.text)).toEqual(['first request', 'first reply']);
    expect(runs[1]!.conversation?.messages.map((m) => m.text)).toEqual(['second request', 'second reply']);
    expect(runs[1]!.conversation?.toolExecutions.map((tool) => tool.output)).toEqual(['second output']);
    expect(runs[1]!.executionBinding).toEqual({ generation: 'same-generation', turnId: 'two' });
  });
  it('keeps viewing, reading, validation and review separate and persists only notification receipts', async () => {
    const { app, command, runtime, session, version } = await setup();
    vi.mocked(runtime.send).mockResolvedValue(
      conversation(session.sessionId, 'one', 1, [{ id: 'one:reply', role: 'assistant', text: 'reply' }]),
    );
    await command({ type: 'startRun', sessionId: session.sessionId, taskVersionId: version.taskVersionId });
    const before = await app.getSnapshot();
    const run = before.workspaces[0]!.runs[0]!;
    const notification = before.notifications[0]!;
    await command({
      type: 'closeTab',
      tabId: before.workspaces[0]!.tabs.find((t) => t.targetRef.resourceId === session.resourceId)!.tabId,
    });
    await app.command({ type: 'createWorkspace', workspaceId: 'other', commandId: 'other', name: 'Other' });
    expect(
      (await command({ type: 'locateSession', sessionId: session.sessionId, taskVersionId: version.taskVersionId, runId: run.runId })).ok,
    ).toBe(true);
    let after = await app.getSnapshot();
    expect(after.activeWorkspaceId).toBe('taskflow-demo');
    expect(after.notifications[0]!.readAt).toBeNull();
    await command({ type: 'markNotificationRead', notificationId: notification.notificationId });
    after = await app.getSnapshot();
    expect(after.notifications[0]!.readAt).not.toBeNull();
    expect(runtime.send).toHaveBeenCalledOnce();
    expect(after.workspaces.find((w) => w.workspaceId === 'taskflow-demo')!.runs).toEqual(before.workspaces[0]!.runs);
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'wsl-notification-')), 'workbench.json');
    const repository = new FileWorkbenchRepository(file);
    await repository.save(after);
    const persisted = JSON.parse(await readFile(file, 'utf8')) as { snapshot: Record<string, unknown> };
    expect(persisted.snapshot).not.toHaveProperty('notifications');
    expect(persisted.snapshot.notificationReadReceipts).toEqual(after.notificationReadReceipts);
    const restored = new WorkbenchApplication(repository, runtime, vi.fn());
    expect((await restored.getSnapshot()).notifications[0]!.readAt).toBe(after.notifications[0]!.readAt);
    expect(runtime.send).toHaveBeenCalledOnce();
  });
  it('rejects a mismatched session/run locator without changing the active space', async () => {
    const { app, command, runtime, session, version } = await setup();
    vi.mocked(runtime.send).mockResolvedValue(conversation(session.sessionId, 'one', 1, []));
    await command({ type: 'startRun', sessionId: session.sessionId, taskVersionId: version.taskVersionId });
    const run = (await app.getSnapshot()).workspaces[0]!.runs[0]!;
    await app.command({ type: 'createWorkspace', workspaceId: 'other', commandId: 'other', name: 'Other' });
    const result = await command({
      type: 'locateSession',
      sessionId: session.sessionId,
      taskVersionId: 'not-this-version',
      runId: run.runId,
    });
    expect(result.ok).toBe(false);
    expect(result.snapshot.activeWorkspaceId).toBe('other');
    expect(runtime.send).toHaveBeenCalledOnce();
  });
});

describe('preserved acceptance and persisted log boundary', () => {
  it.each([
    { state: 'not_run', applicability: 'unknown' },
    { state: 'blocked', applicability: 'unknown' },
    { state: 'passed', applicability: 'stale' },
  ] as const)('rejects acceptance for $state/$applicability while allowing changes requested', async (validation) => {
    const { app, command, runtime, repository, session, version } = await setup();
    vi.mocked(runtime.send).mockResolvedValue(conversation(session.sessionId, 'one', 1, []));
    await command({ type: 'startRun', sessionId: session.sessionId, taskVersionId: version.taskVersionId });
    const snapshot = await app.getSnapshot();
    const run = snapshot.workspaces[0]!.runs[0]!;
    run.validation = { ...validation, reason: null };
    await repository.save(snapshot);
    const restored = new WorkbenchApplication(repository, runtime, vi.fn());
    await restored.getSnapshot();
    const base = { workspaceId: 'taskflow-demo', runId: run.runId, candidateId: run.candidateId };
    const denied = await restored.command({ ...base, type: 'recordReview', commandId: 'accept', decision: 'accepted' });
    expect(denied.ok).toBe(false);
    expect(denied.snapshot.workspaces[0]!.runs[0]!.review).toBeNull();
    const changes = await restored.command({ ...base, type: 'recordReview', commandId: 'changes', decision: 'changes_requested' });
    expect(changes.ok).toBe(true);
  });
  it('rejects structurally valid logs owned by a different session and leaves the file intact', async () => {
    const { app, command, runtime, session, version } = await setup();
    vi.mocked(runtime.send).mockResolvedValue(conversation(session.sessionId, 'one', 1, []));
    await command({ type: 'startRun', sessionId: session.sessionId, taskVersionId: version.taskVersionId });
    const snapshot = await app.getSnapshot();
    snapshot.workspaces[0]!.runs[0]!.conversation!.conversationId = 'session-other';
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'wsl-corrupt-run-')), 'workbench.json');
    const repository = new FileWorkbenchRepository(file);
    await repository.save(snapshot);
    const before = await readFile(file, 'utf8');
    const restored = new WorkbenchApplication(repository, runtime, vi.fn());
    await expect(restored.getSnapshot()).rejects.toThrow('日志');
    expect(await readFile(file, 'utf8')).toBe(before);
  });
});
