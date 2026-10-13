import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { auditTemplateArchive, templateBinaries } from './template-payload.mjs';
import { deterministicArchive } from './payload-lib.mjs';
const elf = () => {
  const bytes = Buffer.alloc(64);
  bytes.set([127, 69, 76, 70, 2, 1, 1]);
  bytes.writeUInt16LE(183, 18);
  return bytes;
};
test('template archive accepts Linux ARM64 and rejects foreign binaries, missing target and missing execute bit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-template-audit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = path.join(root, 'input'),
    archive = path.join(root, 'out.tar.gz');
  for (const file of templateBinaries) {
    await mkdir(path.dirname(path.join(input, file)), { recursive: true });
    await writeFile(path.join(input, file), elf(), { mode: 0o755 });
  }
  const audit = async () => {
    await deterministicArchive(input, archive);
    return auditTemplateArchive(await readFile(archive));
  };
  assert.equal((await audit()).elfFiles.length, 4);
  await chmod(path.join(input, templateBinaries[0]), 0o644);
  await assert.rejects(audit(), /not executable/);
  await chmod(path.join(input, templateBinaries[0]), 0o755);
  await writeFile(path.join(input, 'node_modules/foreign.node'), Buffer.from('cffaedfe', 'hex'));
  await assert.rejects(audit(), /Foreign Mach-O/);
  await rm(path.join(input, 'node_modules/foreign.node'));
  await rm(path.join(input, templateBinaries[1]));
  await assert.rejects(audit(), /Required template/);
});
