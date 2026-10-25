import { useEffect, useRef, useState } from 'react';
import { useImeForm } from '../lib/ime';
import { spaceActions, spaceUiStore } from '../state/space-ui';
import { beginNavigation, isCurrentNavigation, workspaceCommand, workspaceStore } from '../state/workspace';
export function TabRename({
  workspaceId,
  tabId,
  title,
  revision,
}: {
  workspaceId: string;
  tabId: string;
  title: string;
  revision: number;
}) {
  const initialRevision = useRef(revision);
  const target = useRef(spaceUiStore.get().renaming);
  const [name, setName] = useState(title);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const ime = useImeForm();
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = () => {
    if (spaceUiStore.get().renaming !== target.current) return;
    const owner = form.current;
    const navigation = beginNavigation();
    const ownedFocus = !!owner?.contains(document.activeElement);
    spaceActions.closeRename();
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (
        ownedFocus &&
        isCurrentNavigation(navigation) &&
        document.hasFocus() &&
        workspaceStore.get().selectedId === workspaceId &&
        !spaceUiStore.get().renaming &&
        (active === document.body || !!owner?.contains(active))
      ) {
        const tab = document.getElementById(`vertical-${tabId}`);
        if (tab?.getClientRects().length) tab.focus();
      }
    });
  };
  return (
    <form
      ref={form}
      className="tab-rename"
      noValidate
      {...ime.handlers}
      aria-label="重命名标签"
      aria-busy={busy}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        ime.handlers.onKeyDown(event);
        if (event.key === 'Escape' && !ime.composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) {
          event.preventDefault();
          event.stopPropagation();
          if (!submitting.current) finish();
        }
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (submitting.current || ime.composing.current) return;
        if (!name.trim()) {
          setError('请输入标签名称。');
          input.current?.focus();
          return;
        }
        const owner = event.currentTarget;
        const navigation = beginNavigation();
        let revoked = !owner.contains(document.activeElement);
        const focusIntent = new AbortController();
        const outside = (event: Event) => {
          const target = event.target;
          if (target instanceof Node && !owner.contains(target) && (event.type === 'pointerdown' || target !== document.body))
            revoked = true;
        };
        // Disabled inputs can leave body focused. Record a later outside action so that state is not mistaken for retained focus.
        window.addEventListener('pointerdown', outside, { capture: true, signal: focusIntent.signal });
        window.addEventListener('focusin', outside, { signal: focusIntent.signal });
        window.addEventListener(
          'blur',
          () => {
            revoked = true;
          },
          { signal: focusIntent.signal },
        );
        let saved = false;
        submitting.current = true;
        setBusy(true);
        setError(null);
        try {
          const result = await workspaceCommand(workspaceId, { type: 'updateTab', tabId, title: name.trim() }, initialRevision.current);
          if (result?.ok) {
            saved = true;
            if (spaceUiStore.get().renaming === target.current) spaceActions.closeRename();
          } else {
            setError(
              result
                ? result.error.message + (result.error.code === 'conflict' ? '；请取消后重新打开重命名。' : '')
                : (workspaceStore.get().error ?? '保存失败，请重试。'),
            );
          }
        } finally {
          submitting.current = false;
          setBusy(false);
          requestAnimationFrame(() => {
            try {
              const active = document.activeElement;
              if (
                revoked ||
                !isCurrentNavigation(navigation) ||
                !document.hasFocus() ||
                workspaceStore.get().selectedId !== workspaceId ||
                spaceUiStore.get().renaming !== (saved ? null : target.current) ||
                (active !== document.body && !owner.contains(active))
              )
                return;
              const destination = saved ? document.getElementById(`vertical-${tabId}`) : input.current;
              if (destination?.isConnected && destination.getClientRects().length) destination.focus();
            } finally {
              focusIntent.abort();
            }
          });
        }
      }}
    >
      <label className="field">
        <span className="sr-only">标签名称</span>
        <input
          ref={input}
          aria-label="标签名称"
          value={name}
          maxLength={200}
          disabled={busy}
          aria-invalid={!!error}
          aria-describedby={error ? `rename-error-${tabId}` : undefined}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <div className="row gap-8">
        <button type="submit" className="btn" disabled={busy}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={finish}>
          取消
        </button>
      </div>
      {error ? (
        <p id={`rename-error-${tabId}`} role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
