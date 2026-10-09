/* global Buffer, fetch */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, lstat, readlink, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip, gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

export const root = path.resolve(import.meta.dirname, '../..');
export const runtimeRoot = path.join(root, 'packaging/generated/runtime');
export const digest = (bytes, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest('hex');
export async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export function verifyBytes(bytes, source) {
  if (digest(bytes) !== source.sha256) throw new Error(`SHA-256 mismatch: ${source.id}`);
  if (source.integrity) {
    const [algorithm, expected] = source.integrity.split('-');
    if (createHash(algorithm).update(bytes).digest('base64') !== expected) throw new Error(`Registry integrity mismatch: ${source.id}`);
  }
}
export async function download(source, cache) {
  const file = path.join(cache, source.id + '.tar.gz');
  await mkdir(cache, { recursive: true });
  try {
    const bytes = await readFile(file);
    verifyBytes(bytes, source);
    return file;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(source.url);
  if (!response.ok || !response.body) throw new Error(`Download failed: ${source.id}: HTTP ${response.status}`);
  const partial = file + '.partial';
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: 'wx' }));
    verifyBytes(await readFile(partial), source);
    await rename(partial, file);
  } finally {
    await rm(partial, { force: true });
  }
  return file;
}
const text = (buffer) => buffer.toString('utf8').replace(/\0.*$/s, '');
function paxValues(bytes) {
  const fields = {};
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(32, offset);
    const length = Number(bytes.subarray(offset, space).toString());
    if (space < offset || !Number.isSafeInteger(length) || length <= space - offset + 1 || offset + length > bytes.length)
      throw new Error('Invalid PAX entry');
    const record = bytes.subarray(space + 1, offset + length - 1).toString();
    const equals = record.indexOf('=');
    fields[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return fields;
}
function safeRelative(name) {
  if (!name || name.startsWith('/') || name.split('/').includes('..') || name.includes('\\') || name.includes('\0'))
    throw new Error(`Unsafe archive path: ${name}`);
  return path.posix.normalize(name).replace(/\/$/, '');
}
// Check headers and link ancestry before delegating extraction to the platform tar.
export function inspectTar(archive) {
  const bytes = gunzipSync(archive, { maxOutputLength: 2 ** 31 - 1 });
  const entries = [];
  let pax = {},
    globalPax = {},
    longName,
    longLink;
  for (let offset = 0; offset + 512 <= bytes.length;) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const expected = parseInt(text(header.subarray(148, 156)).trim(), 8);
    const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (sum !== expected) throw new Error('Invalid tar checksum');
    const size = parseInt(text(header.subarray(124, 136)).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > bytes.length) throw new Error('Invalid tar size');
    const type = String.fromCharCode(header[156] || 48);
    const body = bytes.subarray(offset + 512, offset + 512 + size);
    const prefix = text(header.subarray(345, 500));
    const rawName = (prefix ? prefix + '/' : '') + text(header.subarray(0, 100));
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = paxValues(body);
      continue;
    }
    if (type === 'g') {
      globalPax = { ...globalPax, ...paxValues(body) };
      continue;
    }
    if (type === 'L') {
      longName = text(body);
      continue;
    }
    if (type === 'K') {
      longLink = text(body);
      continue;
    }
    const attrs = { ...globalPax, ...pax };
    const name = safeRelative(attrs.path || longName || rawName);
    const link = attrs.linkpath || longLink || text(header.subarray(157, 257));
    if (!['0', '1', '2', '5'].includes(type)) throw new Error(`Unsupported tar entry type: ${type}`);
    if (type === '1' || type === '2') {
      if (link.startsWith('/') || link.includes('\\')) throw new Error(`Unsafe archive link: ${name}`);
      const target = path.posix.normalize(type === '2' ? path.posix.join(path.posix.dirname(name), link) : link);
      safeRelative(target);
    }
    entries.push({ name, type, size, link, header: Buffer.from(body.subarray(0, 64)) });
    pax = {};
    longName = undefined;
    longLink = undefined;
  }
  const links = new Set(entries.filter((entry) => ['1', '2'].includes(entry.type)).map((entry) => entry.name));
  const names = new Set();
  for (const entry of entries) {
    if (names.has(entry.name)) throw new Error(`Duplicate archive path: ${entry.name}`);
    names.add(entry.name);
    let parent = path.posix.dirname(entry.name);
    while (parent !== '.') {
      if (links.has(parent)) throw new Error(`Archive writes through link: ${entry.name}`);
      parent = path.posix.dirname(parent);
    }
  }
  return entries;
}
export async function extractSafe(file, destination) {
  const entries = inspectTar(await readFile(file));
  await mkdir(destination, { recursive: true });
  execFileSync('/usr/bin/tar', ['-xzf', file, '-C', destination], { stdio: 'inherit' });
  return entries;
}
export async function inventory(directory, prefix = '') {
  const result = [];
  for (const name of (await readdir(directory)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const absolute = path.join(directory, name);
    const stat = await lstat(absolute);
    result.push({ relative, absolute, stat });
    if (stat.isDirectory()) result.push(...(await inventory(absolute, relative)));
  }
  return result;
}
export async function expandedBytes(directory) {
  return (await inventory(directory)).reduce((size, entry) => size + (entry.stat.isFile() ? entry.stat.size : 0), 0);
}
function headerFor(name, size, mode, type, link = '') {
  const header = Buffer.alloc(512);
  const write = (value, offset, length) => {
    if (Buffer.byteLength(value) > length) throw new Error(`Tar field too long: ${value}`);
    header.write(value, offset, length, 'utf8');
  };
  if (Buffer.byteLength(name) > 100) {
    let split = name.lastIndexOf('/');
    while (split >= 0 && Buffer.byteLength(name.slice(split + 1)) > 100) split = name.lastIndexOf('/', split - 1);
    if (split < 0) throw new Error(`Tar path too long: ${name}`);
    write(name.slice(0, split), 345, 155);
    write(name.slice(split + 1), 0, 100);
  } else write(name, 0, 100);
  write((mode & 0o777).toString(8).padStart(7, '0') + '\0', 100, 8);
  write('0000000\0', 108, 8);
  write('0000000\0', 116, 8);
  write(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  write('00000000000\0', 136, 12);
  write('        ', 148, 8);
  write(type, 156, 1);
  write(link, 157, 100);
  write('ustar\0', 257, 6);
  write('00', 263, 2);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return header;
}
export async function deterministicArchive(directory, destination) {
  const entries = await inventory(directory);
  async function* contents() {
    for (const entry of entries) {
      const symlink = entry.stat.isSymbolicLink();
      const directory = entry.stat.isDirectory();
      const size = entry.stat.isFile() ? entry.stat.size : 0;
      const link = symlink ? await readlink(entry.absolute) : '';
      yield headerFor(entry.relative, size, entry.stat.mode, symlink ? '2' : directory ? '5' : '0', link);
      if (entry.stat.isFile()) {
        for await (const chunk of createReadStream(entry.absolute)) yield chunk;
        if (size % 512) yield Buffer.alloc(512 - (size % 512));
      }
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(contents()), createGzip({ level: 6 }), createWriteStream(destination));
}
