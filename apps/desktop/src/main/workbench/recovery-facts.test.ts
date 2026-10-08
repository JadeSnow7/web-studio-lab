import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import type { ChatConversation, WorkbenchCommand, WorkbenchSnapshot } from '@wsl/protocol';
import { WorkbenchApplication } from './application';
import { FileWorkbenchRepository } from './repository';
import type { WorkbenchRuntime } from './ports';
async function runningFixture() {
  const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'wsl-recovery-')), 'workbench.json');
  const repository = new FileWorkbenchRepository(file);
  const runtime = {
    validateBrowserUrl: vi.fn(),
    publicResourcesList: vi.fn().mockResolvedValue({ spaceId: 'taskflow-demo', revision: 0, resources: [] }),
    registerSession: vi.fn(),
    send: vi.fn(),
  } as unknown as WorkbenchRuntime;
  const app = new WorkbenchApplication(repository, runtime, vi.fn());
  const w = (await app.getSnapshot()).workspaces[0]!;
  const s = w.sessions[0]!;
  const command = (payload: Record<string, unknown>) =>
    app.command({ commandId: crypto.randomUUID(), workspaceId: w.workspaceId, ...payload } as WorkbenchCommand);
  await command({ type: 'confirmTask', sessionId: s.sessionId, goal: 'fixture', targetRef: null });
  const version = (await app.getSnapshot()).workspaces[0]!.sessions[0]!.taskVersions[0]!;
  const conversation: ChatConversation = {
    conversationId: s.sessionId,
    generation: 'fixture',
    seq: 1,
    state: 'running',
    turnId: 'turn',
    threadId: 'thread',
    messages: [],
    toolExecutions: [],
    warnings: [],
    cleanupPending: true,
    error: null,
  };
  vi.mocked(runtime.send).mockResolvedValue(conversation);
  await command({ type: 'startRun', sessionId: s.sessionId, taskVersionId: version.taskVersionId });
  const saved = await app.getSnapshot();
  const web = saved.workspaces[0]!.resources.find((r) => r.kind === 'web')!;
  saved.workspaces[0]!.sessions[0]!.captureRequest = {
    requestId: 'pending-capture',
    resourceId: web.resourceId,
    state: 'pending',
    error: null,
  };
  const runId = saved.workspaces[0]!.runs[0]!.runId;
  saved.notificationReadReceipts = [{ notificationId: w.workspaceId + ':' + runId + ':interrupted', readAt: '2026-10-08T00:00:00.000Z' }];
  await repository.save(saved);
  return { repository, runtime, file, runId };
}
describe('R1/R6 durable recovery facts', () => {
  it('persists interrupted run and cancelled capture once, preserving fact time and receipt across two read-only restarts', async () => {
    const { repository, runtime, runId } = await runningFixture();
    const save = vi.spyOn(repository, 'save');
    const first = new WorkbenchApplication(repository, runtime, vi.fn());
    const before = await first.getSnapshot();
    expect(before.workspaces[0]!.runs[0]).toMatchObject({ runId, state: 'interrupted' });
    expect(before.workspaces[0]!.sessions[0]!.captureRequest?.state).toBe('cancelled');
    const persisted = await repository.load();
    expect(persisted!.workspaces[0]!.runs[0]).toMatchObject({
      runId,
      state: 'interrupted',
      endedAt: before.workspaces[0]!.runs[0]!.endedAt,
    });
    expect(persisted!.workspaces[0]!.sessions[0]!.captureRequest?.state).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = new WorkbenchApplication(repository, runtime, vi.fn());
    const after = await second.getSnapshot();
    expect(after.workspaces[0]!.runs[0]!.endedAt).toBe(before.workspaces[0]!.runs[0]!.endedAt);
    expect(after.notifications[0]).toEqual(before.notifications[0]);
    expect(after.notificationReadReceipts).toEqual(before.notificationReadReceipts);
    expect(save).toHaveBeenCalledOnce();
    expect(runtime.send).toHaveBeenCalledOnce();
  });
  it('exposes a recovery save failure while preserving original bytes and avoiding initialization or execution replay', async () => {
    const { repository, runtime, file } = await runningFixture();
    const original = await readFile(file, 'utf8');
    const load = vi.spyOn(repository, 'load');
    const save = vi.spyOn(repository, 'save').mockRejectedValue(new Error('recovery disk full'));
    const restored = new WorkbenchApplication(repository, runtime, vi.fn());
    const snapshot: WorkbenchSnapshot = await restored.getSnapshot();
    expect(snapshot.workspaces[0]!.runs[0]!.state).toBe('interrupted');
    expect(snapshot.storageError).toContain('recovery disk full');
    expect(await readFile(file, 'utf8')).toBe(original);
    await restored.retryInitialization();
    expect(load).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
    expect(runtime.send).toHaveBeenCalledOnce();
  });
});
