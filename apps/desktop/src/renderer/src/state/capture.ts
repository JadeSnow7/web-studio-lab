import { workspaceCommand, workspaceStore } from './workspace';
import { locateSession } from './location';
// Request identity and navigation are presentation state. Main owns results.
const requests = new Map<string, { workspaceId: string; sessionId: string; requestId: string; unsubscribe: () => void }>();
const key = (workspaceId: string, resourceId: string) => JSON.stringify([workspaceId, resourceId]);
export async function captureContext(workspaceId: string, sessionId: string, resourceId: string) {
  const identity = key(workspaceId, resourceId);
  for (const [existingKey, request] of requests) {
    if (existingKey === identity || (request.workspaceId === workspaceId && request.sessionId === sessionId)) {
      request.unsubscribe();
      requests.delete(existingKey);
    }
  }
  const requestId = crypto.randomUUID();
  const pending = { workspaceId, sessionId, requestId, unsubscribe: () => {} };
  requests.set(identity, pending);
  const release = () => {
    pending.unsubscribe();
    if (requests.get(identity) === pending) requests.delete(identity);
  };
  const opened = await workspaceCommand(workspaceId, { type: 'openTab', resourceId });
  if (!opened?.ok || requests.get(identity) !== pending) {
    release();
    return opened;
  }
  // React publishes native bounds from useLayoutEffect before picking starts.
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  if (requests.get(identity) !== pending) return null;
  pending.unsubscribe = workspaceStore.subscribe(() => {
    if (requests.get(identity) !== pending) return;
    const session = workspaceStore
      .get()
      .snapshot?.workspaces.find((w) => w.workspaceId === workspaceId)
      ?.sessions.find((s) => s.sessionId === sessionId);
    const receipt = session?.captureRequest;
    if (receipt?.requestId !== requestId || receipt.resourceId !== resourceId) return;
    if (receipt.state === 'completed') {
      release();
      void locateSession({ workspaceId, sessionId, view: 'context' });
    } else if (receipt.state === 'failed' || receipt.state === 'cancelled') release();
  });
  const result = await workspaceCommand(workspaceId, { type: 'captureContext', sessionId, resourceId, requestId });
  if (!result?.ok && requests.get(identity) === pending) {
    release();
  }
  return result;
}
export function cancelContextCapture(workspaceId: string, resourceId: string) {
  const identity = key(workspaceId, resourceId);
  const pending = requests.get(identity);
  if (!pending) throw new Error('当前页面没有由此工作台发起的采集请求');
  pending.unsubscribe();
  requests.delete(identity);
  return workspaceCommand(workspaceId, { type: 'cancelCapture', resourceId, requestId: pending.requestId });
}
