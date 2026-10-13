import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import { dismissError } from '../state/errors';
import { useToastQueue } from '../state/status-view';
import { workspaceStore } from '../state/workspace';
import { uiActions, uiStore, type Modal } from '../state/ui';

function AppDialog({ modal }: { modal: NonNullable<Modal> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    cancel.current?.focus();
    return () => {
      dialog.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={modal.kind === 'confirm' ? 'modal modal-confirm' : 'modal'}
      aria-labelledby="modal-title"
      aria-describedby={modal.kind === 'confirm' ? 'modal-description' : undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) uiActions.closeModal();
      }}
    >
      <div className="row space-between gap-12">
        <strong id="modal-title">{modal.title}</strong>
        {modal.kind === 'image' ? (
          <button type="button" ref={cancel} className="icon-btn" aria-label="关闭" onClick={uiActions.closeModal}>
            <Icon name="close" size={15} />
          </button>
        ) : null}
      </div>
      {modal.kind === 'image' ? (
        <img src={modal.src} alt={modal.title} />
      ) : (
        <>
          <p id="modal-description">{modal.description}</p>
          <p className={failed ? 'small text-bad' : 'small muted'} role={failed ? 'alert' : 'status'}>
            {failed ?? (busy ? '正在执行…' : '')}
          </p>
          <div className="row gap-8 modal-actions">
            <button type="button" ref={cancel} className="btn" disabled={busy} onClick={uiActions.closeModal}>
              取消
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy}
              aria-busy={busy}
              onClick={async () => {
                if (busy) return;
                setBusy(true);
                setFailed(null);
                try {
                  if (await modal.onConfirm()) uiActions.closeModal();
                  else setFailed('操作未完成，请处理页面提示后重试。');
                } catch (error) {
                  setFailed((error as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {modal.confirmLabel}
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}

export function ModalLayer() {
  const modal = useStore(uiStore, (s) => s.modal);
  return modal ? <AppDialog key={modal.kind + modal.title} modal={modal} /> : null;
}
/**
 * Toast 队列只放事件：界面错误（原 errorStore）与工作区错误（workspaceStore.error）。
 * 对话不可用、环境未就绪等持续条件不进 Toast，在标题栏呈现。
 * 每个条目自带 role="alert"，容器不带 role，避免嵌套播报与 getByRole('alert') 多重命中。
 */
export function ErrorToasts() {
  const items = useToastQueue();
  if (items.length === 0) return null;
  return (
    <div className="toasts">
      {items.map((item) => {
        if (item.kind === 'ui-error')
          return (
            <div key={item.id} className="toast" role="alert">
              <div>
                <strong>{item.error.context}失败</strong>
                <p>{item.error.message}</p>
              </div>
              <button type="button" className="icon-btn" aria-label="关闭提示" onClick={() => dismissError(item.error.id)}>
                <Icon name="close" size={14} />
              </button>
            </div>
          );
        return (
          <div key={item.id} className="toast workspace-error" role="alert">
            <span>{item.message}</span>
            <button
              type="button"
              className="icon-btn"
              aria-label="关闭错误提示"
              onClick={() => workspaceStore.set((s) => ({ ...s, error: null }))}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** App forms share the modal layer's native focus trap and restoration. */
export function AppFormDialog({
  open,
  label,
  onCancel,
  children,
}: {
  open: boolean;
  label: string;
  onCancel: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!open) return;
    const dialog = ref.current;
    const previous = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else document.querySelector<HTMLButtonElement>('[aria-label="切换空间"]')?.focus();
    };
  }, [open]);
  return createPortal(
    <dialog
      ref={ref}
      className="workspace-editor"
      aria-label={label}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      {children}
    </dialog>,
    document.body,
  );
}
