import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import helper from './guest-helper.py?raw';
import type { GuestFrame } from './sbx';

// Actual Linux helper/process tests. Python edits are lifecycle stimuli, never an
// Agent substitute and never connected to the frozen VS001 acceptance runner.
const roots: string[] = [];
// The managed execution host can virtualize /proc ancestry/session fields. The
// real guest cleanup tests require a faithful process table; unknown is not pass.
const faithfulProc =
  process.platform === 'linux' &&
  execFileSync(
    'python3',
    [
      '-c',
      "import os\nf=open('/proc/self/stat').read().rsplit(')',1)[1].split()\nprint(int(int(f[1])==os.getppid() and int(f[3])==os.getsid(0)))",
    ],
    { encoding: 'utf8' },
  ).trim() === '1';
if (process.platform === 'linux' && !faithfulProc)
  console.info(
    'NOT_RUN guest close/EOF descendant tests: host /proc PPID/session fields differ from process-reported identities; genuine sbx guest cleanup remains unverified.',
  );
function birth(pid: number): string | undefined {
  try {
    return readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').at(-1)?.trim().split(/\s+/)[19];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
function killRecorded(item: { pid: number; birth: string }): void {
  if (birth(item.pid) !== item.birth) return;
  try {
    process.kill(item.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function startProbe(script: string, injectCleanupFailure = false) {
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-guest-workspace-test-'));
  roots.push(root);
  const marker = '\ntry:\n    start = read_start()';
  const prefix = helper.slice(0, helper.lastIndexOf(marker));
  // A synthetic confirmation failure after the real, descendant-free child has
  // stopped exercises preservation; this never changes production helper code.
  const stimulus = injectCleanupFailure
    ? '\nconfirmed_cleanup = cleanup\ndef cleanup(sid, child):\n    confirmed_cleanup(sid, child)\n    raise RuntimeError("synthetic cleanup confirmation failure")\n'
    : '';
  const child = spawn('python3', ['-u', '-c', `${prefix}\nCWD = sys.argv[1]\n${stimulus}\nmain(read_start())\n`, root], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const frames: GuestFrame[] = [];
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => frames.push(JSON.parse(line.slice('WSL_GUEST_FRAME:'.length)) as GuestFrame));
  const done = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const runId = randomUUID();
  child.stdin.write(
    JSON.stringify({
      type: 'start',
      mode: 'codex',
      argv: ['python3', '-u', '-c', script],
      workspace: { runId, files: [{ path: 'src/App.tsx', base64: Buffer.from('before').toString('base64') }] },
    }) + '\n',
  );
  return { root, child, frames, done, runId, stderr: () => stderr };
}

describe.skipIf(process.platform !== 'linux')('actual guest run-copy and cleanup boundaries', () => {
  it('returns the complete inventory after nonzero exit, then removes its exclusive directory', async () => {
    const probe = await startProbe(
      "from pathlib import Path\nPath('src/App.tsx').write_text('changed')\nPath('extra.txt').write_text('outside allowed delta')\nprint('final stdout',flush=True)\nimport sys\nprint('final stderr',file=sys.stderr,flush=True)\nsys.exit(7)",
    );
    try {
      expect(await probe.done, probe.stderr()).toBe(0);
      expect(probe.frames.find((frame) => frame.type === 'exit')).toEqual({ type: 'exit', exitCode: 7 });
      const snapshot = probe.frames.find((frame) => frame.type === 'workspace');
      expect(snapshot).toMatchObject({ runId: probe.runId, files: [{ path: 'extra.txt' }, { path: 'src/App.tsx' }] });
      expect(
        probe.frames
          .filter((frame) => frame.type === 'output')
          .map((frame) => frame.type === 'output' && frame.data)
          .join(''),
      ).toContain('final stderr');
      expect(probe.frames.at(-1)).toEqual({ type: 'cleanup', ok: true });
      expect(await readdir(probe.root)).toEqual([]);
    } finally {
      probe.child.stdin.end();
      if (probe.child.exitCode === null) probe.child.kill('SIGKILL');
      await probe.done;
    }
  });

  it('rejects symlinks without transferring their targets and still confirms directory cleanup', async () => {
    const probe = await startProbe("import os\nos.symlink('/etc/passwd','src/App-link.tsx')");
    try {
      expect(await probe.done, probe.stderr()).toBe(0);
      expect(probe.frames.some((frame) => frame.type === 'error' && frame.error.includes('symlink'))).toBe(true);
      expect(probe.frames.some((frame) => frame.type === 'workspace')).toBe(false);
      expect(probe.frames.at(-1)).toEqual({ type: 'cleanup', ok: true });
      expect(await readdir(probe.root)).toEqual([]);
    } finally {
      probe.child.stdin.end();
      if (probe.child.exitCode === null) probe.child.kill('SIGKILL');
      await probe.done;
    }
  });

  it('retains the exclusive cwd and edits on a synthetic cleanup-confirmation failure (no descendants or model)', async () => {
    const probe = await startProbe("from pathlib import Path\nPath('src/App.tsx').write_text('retained on unknown cleanup')", true);
    try {
      expect(await probe.done, probe.stderr()).toBe(0);
      expect(probe.frames.at(-1)).toEqual({ type: 'cleanup', ok: false, error: 'synthetic cleanup confirmation failure' });
      expect(probe.frames.some((frame) => frame.type === 'workspace')).toBe(false);
      const retained = z
        .object({ type: z.literal('error'), runId: z.uuid(), workspaceDir: z.string(), cleanupConfirmed: z.literal(false) })
        .parse(probe.frames.find((frame) => frame.type === 'error' && frame.error.includes('workspace retained')));
      expect(retained.runId).toBe(probe.runId);
      expect(path.dirname(retained.workspaceDir)).toBe(probe.root);
      expect(path.basename(retained.workspaceDir)).toContain(`wsl-vs001-${probe.runId}-`);
      expect(await readdir(probe.root)).toEqual([path.basename(retained.workspaceDir)]);
      expect(await readFile(path.join(retained.workspaceDir, 'src/App.tsx'), 'utf8')).toBe('retained on unknown cleanup');
      const leader = probe.frames.find((frame) => frame.type === 'ready');
      if (leader?.type === 'ready') expect(() => process.kill(leader.pid, 0)).toThrow();
    } finally {
      probe.child.stdin.end();
      if (probe.child.exitCode === null) probe.child.kill('SIGKILL');
      await probe.done;
    }
  });

  it.skipIf(!faithfulProc).each(['close', 'eof'])(
    `${faithfulProc ? '' : '[not_run: host /proc ancestry/session mismatch] '}%s drains final output, preserves the edit and reaps a detached grandchild before acknowledgment`,
    async (mode) => {
      const probe = await startProbe(
        "import subprocess,signal,time,sys\nfrom pathlib import Path\nPath('src/App.tsx').write_text('cancelled edit')\np=subprocess.Popen(['sleep','60'],start_new_session=True)\nprint('BG_PID:'+str(p.pid),flush=True)\ndef stop(sig,frame):\n print('TAIL_STDOUT',flush=True)\n print('TAIL_STDERR',file=sys.stderr,flush=True)\n sys.exit(0)\nsignal.signal(signal.SIGTERM,stop)\nprint('BODY_READY',flush=True)\ntime.sleep(60)",
      );
      const owned: { pid: number; birth: string }[] = [];
      try {
        await expect
          .poll(
            () =>
              probe.frames
                .filter((frame) => frame.type === 'output')
                .map((frame) => frame.type === 'output' && frame.data)
                .join(''),
            { timeout: 5000 },
          )
          .toContain('BODY_READY');
        const output = probe.frames
          .filter((frame) => frame.type === 'output')
          .map((frame) => frame.type === 'output' && frame.data)
          .join('');
        const detached = Number(output.match(/BG_PID:(\d+)/)![1]);
        const leader = probe.frames.find((frame) => frame.type === 'ready');
        for (const pid of [detached, ...(leader?.type === 'ready' ? [leader.pid] : [])]) {
          const identity = birth(pid);
          if (identity) owned.push({ pid, birth: identity });
        }
        if (mode === 'close') probe.child.stdin.write('{"type":"close"}\n');
        else probe.child.stdin.end();
        expect(await probe.done, probe.stderr()).toBe(0);
        const tail = probe.frames
          .filter((frame) => frame.type === 'output')
          .map((frame) => frame.type === 'output' && frame.data)
          .join('');
        expect(tail).toContain('TAIL_STDOUT');
        expect(tail).toContain('TAIL_STDERR');
        expect(() => process.kill(detached, 0)).toThrow();
        const snapshot = probe.frames.find((frame) => frame.type === 'workspace');
        expect(snapshot?.type === 'workspace' && snapshot.files[0]?.base64).toBe(Buffer.from('cancelled edit').toString('base64'));
        expect(probe.frames.at(-1)).toEqual({ type: 'cleanup', ok: true });
        expect(await readdir(probe.root)).toEqual([]);
      } finally {
        for (const item of owned) killRecorded(item);
        probe.child.stdin.end();
        await Promise.race([probe.done, new Promise<void>((complete) => setTimeout(complete, 1000))]);
        if (probe.child.exitCode === null) probe.child.kill('SIGKILL');
        await probe.done;
      }
    },
    10000,
  );
});
