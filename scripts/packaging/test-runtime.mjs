/* global process, console */
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { setTimeout, clearTimeout } from 'node:timers';
import path from 'node:path';
import { root } from './payload-lib.mjs';

// Fail before the suite with a bounded diagnostic, without dumping argv, env or stderr.
for (const [tool, binary, args] of [
  ['rg', 'rg', ['--version']],
  [
    'bundled-python-pty',
    process.env.WSL_TEST_PYTHON,
    [
      '-I',
      '-B',
      '-c',
      'import json,os,pty,ssl,sys; fds=pty.openpty(); [os.close(fd) for fd in fds]; print(json.dumps({"version":sys.version.split()[0],"pty":"ready","ssl":ssl.OPENSSL_VERSION}))',
    ],
  ],
]) {
  if (!binary || (tool === 'bundled-python-pty' && !path.isAbsolute(binary)))
    throw new Error('WSL_TEST_PYTHON must select the prepared absolute Python executable');
  const started = Date.now();
  const result = spawnSync(binary, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 4096 });
  const diagnostic = {
    tool,
    elapsedMs: Date.now() - started,
    status: result.status,
    signal: result.signal,
    error: result.error?.code ?? null,
  };
  console.log(JSON.stringify(diagnostic));
  if (result.error || result.status !== 0) throw new Error(`${tool} preflight failed`);
  console.log(result.stdout.trim());
}

// Exercise the original helper and shell integration on its first invocation.
// Five seconds to ready, then owned cleanup; ten seconds total, with no retry.
const helper = await readFile(path.join(root, 'apps/service/src/local-terminal.py'), 'utf8');
const rc = await readFile(path.join(root, 'apps/service/src/terminal-zsh-integration.sh'));
const started = Date.now();
const result = await new Promise((resolve) => {
  const child = spawn(process.env.WSL_TEST_PYTHON, ['-I', '-B', '-u', '-c', helper], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let readyMs = null;
  let cleanup = false;
  let failure = null;
  let closing = false;
  function close() {
    if (closing) return;
    closing = true;
    child.stdin.write('{"type":"close"}\n');
  }
  const readiness = setTimeout(() => {
    failure = 'ready-deadline';
    close();
  }, 5000);
  const deadline = setTimeout(() => {
    failure ??= 'cleanup-deadline';
    child.kill('SIGKILL'); // Only the helper created by this probe; never claim cleanup.
  }, 10000);
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume();
  child.stdin.on('error', () => {
    failure ??= 'input-closed';
  });
  child.once('error', () => {
    failure ??= 'spawn-failed';
  });
  lines.on('line', (line) => {
    try {
      const frame = JSON.parse(line);
      if (frame.type === 'ready') {
        readyMs = Date.now() - started;
        clearTimeout(readiness);
        console.log(JSON.stringify({ tool: 'local-pty', phase: 'ready', elapsedMs: readyMs }));
        close();
      } else if (frame.type === 'cleanup') cleanup = frame.ok === true;
    } catch {
      failure ??= 'invalid-frame';
      close();
    }
  });
  child.once('close', (status, signal) => {
    clearTimeout(readiness);
    clearTimeout(deadline);
    lines.close();
    resolve({ tool: 'local-pty', phase: 'closed', readyMs, elapsedMs: Date.now() - started, status, signal, cleanup, failure });
  });
  child.stdin.write(JSON.stringify({ shell: '/bin/zsh', cwd: root, cols: 80, rows: 24, rc: rc.toString('base64') }) + '\n');
});
console.log(JSON.stringify(result));
if (result.failure || result.readyMs === null || !result.cleanup || result.status !== 0)
  throw new Error('Local PTY startup/cleanup preflight failed');
