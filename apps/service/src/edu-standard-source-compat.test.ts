import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import helper from './app-helper.py?raw';
import { SourceSnapshotReader } from './source-snapshot';

it.each(['standard', 'edu', 'unknown'] as const)(
  'actual helper preserves standard snapshots and refuses %s imported profiles',
  async (kind) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'wsl-edu-standard-source-')));
    const key = { workspaceId: 'standard-compatibility', projectId: 'f5391f60-092b-4e5e-b94f-fb0dfe048520' };
    const originalFile = { path: 'package.json', base64: Buffer.from('{"name":"standard"}').toString('base64') };
    const files = [originalFile];
    const execute = (request: unknown) =>
      execFileSync(
        'python3',
        [
          '-I',
          '-c',
          "import sys,json; from pathlib import Path; scope={'__name__':'wsl_source_compat_test'}; exec(sys.argv[3],scope); scope['ROOT']=Path(sys.argv[1]); scope['run'](json.loads(sys.argv[2]))",
          root,
          JSON.stringify(request),
          helper,
        ],
        { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
    try {
      execute({ operation: 'create', ...key, files });
      const receiptPath = path.join(root, key.projectId, '.wsl-profile.json');
      if (kind !== 'standard')
        await writeFile(receiptPath, JSON.stringify({ projectKind: kind === 'edu' ? 'edu-web' : 'unrecognized', profileVersion: 1 }));
      if (kind === 'standard') {
        await expect(readFile(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
        const reader = new SourceSnapshotReader();
        reader.accept(execute({ operation: 'source-snapshot', ...key }));
        expect(reader.result(key).files).toEqual([{ ...originalFile, mode: '100644' }]);
      } else expect(() => execute({ operation: 'source-snapshot', ...key })).toThrow(/unsupported source profile receipt/);
      expect(await readFile(path.join(root, key.projectId, 'package.json'))).toEqual(Buffer.from(originalFile.base64, 'base64'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
