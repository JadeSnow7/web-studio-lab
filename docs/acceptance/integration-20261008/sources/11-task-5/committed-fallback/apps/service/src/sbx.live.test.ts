import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { describe, expect, it } from 'vitest';
import helper from './guest-helper.py?raw';
import { GUEST_CWD, SbxConnection, resolveSbxBinary, type GuestFrame } from './sbx';

const live = process.env['WSL_LIVE_SBX'] === '1';
const background =
  "import subprocess,time; p=subprocess.Popen(['sleep','60'],start_new_session=True); print('BG_PID:'+str(p.pid),flush=True); time.sleep(60)";
async function assertGone(connection: SbxConnection, pid: number) {
  let output = '';
  const probe = connection.start(
    {
      type: 'start',
      mode: 'codex',
      argv: [
        'python3',
        '-c',
        `import os\ntry: os.kill(${pid},0)\nexcept ProcessLookupError: print('GONE')\nelse: raise RuntimeError('owned process still exists')`,
      ],
    },
    (frame) => {
      if (frame.type === 'output' && frame.stream === 'stdout') output += frame.data;
    },
  );
  const result = await probe.done;
  expect(result.confirmed).toBe(true);
  expect(result.error).toBeNull();
  expect(result.exitCode).toBe(0);
  expect(output.trim()).toBe('GONE');
}
describe.skipIf(!live)('真实 sbx guest 生命周期（不调模型）', () => {
  it('PTY尺寸、持久cwd、CtrlC保留shell、close清理后台job', async () => {
    const connection = new SbxConnection();
    expect((await connection.initialize()).available).toBe(true);
    let text = '';
    const child = connection.start({ type: 'start', mode: 'terminal', cols: 90, rows: 31 }, (frame) => {
      if (frame.type === 'ready') console.log('PTY guest session pid', frame.pid);
      if (frame.type === 'output') text += frame.data;
    });
    try {
      await expect.poll(() => text, { timeout: 30000 }).toContain('bash');
      child.write({ type: 'input', data: 'stty size; cd /tmp; pwd; sleep 60 & printf \'BG_PID:%s\\n\' "$!"\r' });
      await expect.poll(() => text).toMatch(/BG_PID:\d+/);
      const pid = Number(text.match(/BG_PID:(\d+)/)![1]);
      expect(text).toContain('31 90');
      expect(text).toContain('/tmp');
      child.write({
        type: 'input',
        data: `python3 -c "import subprocess; p=subprocess.Popen(['sleep','60'],start_new_session=True); print('DETACHED_PID:'+str(p.pid))"\r`,
      });
      await expect.poll(() => text).toMatch(/DETACHED_PID:\d+/);
      const detachedPid = Number(text.match(/DETACHED_PID:(\d+)/)![1]);
      child.write({ type: 'resize', cols: 110, rows: 42 });
      child.write({ type: 'input', data: 'stty size\r' });
      await expect.poll(() => text).toContain('42 110');
      child.write({
        type: 'input',
        data: `python3 -u -c "import os,time; print('FG_PID:'+str(os.getpid()),flush=True); time.sleep(60)"\r`,
      });
      await expect.poll(() => text).toMatch(/FG_PID:\d+/);
      const foregroundPid = Number(text.match(/FG_PID:(\d+)/)![1]);
      child.write({ type: 'input', data: '\u0003' });
      child.write({ type: 'input', data: "printf 'SHELL_ALIVE\\n'; pwd\r" });
      await expect.poll(() => text).toMatch(/SHELL_ALIVE\r?\n/);
      const outcome = await child.close();
      expect(outcome.confirmed).toBe(true);
      expect(outcome.error).toBeNull();
      console.log('PTY close cleanup', outcome, 'background pid', pid);
      await assertGone(connection, pid);
      await assertGone(connection, detachedPid);
      await assertGone(connection, foregroundPid);
    } finally {
      await child.close();
    }
  }, 60000);
  it('非TTY cancel与控制stdin EOF均确认清理所属后台job', async () => {
    const connection = new SbxConnection();
    expect((await connection.initialize()).available).toBe(true);
    let output = '';
    const child = connection.start({ type: 'start', mode: 'codex', argv: ['python3', '-u', '-c', background] }, (frame) => {
      if (frame.type === 'ready') console.log('nonTTY guest session pid', frame.pid);
      if (frame.type === 'output') output += frame.data;
    });
    try {
      await expect.poll(() => output, { timeout: 30000 }).toMatch(/BG_PID:\d+/);
      const pid = Number(output.match(/BG_PID:(\d+)/)![1]);
      const outcome = await child.close();
      expect(outcome.confirmed).toBe(true);
      expect(outcome.error).toBeNull();
      console.log('nonTTY cancel cleanup', outcome, 'background pid', pid);
      await assertGone(connection, pid);
    } finally {
      await child.close();
    }
    // EOF is tested on the real sbx pipe rather than a renderer command.
    const sandbox = process.env['WSL_SBX_NAME']!;
    const host = spawn(await resolveSbxBinary(), ['exec', '-i', '-w', GUEST_CWD, sandbox, 'python3', '-u', '-c', helper], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const frames: GuestFrame[] = [];
    const lines = createInterface({ input: host.stdout });
    lines.on('line', (line) => {
      if (line === `Sandbox ${sandbox} started successfully`) return;
      expect(line.startsWith('WSL_GUEST_FRAME:')).toBe(true);
      frames.push(JSON.parse(line.slice('WSL_GUEST_FRAME:'.length)) as GuestFrame);
    });
    let stderr = '';
    host.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const exit = new Promise<number | null>((resolve, reject) => {
      host.once('error', reject);
      host.once('close', resolve);
    });
    host.stdin.write(JSON.stringify({ type: 'start', mode: 'codex', argv: ['python3', '-u', '-c', background] }) + '\n');
    let eofPid: number;
    try {
      await expect
        .poll(
          () =>
            frames
              .filter((frame) => frame.type === 'output')
              .map((frame) => (frame.type === 'output' ? frame.data : ''))
              .join(''),
          { timeout: 30000 },
        )
        .toMatch(/BG_PID:\d+/);
      const output = frames
        .filter((frame) => frame.type === 'output')
        .map((frame) => (frame.type === 'output' ? frame.data : ''))
        .join('');
      eofPid = Number(output.match(/BG_PID:(\d+)/)![1]);
    } finally {
      host.stdin.end();
    }

    expect(await exit, stderr).toBe(0);
    expect(frames.some((frame) => frame.type === 'cleanup' && frame.ok)).toBe(true);
    const ready = frames.find((frame) => frame.type === 'ready');
    console.log(
      'EOF cleanup',
      frames.filter((frame) => frame.type !== 'output'),
    );
    expect(ready?.type).toBe('ready');
    if (ready?.type === 'ready') await assertGone(connection, ready.pid);
    await assertGone(connection, eofPid);
  }, 60000);
});
