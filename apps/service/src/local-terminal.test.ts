import { mkdtemp, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type * as childProcess from 'node:child_process';
import { vi } from 'vitest';
import { expect, it, describe } from 'vitest';
import { z } from 'zod';
import { LocalTerminal } from './local-terminal';

type Spawn = typeof childProcess.spawn;
const spawnDiagnostic = vi.hoisted((): { intercept?: (spawn: Spawn, ...args: Parameters<Spawn>) => ReturnType<Spawn> } => ({}));
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof childProcess>();
  return {
    ...original,
    spawn: (...args: Parameters<Spawn>) =>
      spawnDiagnostic.intercept ? spawnDiagnostic.intercept(original.spawn, ...args) : original.spawn(...args),
  };
});

const python = path.resolve(process.env['WSL_TEST_PYTHON'] ?? '/usr/bin/python3');
const tracePrefix = 'WSL_PTY_START_PROBE ';
const phaseSchema = z.enum([
  'importsDone',
  'processTableBegin',
  'processTableDone',
  'startFrameBegin',
  'startFrameDone',
  'rcWritten',
  'forkBegin',
  'forkParent',
  'rootBound',
  'resized',
  'readyEmitted',
]);
const pythonTime = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const traceFrameSchema = z.union([
  z.object({ phase: z.literal('pythonEntry') }).strict(),
  z.object({ phase: phaseSchema, pythonMs: pythonTime, wallMs: pythonTime }).strict(),
  z
    .object({
      phase: z.literal('runtime'),
      pythonMs: pythonTime,
      wallMs: pythonTime,
      version: z.tuple([z.number().int().min(0).max(999), z.number().int().min(0).max(999), z.number().int().min(0).max(999)]),
      flags: z
        .object({
          isolated: z.boolean(),
          noSite: z.boolean(),
          noUserSite: z.boolean(),
          ignoreEnvironment: z.boolean(),
          dontWriteBytecode: z.boolean(),
        })
        .strict(),
      siteLoaded: z.boolean(),
      siteCustomizeLoaded: z.boolean(),
      userCustomizeLoaded: z.boolean(),
      executableMatchesRequested: z.boolean(),
      executableIsPythonFramework: z.boolean(),
    })
    .strict(),
]);

type NativeSample = {
  mode: 'sampling-after-poll-failure';
  intervened: boolean;
  outcome: 'observed' | 'undetermined';
  reason: 'complete' | 'unavailable' | 'incomplete' | 'denied' | 'output-limit' | 'sample-failed' | 'no-symbols' | 'cleanup-unconfirmed';
  image: 'system-python-wrapper' | 'xcrun' | 'python-framework' | 'unknown';
  frames: { xcselect: number; xcrun: number; loader: number; cpythonInit: number };
  cleanupConfirmed: boolean;
};

function instrumentFirstHelper(source: string, requested: string) {
  const imports = 'import base64, codecs, ctypes, errno, fcntl, json, os, pty, select, signal, struct, sys, tempfile, termios, time, uuid';
  const mark = (phase: z.infer<typeof phaseSchema>) => `_wsl_start_probe('${phase}')`;
  const replacements: [string, string][] = [
    [
      imports,
      // sys is already initialized; do not import time/json ahead of the original imports.
      `import sys\nsys.stderr.write('${tracePrefix}{"phase":"pythonEntry"}\\n')\nsys.stderr.flush()\n${imports}

def _wsl_start_probe(phase):
    stamp = {'phase': phase, 'pythonMs': time.monotonic() * 1000, 'wallMs': time.time() * 1000}
    sys.stderr.write('${tracePrefix}' + json.dumps(stamp) + '\\n')
    sys.stderr.flush()

${mark('importsDone')}
sys.stderr.write('${tracePrefix}' + json.dumps({
    'phase': 'runtime', 'pythonMs': time.monotonic() * 1000, 'wallMs': time.time() * 1000,
    'version': list(sys.version_info[:3]),
    'flags': {'isolated': bool(sys.flags.isolated), 'noSite': bool(sys.flags.no_site),
              'noUserSite': bool(sys.flags.no_user_site), 'ignoreEnvironment': bool(sys.flags.ignore_environment),
              'dontWriteBytecode': bool(sys.flags.dont_write_bytecode)},
    'siteLoaded': 'site' in sys.modules, 'siteCustomizeLoaded': 'sitecustomize' in sys.modules,
    'userCustomizeLoaded': 'usercustomize' in sys.modules,
    'executableMatchesRequested': sys.executable == ${JSON.stringify(requested)},
    'executableIsPythonFramework': isinstance(sys.executable, str) and 'Python3.framework/' in sys.executable
}) + '\\n')
sys.stderr.flush()`,
    ],
    ['processes = ProcessTable()', `${mark('processTableBegin')}\nprocesses = ProcessTable()\n${mark('processTableDone')}`],
    ['start_line = bytearray()', `${mark('startFrameBegin')}\nstart_line = bytearray()`],
    ['start = json.loads(start_line)', `start = json.loads(start_line)\n${mark('startFrameDone')}`],
    ['    pid, fd = pty.fork()', `    ${mark('rcWritten')}\n    ${mark('forkBegin')}\n    pid, fd = pty.fork()`],
    ['    processes.bind_root(pid)', `    ${mark('forkParent')}\n    processes.bind_root(pid)\n    ${mark('rootBound')}`],
    ["    resize(fd, start['cols'], start['rows'])", `    resize(fd, start['cols'], start['rows'])\n    ${mark('resized')}`],
    ["    emit({'type': 'ready'})", `    emit({'type': 'ready'})\n    ${mark('readyEmitted')}`],
  ];
  if (source.includes('_wsl_start_probe')) throw new Error('PTY diagnostic helper name is already present');
  for (const [index, [anchor]] of replacements.entries()) {
    if (source.split(anchor).length !== 2) throw new Error(`PTY diagnostic anchor ${index} must occur exactly once`);
  }
  return replacements.reduce((value, [anchor, replacement]) => value.replace(anchor, replacement), source);
}

function traceFirstSpawn() {
  const started = process.hrtime.bigint();
  type Event = {
    event: string;
    nodeMs: number;
    wallMs: number;
    python?: z.infer<typeof traceFrameSchema>;
    exitCode?: number | null;
    sampling?: NativeSample;
  };
  const events: Event[] = [];
  let traceBytes = 0;
  let truncated = false;
  let invalidMarkers = 0;
  const detach: (() => void)[] = [];
  const record = (event: string, detail: Pick<Event, 'python' | 'exitCode' | 'sampling'> = {}) => {
    // Wall time estimates same-host delivery delay; monotonic deltas expose clock adjustments.
    const value = { event, nodeMs: Number(process.hrtime.bigint() - started) / 1e6, wallMs: Date.now(), ...detail };
    const bytes = Buffer.byteLength(JSON.stringify(value)) + 1;
    // Reserve room for the fixed report envelope; never retain raw stream contents.
    if (events.length >= 64 || traceBytes + bytes > 8192 - 512) {
      truncated = true;
      return;
    }
    events.push(value);
    traceBytes += bytes;
  };
  const lines = (accept: (line: string) => void, onOversized?: () => void) => {
    let pending = '';
    let oversized = false;
    return (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let offset = 0;
      while (offset < text.length) {
        const newline = text.indexOf('\n', offset);
        const end = newline < 0 ? text.length : newline;
        if (!oversized && pending.length + end - offset <= 1024) pending += text.slice(offset, end);
        else {
          if (!oversized) onOversized?.();
          pending = '';
          oversized = true;
        }
        if (newline < 0) break;
        if (!oversized) accept(pending);
        pending = '';
        oversized = false;
        offset = newline + 1;
      }
    };
  };
  let spawned = false;
  let sampling: NativeSample | undefined;
  let startSampling: (() => void) | undefined;
  let stopSampling = () => {};
  let finishSampling = async () => {};
  spawnDiagnostic.intercept = (spawn, command, args, options) => {
    if (spawned) throw new Error('PTY diagnostic permits exactly one real spawn');
    if (command !== python || args.length !== 5 || args.slice(0, 4).join(' ') !== '-I -B -u -c' || typeof args[4] !== 'string')
      throw new Error('PTY diagnostic spawn contract changed');
    if (!Array.isArray(options.stdio) || options.stdio.length !== 3 || options.stdio.some((value) => value !== 'pipe'))
      throw new Error('PTY diagnostic requires the original piped transport');
    const source = instrumentFirstHelper(args[4], command);
    spawned = true;
    record('spawnRequested');
    // The actual executable, options and transport remain unchanged. Only this call's source has markers.
    const child = spawn(command, [...args.slice(0, 4), source], options);
    record('spawnReturned');
    startSampling = () => {
      if (sampling) return;
      const result: NativeSample = {
        mode: 'sampling-after-poll-failure',
        intervened: false,
        outcome: 'undetermined',
        reason: 'unavailable',
        image: 'unknown',
        frames: { xcselect: 0, xcrun: 0, loader: 0, cpythonInit: 0 },
        cleanupConfirmed: true,
      };
      sampling = result;
      if (process.platform !== 'darwin' || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
      let sampler: ReturnType<Spawn>;
      try {
        result.intervened = true;
        // Sampling suspends the target: all subsequent timings are diagnostic, not cold-start performance.
        sampler = spawn('/usr/bin/sample', [String(child.pid), '1', '10', '-file', '/dev/stdout'], {
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        result.reason = 'sample-failed';
        return;
      }
      result.reason = 'incomplete';
      result.cleanupConfirmed = false;
      let closed = false;
      let stopped = false;
      let inputBytes = 0;
      let inGraph = false;
      let graphEnded = false;
      let issue: NativeSample['reason'] | undefined;
      let settled: (() => void) | undefined;
      stopSampling = () => {
        if (closed || stopped) return;
        stopped = true;
        issue ??= 'incomplete';
        result.outcome = 'undetermined';
        result.reason = issue;
        try {
          sampler.kill('SIGKILL');
        } catch {
          result.reason = 'cleanup-unconfirmed';
        }
      };
      const limit = () => {
        issue = 'output-limit';
        stopSampling();
      };
      const stdoutLines = lines((line) => {
        if (issue) return;
        if (line.startsWith('Path:')) {
          const image = line.slice(5).trim();
          result.image =
            image === '/usr/bin/python3'
              ? 'system-python-wrapper'
              : image.endsWith('/usr/bin/xcrun')
                ? 'xcrun'
                : image.includes('/Python3.framework/')
                  ? 'python-framework'
                  : 'unknown';
        }
        if (line === 'Call graph:') {
          inGraph = true;
          return;
        }
        if (/^(?:Total number in stack|Sort by top of stack|Binary Images:)/.test(line)) {
          graphEnded ||= inGraph;
          inGraph = false;
        }
        if (!inGraph) return;
        const frame = /^[ \t+|:!]*(\d{1,7})[ \t]+(.+?) \(in ([^()]+)\)(?: .*)?$/.exec(line);
        if (!frame || Number(frame[1]) < 1) return;
        const [, , symbol, image] = frame;
        if (!symbol || !image) return;
        // Count matching call-graph rows, not elapsed time or loaded-image presence.
        if (image === 'libxcselect.dylib' && /^_?xcselect_/.test(symbol)) result.frames.xcselect++;
        else if (image === 'xcrun' && /^[A-Za-z_]/.test(symbol)) result.frames.xcrun++;
        else if (image === 'dyld' && /^dyld[34]::(?:(?:Loader|JustInTimeLoader|PrebuiltLoader|APIs|RuntimeState)::|prepare\()/.test(symbol))
          result.frames.loader++;
        else if (
          /^(?:Python3?|python3)$/.test(image) &&
          /^(?:_?Py_Initialize(?:FromConfig|Ex|Main)?|_?Py_PreInitialize(?:FromArgs|FromBytesArgs)?|_PyRuntime_Initialize|pyinit_[A-Za-z_]+|pycore_init_[A-Za-z_]+|init_interp_main)\b/.test(
            symbol,
          )
        )
          result.frames.cpythonInit++;
      }, limit);
      const stderrLines = lines((line) => {
        if (/(?:permission denied|not permitted|access denied)/i.test(line)) issue ??= 'denied';
        else if (/(?:no such process|does not appear to exist|process (?:has )?exited)/i.test(line)) issue ??= 'unavailable';
        else if (/(?:cannot examine process|unable to get task port)/i.test(line)) issue ??= 'sample-failed';
      }, limit);
      const bounded = (consume: (chunk: Buffer | string) => void) => (chunk: Buffer | string) => {
        if (stopped) return;
        inputBytes += Buffer.byteLength(chunk);
        // A validated report was ~69 KB with its image list; bound total input without retaining it.
        if (inputBytes > 256 * 1024) {
          limit();
          return;
        }
        consume(chunk);
      };
      const sampleStdout = bounded(stdoutLines);
      const sampleStderr = bounded(stderrLines);
      sampler.stdout?.on('data', sampleStdout);
      sampler.stderr?.on('data', sampleStderr);
      const sampleError = () => {
        issue ??= 'sample-failed';
      };
      sampler.once('error', sampleError);
      sampler.stdout?.once('error', sampleError);
      sampler.stderr?.once('error', sampleError);
      sampler.once('close', (code) => {
        closed = true;
        result.cleanupConfirmed = true;
        result.reason =
          issue ??
          (code !== 0
            ? 'sample-failed'
            : !graphEnded
              ? 'incomplete'
              : Object.values(result.frames).every((count) => count === 0)
                ? 'no-symbols'
                : 'complete');
        result.outcome = result.reason === 'complete' ? 'observed' : 'undetermined';
        settled?.();
      });
      finishSampling = async () => {
        stopSampling();
        if (!closed)
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
              settled = undefined;
              resolve();
            }, 250);
            settled = () => {
              clearTimeout(timer);
              settled = undefined;
              resolve();
            };
          });
        sampler.stdout?.off('data', sampleStdout);
        sampler.stderr?.off('data', sampleStderr);
        if (!closed) {
          result.outcome = 'undetermined';
          result.reason = 'cleanup-unconfirmed';
          sampler.stdout?.destroy();
          sampler.stderr?.destroy();
          sampler.unref();
        }
      };
    };
    if (!child.stderr || !child.stdout) throw new Error('PTY diagnostic streams are unavailable');
    const stderr = lines((line) => {
      if (!line.startsWith(tracePrefix)) return;
      let value: unknown;
      try {
        value = JSON.parse(line.slice(tracePrefix.length));
      } catch {
        invalidMarkers++;
        return;
      }
      const frame = traceFrameSchema.safeParse(value);
      if (frame.success) record('python', { python: frame.data });
      else invalidMarkers++;
    });
    const stdout = lines((line) => {
      // Recognize only the fixed control frame; never parse or report shell output.
      if (line === '{"type": "ready"}') record('readyReceived');
    });
    const onSpawn = () => record('spawnEvent');
    const onError = () => record('childError');
    const onClose = (exitCode: number | null) => {
      record('childClose', { exitCode });
      stopSampling();
    };
    child.stderr.on('data', stderr);
    child.stdout.on('data', stdout);
    child.once('spawn', onSpawn);
    child.once('error', onError);
    child.once('close', onClose);
    const stderrStream = child.stderr;
    const stdoutStream = child.stdout;
    detach.push(() => {
      stderrStream.off('data', stderr);
      stdoutStream.off('data', stdout);
      child.off('spawn', onSpawn);
      child.off('error', onError);
      child.off('close', onClose);
    });
    return child;
  };
  return {
    record,
    sampleAfterFailure() {
      try {
        startSampling?.();
      } catch {
        if (sampling) {
          sampling.outcome = 'undetermined';
          sampling.reason = 'sample-failed';
        }
        stopSampling();
      }
    },
    async finish() {
      try {
        await finishSampling();
      } catch {
        if (sampling) {
          sampling.outcome = 'undetermined';
          sampling.reason = 'cleanup-unconfirmed';
        }
      }
      record('probeEnd', sampling ? { sampling } : {});
      spawnDiagnostic.intercept = undefined;
      for (const release of detach) release();
      process.stderr.write(
        JSON.stringify({
          probe: 'local-pty-first-spawn',
          instrumented: true,
          runtime: process.env['WSL_TEST_PYTHON'] ? 'configured' : 'system',
          spawned,
          truncated,
          invalidMarkers,
          events,
        }) + '\n',
      );
    },
  };
}

async function expectRunning(terminal: LocalTerminal, timeout?: number) {
  const started = Date.now();
  try {
    await expect.poll(() => terminal.get().state, timeout === undefined ? {} : { timeout }).toBe('running');
  } catch (error) {
    const snapshot = terminal.get();
    // State only: shell output, cwd and inherited environment may contain private data.
    console.error(
      JSON.stringify({
        probe: 'local-pty-start',
        elapsedMs: Date.now() - started,
        runtime: process.env['WSL_TEST_PYTHON'] ? 'configured' : 'system',
        state: snapshot.state,
        error: snapshot.error,
        cleanupPending: snapshot.cleanupPending,
      }),
    );
    throw error;
  }
}
describe('local terminal lifecycle', () => {
  it('real local PTY: failed command preserves shell, zsh hooks report code, close settles', async () => {
    const trace = traceFirstSpawn();
    try {
      const terminal = new LocalTerminal(
        process.cwd(),
        {
          workspaceId: 'test',
          environmentId: 'local',
          resourceId: 'local-test',
          kind: 'terminal',
          instanceId: 'local-instance',
          instanceGeneration: 1,
        },
        () => undefined,
        python,
      );
      trace.record('openRequested');
      const opened = await terminal.open(80, 24);
      trace.record('openReturned');
      try {
        trace.record('pollBegin');
        try {
          await expectRunning(terminal);
          trace.record('pollPassed');
        } catch (error) {
          trace.record('pollFailed');
          trace.sampleAfterFailure();
          throw error;
        }
        terminal.write(opened.sessionId!, 'false\n');
        await expect.poll(async () => JSON.stringify((await terminal.observation!.readCommand()).data)).toContain('"exitCode":1');
        expect(terminal.get().state).toBe('running');
        terminal.write(opened.sessionId!, "printf 'LOCAL_PTY_OK\\n'\n");
        await expect.poll(() => terminal.get().output).toContain('LOCAL_PTY_OK');
      } finally {
        trace.record('closeRequested');
        await terminal.close(opened.sessionId!);
      }
      expect(terminal.get().state).toBe('closed');
    } finally {
      // Keep listeners through the existing close, including ready frames arriving after a poll failure.
      await trace.finish();
    }
  }, 15000);
  it('bounds cleanup when foreground process ignores hangup', async () => {
    const terminal = new LocalTerminal(
      process.cwd(),
      {
        workspaceId: 'test',
        environmentId: 'local',
        resourceId: 'local-test',
        kind: 'terminal',
        instanceId: 'local-instance',
        instanceGeneration: 1,
      },
      () => undefined,
      python,
    );
    const opened = await terminal.open(80, 24);
    await expectRunning(terminal);
    terminal.write(opened.sessionId!, "trap '' HUP; sleep 60\n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    await terminal.close(opened.sessionId!);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(terminal.get().cleanupPending).toBe(false);
  }, 10000);
  it('consumes immediate close queued alongside start without losing the frame', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const states: string[] = [];
      const terminal = new LocalTerminal(
        process.cwd(),
        {
          workspaceId: 'test',
          environmentId: 'local',
          resourceId: 'local-test',
          kind: 'terminal',
          instanceId: 'local-instance',
          instanceGeneration: 1,
        },
        (snapshot) => states.push(snapshot.state),
        python,
      );
      const opened = await terminal.open(80, 24);
      expect(opened.state).toBe('starting');
      await terminal.close(opened.sessionId!);
      expect(terminal.get().state).toBe('closed');
      expect(terminal.get().cleanupPending).toBe(false);
      expect(states.slice(states.indexOf('closing'))).not.toContain('running');
    }
  }, 15000);
});

it('local PTY observation retains the Main identity instead of using the shell session as resource', async () => {
  const identity = {
    workspaceId: 'w-other',
    environmentId: 'local',
    resourceId: 'terminal-stable',
    kind: 'terminal' as const,
    instanceId: 'main-instance',
    instanceGeneration: 4,
  };
  const terminal = new LocalTerminal(process.cwd(), identity, () => undefined, python);
  const opened = await terminal.open(80, 24);
  try {
    await expectRunning(terminal);
    expect(terminal.observation?.resource).toEqual(identity);
    expect(opened.sessionId).not.toBe(identity.resourceId);
  } finally {
    await terminal.close(opened.sessionId!);
  }
});

it('rejects oversized UTF-8 Chinese input without closing the PTY and still runs the next command', async () => {
  const terminal = new LocalTerminal(
    process.cwd(),
    {
      workspaceId: 'w',
      environmentId: 'local',
      resourceId: 'terminal-input',
      kind: 'terminal',
      instanceId: 'instance-input',
      instanceGeneration: 1,
    },
    () => {},
    python,
  );
  const opened = await terminal.open(80, 24);
  await expectRunning(terminal);
  let writeError: unknown;
  try {
    terminal.write(opened.sessionId!, '中'.repeat(30000));
  } catch (error) {
    writeError = error;
  }
  if (writeError) {
    terminal.write(opened.sessionId!, "printf 'AFTER_REJECTED_CHINESE_INPUT\\n'\n");
    await expect.poll(() => terminal.get().output).toContain('AFTER_REJECTED_CHINESE_INPUT');
    expect(terminal.get().state).toBe('running');
  } else {
    await expect.poll(() => terminal.get().state).toBe('failed');
  }
  const shutdown = await Promise.allSettled([terminal.shutdown()]);
  expect(writeError).toBeInstanceOf(Error);
  expect((writeError as Error).message).toBe('input too large');
  expect(shutdown[0]?.status).toBe('fulfilled');
}, 15000);

it('bundled Python PTY isolates stdlib imports from cwd and PYTHONPATH', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-isolated-pty-'));
  for (const module of ['json', 'pty', 'signal'])
    await writeFile(path.join(root, module + '.py'), "raise RuntimeError('hostile-module-executed')");
  await access(python);
  vi.stubEnv('PYTHONPATH', root);
  const terminal = new LocalTerminal(
    root,
    { workspaceId: 'w', environmentId: 'local', resourceId: 'r', kind: 'terminal', instanceId: 'i', instanceGeneration: 1 },
    () => undefined,
    python,
  );
  try {
    const started = await terminal.open(80, 24);
    await expectRunning(terminal, 5000);
    terminal.write(started.sessionId!, "printf 'ISOLATED_PYTHON_OK\\n'\n");
    await expect.poll(() => terminal.get().output).toContain('ISOLATED_PYTHON_OK');
    expect(terminal.get().output).not.toContain('hostile-module-executed');
    await terminal.close(started.sessionId!);
  } finally {
    vi.unstubAllEnvs();
    await terminal.shutdown();
  }
}, 15000);
