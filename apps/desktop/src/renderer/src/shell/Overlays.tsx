import { useEffect, useRef, useState } from 'react';
import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import { dismissError, errorStore } from '../state/errors';
import { uiActions, uiStore, type Modal } from '../state/ui';

function AppDialog({ modal }: { modal: NonNullable<Modal> }) {
  const ref = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
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
            {failed ? '未移除资源。请先停止当前空间回复，再重试；取消后可在资源页查看具体错误。' : busy ? '正在移除资源…' : ''}
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
                setFailed(false);
                try {
                  if (await modal.onConfirm()) uiActions.closeModal();
                  else setFailed(true);
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
export function ErrorToasts() {
  const errors = useStore(errorStore, (e) => e);
  if (errors.length === 0) return null;
  return (
    <div className="toasts" role="alert">
      {errors.map((e) => (
        <div key={e.id} className="toast">
          <div>
            <strong>{e.context}失败</strong>
            <p>{e.message}</p>
          </div>
          <button type="button" className="icon-btn" aria-label="关闭提示" onClick={() => dismissError(e.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
