import { useLayoutEffect, useRef } from 'react';
import type { WorkbenchResource } from '@wsl/protocol';
import { workspaceCommand } from '../state/workspace';

/** Geometry only. Editor content never enters the generic Browser/Agent surface. */
export function MotaEditorViewport({
  workspaceId,
  resource,
  visible,
  occluded,
  appInstanceId,
  running,
  gameResourceId,
}: {
  workspaceId: string;
  resource: WorkbenchResource;
  visible: boolean;
  occluded: boolean;
  appInstanceId: string | null;
  running: boolean;
  gameResourceId?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = host.current;
    if (!element || !running) return;
    const sync = () => {
      const rect = element.getBoundingClientRect();
      void workspaceCommand(workspaceId, {
        type: 'browserLayout',
        resourceId: resource.resourceId,
        layout: {
          visible: visible && !occluded,
          bounds: {
            x: Math.max(0, Math.round(rect.x)),
            y: Math.max(0, Math.round(rect.y)),
            width: Math.max(0, Math.round(rect.width)),
            height: Math.max(0, Math.round(rect.height)),
          },
        },
      });
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(element);
    window.addEventListener('resize', sync);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
      void workspaceCommand(workspaceId, {
        type: 'browserLayout',
        resourceId: resource.resourceId,
        layout: { visible: false, bounds: { x: 0, y: 0, width: 0, height: 0 } },
      });
    };
  }, [workspaceId, resource.resourceId, appInstanceId, running, visible, occluded]);
  return (
    <div className="workspace-browser">
      <div className="browser-toolbar row">
        <span className="muted">魔塔 · 文本编辑</span>
        <button
          className="btn"
          type="button"
          disabled={!running || !gameResourceId}
          onClick={() => {
            if (gameResourceId) void workspaceCommand(workspaceId, { type: 'browserAction', resourceId: gameResourceId, action: 'reload' });
          }}
        >
          刷新游戏
        </button>
      </div>
      <div className="preview-host" ref={host} aria-label="可信魔塔编辑器视图">
        {!running ? '应用已停止，草稿保留。启动应用后重新读取。' : null}
      </div>
    </div>
  );
}
