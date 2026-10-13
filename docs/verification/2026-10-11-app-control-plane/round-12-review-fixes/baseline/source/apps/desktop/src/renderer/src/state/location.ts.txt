import { createStore } from '../lib/store';
import { workspaceCommand, workspaceStore, beginNavigation, isCurrentNavigation } from './workspace';
import { shellActions } from './shell';
import type { RunView } from '../workspace/RunDetails';
export interface SessionLocation {
  workspaceId: string;
  sessionId: string;
  taskVersionId?: string;
  runId?: string;
  view?: RunView | 'task' | 'context' | 'checks';
}
export const locationStore = createStore<{ location: SessionLocation | null; token: number }>({ location: null, token: 0 });
export async function locateSession(location: SessionLocation) {
  const token = beginNavigation();
  const identity = {
    sessionId: location.sessionId,
    ...(location.taskVersionId ? { taskVersionId: location.taskVersionId } : {}),
    ...(location.runId ? { runId: location.runId } : {}),
  };
  const result = await workspaceCommand(location.workspaceId, { type: 'locateSession', ...identity });
  if (!result?.ok || !isCurrentNavigation(token)) return false;
  workspaceStore.set((s) => ({ ...s, selectedId: location.workspaceId }));
  locationStore.set((s) => ({ location, token: s.token + 1 }));
  shellActions.navigate('space');
  return true;
}
