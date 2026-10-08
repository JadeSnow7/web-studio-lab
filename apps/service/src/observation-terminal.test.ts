import { describe, expect, it } from 'vitest';
import { TerminalObservation } from './observation-terminal';
const resource = {
  workspaceId: 'test',
  environmentId: 'local',
  resourceId: 'pty1',
  instanceId: 'pty-instance',
  instanceGeneration: 1,
  kind: 'terminal' as const,
};
function observer(limit = 262144) {
  return new TerminalObservation(resource, 'session1', 20, 4, limit);
}
describe('terminal observation', () => {
  it('parses CR redraw, wide characters, alternate buffer and restores normal', async () => {
    const terminal = observer();
    terminal.append('progress 0\rprogress 9\r\n中文');
    const screen = await terminal.readScreen();
    expect(JSON.stringify(screen.data)).toContain('progress 9');
    expect(JSON.stringify(screen.data)).toContain('中文');
    terminal.append('\x1b[?1049h\x1b[2J\x1b[Halternate');
    expect((await terminal.readScreen()).data).toMatchObject({ buffer: 'alternate' });
    terminal.append('\x1b[?1049l');
    expect(JSON.stringify((await terminal.readScreen()).data)).toContain('progress 9');
    terminal.dispose();
  });
  it('binds cursor to resource and generation, exposes eviction and large chunk truncation', async () => {
    const terminal = observer(10);
    terminal.append('123456789012345');
    const result = terminal.readOutput({ maxChars: 2 });
    expect(result.coverage.status).toBe('partial');
    expect(result.data).toMatchObject({ droppedChars: 5 });
    const cursor = result.nextCursor;
    terminal.append('nextchunk!');
    expect(() => terminal.readOutput({ cursor })).toThrow('gap');
    expect(() => observer().readOutput({ cursor })).toThrow('stale_cursor');
    await terminal.readScreen();
    terminal.dispose();
  });
  it('records resize and reads explicit scrollback without pretending UI viewport', async () => {
    const terminal = observer();
    terminal.append('one\r\ntwo\r\nthree\r\nfour\r\nfive');
    expect(JSON.stringify((await terminal.readScreen({ viewportY: 0 })).data)).toContain('one');
    terminal.resize(30, 5);
    expect((await terminal.readScreen()).data).toMatchObject({ cols: 30, rows: 5, processedSeq: 2 });
    expect(JSON.stringify(terminal.readOutput().data)).toContain('resize');
    terminal.dispose();
  });
  it('does not equate PTY close with individual command success', async () => {
    const terminal = observer();
    terminal.append('\x1b]777;wsl;start;ZmFsc2U=;L3RtcA==\x07');
    await terminal.readScreen();
    terminal.close();
    expect((await terminal.readCommand()).data).toMatchObject({ commands: [{ status: 'unknown', exitCode: null }] });
    terminal.dispose();
  });
  it.each(['999', '256', '-1', '1x', '01', '0;extra'])('rejects invalid command exit marker %s as unknown', async (exit) => {
    const terminal = observer();
    terminal.append('\x1b]777;wsl;start;ZmFsc2U=;L3RtcA==\x07');
    terminal.append(`\x1b]777;wsl;end;${exit}\x07`);
    terminal.append('\x1b]777;wsl;end;0\x07');
    expect((await terminal.readCommand()).data).toMatchObject({ commands: [{ status: 'unknown', exitCode: null, endedAt: null }] });
    terminal.dispose();
  });
  it.each(['%%%=', 'ZmFsc2U', 'Zh==', '/w==', 'AA=='])('rejects noncanonical base64 or invalid UTF-8 %s', async (value) => {
    const terminal = observer();
    terminal.append(`\x1b]777;wsl;start;${value};L3RtcA==\x07\x1b]777;wsl;end;0\x07`);
    expect((await terminal.readCommand()).data).toMatchObject({ commands: [], integration: 'not_observed' });
    terminal.dispose();
  });
  it('invalid cwd invalidates the previous command instead of assigning a later exit to it', async () => {
    const terminal = observer();
    terminal.append('\x1b]777;wsl;start;ZmFsc2U=;L3RtcA==\x07');
    terminal.append('\x1b]777;wsl;start_full;dHJ1ZQ==;/w==\x07\x1b]777;wsl;end;0\x07');
    expect((await terminal.readCommand()).data).toMatchObject({ commands: [{ command: 'false', status: 'unknown', exitCode: null }] });
    terminal.dispose();
  });
});

it('rejects disposed terminal reads including an already queued screen request', async () => {
  const terminal = observer();
  terminal.append('pending');
  const pending = terminal.readScreen();
  terminal.dispose();
  await expect(pending).rejects.toThrow('unavailable');
  expect(() => terminal.readOutput()).toThrow('unavailable');
  await expect(terminal.readCommand()).rejects.toThrow('unavailable');
});

it('late PTY output after disposal does not enqueue a write into the released emulator', async () => {
  const terminal = observer();
  terminal.dispose();
  expect(() => terminal.append('late bytes')).not.toThrow();
  expect(() => terminal.resize(80, 24)).toThrow('unavailable');
  terminal.dispose();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(() => terminal.readOutput()).toThrow('unavailable');
});
