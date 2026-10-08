import { useEffect, useRef } from 'react';
import { useStore } from '../lib/store';
import { occlusion } from '../state/occlusion';
import { Icon } from '../components/Icon';
import { shellActions, shellStore } from '../state/shell';
import { workspaceStore } from '../state/workspace';
import { Notifications } from '../workspace/Notifications';
export function RightPanel({ mode }: { mode: 'docked' | 'overlay' | 'collapsed' }) {
  const pinned = useStore(shellStore, (s) => s.rightPanel.pinned);
  const unread = useStore(workspaceStore, (s) => s.snapshot?.notifications.filter((n) => !n.readAt).length ?? 0);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (mode !== 'overlay') return;
    const escape = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.key === 'Escape' && occlusion.top() === 'right' && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        shellActions.closePanel('right');
        trigger.current?.focus();
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [mode]);
  return (
    <>
      <div className="notification-edge">
        <button
          id="right-panel-trigger"
          ref={trigger}
          type="button"
          className="edge-handle notification-trigger"
          aria-label={`通知 · ${unread} 条未读`}
          aria-expanded={mode !== 'collapsed'}
          onClick={() => void shellActions.toggleRightPanel()}
        >
          <Icon name="chat" size={17} />
          <span>{unread}</span>
        </button>
      </div>
      {mode !== 'collapsed' ? (
        <aside className={`right-panel ${mode === 'overlay' ? 'right-panel-overlay' : ''}`} aria-label="通知栏">
          <header className="row space-between panel-controls">
            <strong>通知</strong>
            <div className="row">
              <button
                type="button"
                className="icon-btn"
                aria-label={pinned ? '取消固定通知' : '固定通知'}
                aria-pressed={pinned}
                onClick={() => void shellActions.setPinned(!pinned, 'right')}
              >
                <Icon name="pin" size={17} />
              </button>
              <button type="button" className="icon-btn" aria-label="收起通知栏" onClick={() => shellActions.closePanel('right')}>
                <Icon name="close" size={17} />
              </button>
            </div>
          </header>
          <Notifications
            onOpen={(sessionId) => {
              shellActions.closePanel('right');
              requestAnimationFrame(() => document.getElementById(`session-heading-${sessionId}`)?.focus());
            }}
          />
        </aside>
      ) : null}
    </>
  );
}
