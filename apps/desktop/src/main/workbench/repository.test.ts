import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { FileWorkbenchRepository } from './repository';
describe('workbench persistence boundary', () => {
  it('rejects corrupt and future schema without overwriting original bytes', async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'wsl-workbench-')), 'state.json');
    const repository = new FileWorkbenchRepository(file);
    for (const content of ['{invalid', '{"schemaVersion":99,"snapshot":{}}']) {
      await writeFile(file, content);
      await expect(repository.load()).rejects.toThrow();
      expect(await readFile(file, 'utf8')).toBe(content);
    }
  });
  it('treats only a missing file as new workspace', async () => {
    const file = path.join(await mkdtemp(path.join(os.tmpdir(), 'wsl-workbench-')), 'missing.json');
    expect(await new FileWorkbenchRepository(file).load()).toBeNull();
  });
});
