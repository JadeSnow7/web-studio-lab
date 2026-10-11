import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile, mkdtemp } from 'node:fs/promises';
import { DependencyManifestSchema } from '@wsl/protocol';
import type * as FsPromises from 'node:fs/promises';
import type * as Os from 'node:os';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
const control = vi.hoisted(() => ({
  free: 0,
  version: 'sbx version: v0.48.0 build',
  calls: [] as string[][],
  commands: [] as string[],
  readCommand: null as null | ((file: string) => Promise<string>),
}));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof Os>()),
  homedir: () => '/fixture-home',
  release: () => '23.0.0',
}));
vi.mock('node:child_process', () => ({
  spawn: (binary: string, args: string[]) => {
    control.calls.push([binary, ...args]);
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    queueMicrotask(async () => {
      if (args[0] === '-a' && control.readCommand && args[2]) control.commands.push(await control.readCommand(args[2]));
      if (args[0] === 'version') child.stdout.write(control.version);
      child.emit('close', 0);
    });
    return child;
  },
}));
const bytes = Buffer.from('payload');
const hash = createHash('sha256').update(bytes).digest('hex');
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof FsPromises>()),
  lstat: vi.fn(async () => ({ isDirectory: () => true })),
  access: vi.fn(async () => undefined),
  statfs: vi.fn(async () => ({ bavail: control.free, bsize: 1 })),
  readFile: vi.fn(async (file: string) =>
    file.endsWith('result.json')
      ? JSON.stringify({ exitCode: 0 })
      : file.endsWith('dependencies.json')
        ? JSON.stringify({
            schemaVersion: 1,
            platform: 'darwin-arm64',
            minimumFreeBytes: 1024,
            python: {
              path: 'python/bin/python3',
              executable: 'python/bin/python3',
              sha256: hash,
              archiveSha256: 'b'.repeat(64),
              expandedBytes: 1024,
              source: 'https://example.com/python',
              license: 'Python',
              version: '3.14.4',
            },
            guest: {
              path: 'guest.tar.gz',
              sha256: hash,
              expandedBytes: 1024,
              source: 'https://example.com/guest',
              license: 'MIT',
              node: '24.21.0',
              pnpm: '10.34.6',
              codex: '0.160.0',
            },
            baseImage: 'docker.io/docker/sandbox-templates@sha256:8b4cd0a46c8b600bc6b6a64af23c03d4c2807fbfc61f47568092a93fb9dc88b0',
          })
        : bytes,
  ),
}));
import { NativeSetupAdapter } from './setup-adapter';
afterEach(() => {
  control.calls = [];
  control.commands = [];
  control.readCommand = null;
  vi.unstubAllGlobals();
});
it('insufficient free space blocks before sbx installation or sandbox side effects', async () => {
  vi.stubGlobal('process', { ...process, platform: 'darwin', arch: 'arm64' });
  const adapter = new NativeSetupAdapter('/runtime', '/Applications/App.app', '/user-data');
  await expect(adapter.check(new AbortController().signal)).rejects.toMatchObject({ code: 'disk-space' });
  expect(control.calls.every((call) => call[0] === '/usr/bin/codesign')).toBe(true);
});
it('existing incompatible sbx is verified then refused without downloading or overwriting', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const adapter = new NativeSetupAdapter('/runtime', '/Applications/App.app', '/user-data');
  await expect(adapter.installSbx(new AbortController().signal)).rejects.toMatchObject({ code: 'sbx-version-conflict' });
  expect(fetch).not.toHaveBeenCalled();
  expect(control.calls.map((call) => call[1])).toEqual(['--verify', 'version']);
  expect(control.calls[0]).toEqual([
    '/usr/bin/codesign',
    '--verify',
    '--deep',
    '--strict',
    '-R',
    '=anchor apple generic and certificate leaf[subject.OU] = "9BNSXJN65R"',
    expect.stringMatching(/\/Applications\/Sbx\.app$/),
  ]);
});

it('guest payload cleanup uses privilege only for the fixed copied archive', async () => {
  const manifest = DependencyManifestSchema.parse(JSON.parse(await readFile('/runtime/dependencies.json', 'utf8')));
  const adapter = new NativeSetupAdapter('/runtime', '/Applications/App.app', '/user-data');
  await adapter.installTools('/sbx', 'owned', manifest, new AbortController().signal);
  expect(control.calls[0]).toEqual(['/sbx', 'cp', '/runtime/guest.tar.gz', 'owned:/tmp/wsl-competition-tools.tar.gz']);
  expect(control.calls[1]?.slice(0, 5)).toEqual(['/sbx', 'exec', 'owned', 'sh', '-c']);
  const script = control.calls[1]?.[5];
  expect(script).toContain('sudo -n tar -xzf /tmp/wsl-competition-tools.tar.gz -C /; sudo -n rm -- /tmp/wsl-competition-tools.tar.gz');
  expect(script).not.toContain('/fixture-home');
});

it('login invokes bundled host Python with isolation and disabled bytecode writes', async () => {
  const fs = await vi.importActual<typeof FsPromises>('node:fs/promises');
  const root = await mkdtemp(path.join(tmpdir(), 'wsl-login-flags-'));
  control.readCommand = async (file) => fs.readFile(file, 'utf8');
  const adapter = new NativeSetupAdapter('/runtime', '/Applications/App.app', root);
  await adapter.login('/sbx', 'docker', new AbortController().signal, '00000000-0000-4000-8000-000000000001');
  expect(control.commands).toHaveLength(1);
  expect(control.commands[0]).toContain("exec '/runtime/python/bin/python3' -I -B ");
});
