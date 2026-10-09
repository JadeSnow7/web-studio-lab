/* global Buffer */
import { open, rm } from 'node:fs/promises';
import { inventory, inspectTar } from './payload-lib.mjs';

const macho = new Set(['feedface', 'cefaedfe', 'feedfacf', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
export const requiredGuestBinaries = [
  'usr/local/bin/node',
  'usr/local/lib/node_modules/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex',
];
function format(header) {
  if (macho.has(header.subarray(0, 4).toString('hex'))) return 'Mach-O';
  if (header.subarray(0, 2).toString() === 'MZ') return 'PE';
  if (header.subarray(0, 4).toString('hex') === '7f454c46') return 'ELF';
  return null;
}
async function readHeader(file) {
  const handle = await open(file, 'r');
  try {
    const header = Buffer.alloc(64);
    const { bytesRead } = await handle.read(header, 0, 64, 0);
    return header.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}
export async function prunePnpmForeignTargets(directory) {
  const removed = [];
  for (const entry of await inventory(directory)) {
    if (!entry.stat.isFile()) continue;
    const kind = format(await readHeader(entry.absolute));
    if (kind !== 'Mach-O' && kind !== 'PE') continue;
    // The pinned pnpm loader uses these only on darwin/win32; Linux cloning uses fs.copyFileSync.
    if (!/^dist\/(?:reflink\.(?:darwin|win32)[^/]*\.node|vendor\/fastlist-[^/]*\.exe)$/.test(entry.relative))
      throw new Error(`Unexpected foreign pnpm binary: ${entry.relative}`);
    await rm(entry.absolute);
    removed.push(entry.relative);
  }
  return removed;
}
export function inspectLinuxBinary(name, header, elfFiles) {
  const kind = format(header);
  if (kind === 'Mach-O' || kind === 'PE') throw new Error(`Foreign ${kind} binary in Linux ARM64 guest: ${name}`);
  if (kind !== 'ELF') return;
  if (header.length < 20 || header[4] !== 2 || header[5] !== 1 || header.readUInt16LE(18) !== 183)
    throw new Error(`Incompatible ELF binary in Linux ARM64 guest: ${name}`);
  elfFiles.add(name);
}
function verifyRequired(elfFiles) {
  for (const name of requiredGuestBinaries) if (!elfFiles.has(name)) throw new Error(`Required Linux ARM64 executable is missing: ${name}`);
  return { platform: 'linux-arm64', elfFiles: [...elfFiles].sort() };
}
export async function auditGuestDirectory(directory) {
  const elfFiles = new Set();
  for (const entry of await inventory(directory))
    if (entry.stat.isFile()) inspectLinuxBinary(entry.relative, await readHeader(entry.absolute), elfFiles);
  return verifyRequired(elfFiles);
}
export function auditGuestArchive(archive) {
  const elfFiles = new Set();
  for (const entry of inspectTar(archive)) if (entry.type === '0') inspectLinuxBinary(entry.name, entry.header, elfFiles);
  return verifyRequired(elfFiles);
}
