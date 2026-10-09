import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createPortProbe } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { build, createServer } from 'vite';
import { z } from 'zod';
import {
  identitySchema,
  taskSchema,
  type AdapterContext,
  type ExecuteTask,
  type RawLog,
  type Task,
} from '../../../../tests/vertical-slice/contracts.js';
import { parseCodexLine } from '../codex-chat';
import { SbxConnection, type GuestFrame, type GuestProcess, type GuestStart, type GuestWorkspace } from '../sbx';

type RecordDiagnostic = (value: Record<string, unknown>) => void;
let configuration: { repo: string; directory: string; record: RecordDiagnostic } | undefined;
export function configure(repo: string, directory: string, record: RecordDiagnostic): void {
  if (configuration) throw new Error('VS001 runtime already configured');
  configuration = { repo, directory, record };
}

/** Every allocation has an idempotent cleanup before the next awaited operation. */
export class RunResources {
  private readonly cleanups: (() => Promise<void>)[] = [];
  private stopping: Promise<void> | undefined;
  private readonly abort = () => {
    void this.stop().catch((error) => {
      try {
        this.record({ kind: 'abort-cleanup-error', message: String(error) });
      } catch {
        // Registered cleanups still expose the original failure to the runner.
      }
    });
  };
  constructor(
    private readonly context: AdapterContext,
    private readonly record: RecordDiagnostic,
  ) {
    context.signal.throwIfAborted();
    context.signal.addEventListener('abort', this.abort, { once: true });
  }
  check(): void {
    this.context.signal.throwIfAborted();
    if (this.stopping) throw new Error('VS001 run is stopping');
  }
  async own(release: () => Promise<void>): Promise<void> {
    let released: Promise<void> | undefined;
    const cleanup = () => (released ??= release());
    try {
      this.check();
      this.context.registerCleanup(cleanup);
      this.cleanups.push(cleanup);
    } catch (error) {
      await cleanup();
      throw error;
    }
  }
  stop(): Promise<void> {
    return (this.stopping ??= (async () => {
      const failures: unknown[] = [];
      for (const cleanup of this.cleanups.toReversed()) {
        try {
          await cleanup();
        } catch (error) {
          failures.push(error);
        }
      }
      this.context.signal.removeEventListener('abort', this.abort);
      if (failures.length) throw new AggregateError(failures, 'VS001 resource cleanup failed');
    })());
  }
}

function safeFile(root: string, relative: string): string {
  if (
    !relative ||
    relative.includes('\\') ||
    relative.includes('\0') ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error(`Unsafe guest workspace path: ${relative}`);
  return join(root, relative);
}
export function readWorkspace(root: string): GuestWorkspace['files'] {
  const files: GuestWorkspace['files'] = [];
  function walk(directory: string, prefix: string) {
    for (const name of readdirSync(directory).sort()) {
      const relative = prefix + name;
      const location = safeFile(root, relative);
      const stat = lstatSync(location);
      if (stat.isSymbolicLink()) throw new Error(`Workspace symlink: ${relative}`);
      if (!prefix && ['node_modules', 'dist', '.vite'].includes(name) && stat.isDirectory()) continue;
      if (stat.isDirectory()) walk(location, relative + '/');
      else if (stat.isFile()) files.push({ path: relative, base64: readFileSync(location).toString('base64') });
      else throw new Error(`Workspace non-file: ${relative}`);
    }
  }
  walk(root, '');
  if (!files.length || files.length > 256 || files.reduce((bytes, file) => bytes + Buffer.from(file.base64, 'base64').length, 0) > 524288)
    throw new Error('Workspace exceeds guest transfer budget');
  return files;
}

/** Audit the complete returned inventory, including deleted and added paths. */
export function commitWorkspace(root: string, before: GuestWorkspace['files'], result: GuestWorkspace, task: Task): void {
  if (result.runId !== task.runId) throw new Error('Guest workspace belongs to another run');
  const initial = new Map(before.map((file) => [file.path, file.base64]));
  const current = new Map<string, string>();
  let bytes = 0;
  for (const file of result.files) {
    safeFile(root, file.path);
    const content = Buffer.from(file.base64, 'base64');
    if (content.toString('base64') !== file.base64 || current.has(file.path)) throw new Error('Invalid or duplicate guest workspace file');
    bytes += content.length;
    if (bytes > 524288 || current.size >= 256) throw new Error('Guest workspace exceeds transfer budget');
    current.set(file.path, file.base64);
  }
  const changed = [...new Set([...initial.keys(), ...current.keys()])].sort().filter((file) => initial.get(file) !== current.get(file));
  // Preserve a safe App edit even when another path violates the task or Codex exits nonzero.
  const app = current.get('src/App.tsx');
  if (app !== undefined && app !== initial.get('src/App.tsx')) {
    const host = readWorkspace(root);
    if (JSON.stringify(host) !== JSON.stringify(before)) throw new Error('Host run copy changed while the Agent was running');
    writeFileSync(safeFile(root, 'src/App.tsx'), Buffer.from(app, 'base64'));
  }
  if (JSON.stringify(changed) !== JSON.stringify(task.allowedPaths) || app === undefined)
    throw new Error(`Agent changed forbidden paths or did not modify App: ${JSON.stringify(changed)}`);
}

export async function runAgent(
  task: Task,
  context: AdapterContext,
  connection: {
    start(
      start: GuestStart,
      onFrame: (frame: GuestFrame) => void,
      onTransportOutput?: (stream: 'stdout' | 'stderr', text: string) => void,
    ): Pick<GuestProcess, 'done' | 'close'>;
  },
  resources: RunResources,
  version: string,
  model: string,
  record: RecordDiagnostic,
): Promise<void> {
  resources.check();
  const files = readWorkspace(context.workspaceDir);
  const command = ['codex', 'exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write', '--model', model, '-'];
  let pid: number | undefined;
  let startedAt: string | undefined;
  let sessionId: string | undefined;
  let completion = false;
  let reply = false;
  let failure: string | undefined;
  let buffer = '';
  let queuedBytes = 0;
  let snapshot: GuestWorkspace | undefined;
  const pending: Omit<RawLog, 'sessionId'>[] = [];
  const binding = { runId: task.runId, taskSha256: context.taskSha256 };
  const consume = (line: string) => {
    if (!line.trim()) return;
    const event = parseCodexLine(line);
    if (!event) return;
    if (event.type === 'thread.started') {
      if (sessionId || !pid || !startedAt) throw new Error('Duplicate or premature Codex thread identity');
      sessionId = event.thread_id;
      context.emit({
        ...binding,
        at: startedAt,
        seq: 1,
        type: 'harness.started',
        pid,
        sessionId,
        harness: 'Codex CLI (sbx)',
        version,
        model,
        command,
      });
      for (const entry of pending.splice(0)) context.log({ ...entry, sessionId });
    }
    if (event.type === 'turn.completed') completion = true;
    if (event.type === 'item.completed' && event.item.type === 'agent_message' && event.item.text?.trim()) reply = true;
    if (event.type === 'turn.failed') failure ??= event.error.message;
    if (event.type === 'error') failure ??= event.message;
  };
  const guest = connection.start(
    { type: 'start', mode: 'codex', argv: command, prompt: task.instruction, workspace: { runId: task.runId, files } },
    (frame) => {
      if (frame.type === 'ready') {
        pid = frame.pid;
        startedAt = new Date().toISOString();
      }
      if (frame.type === 'workspace') {
        if (snapshot) throw new Error('Duplicate guest workspace snapshot');
        snapshot = { runId: frame.runId, files: frame.files };
        record({ kind: 'guest-workspace-snapshot', workspace: snapshot });
      }
      if (frame.type !== 'output') return;
      const at = new Date().toISOString();
      record({ kind: 'harness-output', pid: pid ?? null, sessionId: sessionId ?? null, stream: frame.stream, text: frame.data });
      if (!pid || !startedAt) throw new Error('Guest output precedes process identity');
      if (frame.data) {
        const entry: Omit<RawLog, 'sessionId'> = { ...binding, at, source: 'harness', pid, stream: frame.stream, text: frame.data };
        if (sessionId) context.log({ ...entry, sessionId });
        else {
          queuedBytes += Buffer.byteLength(frame.data);
          if (queuedBytes > 4 * 1024 * 1024) throw new Error('Codex produced excessive output before thread identity');
          pending.push(entry);
        }
      }
      if (frame.stream === 'stdout' && !failure) {
        buffer += frame.data;
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n');
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          try {
            consume(line);
          } catch (error) {
            failure ??= `Codex protocol: ${String(error)}`;
            throw error;
          }
        }
        if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) throw new Error('Codex JSON line exceeds budget');
      }
    },
    (stream, text) => record({ kind: 'sbx-transport', stream, text }),
  );
  await resources.own(async () => {
    const outcome = await guest.close();
    if (!outcome.confirmed) throw new Error(outcome.error ?? 'Agent guest cleanup not confirmed');
  });
  const outcome = await guest.done;
  if (buffer.trim() && !failure) {
    try {
      consume(buffer);
    } catch (error) {
      failure ??= `Codex protocol: ${String(error)}`;
    }
  }
  record({ kind: 'harness-outcome', pid: pid ?? null, sessionId: sessionId ?? null, ...outcome });
  if (pid && sessionId && outcome.exitCode !== null)
    context.emit({ ...binding, at: new Date().toISOString(), seq: 2, type: 'harness.exited', pid, sessionId, exitCode: outcome.exitCode });
  if (snapshot) commitWorkspace(context.workspaceDir, files, snapshot, task);
  if (!outcome.confirmed || outcome.error || outcome.exitCode !== 0) throw new Error(outcome.error ?? `Codex exited ${outcome.exitCode}`);
  if (!snapshot || !sessionId || !completion || !reply || failure)
    throw new Error(failure ?? 'Codex completion, thread or workspace snapshot missing');
  resources.check();
}

function processGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
export async function stopChild(child: ChildProcessWithoutNullStreams, closed: Promise<void>): Promise<void> {
  if (child.pid === undefined) return closed;
  const pid = child.pid;
  let transportClosed = false;
  void closed.then(() => {
    transportClosed = true;
  });
  // EOF asks the actual host to dispose its PreviewController, windows and app.
  child.stdin.end();
  for (const signal of [null, 'SIGTERM', 'SIGKILL'] as const) {
    if (signal && processGroupAlive(pid)) process.kill(-pid, signal);
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      if (transportClosed && !processGroupAlive(pid)) return;
      await new Promise<void>((complete) => setTimeout(complete, 25));
    }
  }
  throw new Error('Owned Electron process group cleanup not confirmed');
}

const readySchema = z
  .object({
    kind: z.literal('vs001-ready'),
    pid: z.number().int().positive(),
    webContentsId: z.number().int().positive(),
    targetId: z.string().min(1),
  })
  .strict();
const discoverySchema = z.array(z.object({ id: z.string(), type: z.string(), url: z.string() }));
export function buildElectronHost(repo: string, directory: string) {
  return build({
    root: repo,
    configFile: false,
    logLevel: 'silent',
    resolve: { alias: { '@wsl/protocol': join(repo, 'packages/protocol/src/index.ts') } },
    ssr: { noExternal: true },
    build: {
      ssr: join(repo, 'apps/desktop/src/main/vertical-slice.ts'),
      outDir: directory,
      emptyOutDir: false,
      rollupOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'electron.cjs' } },
    },
  });
}
export async function allocatePagePort(resources: RunResources): Promise<number> {
  resources.check();
  const probe = createPortProbe((socket) => socket.destroy());
  const listening: { pending?: Promise<number> } = {};
  let stopping: Promise<void> | undefined;
  const release = () =>
    (stopping ??= (async () => {
      await listening.pending?.catch(() => undefined);
      if (!probe.listening) return;
      await new Promise<void>((complete, reject) => probe.close((error) => (error ? reject(error) : complete())));
    })());
  await resources.own(release);
  resources.check();
  listening.pending = new Promise<number>((complete, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') reject(new Error('Page port probe did not bind loopback'));
      else complete(address.port);
    });
  });
  const port = await listening.pending;
  await release();
  resources.check();
  return port;
}
export function createRunPage(workspaceDir: string, repo: string, port: number) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid reserved page port');
  return createServer({
    root: workspaceDir,
    configFile: false,
    envFile: false,
    logLevel: 'silent',
    cacheDir: join(workspaceDir, '.vite'),
    esbuild: { jsx: 'automatic' },
    optimizeDeps: { noDiscovery: true, include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime'] },
    server: { host: '127.0.0.1', port, strictPort: true, fs: { strict: true, allow: [workspaceDir, join(repo, 'node_modules')] } },
  });
}
async function discovery(profile: string, targetId: string, signal: AbortSignal, record: RecordDiagnostic): Promise<string> {
  const deadline = Date.now() + 10000;
  while (true) {
    signal.throwIfAborted();
    try {
      const activePort = await readFile(join(profile, 'DevToolsActivePort'), 'utf8');
      const port = Number(activePort.split('\n')[0]);
      if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Invalid Electron DevTools port');
      const endpoint = `http://127.0.0.1:${port}/`;
      const url = new URL('json/list', endpoint).href;
      record({ kind: 'discovery-request', url });
      const response = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]), redirect: 'error' });
      if (!response.ok) throw new Error(`Electron discovery HTTP ${response.status}`);
      const body: unknown = await response.json();
      record({ kind: 'discovery-response', url, status: response.status, body });
      const matches = discoverySchema
        .parse(body)
        .filter((target) => target.id === targetId && target.type === 'page' && target.url === 'about:blank');
      if (matches.length !== 1) throw new Error('Electron target identity does not match about:blank discovery');
      return endpoint;
    } catch (error) {
      record({ kind: 'discovery-error', message: String(error) });
      const code = (error as NodeJS.ErrnoException).code ?? (error as { cause?: NodeJS.ErrnoException }).cause?.code;
      if (signal.aborted || Date.now() >= deadline || !['ENOENT', 'ECONNREFUSED'].includes(code ?? '')) throw error;
      await new Promise<void>((complete) => setTimeout(complete, 50));
    }
  }
}

async function assertCdpStopped(profile: string): Promise<void> {
  let port: number;
  try {
    port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Cannot verify stopped Electron CDP port');
  try {
    await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
  } catch (error) {
    if ((error as { cause?: NodeJS.ErrnoException }).cause?.code === 'ECONNREFUSED') return;
    throw new Error('Electron CDP listener stop could not be confirmed', { cause: error });
  }
  throw new Error('Electron CDP listener remains reachable after process cleanup');
}

export const executeTask: ExecuteTask = async (input, context) => {
  if (!configuration) throw new Error('VS001 runtime configuration missing');
  const { repo, directory, record } = configuration;
  const task = taskSchema.parse(input);
  const resources = new RunResources(context, record);
  try {
    const model = process.env['WSL_VS001_MODEL']?.trim();
    if (!model || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model))
      throw new Error('Set WSL_VS001_MODEL to the actual Codex model for VS001');
    if (!['linux', 'darwin'].includes(process.platform)) throw new Error('VS001 owned-process lifecycle currently requires macOS or Linux');
    resources.check();
    const connection = new SbxConnection();
    await resources.own(() => connection.shutdown());
    const status = await connection.initialize((stream, text) => record({ kind: 'sbx-version-transport', stream, text }));
    resources.check();
    if (!status.available || !status.version) throw new Error(status.reason ?? 'sbx Codex version unavailable');
    const electron: unknown = createRequire(join(repo, 'apps/desktop/package.json'))('electron');
    if (typeof electron !== 'string') throw new Error('Installed Electron executable is unavailable');
    await runAgent(task, context, connection, resources, status.version, model, record);
    const desktopBuild: { pending?: Promise<unknown> } = {};
    await resources.own(async () => {
      await desktopBuild.pending?.catch(() => undefined);
    });
    resources.check();
    desktopBuild.pending = buildElectronHost(repo, directory);
    await desktopBuild.pending;
    resources.check();
    const pagePort = await allocatePagePort(resources);
    resources.check();
    const server = await createRunPage(context.workspaceDir, repo, pagePort);
    await resources.own(() => server.close());
    resources.check();
    await server.listen();
    resources.check();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not bind a loopback port');
    const previewUrl = `http://127.0.0.1:${address.port}/?runId=${task.runId}`;
    const profile = await mkdtemp(join(directory, 'electron-profile-'));
    await resources.own(() => rm(profile, { recursive: true, force: true }));
    resources.check();
    const command = [
      electron,
      join(directory, 'electron.cjs'),
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
    ];
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      WSL_VS001_RUN_ID: task.runId,
      WSL_VS001_PREVIEW_URL: previewUrl,
      WSL_VS001_PROFILE: profile,
    };
    delete env['ELECTRON_RUN_AS_NODE'];
    const child = spawn(electron, command.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], env, detached: true });
    child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') record({ kind: 'app-control-error', message: error.message });
    });
    let resolveClosed!: () => void;
    const closed = new Promise<void>((complete) => {
      resolveClosed = complete;
    });
    child.once('close', resolveClosed);
    let resolveReady!: (value: z.infer<typeof readySchema>) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<z.infer<typeof readySchema>>((complete, reject) => {
      resolveReady = complete;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);
    child.once('error', rejectReady);
    child.once('close', (code, signal) => rejectReady(new Error(`Electron exited before ready: ${code ?? signal}`)));
    await resources.own(async () => {
      await stopChild(child, closed);
      await assertCdpStopped(profile);
    });
    const pid = child.pid;
    if (!pid) throw new Error('Electron did not allocate a process');
    context.emit({
      runId: task.runId,
      taskSha256: context.taskSha256,
      at: new Date().toISOString(),
      seq: 3,
      type: 'app.started',
      pid,
      command,
    });
    const log = (stream: 'stdout' | 'stderr', text: string) => {
      try {
        record({ kind: 'app-output', pid, stream, text });
        if (text)
          context.log({
            runId: task.runId,
            taskSha256: context.taskSha256,
            at: new Date().toISOString(),
            source: 'app',
            pid,
            stream,
            text,
          });
      } catch (error) {
        rejectReady(new Error(`Application log callback failed: ${String(error)}`));
        void resources.stop().catch(() => undefined);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => log('stdout', chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => log('stderr', chunk.toString()));
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (!line.startsWith('WSL_VS001:')) return;
      try {
        resolveReady(readySchema.parse(JSON.parse(line.slice('WSL_VS001:'.length))));
      } catch (error) {
        rejectReady(new Error(`Invalid Electron ready identity: ${String(error)}`));
      }
    });
    await resources.own(async () => lines.close());
    const abort = () => rejectReady(new Error('Electron readiness aborted'));
    context.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => rejectReady(new Error('Electron readiness timed out')), 10000);
    let page: z.infer<typeof readySchema>;
    try {
      resources.check();
      page = await ready;
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
    }
    resources.check();
    if (page.pid !== pid) throw new Error('Electron ready belongs to another process');
    const cdpEndpoint = await discovery(profile, page.targetId, context.signal, record);
    resources.check();
    const identity = identitySchema.parse({ pid, webContentsId: page.webContentsId, targetId: page.targetId, previewUrl, cdpEndpoint });
    context.emit({ runId: task.runId, taskSha256: context.taskSha256, at: new Date().toISOString(), seq: 4, type: 'app.ready', identity });
    return { ...identity, stop: () => resources.stop() };
  } catch (error) {
    try {
      record({ kind: 'runtime-error', message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    } finally {
      await resources.stop();
    }
    throw error;
  }
};
