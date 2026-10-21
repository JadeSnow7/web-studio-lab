/* global process, console */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { StringDecoder } from 'node:string_decoder';
import { clearTimeout, setTimeout } from 'node:timers';
import { z } from 'zod';

const root = path.resolve(import.meta.dirname, '..');
const budgets = { readyMs: 5000, commandMs: 1000, cleanupMs: 5000, forcedReapMs: 1000 };
const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }).strict(),
  z.object({ type: z.literal('output'), data: z.string().max(65536) }).strict(),
  z.object({ type: z.literal('exit'), exitCode: z.number().int() }).strict(),
  z.object({ type: z.literal('cleanup'), ok: z.boolean() }).strict(),
]);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function sample(python, helper, rc, shell, cwd, index) {
  const row = {
    index,
    label: index === 1 ? 'first-in-this-batch' : 'subsequent-in-this-batch',
    status: 'running',
    readyMs: null,
    usableMs: null,
    closeRequestedMs: null,
    cleanupMs: null,
    elapsedMs: null,
    exitCode: null,
    signal: null,
    cleanupAcknowledged: false,
    cleanupConfirmed: false,
    helperReaped: false,
    forcedHelperTermination: false,
    failure: null,
  };
  const started = performance.now();
  const elapsed = () => performance.now() - started;
  let child;
  try {
    child = spawn(python, ['-I', '-B', '-u', '-c', helper], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (error) {
    return { ...row, status: 'failed', elapsedMs: elapsed(), failure: `spawn-failed:${error.code ?? 'unknown'}` };
  }
  row.helperPid = child.pid ?? null;
  return new Promise((resolve) => {
    const decoder = new StringDecoder('utf8');
    const maxFrameChars = 6 * 65536 + 256;
    let pending = '';
    const marker = `WSL_PTY_BASELINE_${index}_OK`;
    // The complete result marker is absent from the echoed input.
    const command = `printf '%s%s\\n' 'WSL_PTY_' 'BASELINE_${index}_OK'\n`;
    let output = '';
    let settled = false;
    let commandTimer;
    let cleanupTimer;
    let reapTimer;
    const readyTimer = setTimeout(() => fail('ready-deadline'), Math.max(0, budgets.readyMs - elapsed()));

    function finish() {
      if (settled) return;
      settled = true;
      for (const timer of [readyTimer, commandTimer, cleanupTimer, reapTimer]) clearTimeout(timer);
      child.stdout.removeListener('data', onData);
      child.stdout.removeListener('end', onEnd);
      child.removeListener('close', onClose);
      child.removeListener('error', onError);
      // Disconnect only this probe's pipes; do not keep a failed process alive through our handles.
      child.stdin.destroy();
      if (child.stdin.closed) child.stdin.removeListener('error', onInputError);
      else child.stdin.once('close', () => child.stdin.removeListener('error', onInputError));
      child.stdout.destroy();
      if (child.stdout.closed) child.stdout.removeListener('error', onOutputError);
      else child.stdout.once('close', () => child.stdout.removeListener('error', onOutputError));
      child.stderr.destroy();
      if (!row.helperReaped) child.unref();
      row.elapsedMs = elapsed();
      row.status = row.failure === null && row.cleanupConfirmed && row.usableMs !== null ? 'passed' : 'failed';
      resolve(row);
    }
    function requestClose() {
      if (row.closeRequestedMs !== null || settled) return;
      row.closeRequestedMs = elapsed();
      clearTimeout(readyTimer);
      clearTimeout(commandTimer);
      cleanupTimer = setTimeout(() => {
        row.failure ??= 'cleanup-deadline';
        row.forcedHelperTermination = true;
        reapTimer = setTimeout(() => {
          row.failure ??= 'helper-reap-deadline';
          finish();
        }, budgets.forcedReapMs);
        // This is solely the helper we spawned. Descendant cleanup remains unconfirmed.
        try {
          row.helperKillRequested = child.kill('SIGKILL');
        } catch (error) {
          row.helperKillError = error.code ?? 'unknown';
        }
      }, budgets.cleanupMs);
      try {
        child.stdin.write('{"type":"close"}\n');
      } catch (error) {
        row.failure ??= `close-input-failed:${error.code ?? 'unknown'}`;
      }
    }
    function fail(reason) {
      if (settled) return;
      row.failure ??= reason;
      requestClose();
    }
    function onError(error) {
      fail(`spawn-failed:${error.code ?? 'unknown'}`);
    }
    function onInputError() {
      fail('input-closed');
    }
    function onOutputError() {
      fail('output-closed');
    }
    function onClose(code, signal) {
      row.helperReaped = true;
      row.exitCode = code;
      row.signal = signal;
      row.cleanupMs = row.closeRequestedMs === null ? null : elapsed() - row.closeRequestedMs;
      row.cleanupConfirmed = code === 0 && row.cleanupAcknowledged && !row.forcedHelperTermination;
      if (row.cleanupMs !== null && row.cleanupMs > budgets.cleanupMs) row.failure ??= 'cleanup-deadline';
      if (!row.cleanupConfirmed) row.failure ??= 'cleanup-unconfirmed';
      if (row.usableMs === null) row.failure ??= 'helper-exited-before-command-result';
      finish();
    }
    child.on('error', onError);
    child.once('close', onClose);
    child.stdin.on('error', onInputError);
    child.stderr.resume();
    function onLine(line) {
      if (settled) return;
      let frame;
      try {
        frame = frameSchema.parse(JSON.parse(line));
      } catch {
        fail('invalid-frame');
        return;
      }
      if (frame.type === 'cleanup') row.cleanupAcknowledged = frame.ok;
      if (frame.type === 'ready' && row.readyMs === null) {
        row.readyMs = elapsed();
        if (row.readyMs > budgets.readyMs) fail('ready-deadline');
        if (row.closeRequestedMs !== null) return;
        clearTimeout(readyTimer);
        commandTimer = setTimeout(() => fail('command-deadline'), budgets.commandMs);
        try {
          child.stdin.write(JSON.stringify({ type: 'input', data: command }) + '\n');
        } catch (error) {
          fail(`command-input-failed:${error.code ?? 'unknown'}`);
        }
      }
      if (frame.type === 'output' && row.readyMs !== null && row.closeRequestedMs === null) {
        output = (output + frame.data).slice(-4096);
        if (output.includes(marker)) {
          row.usableMs = elapsed();
          if (row.usableMs - row.readyMs > budgets.commandMs) row.failure ??= 'command-deadline';
          requestClose();
        }
      }
    }
    function onData(chunk) {
      pending += decoder.write(chunk);
      let newline;
      while (!settled && (newline = pending.indexOf('\n')) !== -1) {
        if (newline > maxFrameChars) {
          pending = '';
          fail('frame-too-large');
          return;
        }
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        onLine(line);
      }
      if (pending.length > maxFrameChars) {
        pending = '';
        fail('frame-too-large');
      }
    }
    function onEnd() {
      if ((pending + decoder.end()).length) fail('truncated-frame');
    }
    child.stdout.on('data', onData);
    child.stdout.once('end', onEnd);
    child.stdout.on('error', onOutputError);
    try {
      child.stdin.write(JSON.stringify({ cwd, shell, cols: 80, rows: 24, rc: rc.toString('base64') }) + '\n');
    } catch (error) {
      fail(`start-input-failed:${error.code ?? 'unknown'}`);
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || !path.isAbsolute(args[0]) || !path.isAbsolute(args[1]))
    throw new Error('Usage: node scripts/pty-startup-baseline.mjs /absolute/python3 /absolute/new-report.json');
  const python = args[0];
  const outputFile = args[1];
  const report = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    status: 'running',
    measurementBoundary: {
      ready: 'immediately-before-helper-spawn-to-valid-ready-frame',
      usable: 'same-start-to-first-real-shell-command-result',
      cleanup: 'close-request-to-helper-close',
    },
    cacheState: 'unknown',
    firstLabel: 'first-in-this-batch',
    coldStartClaim: false,
    performanceSlo: 'not-established',
    plannedSamples: 6,
    retryCount: 0,
    budgets,
    environment: {
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      osVersion: os.version(),
      node: process.version,
    },
    runtime: { requestedPath: python },
    samples: [],
  };
  // Reserve a new report before any Python execution. Existing evidence is never overwritten.
  await writeFile(outputFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  const save = () => writeFile(outputFile, JSON.stringify(report, null, 2) + '\n');
  let cwd;
  try {
    await access(python, constants.X_OK);
    report.runtime.realpath = await realpath(python);
    const helperBytes = await readFile(path.join(root, 'apps/service/src/local-terminal.py'));
    const shell = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
    const rc = await readFile(path.join(root, `apps/service/src/terminal-${shell.endsWith('zsh') ? 'zsh' : 'bash'}-integration.sh`));
    report.source = {
      helperSha256: hash(helperBytes),
      shellIntegrationSha256: hash(rc),
      scriptSha256: hash(await readFile(import.meta.filename)),
      shell,
      instrumentation: 'none',
    };
    cwd = await mkdtemp(path.join(os.tmpdir(), 'wsl-pty-baseline-'));
    let cleanupUnknown = false;
    for (let index = 1; index <= report.plannedSamples; index++) {
      if (cleanupUnknown) {
        report.samples.push({ index, label: 'subsequent-in-this-batch', status: 'not_run', reason: 'previous-cleanup-unconfirmed' });
      } else {
        const row = await sample(python, helperBytes.toString('utf8'), rc, shell, cwd, index);
        report.samples.push(row);
        cleanupUnknown = !row.cleanupConfirmed;
      }
      await save();
    }
    // Hash the executable only after timing, to avoid deliberately reading its pages before the first sample.
    report.runtime.sha256 = hash(await readFile(python));
    report.runtime.executableHashTiming = 'after-measured-samples';
    if (cleanupUnknown) {
      report.runtime.postMeasurementProbe = { status: 'not_run', reason: 'previous-cleanup-unconfirmed' };
      report.retainedCwd = cwd;
    } else {
      // This deliberately occurs after every measured invocation; it cannot prewarm the first sample.
      const probe = spawnSync(
        python,
        ['-I', '-B', '-c', 'import json,sys; print(json.dumps({"version":sys.version,"executable":sys.executable}))'],
        { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 4096 },
      );
      report.runtime.postMeasurementProbe = { status: probe.status, signal: probe.signal, error: probe.error?.code ?? null };
      if (probe.status === 0 && !probe.error) {
        report.runtime.identity = z
          .object({ version: z.string().max(512), executable: z.string().max(4096).refine(path.isAbsolute) })
          .strict()
          .parse(JSON.parse(probe.stdout));
        report.runtime.identity.executableSha256 = hash(await readFile(report.runtime.identity.executable));
      }
    }
    report.status =
      report.samples.every((row) => row.status === 'passed') &&
      report.runtime.postMeasurementProbe.status === 0 &&
      report.runtime.postMeasurementProbe.error === null
        ? 'passed'
        : 'failed';
  } catch (error) {
    report.status = 'failed';
    report.failure = { code: error.code ?? null, kind: error.name ?? 'Error' };
    if (!report.samples.length) {
      for (let index = 1; index <= report.plannedSamples; index++) {
        report.samples.push({
          index,
          label: index === 1 ? 'first-in-this-batch' : 'subsequent-in-this-batch',
          status: 'not_run',
          reason: 'runtime-or-source-preflight-failed',
        });
      }
    }
  } finally {
    if (cwd && report.samples.some((row) => row.cleanupConfirmed === false)) report.retainedCwd = cwd;
    if (cwd && !report.retainedCwd) {
      try {
        await rm(cwd, { recursive: true, force: true });
      } catch (error) {
        report.status = 'failed';
        report.temporaryDirectoryCleanup = { code: error.code ?? null, kind: error.name ?? 'Error' };
      }
    }
    report.finishedAt = new Date().toISOString();
    await save();
  }
  console.log(JSON.stringify({ report: outputFile, status: report.status, samples: report.samples.length }));
  if (report.status !== 'passed') process.exitCode = 1;
}

main().catch((error) => {
  console.error(`PTY baseline could not start: ${error.code ?? error.name ?? 'Error'}`);
  process.exitCode = 1;
});
