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
  z.object({ phase: phaseSchema, pythonMs: pythonTime }).strict(),
  z
    .object({
      phase: z.literal('runtime'),
      pythonMs: pythonTime,
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
    })
    .strict(),
]);

function instrumentFirstHelper(source: string) {
  const imports = 'import base64, codecs, ctypes, errno, fcntl, json, os, pty, select, signal, struct, sys, tempfile, termios, time, uuid';
  const mark = (phase: z.infer<typeof phaseSchema>) => `_wsl_start_probe('${phase}')`;
  const replacements: [string, string][] = [
    [
      imports,
      // sys is already initialized; do not import time/json ahead of the original imports.
      `import sys\nsys.stderr.write('${tracePrefix}{"phase":"pythonEntry"}\\n')\nsys.stderr.flush()\n${imports}

def _wsl_start_probe(phase):
    sys.stderr.write('${tracePrefix}' + json.dumps({'phase': phase, 'pythonMs': time.monotonic() * 1000}) + '\\n')
    sys.stderr.flush()

${mark('importsDone')}
sys.stderr.write('${tracePrefix}' + json.dumps({
    'phase': 'runtime', 'pythonMs': time.monotonic() * 1000, 'version': list(sys.version_info[:3]),
    'flags': {'isolated': bool(sys.flags.isolated), 'noSite': bool(sys.flags.no_site),
              'noUserSite': bool(sys.flags.no_user_site), 'ignoreEnvironment': bool(sys.flags.ignore_environment),
              'dontWriteBytecode': bool(sys.flags.dont_write_bytecode)},
    'siteLoaded': 'site' in sys.modules, 'siteCustomizeLoaded': 'sitecustomize' in sys.modules,
    'userCustomizeLoaded': 'usercustomize' in sys.modules
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
    python?: z.infer<typeof traceFrameSchema>;
    exitCode?: number | null;
  };
  const events: Event[] = [];
  let traceBytes = 0;
  let truncated = false;
  let invalidMarkers = 0;
  const detach: (() => void)[] = [];
  const record = (event: string, detail: Pick<Event, 'python' | 'exitCode'> = {}) => {
    const value = { event, nodeMs: Number(process.hrtime.bigint() - started) / 1e6, ...detail };
    const bytes = Buffer.byteLength(JSON.stringify(value)) + 1;
    // Reserve room for the fixed report envelope; never retain raw stream contents.
    if (events.length >= 64 || traceBytes + bytes > 8192 - 512) {
      truncated = true;
      return;
    }
    events.push(value);
    traceBytes += bytes;
  };
  const lines = (accept: (line: string) => void) => {
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
  spawnDiagnostic.intercept = (spawn, command, args, options) => {
    if (spawned) throw new Error('PTY diagnostic permits exactly one real spawn');
    if (command !== python || args.length !== 5 || args.slice(0, 4).join(' ') !== '-I -B -u -c' || typeof args[4] !== 'string')
      throw new Error('PTY diagnostic spawn contract changed');
    if (!Array.isArray(options.stdio) || options.stdio.length !== 3 || options.stdio.some((value) => value !== 'pipe'))
      throw new Error('PTY diagnostic requires the original piped transport');
    const source = instrumentFirstHelper(args[4]);
    spawned = true;
    record('spawnRequested');
    // The actual executable, options and transport remain unchanged. Only this call's source has markers.
    const child = spawn(command, [...args.slice(0, 4), source], options);
    record('spawnReturned');
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
    const onClose = (exitCode: number | null) => record('childClose', { exitCode });
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
    finish() {
      record('probeEnd');
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
      trace.finish();
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
