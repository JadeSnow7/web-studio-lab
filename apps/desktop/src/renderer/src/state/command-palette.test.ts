import { describe, expect, it } from 'vitest';
import { WorkspaceSnapshotSchema } from '@wsl/protocol';
import { paletteEntries } from './command-palette';
const workspace = () =>
  WorkspaceSnapshotSchema.parse({
    workspaceId: 'space',
    name: '研究空间',
    revision: 1,
    theme: 'light',
    tabs: [],
    resources: [],
    layout: { kind: 'pane', paneId: 'pane', tabId: null },
    activePaneId: 'pane',
    sessions: [],
    runs: [],
  });
describe('command palette local search', () => {
  it('searches local spaces, tabs, closed sessions and fixed commands without running an action', () => {
    const space = workspace();
    space.tabs.push({
      tabId: 'tab',
      title: '论文页面',
      pinned: false,
      group: null,
      autoTitle: false,
      targetRef: { kind: 'web', resourceId: 'page' },
    });
    expect(paletteEntries([space], '论文')).toMatchObject([{ kind: 'tab', tabId: 'tab' }]);
    expect(paletteEntries([space], '研究')).toMatchObject([{ kind: 'workspace' }, { kind: 'tab' }]);
    expect(paletteEntries([space], '打开设置')).toMatchObject([{ kind: 'command', command: 'settings' }]);
    expect(paletteEntries([space], '不存在')).toEqual([]);
    expect(paletteEntries([space], '').filter((entry) => entry.kind === 'command')).toHaveLength(3);
  });
  it('limits runs to the latest 50 globally before applying the query, retaining frozen version identity', () => {
    const space = workspace();
    const session = {
      sessionId: 'session',
      resourceId: 'resource',
      title: '关闭的会话',
      draft: '',
      taskVersions: [],
      context: null,
      contextTarget: null,
      captureRequest: null,
      harnessSelection: null,
      conversation: null,
      taskTargetRef: null,
      contextApplicability: 'unknown',
    };
    space.sessions = WorkspaceSnapshotSchema.shape.sessions.parse([session]);
    for (let i = 0; i < 55; i++) {
      const taskVersionId = `task-${i}`;
      space.sessions[0]?.taskVersions.push({
        taskVersionId,
        version: i + 1,
        workspaceId: space.workspaceId,
        sessionId: 'session',
        goal: `目标 ${i}`,
        targetRef: null,
        capture: null,
        appTarget: null,
        captureBinding: null,
        acceptance: [],
        allowedScopes: [],
        confirmedAt: '2026-10-23T00:00:00Z',
      });
      space.runs.push({
        runId: `run-${i}`,
        workspaceId: space.workspaceId,
        sessionId: 'session',
        taskVersionId,
        targetRef: null,
        state: 'completed',
        startedAt: String(i).padStart(3, '0'),
        endedAt: null,
        error: null,
        candidateId: `candidate-${i}`,
        validation: { state: 'not_run', applicability: 'unknown', reason: null },
        conversation: null,
        executionBinding: null,
        review: null,
      });
    }
    const entries = paletteEntries([space], '目标');
    expect(entries).toHaveLength(50);
    expect(entries[0]).toMatchObject({ kind: 'run', runId: 'run-54', taskVersionId: 'task-54', sessionId: 'session' });
    expect(entries.at(-1)).toMatchObject({ runId: 'run-5' });
    expect(paletteEntries([space], '目标 0')).toEqual([]);
    expect(paletteEntries([space], '关闭的会话').some((entry) => entry.kind === 'session')).toBe(true);
  });
});
