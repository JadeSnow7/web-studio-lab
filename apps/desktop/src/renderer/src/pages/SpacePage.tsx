import { defaultEnvironment, readEnvironmentPreference, rememberEnvironment, supportsEnvironment } from '../state/default-environment';
import { AppEditor } from '../workspace/AppEditor';
import type { EnvironmentDescription } from '@wsl/protocol';
import { useImeForm } from '../lib/ime';
import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { useViewportWidth } from '../lib/viewport';
import { initializeWorkspace, switchWorkspace, workspaceCommand, workspaceStore } from '../state/workspace';
import { spaceActions, spaceUiStore, type Editor } from '../state/space-ui';
import { shellActions, shellStore } from '../state/shell';
import { WorkspaceContent } from '../workspace/Panes';
import { ManagedAppDialog } from '../workspace/ManagedAppDialog';
import { SpaceSwitcher } from '../workspace/SpaceSwitcher';
export function SpacePage({ active, occluded }: { active: boolean; occluded: boolean }) {
  const state = useStore(workspaceStore, (s) => s);
  const ui = useStore(spaceUiStore, (s) => s);
  const focus = useStore(shellStore, (s) => s.focusMode);
  const width = useViewportWidth();
  const workspace = state.snapshot?.workspaces.find((w) => w.workspaceId === state.selectedId);
  const ime = useImeForm();
  const dialog = useRef<HTMLDialogElement>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<{ editor: Editor; message: string } | null>(null);
  const error = failure?.editor === ui.editor ? failure?.message : null;
  const submitting = useRef(false);
  const { environments, environmentId, environmentError, loadingEnvironments } = ui;
  const setEnvironmentId = (environmentId: string) => spaceUiStore.set((s) => ({ ...s, environmentId }));
  const requiresEnvironment = ['file', 'terminal', 'ssh'].includes(ui.kind);
  const supports = (environment: EnvironmentDescription) => supportsEnvironment(environment, ui.kind);
  const selectedEnvironment = environments.find((environment) => environment.environmentId === environmentId);
  const canCreate = !requiresEnvironment || (!!selectedEnvironment && !loadingEnvironments && supports(selectedEnvironment));
  useEffect(() => {
    if (ui.editor) dialog.current?.showModal();
    else dialog.current?.close();
  }, [ui.editor]);
  const submit = async () => {
    if (!workspace || !ui.editor || !ui.name.trim() || submitting.current || ime.composing.current) return;
    submitting.current = true;
    setPending(true);
    setFailure(null);
    try {
      let result;
      const editor = ui.editor;
      const targetId = editor.workspaceId;
      if (!targetId) throw new Error('没有目标空间');
      if (editor.kind === 'workspace') {
        const workspaceId = crypto.randomUUID();
        result = await workspaceCommand(workspaceId, { type: 'createWorkspace', name: ui.name.trim() });
        if (result?.ok) await switchWorkspace(workspaceId);
      } else if (editor.kind === 'rename-workspace')
        result = await workspaceCommand(targetId, { type: 'renameWorkspace', name: ui.name.trim() });
      else if (editor.kind === 'tab') {
        if (!canCreate) return;
        result = await workspaceCommand(targetId, {
          type: 'createTab',
          kind: ui.kind,
          title: ui.name.trim(),
          ...(ui.kind === 'web' && ui.url.trim() ? { url: ui.url.trim() } : {}),
          ...(requiresEnvironment ? { environmentId: environmentId as EnvironmentDescription['environmentId'] } : {}),
        });
      } else if (editor.tabId) result = await workspaceCommand(targetId, { type: 'updateTab', tabId: editor.tabId, group: ui.name.trim() });
      if (result?.ok) {
        if (editor.kind === 'tab' && requiresEnvironment) rememberEnvironment(localStorage, targetId, ui.kind, environmentId);
        if (spaceUiStore.get().editor !== editor) return;
        spaceActions.closeEditor();
        shellActions.navigate('space');
      } else
        setFailure({ editor: ui.editor, message: result ? result.error.message : (workspaceStore.get().error ?? '保存失败，请重试。') });
    } catch (error) {
      setFailure({ editor: ui.editor, message: (error as Error).message });
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
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
        />
      ))}
      {!state.snapshot ? (
        <p className="workspace-empty" role="status">
          正在加载空间工作现场…
        </p>
      ) : null}
      {createPortal(
        <>
          {ui.appEditor ? (
            <AppEditor key={ui.appEditor.overlayId} workspace={ui.appEditor.workspace} overlayId={ui.appEditor.overlayId} />
          ) : null}
          <ManagedAppDialog workspaceId={ui.appWorkspaceId} />
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
                  disabled={pending}
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
                    disabled={pending}
                    onChange={(event) => {
                      const kind = event.target.value as typeof ui.kind;
                      spaceUiStore.set((s) => ({
                        ...s,
                        kind,
                        environmentId:
                          defaultEnvironment(
                            s.environments,
                            kind,
                            readEnvironmentPreference(localStorage, s.editor?.workspaceId ?? '', kind),
                          )?.environmentId ?? '',
                      }));
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
              {ui.editor?.kind === 'tab' && ui.kind === 'web' ? (
                <label className="field">
                  网页地址（可选）
                  <input
                    aria-label="网页地址"
                    value={ui.url}
                    maxLength={2048}
                    disabled={pending}
                    placeholder="https://…"
                    onChange={(event) => spaceUiStore.set((s) => ({ ...s, url: event.target.value }))}
                  />
                  <span className="muted small">留空打开演示页；公开网页使用 HTTPS。</span>
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
              {error ? <p role="alert">{error}</p> : null}
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
        </>,
        document.body,
      )}
    </div>
  );
}
