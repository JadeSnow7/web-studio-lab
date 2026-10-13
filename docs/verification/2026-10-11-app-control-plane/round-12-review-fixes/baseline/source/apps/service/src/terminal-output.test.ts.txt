import { expect, it, vi } from 'vitest';
import type { GuestFrame } from './sbx';
const fixture = vi.hoisted(() => ({ frame: null as null | ((frame: GuestFrame) => void) }));
vi.mock('./sbx', () => ({
  SbxConnection: class {
    getStatus() {
      return { available: true, sandbox: 'fixture', cwd: '/authorized', reason: null, version: 'fixture' };
    }
    start(_start: unknown, frame: (frame: GuestFrame) => void) {
      fixture.frame = frame;
      return { done: new Promise(() => {}), close: async () => ({ confirmed: true, error: null, exitCode: 0 }), write: vi.fn() };
    }
  },
}));
import { SbxConnection } from './sbx';
import { Terminal } from './terminal';
it('tracks the same sandbox PTY stream after its visible output window rolls over', async () => {
  const terminal = new Terminal(
    new SbxConnection(),
    { workspaceId: 'w', environmentId: 'sandbox', resourceId: 'terminal', kind: 'terminal', instanceId: 'instance', instanceGeneration: 1 },
    () => {},
  );
  await terminal.open(80, 24);
  for (let n = 0; n < 5; n++) fixture.frame!({ type: 'output', stream: 'stdout', data: 'x'.repeat(65536) });
  expect(terminal.get().outputOffset).toBe(65536);
  const first = terminal.observation!.readOutput({ maxChars: 65536 });
  expect(first.coverage.status).toBe('partial');
  expect(first.data.records).toMatchObject([{ data: 'x'.repeat(65536) }]);
  fixture.frame!({ type: 'output', stream: 'stdout', data: 'AFTER_WINDOW' });
  expect(terminal.get().output.endsWith('AFTER_WINDOW')).toBe(true);
  expect(terminal.get().outputOffset).toBe(65536 + 'AFTER_WINDOW'.length);
  let cursor = first.nextCursor!;
  for (let n = 0; n < 3; n++) {
    const next = terminal.observation!.readOutput({ cursor, maxChars: 65536 });
    expect(next.resource).toEqual(first.resource);
    expect(next.data.records).toMatchObject([{ data: 'x'.repeat(65536) }]);
    cursor = next.nextCursor!;
  }
  expect(terminal.observation!.readOutput({ cursor, maxChars: 65536 }).data.records).toMatchObject([{ data: 'AFTER_WINDOW' }]);
  await terminal.shutdown();
});
