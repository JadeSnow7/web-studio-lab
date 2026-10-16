import { describe, expect, it } from 'vitest';
import { allowsEduAudio, type EduAudioBinding, type EduAudioRequest } from './edu-audio-policy';
const binding: EduAudioBinding = {
  workspaceId: 'w',
  resourceId: 'r',
  instanceId: 'i',
  instanceGeneration: 2,
  appInstanceId: 'app',
  origin: 'http://127.0.0.1:8000',
  webContentsId: 42,
  documentGeneration: 5,
  url: 'http://127.0.0.1:8000/student',
  visible: true,
  activeWorkspace: true,
  running: true,
  monitorReady: true,
};
const request: EduAudioRequest = {
  webContentsId: 42,
  permission: 'media',
  isMainFrame: true,
  requestingUrl: binding.url,
  requestingOrigin: binding.origin,
  mediaTypes: ['audio'],
};
describe('edu audio permission tuple', () => {
  it('allows only the current student audio main frame', () => expect(allowsEduAudio(binding, request)).toBe(true));
  it.each([
    { permission: 'display-capture' },
    { mediaTypes: ['video'] },
    { mediaTypes: ['audio', 'video'] },
    { mediaTypes: [] },
    { mediaTypes: ['unknown'] },
    { isMainFrame: false },
    { webContentsId: 43 },
    { webContentsId: null },
    { requestingUrl: 'http://127.0.0.1:8001/student' },
    { requestingOrigin: 'https://other.example' },
    { requestingOrigin: binding.origin + '/student' },
    { requestingOrigin: binding.origin + '/?q=1' },
    { requestingUrl: 'http://127.0.0.1:8000/admin' },
    { requestingUrl: undefined },
    { requestingUrl: 'http://user:pass@127.0.0.1:8000/student' },
    { requestingUrl: 'bad url' },
  ])('denies request %j', (change) => expect(allowsEduAudio(binding, { ...request, ...change })).toBe(false));
  it.each([
    { visible: false },
    { activeWorkspace: false },
    { running: false },
    { monitorReady: false },
    { url: 'http://127.0.0.1:8000/admin' },
    { url: 'http://127.0.0.1:8001/student' },
  ])('denies inactive binding %j', (change) => expect(allowsEduAudio({ ...binding, ...change }, request)).toBe(false));
  it('accepts Electron origin serialization with a trailing root slash', () =>
    expect(allowsEduAudio(binding, { ...request, requestingOrigin: binding.origin + '/' })).toBe(true));
  it('denies absent or revoked instances', () => expect(allowsEduAudio(null, request)).toBe(false));
});
