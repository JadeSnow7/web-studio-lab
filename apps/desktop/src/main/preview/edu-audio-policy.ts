export interface EduAudioBinding {
  workspaceId: string;
  resourceId: string;
  instanceId: string;
  instanceGeneration: number;
  appInstanceId: string;
  origin: string;
  webContentsId: number;
  documentGeneration: number;
  url: string;
  visible: boolean;
  activeWorkspace: boolean;
  running: boolean;
  monitorReady: boolean;
}
export interface EduAudioRequest {
  webContentsId: number | null;
  permission: string;
  isMainFrame: boolean;
  requestingUrl: string | undefined;
  requestingOrigin: string | undefined;
  mediaTypes: readonly string[];
}
/** Both Electron handlers authorize exactly the same current student/audio tuple. */
export function allowsEduAudio(binding: EduAudioBinding | null, request: EduAudioRequest): boolean {
  if (
    !binding ||
    !binding.visible ||
    !binding.activeWorkspace ||
    !binding.running ||
    !binding.monitorReady ||
    request.permission !== 'media' ||
    !request.isMainFrame ||
    request.webContentsId !== binding.webContentsId ||
    request.mediaTypes.length !== 1 ||
    request.mediaTypes[0] !== 'audio' ||
    !request.requestingUrl
  )
    return false;
  try {
    const current = new URL(binding.url);
    const requested = new URL(request.requestingUrl);
    const origin = request.requestingOrigin === undefined ? null : new URL(request.requestingOrigin);
    return (
      current.origin === binding.origin &&
      requested.origin === binding.origin &&
      current.pathname === '/student' &&
      requested.pathname === '/student' &&
      !current.username &&
      !current.password &&
      !requested.username &&
      !requested.password &&
      (origin === null ||
        (origin.origin === binding.origin &&
          origin.pathname === '/' &&
          !origin.username &&
          !origin.password &&
          !origin.search &&
          !origin.hash))
    );
  } catch {
    return false;
  }
}
