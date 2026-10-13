import { useEffect } from 'react';
import { useStore } from '../lib/store';
import { occlusion } from '../state/occlusion';
import { Icon } from '../components/Icon';
import { shellActions, shellStore } from '../state/shell';
import { Notifications } from '../workspace/Notifications';
export function RightPanel({ mode }: { mode: 'docked' | 'overlay' | 'collapsed' }) {
  const pinned = useStore(shellStore, (s) => s.rightPanel.pinned);
  useEffect(() => {
    if (mode !== 'overlay') return;
    const escape = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && event.key === 'Escape' && occlusion.top() === 'right' && !document.querySelector('dialog[open]')) {
        event.preventDefault();
        shellActions.closePanel('right');
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [mode]);
  if (mode === 'collapsed') return null;
  return (
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
  );
}
