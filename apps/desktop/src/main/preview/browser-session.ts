import type { Session } from 'electron';
import { isAllowedPreviewUrl, isBrowserUrl } from './navigation-policy';

interface Owner {
  managedAppOrigin?(): string | null;
  allowedOrigins: readonly string[];
  devToolsWebContentsId(): number | undefined;
}
interface BrowserSession {
  owners: Map<number, Owner>;
  cancelDownload(event: Electron.Event): void;
}
const sessions = new WeakMap<Session, BrowserSession>();

/** Electron permits one request listener per session; all views in a workspace share it. */
export function acquireBrowserSession(session: Session, webContentsId: number, owner: Owner): () => void {
  let state = sessions.get(session);
  if (!state) {
    state = { owners: new Map(), cancelDownload: (event) => event.preventDefault() };
    const current = state;
    session.webRequest.onBeforeRequest((details, callback) => {
      const policy = details.webContentsId === undefined ? undefined : current.owners.get(details.webContentsId);
      if (!policy) {
        const worker =
          (details.webContentsId === undefined || details.webContentsId <= 0) &&
          [...current.owners.values()].some((candidate) => !candidate.managedAppOrigin);
        if (worker && /^(?:https?|wss?):/u.test(details.url)) {
          callback({ cancel: false });
          return;
        }
        const tools = [...current.owners.values()].some((candidate) => candidate.devToolsWebContentsId() === details.webContentsId);
        let bundled: boolean;
        try {
          const url = new URL(details.url);
          bundled =
            url.href === details.url && url.protocol === 'devtools:' && url.host === 'devtools' && url.pathname.startsWith('/bundled/');
        } catch {
          callback({ cancel: true });
          return;
        }
        callback({ cancel: !(tools && bundled && details.method === 'GET') });
        return;
      }
      if (policy.managedAppOrigin) {
        const origin = policy.managedAppOrigin();
        callback({
          cancel:
            !origin ||
            !isAllowedPreviewUrl(details.url, [origin]) ||
            !isAllowedPreviewUrl(details.url, policy.allowedOrigins) ||
            !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(details.method),
        });
        return;
      }
      const protocol = new URL(details.url).protocol;
      // Chromium keeps normal page/subresource semantics, including generated blob/data resources.
      callback({
        cancel: !(
          isBrowserUrl(details.url) ||
          ['ws:', 'wss:', 'blob:', 'data:'].includes(protocol) ||
          isAllowedPreviewUrl(details.url, policy.allowedOrigins)
        ),
      });
    });
    session.on('will-download', state.cancelDownload);
    sessions.set(session, state);
  }
  state.owners.set(webContentsId, owner);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.owners.delete(webContentsId);
    if (state.owners.size !== 0) return;
    session.webRequest.onBeforeRequest(null);
    session.removeListener('will-download', state.cancelDownload);
    sessions.delete(session);
  };
}
