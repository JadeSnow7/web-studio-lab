import type { EnvironmentDescription } from '@wsl/protocol';
import { useImeForm } from '../lib/ime';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { useViewportWidth } from '../lib/viewport';
import { command, initializeWorkspace, switchWorkspace, workspaceCommand, workspaceStore } from '../state/workspace';
import { spaceActions, spaceUiStore } from '../state/space-ui';
import { shellActions, shellStore } from '../state/shell';
import { occlusion } from '../state/occlusion';
import { WorkspaceContent } from '../workspace/Panes';
import { SpaceSwitcher } from '../workspace/SpaceSwitcher';
const paneOverlay = async (open: boolean) => {
  if (open) return occlusion.open('pane-menu');
  occlusion.close('pane-menu');
  return true;
};
export function SpacePage({ active, occluded }: { active: boolean; occluded: boolean }) {
  const state = useStore(workspaceStore, (s) => s);
  const ui = useStore(spaceUiStore, (s) => s);
  const focus = useStore(shellStore, (s) => s.focusMode);
  const width = useViewportWidth();
  const workspace = state.snapshot?.workspaces.find((w) => w.workspaceId === state.selectedId);
  const ime = useImeForm();
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const { environments, environmentId, environmentError, loadingEnvironments } = ui;
  const setEnvironmentId = (environmentId: string) => spaceUiStore.set((s) => ({ ...s, environmentId }));
  const requiresEnvironment = ['file', 'terminal', 'ssh'].includes(ui.kind);
  const supports = (environment: EnvironmentDescription) =>
    environment.state === 'configured' &&
    environment.capabilities[ui.kind === 'file' ? 'files' : 'terminal'] &&
    (ui.kind !== 'ssh' || environment.environmentId === 'ssh');
  const selectedEnvironment = environments.find((environment) => environment.environmentId === environmentId);
  const canCreate = !requiresEnvironment || (!!selectedEnvironment && !loadingEnvironments && supports(selectedEnvironment));
  useEffect(() => {
    if (ui.editor) dialog.current?.showModal();
    else dialog.current?.close();
  }, [ui.editor]);
  useEffect(() => {
    if (!ui.tabMenu) return;
    const escape = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.key === 'Escape' && occlusion.top() === 'tab-menu') {
        event.preventDefault();
        spaceActions.closeTabMenu();
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [ui.tabMenu]);
  const submit = async () => {
    if (!workspace || !ui.editor || !ui.name.trim() || submitting.current || ime.composing.current) return;
    submitting.current = true;
    setPending(true);
    try {
      let result;
      const editor = ui.editor;
      if (editor.kind === 'workspace') {
        const workspaceId = crypto.randomUUID();
        result = await workspaceCommand(workspaceId, { type: 'createWorkspace', name: ui.name.trim() });
        if (result?.ok) await switchWorkspace(workspaceId);
      } else if (editor.kind === 'rename-workspace') result = await command({ type: 'renameWorkspace', name: ui.name.trim() });
      else if (editor.kind === 'tab') {
        if (!canCreate) return;
        result = await command({
          type: 'createTab',
          kind: ui.kind,
          title: ui.name.trim(),
          ...(requiresEnvironment ? { environmentId: environmentId as EnvironmentDescription['environmentId'] } : {}),
        });
      } else if (editor.kind === 'rename-tab' && editor.tabId)
        result = await command({ type: 'updateTab', tabId: editor.tabId, title: ui.name.trim() });
      else if (editor.tabId) result = await command({ type: 'updateTab', tabId: editor.tabId, group: ui.name.trim() });
      if (result?.ok) {
        spaceActions.closeEditor();
        shellActions.navigate('space');
      }
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  const reorder = (tabId: string, delta: number) => {
    if (!workspace) return;
    const ids = workspace.tabs.map((t) => t.tabId),
      i = ids.indexOf(tabId),
      j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void command({ type: 'reorderTabs', tabIds: ids });
  };
  const tab = workspace?.tabs.find((t) => t.tabId === ui.tabMenu);
  return (
    <div className="space-page">
      {!state.snapshot && state.error ? (
        <button className="btn" type="button" onClick={() => void initializeWorkspace(true)}>
          重新加载空间
        </button>
      ) : null}
      {state.snapshot?.workspaces.map((w) => (
        <WorkspaceContent
          key={w.workspaceId}
          workspace={w}
          active={active && w.workspaceId === state.selectedId}
          occluded={occluded}
          focus={focus}
          narrow={width < 1080}
          onFocus={shellActions.toggleFocus}
          onOverlay={paneOverlay}
        />
      ))}
      {!state.snapshot ? (
        <p className="workspace-empty" role="status">
          正在加载空间工作现场…
        </p>
      ) : null}
      {createPortal(
        <>
          <SpaceSwitcher
            open={ui.switcher}
            workspaces={state.snapshot?.workspaces ?? []}
            selectedId={state.selectedId}
            onClose={spaceActions.closeSwitcher}
            onExpand={() => {
              shellActions.navigate('space');
              void shellActions.setPeek(true);
            }}
            onCreate={() => void spaceActions.openEditor({ kind: 'workspace' })}
            onManage={() => void spaceActions.openEditor({ kind: 'rename-workspace' }, workspace?.name ?? '')}
          />
          <dialog
            ref={dialog}
            className="workspace-editor"
            aria-label={ui.editor?.kind === 'workspace' ? '新建空间' : ui.editor?.kind === 'tab' ? '新建标签' : '编辑名称'}
            onCancel={(event) => {
              event.preventDefault();
              if (!pending) spaceActions.closeEditor();
            }}
          >
            <form
              noValidate
              {...ime.handlers}
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <h2>{ui.editor?.kind === 'workspace' ? '新建空间' : ui.editor?.kind === 'tab' ? '新建标签' : '编辑名称'}</h2>
              <label className="field">
                名称
                <input
                  autoFocus
                  aria-label="名称"
                  value={ui.name}
                  maxLength={200}
                  onChange={(event) => spaceUiStore.set((s) => ({ ...s, name: event.target.value }))}
                />
              </label>
              {ui.editor?.kind === 'tab' ? (
                <label className="field">
                  类型
                  <select
                    aria-label="标签类型"
                    value={ui.kind}
                    onChange={(event) => {
                      setEnvironmentId('');
                      spaceUiStore.set((s) => ({ ...s, kind: event.target.value as typeof ui.kind }));
                    }}
                  >
                    {['web', 'terminal', 'session', 'file', 'ssh'].map((kind) => (
                      <option key={kind} value={kind}>
                        {
                          ({ web: '网页', terminal: '终端', session: 'Agent 会话', file: '文件', ssh: 'SSH' } as Record<string, string>)[
                            kind
                          ]
                        }
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              {ui.editor?.kind === 'tab' && requiresEnvironment ? (
                <>
                  <label className="field">
                    资源环境
                    <select
                      aria-label="资源环境"
                      value={environmentId}
                      disabled={loadingEnvironments || pending}
                      onChange={(event) => setEnvironmentId(event.target.value)}
                    >
                      <option value="">明确选择已配置环境</option>
                      {environments.map((environment) => (
                        <option key={environment.environmentId} value={environment.environmentId} disabled={!supports(environment)}>
                          {environment.label}
                          {!supports(environment) ? ` · ${environment.reason ?? '不支持此资源类型'}` : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {loadingEnvironments ? <p role="status">正在核对环境能力…</p> : null}
                  {environmentError ? <p role="alert">环境加载失败：{environmentError}。可重新加载环境，保留已填内容。</p> : null}
                  {environmentError ? (
                    <button type="button" className="btn" disabled={loadingEnvironments} onClick={spaceActions.reloadEnvironments}>
                      重新加载环境
                    </button>
                  ) : null}
                  {environments
                    .filter((environment) => !supports(environment))
                    .map((environment) => (
                      <p className="muted small" key={environment.environmentId}>
                        {environment.label} · {environment.reason ?? '不支持此资源类型'}
                      </p>
                    ))}
                  <p className="muted small">仅使用已有可信配置；选择不会授予 home 或复制认证。</p>
                </>
              ) : null}
              <div className="row gap-8">
                <button type="button" className="btn" disabled={pending} onClick={spaceActions.closeEditor}>
                  取消
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={pending || !ui.name.trim() || (ui.editor?.kind === 'tab' && !canCreate)}
                >
                  {pending ? '保存中…' : '保存'}
                </button>
              </div>
            </form>
          </dialog>
          {tab && workspace ? (
            <div className="tab-menu" role="menu" aria-label={`${tab.title}操作`}>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void command({ type: 'updateTab', tabId: tab.tabId, pinned: !tab.pinned });
                  spaceActions.closeTabMenu();
                }}
              >
                {tab.pinned ? '取消置顶' : '置顶标签'}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void spaceActions.openEditor({ kind: 'rename-tab', tabId: tab.tabId }, tab.title)}
              >
                重命名
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => void spaceActions.openEditor({ kind: 'group', tabId: tab.tabId }, tab.group ?? '')}
              >
                设置分组
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void command({ type: 'updateTab', tabId: tab.tabId, group: null });
                  spaceActions.closeTabMenu();
                }}
              >
                移出分组
              </button>
              {[-1, 1].map((delta) => (
                <button
                  key={delta}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    reorder(tab.tabId, delta);
                    spaceActions.closeTabMenu();
                  }}
                >
                  {delta < 0 ? '向上移动' : '向下移动'}
                </button>
              ))}
              {(['horizontal', 'vertical'] as const).map((direction) => (
                <button
                  key={direction}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    void command({ type: 'splitPane', paneId: workspace.activePaneId, direction, tabId: tab.tabId });
                    spaceActions.closeTabMenu();
                  }}
                >
                  在{direction === 'horizontal' ? '右侧' : '下方'}打开
                </button>
              ))}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  void command({ type: 'closeTab', tabId: tab.tabId });
                  spaceActions.closeTabMenu();
                }}
              >
                关闭标签（保留后台执行）
              </button>
              <button type="button" role="menuitem" onClick={spaceActions.closeTabMenu}>
                关闭菜单
              </button>
            </div>
          ) : null}
        </>,
        document.body,
      )}
    </div>
  );
}
