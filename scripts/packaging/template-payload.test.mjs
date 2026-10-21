import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { auditTemplateArchive, templateBinaries } from './template-payload.mjs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { deterministicArchive } from './payload-lib.mjs';
const elf = () => {
  const bytes = Buffer.alloc(64);
  bytes.set([127, 69, 76, 70, 2, 1, 1]);
  bytes.writeUInt16LE(183, 18);
  return bytes;
};
test('template archive accepts Linux ARM64 and rejects foreign binaries, missing target and missing execute bit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-template-audit-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await assert.rejects(lstat(root), { code: 'ENOENT' });
  });
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

function changeTarMode(archive, name, mode) {
  const bytes = gunzipSync(archive);
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    const text = (part) => part.toString().replace(/\0.*$/s, '');
    const entry = text(header.subarray(345, 500));
    const current = (entry ? entry + '/' : '') + text(header.subarray(0, 100));
    if (current === name) {
      header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8);
      header.write('        ', 148, 8);
      const sum = header.reduce((total, byte) => total + byte, 0);
      header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
      return gzipSync(bytes);
    }
    offset += 512 + Math.ceil(parseInt(text(header.subarray(124, 136)) || '0', 8) / 512) * 512;
  }
  throw new Error('fixture member missing: ' + name);
}
test('template archive rejects private dependency directories, unreadable files and owner-only execute modes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wsl-template-permissions-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await assert.rejects(lstat(root), { code: 'ENOENT' });
  });
  const input = path.join(root, 'input'),
    archive = path.join(root, 'out.tar.gz');
  for (const file of templateBinaries) {
    await mkdir(path.dirname(path.join(input, file)), { recursive: true });
    await writeFile(path.join(input, file), elf());
    await chmod(path.join(input, file), 0o755);
  }
  await writeFile(path.join(input, 'node_modules/package.json'), '{}');
  await deterministicArchive(input, archive);
  const bytes = await readFile(archive);
  for (const [name, mode] of [
    ['node_modules', 0o700],
    ['node_modules/package.json', 0o600],
    [templateBinaries[0], 0o744],
  ])
    assert.throws(() => auditTemplateArchive(changeTarMode(bytes, name, mode)), /payload permissions|not executable/);
});
