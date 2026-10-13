import { appendFileSync, closeSync, openSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { taskSchema, type ExecuteTask, type ProductAdapter } from '../../tests/vertical-slice/contracts.js';
type RecordDiagnostic = (value: Record<string, unknown>) => void;

// Existing service sources use Vite's ?raw assets and Bundler module resolution.
// Compile them with the installed toolchain rather than creating another sbx runtime.
export const executeTask: ExecuteTask = async (input, context) => {
  const task = taskSchema.parse(input);
  context.signal.throwIfAborted();
  const diagnostics = openSync(join(dirname(context.workspaceDir), 'product-diagnostics.ndjson'), 'wx');
  const record: RecordDiagnostic = (value) =>
    appendFileSync(
      diagnostics,
      JSON.stringify({ runId: task.runId, taskSha256: context.taskSha256, at: new Date().toISOString(), ...value }) + '\n',
    );
  let diagnosticsClosed = false;
  const closeDiagnostics = async () => {
    if (diagnosticsClosed) return;
    diagnosticsClosed = true;
    closeSync(diagnostics);
  };
  try {
    context.registerCleanup(closeDiagnostics);
  } catch (error) {
    await closeDiagnostics();
    throw error;
  }
  let finishExecution!: () => void;
  const executionCompleted = new Promise<void>((complete) => {
    finishExecution = complete;
  });
  let directory: string | undefined;
  let building: Promise<unknown> | undefined;
  let stopping: Promise<void> | undefined;
  const cleanup = () =>
    (stopping ??= (async () => {
      await building?.catch(() => undefined);
      if (directory) await rm(directory, { recursive: true, force: true });
    })());
  try {
    // The runner may stop awaiting executeTask on abort. Keep diagnostics open until
    // late async allocations have returned, rejected registration and been released.
    context.registerCleanup(() => executionCompleted);
    context.signal.throwIfAborted();
    directory = await mkdtemp(join(tmpdir(), `wsl-vs001-${task.runId}-`));
    try {
      context.registerCleanup(cleanup);
    } catch (error) {
      await cleanup();
      throw error;
    }
    context.signal.throwIfAborted();
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const entry = join(directory, 'service.mjs');
    building = build({
      root: repo,
      configFile: false,
      logLevel: 'silent',
      resolve: { alias: { '@wsl/protocol': join(repo, 'packages/protocol/src/index.ts') } },
      ssr: { noExternal: true },
      build: {
        ssr: join(repo, 'apps/service/src/vertical-slice/adapter.ts'),
        outDir: directory,
        emptyOutDir: false,
        rollupOptions: {
          external: (id) => id === 'vite',
          output: { format: 'es', entryFileNames: 'service.mjs', paths: { vite: join(repo, 'node_modules/vite/dist/node/index.js') } },
        },
      },
    });
    await building;
    context.signal.throwIfAborted();
    const adapter: ProductAdapter & { configure(repo: string, directory: string, record: RecordDiagnostic): void } = await import(
      pathToFileURL(entry).href
    );
    if (typeof adapter.executeTask !== 'function' || typeof adapter.configure !== 'function')
      throw new Error('Built VS001 runtime exports are invalid');
    context.signal.throwIfAborted();
    adapter.configure(repo, directory, record);
    return await adapter.executeTask(task, context);
  } catch (error) {
    try {
      record({ kind: 'adapter-error', message: error instanceof Error ? (error.stack ?? error.message) : String(error) });
    } finally {
      await cleanup();
    }
    throw error;
  } finally {
    finishExecution();
  }
};
