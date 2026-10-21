import { describe, expect, it } from 'vitest';
import { SbxConnection } from './sbx';

const live = process.env['WSL_P0_PREFLIGHT'] === '1';

describe.skipIf(!live)('P0 guest preflight without a model', () => {
  it('uses the product bash PTY with OSC command integration and confirms cleanup', async () => {
    const connection = new SbxConnection();
    expect((await connection.initialize()).available).toBe(true);
    let text = '';
    let ready = false;
    const child = connection.start({ type: 'start', mode: 'terminal', cols: 90, rows: 30 }, (frame) => {
      if (frame.type === 'ready') ready = true;
      if (frame.type === 'output') text += frame.data;
    });
    const command = 'printf \'WSL_P0_BASH:%s\\n\' "$BASH_VERSION"';
    try {
      await expect.poll(() => ready, { timeout: 30000 }).toBe(true);
      child.write({ type: 'input', data: command + '\r' });
      await expect.poll(() => text, { timeout: 30000 }).toMatch(/WSL_P0_BASH:5\.[0-9]+/);
      await expect.poll(() => text, { timeout: 30000 }).toContain('\u001b]777;wsl;end;0\u0007');
      const commands = text
        .split('\u001b]777;wsl;start;')
        .slice(1)
        .map((frame) => {
          const fields = frame.split('\u0007')[0]?.split(';');
          return {
            command: Buffer.from(fields?.[0] ?? '', 'base64').toString('utf8'),
            cwd: Buffer.from(fields?.[1] ?? '', 'base64').toString('utf8'),
          };
        });
      expect(commands).toContainEqual({ command, cwd: '/home/agent/workspace' });
    } finally {
      const outcome = await child.close();
      expect(outcome.confirmed).toBe(true);
      expect(outcome.error).toBeNull();
    }
  }, 90000);
});
