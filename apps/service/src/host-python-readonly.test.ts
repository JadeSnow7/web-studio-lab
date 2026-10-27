import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { LocalFileTransport } from './observation-files';
import { LocalTerminal } from './local-terminal';

async function pythonFiles(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function collect(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile() && /\.py[co]?$/.test(entry.name))
        result[path.relative(root, file)] = createHash('sha256')
          .update(await readFile(file))
          .digest('hex');
    }
  }
  await collect(root);
  return result;
}
it('host file and PTY Python invocations leave source and bytecode unchanged, including an uncached import', async () => {
  const python = path.resolve(process.env['WSL_TEST_PYTHON'] ?? '/usr/bin/python3');
  await access(python);
  const { stdout } = await promisify(execFile)(python, ['-I', '-B', '-c', 'import sysconfig; print(sysconfig.get_path("stdlib"))']);
  const stdlib = await realpath(stdout.trim());
  const before = await pythonFiles(stdlib);
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-python-seal-'));
  await writeFile(path.join(root, 'bytecode_canary.py'), 'VALUE = 42\n');
  await writeFile(path.join(root, 'document.txt'), 'HOST_READ_OK');
  const wrapper = path.join(root, 'python-wrapper');
  const prefix = 'import sys; sys.path.insert(0, ' + JSON.stringify(root) + '); import bytecode_canary; sys.path.pop(0)\n';
  // Preserve the spawned PID and production flags while forcing a fresh compile; without -B the canary creates a detectable .pyc.
  await writeFile(
    wrapper,
    '#!' +
      python +
      '\nimport os, sys\nargs = sys.argv[1:]\nsource = args.index("-c") + 1\nargs[source] = ' +
      JSON.stringify(prefix) +
      '+ args[source]\nos.execv(' +
      JSON.stringify(python) +
      ', [' +
      JSON.stringify(python) +
      ', *args])\n',
    { mode: 0o700 },
  );
  const files = new LocalFileTransport(root, wrapper);
  const terminal = new LocalTerminal(
    root,
    {
      workspaceId: 'test',
      environmentId: 'local',
      resourceId: 'terminal',
      kind: 'terminal',
      instanceId: 'instance',
      instanceGeneration: 1,
    },
    () => undefined,
    wrapper,
  );
  try {
    const file = await files.read(await files.realpath(path.join(root, 'document.txt')), 1024);
    expect(file.toString()).toBe('HOST_READ_OK');
    const opened = await terminal.open(80, 24);
    await expect.poll(() => terminal.get().state, { timeout: 5000 }).toBe('running');
    terminal.write(opened.sessionId!, "printf 'PTY_READONLY_OK\\n'\n");
    await expect.poll(() => terminal.get().output).toContain('PTY_READONLY_OK');
    await terminal.close(opened.sessionId!);
    expect(await readdir(root)).not.toContain('__pycache__');
    expect(await readFile(path.join(root, 'bytecode_canary.py'), 'utf8')).toBe('VALUE = 42\n');
    expect(await pythonFiles(stdlib)).toEqual(before);
  } finally {
    await files.close();
    await terminal.shutdown();
  }
}, 30000);
