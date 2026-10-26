import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { expect, it } from 'vitest';

const fixture = path.resolve('e2e/fixtures/sbx.mjs');
const close = `${JSON.stringify({ type: 'close' })}\n`;
const start = (argv: string[]) => `${JSON.stringify({ type: 'start', stdin: 'relay', mode: 'codex', argv })}\n`;

function stopFixtureGroup(pid: number) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

async function within<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withFixture(
  check: (fixture: {
    write: (input: string) => void;
    output: () => string;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  }) => Promise<void>,
) {
  // The regression intentionally exercises kill(0) on broken versions. Its group must never include the test runner.
  const child = spawn(process.execPath, [fixture, 'exec', '-i', 'fixture-sandbox', 'python3'], { detached: true });
  let output = '';
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  let ownedGroup: number | undefined;
  try {
    await within(
      (async () => {
        await once(child, 'spawn');
        const pid = child.pid;
        if (pid === undefined) throw new Error('Fixture did not receive a process identity');
        // A successful zero signal verifies that detached spawn established the group before any protocol input.
        process.kill(-pid, 0);
        ownedGroup = pid;
        await check({ write: (input) => void child.stdin.write(input), output: () => output, exited });
      })(),
      3000,
      'Fixture check did not finish',
    );
  } finally {
    try {
      if (ownedGroup !== undefined) stopFixtureGroup(ownedGroup);
    } finally {
      await within(exited, 1000, 'Owned fixture did not close after cleanup');
    }
  }
}

it('E2E sbx fixture accounts for failed relay spawn before a close in the same input chunk', async () => {
  await withFixture(async ({ write, output, exited }) => {
    write(start(['/missing/wsl-relay-command']) + close);
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(output()).toContain('ENOENT');
    expect(output()).toContain('"type":"exit","exitCode":127');
    expect(output()).toContain('"type":"cleanup","ok":true');
  });
});

it('E2E sbx fixture closes a valid relay when close arrives before its spawn event', async () => {
  await withFixture(async ({ write, output, exited }) => {
    write(start([process.execPath, '-e', 'process.stdin.resume()']) + close);
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(output()).toContain('"type":"exit","exitCode":1');
    expect(output()).toContain('"type":"cleanup","ok":true');
  });
});

it('E2E sbx fixture still cancels its successfully started relay process', async () => {
  await withFixture(async ({ write, output, exited }) => {
    write(start([process.execPath, '-e', 'console.log("child-ready:" + process.pid); process.stdin.resume()']));
    await expect.poll(output).toContain('child-ready:');
    const pid = /child-ready:(\d+)/.exec(output())?.[1];
    if (!pid) throw new Error('Relay did not report its process identity');
    write(close);
    expect(await exited).toEqual({ code: 0, signal: null });
    expect(output()).toContain('"type":"exit","exitCode":1');
    expect(output()).toContain('"type":"cleanup","ok":true');
    expect(() => process.kill(Number(pid), 0)).toThrowError(expect.objectContaining({ code: 'ESRCH' }));
  });
});
