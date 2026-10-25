import { tabTitle } from './tab-title';
import type { WorkspaceSnapshot } from '@wsl/protocol';
export type PaletteEntry = {
  id: string;
  label: string;
  detail: string;
} & (
  | { kind: 'workspace'; workspaceId: string }
  | { kind: 'tab'; workspaceId: string; tabId: string }
  | { kind: 'session'; workspaceId: string; sessionId: string }
  | { kind: 'run'; workspaceId: string; sessionId: string; runId: string; taskVersionId: string }
  | { kind: 'command'; command: 'new-web-tab' | 'theme' | 'settings' }
);
export function paletteEntries(workspaces: WorkspaceSnapshot[], query: string): PaletteEntry[] {
  const entries: PaletteEntry[] = [];
  for (const workspace of workspaces) {
    const workspaceId = workspace.workspaceId;
    entries.push({
      kind: 'workspace',
      id: workspaceId,
      workspaceId,
      label: workspace.name,
      detail: `空间 · ${workspace.tabs.length} 个标签 · ${workspace.runs.filter((run) => run.state === 'running').length} 个运行中 · ${workspace.runs.filter((run) => run.state === 'completed' && !run.review).length} 个待审阅`,
    });
    for (const tab of workspace.tabs)
      entries.push({
        kind: 'tab',
        id: tab.tabId,
        workspaceId,
        tabId: tab.tabId,
        label: tabTitle(workspace, tab),
        detail: `${workspace.name} · 标签`,
      });
    for (const session of workspace.sessions.filter(
      (session) => !workspace.tabs.some((tab) => tab.targetRef.resourceId === session.resourceId),
    ))
      entries.push({
        kind: 'session',
        id: session.sessionId,
        workspaceId,
        sessionId: session.sessionId,
        label: session.title,
        detail: `${workspace.name} · 会话`,
      });
  }
  const recent = workspaces
    .flatMap((workspace) => workspace.runs.map((run) => ({ workspace, run })))
    .sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt))
    .slice(0, 50);
  for (const { workspace, run } of recent) {
    const session = workspace.sessions.find((item) => item.sessionId === run.sessionId);
    const task = session?.taskVersions.find((item) => item.taskVersionId === run.taskVersionId);
    if (task)
      entries.push({
        kind: 'run',
        id: run.runId,
        workspaceId: workspace.workspaceId,
        sessionId: run.sessionId,
        runId: run.runId,
        taskVersionId: run.taskVersionId,
        label: task.goal,
        detail: `${workspace.name} · ${session?.title} · 运行记录`,
      });
  }
  entries.push(
    { kind: 'command', id: 'new-web-tab', command: 'new-web-tab', label: '新建网页标签', detail: '命令 · ⌘T' },
    { kind: 'command', id: 'theme', command: 'theme', label: '切换主题', detail: '命令 · 白 / 暗 / 暖' },
    { kind: 'command', id: 'settings', command: 'settings', label: '打开设置', detail: '命令 · ⌘,' },
  );
  const text = query.trim().toLocaleLowerCase();
  return entries.filter((entry) =>
    text ? `${entry.label} ${entry.detail}`.toLocaleLowerCase().includes(text) : entry.kind === 'workspace' || entry.kind === 'command',
  );
}
