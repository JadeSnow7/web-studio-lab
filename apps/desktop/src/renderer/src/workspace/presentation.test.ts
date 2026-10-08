import { describe, expect, it } from 'vitest';
import type { WorkbenchSession, WorkspaceSnapshot, Observation } from '@wsl/protocol';
import { reorderTabIds, sessionSelection, terminalDelta, observationImage } from './presentation';
describe('workspace presentation ownership', () => {
  it('dropping a tab onto itself keeps the exact order', () => {
    expect(reorderTabIds(['a', 'b', 'c'], 'a', 'a')).toEqual(['a', 'b', 'c']);
    expect(reorderTabIds(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  });
  it('historical version chooses its own conversation, including an unrun version', () => {
    const session = {
      sessionId: 's',
      taskVersions: [{ taskVersionId: 'v1' }, { taskVersionId: 'v2' }, { taskVersionId: 'v3' }],
      conversation: { messages: ['latest'] },
    } as unknown as WorkbenchSession;
    const runs = [
      { sessionId: 's', runId: 'r1', taskVersionId: 'v1', conversation: { messages: ['old'] } },
      { sessionId: 's', runId: 'r2', taskVersionId: 'v2', conversation: { messages: ['latest'] } },
    ] as unknown as WorkspaceSnapshot['runs'];
    expect(sessionSelection(session, runs, 'v1', '').conversation?.messages).toEqual(['old']);
    expect(sessionSelection(session, runs, 'v3', '').conversation).toBeUndefined();
    expect(sessionSelection(session, runs, '', '').conversation).toBe(session.conversation);
  });
  it('provider offset zero appends only new characters before any clipping', () => {
    const previous = { instanceId: 'i', sessionId: 'pty', output: 'abc', offset: 0 };
    expect(terminalDelta(previous, { ...previous, output: 'abcd' })).toEqual({ reset: false, text: 'd', gap: false });
    expect(terminalDelta(previous, previous)).toEqual({ reset: false, text: '', gap: false });
  });
  it('repeated text with a new absolute offset is appended, not dropped', () => {
    const previous = { instanceId: 'i', sessionId: 'pty', output: 'abc', offset: 0 };
    expect(terminalDelta(previous, { ...previous, offset: 3 })).toEqual({ reset: false, text: 'abc', gap: false });
  });
  it('overlapping retained window appends only unread bytes and reports a lost window', () => {
    const previous = { instanceId: 'i', sessionId: 'pty', output: 'abc', offset: 0 };
    expect(terminalDelta(previous, { ...previous, output: 'bcd', offset: 1 })).toEqual({ reset: false, text: 'd', gap: false });
    expect(terminalDelta(previous, { ...previous, output: 'xyz', offset: 6 })).toEqual({ reset: true, text: 'xyz', gap: true });
    expect(terminalDelta(previous, { ...previous, sessionId: 'replacement', offset: 0 })).toEqual({ reset: true, text: 'abc', gap: false });
  });
});

it('renders raster observation data while rejecting SVG or non-data URLs', () => {
  const observation = (data: Record<string, unknown>) => ({ data }) as Observation;
  expect(observationImage(observation({ mediaType: 'image/png', base64: 'YWJj' }))).toBe('data:image/png;base64,YWJj');
  expect(observationImage(observation({ dataUrl: 'data:image/jpeg;base64,YWJj' }))).toBe('data:image/jpeg;base64,YWJj');
  expect(observationImage(observation({ mediaType: 'image/svg+xml', base64: 'YWJj' }))).toBeNull();
  expect(observationImage(observation({ dataUrl: 'https://outside/image.png' }))).toBeNull();
});
