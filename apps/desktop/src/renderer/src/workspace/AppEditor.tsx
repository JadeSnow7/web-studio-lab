import { useEffect, useRef, useState } from 'react';
import { AppFormDialog } from '../shell/Overlays';
import type { WorkspaceSnapshot } from '@wsl/protocol';
import { useImeForm } from '../lib/ime';
import { occlusion } from '../state/occlusion';
import { spaceActions } from '../state/space-ui';
import { workspaceCommand } from '../state/workspace';

/** Both forms freeze their recipient when opened; switching spaces cannot redirect a save. */
export function AppEditor({ workspace, overlayId }: { workspace: WorkspaceSnapshot; overlayId: string }) {
  const [draft, setDraft] = useState<{
    workspaceId: string;
    workspaceName: string;
    appId: string | null;
    revision: number;
    name: string;
    description: string;
  }>(() => ({
    workspaceId: workspace.workspaceId,
    workspaceName: workspace.name,
    appId: workspace.app?.appId ?? null,
    revision: workspace.app?.revision ?? 0,
    name: workspace.app?.name ?? '',
    description: workspace.app?.description ?? '',
  }));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const nameInput = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const ime = useImeForm();
  const close = () => {
    if (submitting.current) return;
    spaceActions.closeAppEditor(overlayId);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      occlusion.close(overlayId);
    };
  }, [overlayId]);
  const save = async () => {
    if (submitting.current || ime.composing.current) return;
    if (!draft.name.trim()) {
      setError('请输入 App 名称');
      nameInput.current?.focus();
      return;
    }
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      const fields = { name: draft.name.trim(), description: draft.description.trim() };
      const result = await workspaceCommand(
        draft.workspaceId,
        draft.appId
          ? { type: 'updateApp', appId: draft.appId, expectedAppRevision: draft.revision, ...fields }
          : { type: 'createApp', ...fields },
      );
      if (!mounted.current) return;
      if (result?.ok) {
        submitting.current = false;
        close();
      } else {
        const app = result?.snapshot.workspaces.find((value) => value.workspaceId === draft.workspaceId)?.app;
        if (app && !draft.appId && result && !result.ok && result.error.code === 'execution_failed')
          setDraft((value) => ({ ...value, appId: app.appId, revision: app.revision }));
        setError(result?.error.message ?? '保存失败，请重试');
      }
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  return (
    <>
      <AppFormDialog open={true} label={draft?.appId ? '编辑 App' : '创建 App'} onCancel={close}>
        <form
          noValidate
          {...ime.handlers}
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <h2>{draft?.appId ? '编辑 App' : '创建 App'}</h2>
          <p className="muted small">{draft?.workspaceName} · 每个空间一个标准 App</p>
          <label className="field">
            App 名称
            <input
              ref={nameInput}
              autoFocus
              aria-label="App 名称"
              maxLength={200}
              value={draft?.name ?? ''}
              disabled={pending}
              aria-invalid={!!error && !draft?.name.trim()}
              aria-describedby={error ? 'app-form-error' : undefined}
              onChange={(event) => setDraft((value) => ({ ...value, name: event.target.value }))}
            />
          </label>
          <label className="field">
            App 说明
            <textarea
              aria-label="App 说明"
              className="resize-none"
              maxLength={2000}
              rows={4}
              value={draft?.description ?? ''}
              disabled={pending}
              onChange={(event) => setDraft((value) => ({ ...value, description: event.target.value }))}
            />
          </label>
          <p className="muted small" role="status" style={{ minHeight: '1.5em' }}>
            {pending ? '正在保存 App…' : ''}
          </p>
          {error ? (
            <p id="app-form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="row gap-8">
            <button type="button" className="btn" disabled={pending} onClick={close}>
              取消
            </button>
            <button type="submit" className="btn btn-primary" disabled={pending} aria-busy={pending}>
              保存 App
            </button>
          </div>
        </form>
      </AppFormDialog>
    </>
  );
}
