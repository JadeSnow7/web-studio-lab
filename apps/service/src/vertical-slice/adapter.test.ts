import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { taskSchema, type AdapterContext, type ProductEvent, type RawLog } from '../../../../tests/vertical-slice/contracts.js';
import { SbxConnection, type GuestFrame, type GuestOutcome, type GuestWorkspace } from '../sbx';
import { executeTask as executeProductTask } from '../../../../src/vertical-slice/adapter.js';
import {
  allocatePagePort,
  buildElectronHost,
  commitWorkspace,
  createRunPage,
  readWorkspace,
  RunResources,
  runAgent,
  stopChild,
} from './adapter';
// Dynamically reuse the frozen verifier without changing its baseline tsconfig
// assumptions by pulling it into the service's stricter compilation unit.
const {
  ProductTranscript,
}: {
  ProductTranscript: new (runId: string, taskSha256: string) => { emit(event: ProductEvent): unknown; log(entry: RawLog): unknown };
} = await import(path.resolve('tests/vertical-slice/evidence.ts'));

const task = taskSchema.parse({
  schemaVersion: 1,
  taskId: 'VS001',
  runId: randomUUID(),
  instruction:
    'Change only src/App.tsx so the unique visible [data-testid="greeting"] reads exactly Hello Web Studio. Use one real Agent harness session.',
  allowedPaths: ['src/App.tsx'],
  initialText: 'Hello baseline',
  expectedText: 'Hello Web Studio',
  selector: '[data-testid="greeting"]',
});
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-vs001-unit-'));
  roots.push(root);
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src/App.tsx'), 'before');
  await writeFile(path.join(root, 'package.json'), '{}');
  return root;
}
function context(root: string, controller = new AbortController()) {
  const cleanups: (() => Promise<void>)[] = [];
  const events: ProductEvent[] = [];
  const logs: RawLog[] = [];
  const transcript = new ProductTranscript(task.runId, 'a'.repeat(64));
  const value: AdapterContext = {
    workspaceDir: root,
    taskSha256: 'a'.repeat(64),
    signal: controller.signal,
    registerCleanup(cleanup) {
      if (controller.signal.aborted) throw new Error('registration after abort');
      cleanups.push(cleanup);
    },
    emit(event) {
      transcript.emit(event);
      events.push(event);
    },
    log(entry) {
      transcript.log(entry);
      logs.push(entry);
    },
  };
  return { value, cleanups, events, logs };
}

describe('offline VS001 inventory and lifecycle rejection tests (no model)', () => {
  it('builds and imports the real service adapter, retaining a preflight error without starting an Agent', async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), 'wsl-vs001-build-test-'));
    roots.push(runDir);
    const root = path.join(runDir, 'work');
    await mkdir(root);
    vi.stubEnv('WSL_VS001_MODEL', '');
    const ctx = context(root);
    await expect(executeProductTask(task, ctx.value)).rejects.toThrow('WSL_VS001_MODEL');
    for (const cleanup of ctx.cleanups.toReversed()) await cleanup();
    const diagnostics = await readFile(path.join(runDir, 'product-diagnostics.ndjson'), 'utf8');
    expect(diagnostics).toContain('WSL_VS001_MODEL');
    expect(
      diagnostics
        .split('\n')
        .filter(Boolean)
        .every((line) => JSON.parse(line).runId === task.runId),
    ).toBe(true);
    expect(ctx.events).toEqual([]);
  }, 15000);

  it('builds the actual thin Electron host with the production PreviewController', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'wsl-vs001-host-build-test-'));
    roots.push(directory);
    await buildElectronHost(path.resolve('.'), directory);
    const output = await readFile(path.join(directory, 'electron.cjs'), 'utf8');
    expect(output).toContain('Target.getTargetInfo');
    expect(output).toContain('WebContentsView');
    expect(output).toContain('WSL_VS001:');
  }, 15000);

  it('waits for a late root allocation after abort before closing its diagnostic descriptor', async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), 'wsl-vs001-abort-build-test-'));
    roots.push(runDir);
    const root = path.join(runDir, 'work');
    await mkdir(root);
    const controller = new AbortController();
    const ctx = context(root, controller);
    const executing = executeProductTask(task, ctx.value);
    const rejected = expect(executing).rejects.toThrow();
    controller.abort(new Error('unit early abort'));
    for (const cleanup of ctx.cleanups.toReversed()) await cleanup();
    await rejected;
    const diagnostics = await readFile(path.join(runDir, 'product-diagnostics.ndjson'), 'utf8');
    expect(diagnostics).toContain('abort');
    expect(diagnostics).not.toContain('EBADF');
    expect(ctx.events).toEqual([]);
  });

  it('serves the unchanged fixed page and resolves React and App.js to TSX through the real Vite component', async () => {
    const repo = path.resolve('.');
    await mkdir(path.join(repo, '.local'), { recursive: true });
    const directory = await mkdtemp(path.join(repo, '.local/vs001-page-smoke-'));
    roots.push(directory);
    await cp(path.join(repo, 'fixtures/vertical-slice/page'), directory, { recursive: true });
    const before = readWorkspace(directory);
    const resources = new RunResources(context(directory).value, () => undefined);
    const port = await allocatePagePort(resources);
    const server = await createRunPage(directory, repo, port);
    await resources.own(() => server.close());
    try {
      await server.listen();
      const address = server.httpServer?.address();
      if (!address || typeof address === 'string') throw new Error('Vite did not bind a TCP port');
      const origin = `http://127.0.0.1:${address.port}`;
      const index = await fetch(origin, { signal: AbortSignal.timeout(3000) });
      expect(index.status).toBe(200);
      expect(await index.text()).toContain('/src/main.tsx');
      const main = await fetch(origin + '/src/main.tsx', { signal: AbortSignal.timeout(3000) });
      expect(main.status).toBe(200);
      expect(await main.text()).toContain('/src/App.tsx');
      const app = await fetch(origin + '/src/App.tsx', { signal: AbortSignal.timeout(3000) });
      expect(app.status).toBe(200);
      const source = await app.text();
      expect(source).toContain('Hello baseline');
      expect(source).toMatch(/jsx(?:-dev)?-runtime/);
      const runtimePath = source.match(/from "([^"]*react_jsx[^"]*\.js[^"]*)"/)?.[1];
      if (!runtimePath) throw new Error('Transformed App has no JSX runtime module');
      const runtime = await fetch(origin + runtimePath, { signal: AbortSignal.timeout(3000) });
      expect(runtime.status).toBe(200);
      expect(readWorkspace(directory)).toEqual(before);
    } finally {
      await resources.stop();
    }
  }, 15000);

  it.each(['extra', 'deleted', 'unchanged', 'duplicate', 'unsafe', 'wrong-run'])(
    'rejects %s inventory and retains a safe App edit when available',
    async (kind) => {
      const root = await workspace();
      const before = readWorkspace(root);
      const result: GuestWorkspace = {
        runId: task.runId,
        files: before.map((file) => ({
          ...file,
          ...(file.path === 'src/App.tsx' ? { base64: Buffer.from('changed').toString('base64') } : {}),
        })),
      };
      if (kind === 'extra') result.files.push({ path: 'extra.txt', base64: Buffer.from('unallowed').toString('base64') });
      if (kind === 'deleted') result.files = result.files.filter((file) => file.path !== 'package.json');
      if (kind === 'unchanged') result.files = before;
      if (kind === 'duplicate') result.files.push(result.files[0]!);
      if (kind === 'unsafe') result.files.push({ path: '../escape', base64: '' });
      if (kind === 'wrong-run') result.runId = randomUUID();
      expect(() => commitWorkspace(root, before, result, task)).toThrow();
      expect(await readFile(path.join(root, 'src/App.tsx'), 'utf8')).toBe(['extra', 'deleted'].includes(kind) ? 'changed' : 'before');
      expect(await readFile(path.join(root, 'package.json'), 'utf8')).toBe('{}');
    },
  );

  it('rejects concurrent host changes instead of overwriting them', async () => {
    const root = await workspace();
    const before = readWorkspace(root);
    await writeFile(path.join(root, 'src/App.tsx'), 'host changed');
    expect(() =>
      commitWorkspace(
        root,
        before,
        {
          runId: task.runId,
          files: before.map((file) => ({
            ...file,
            ...(file.path === 'src/App.tsx' ? { base64: Buffer.from('agent changed').toString('base64') } : {}),
          })),
        },
        task,
      ),
    ).toThrow('Host run copy changed');
    expect(await readFile(path.join(root, 'src/App.tsx'), 'utf8')).toBe('host changed');
  });

  it('immediately releases a late allocation whose cleanup registration is rejected', async () => {
    const controller = new AbortController();
    const ctx = context('/unused', controller);
    const resources = new RunResources(ctx.value, () => undefined);
    controller.abort();
    const release = vi.fn(async () => undefined);
    await expect(resources.own(release)).rejects.toThrow();
    expect(release).toHaveBeenCalledOnce();
    expect(ctx.cleanups).toEqual([]);
    await resources.stop();
  });

  it('shutdown during asynchronous sbx resolution prevents later probe allocation', async () => {
    const root = await workspace();
    const binary = path.join(root, 'sbx');
    await writeFile(
      binary,
      "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.argv[1]+'.called','invoked');\nprocess.exit(1);\n",
      { mode: 0o755 },
    );
    const connection = new SbxConnection();
    vi.stubEnv('WSL_SBX_NAME', 'unit-sandbox');
    vi.stubEnv('WSL_SBX_BIN', binary);
    const initializing = connection.initialize();
    await connection.shutdown();
    expect((await initializing).available).toBe(false);
    expect(connection.getStatus().reason).toContain('关闭');
    expect(connection.getCleanupPending()).toBe(false);
    await expect(readFile(binary + '.called')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('abort from an inspect diagnostic callback prevents a later Codex version probe', async () => {
    const root = await workspace();
    const binary = path.join(root, 'sbx');
    await writeFile(
      binary,
      "#!/usr/bin/env node\nconst fs=require('node:fs'); fs.appendFileSync(process.argv[1]+'.calls',process.argv[2]+'\\n'); if(process.argv[2]==='inspect') console.log(JSON.stringify({name:'unit-sandbox',agent:'codex',state:'running',runtime_mounts:[]})); else process.exit(1);\n",
      { mode: 0o755 },
    );
    vi.stubEnv('WSL_SBX_NAME', 'unit-sandbox');
    vi.stubEnv('WSL_SBX_BIN', binary);
    const connection = new SbxConnection();
    const result = await connection.initialize(() => {
      void connection.shutdown();
    });
    expect(result.available).toBe(false);
    expect(result.reason).toContain('关闭');
    expect(await readFile(binary + '.calls', 'utf8')).toBe('inspect\n');
    expect(connection.getCleanupPending()).toBe(false);
  });

  // Synthetic protocol samples exercise log binding/failure handling only. They are
  // not imported by src/vertical-slice/adapter.ts or the frozen acceptance command.
  it.each(['pre-thread', 'malformed', 'nonzero', 'abort'])(
    'retains %s output and modifications without claiming successful acceptance',
    async (kind) => {
      const root = await workspace();
      const controller = new AbortController();
      const ctx = context(root, controller);
      const diagnostics: Record<string, unknown>[] = [];
      const resources = new RunResources(ctx.value, (entry) => diagnostics.push(entry));
      const expected: GuestOutcome = {
        error: kind === 'malformed' ? 'protocol failed' : null,
        exitCode: kind === 'nonzero' || kind === 'pre-thread' ? 7 : kind === 'abort' ? -15 : 0,
        confirmed: true,
      };
      const connection: Parameters<typeof runAgent>[2] = {
        start(start, onFrame) {
          let resolveDone!: (outcome: GuestOutcome) => void;
          const done = new Promise<GuestOutcome>((complete) => {
            resolveDone = complete;
          });
          const guest = { done, close: vi.fn(async () => done), write: vi.fn() };
          setTimeout(() => {
            const emit = (frame: GuestFrame) => {
              try {
                onFrame(frame);
              } catch {
                /* GuestProcess converts callback rejection into a failed outcome. */
              }
            };
            emit({ type: 'ready', pid: 12345 });
            emit({ type: 'output', stream: 'stderr', data: 'early stderr\n' });
            if (kind !== 'pre-thread') {
              emit({ type: 'output', stream: 'stdout', data: '{"type":"thread.started","thread_id":"synthetic-unit-thread"}\n' });
              emit({
                type: 'output',
                stream: 'stdout',
                data:
                  kind === 'malformed'
                    ? '{broken\n'
                    : '{"type":"item.completed","item":{"id":"r","type":"agent_message","text":"done"}}\n{"type":"turn.completed"}\n',
              });
            }
            if (start.mode !== 'codex' || !start.workspace) throw new Error('unit workspace missing');
            emit({
              type: 'workspace',
              runId: task.runId,
              files: start.workspace.files.map((file) => ({
                ...file,
                ...(file.path === 'src/App.tsx' ? { base64: Buffer.from('retained edit').toString('base64') } : {}),
              })),
            });
            if (kind === 'abort') controller.abort();
            resolveDone(expected);
          }, 0);
          return guest;
        },
      };
      try {
        await expect(
          runAgent(task, ctx.value, connection, resources, 'codex-cli synthetic-unit-version', 'synthetic-unit-model', (entry) =>
            diagnostics.push(entry),
          ),
        ).rejects.toThrow();
        expect(await readFile(path.join(root, 'src/App.tsx'), 'utf8')).toBe('retained edit');
        expect(diagnostics.some((entry) => entry['kind'] === 'harness-output' && entry['text'] === 'early stderr\n')).toBe(true);
        expect(diagnostics.some((entry) => entry['kind'] === 'guest-workspace-snapshot')).toBe(true);
        expect(ctx.events.some((event) => event.type === 'app.started')).toBe(false);
        if (kind === 'pre-thread') expect(ctx.events).toEqual([]);
        else {
          expect(ctx.events.map((event) => event.type)).toEqual(['harness.started', 'harness.exited']);
          expect(ctx.logs[0]?.text).toBe('early stderr\n');
          expect(ctx.logs.every((entry) => entry.sessionId === 'synthetic-unit-thread')).toBe(true);
        }
      } finally {
        await resources.stop();
      }
    },
  );

  it.skipIf(!['linux', 'darwin'].includes(process.platform)).each(['eof', 'term'])(
    '%s stops an actual host grandchild and confirms the owned process group is gone',
    async (mode) => {
      const script =
        "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']); let stopping=false; child.on('close',()=>{if(stopping)process.exit(0)}); const stop=()=>{stopping=true;if(child.exitCode!==null||child.signalCode!==null)process.exit(0);else child.kill('SIGTERM')}; process.stdout.write(String(child.pid)+'\\n'); process.stdin.resume(); process.stdin.on('end',()=>{if(process.argv[1]==='eof')stop()});process.once('SIGTERM',stop);";
      const child = spawn(process.execPath, ['-e', script, mode], { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      const closed = new Promise<void>((complete) => child.once('close', () => complete()));
      let output = '';
      child.stdout.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      try {
        await expect.poll(() => output).toMatch(/^\d+\n$/);
        const grandchild = Number(output.trim());
        await stopChild(child, closed);
        expect(() => process.kill(grandchild, 0)).toThrow();
        expect(() => process.kill(-child.pid!, 0)).toThrow();
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        await closed;
      }
    },
    10000,
  );
});
