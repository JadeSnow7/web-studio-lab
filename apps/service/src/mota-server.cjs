#!/usr/bin/env node
'use strict';
/* global Buffer, process, require, module, URL, TextDecoder, setTimeout, clearTimeout, window, XMLHttpRequest */
/* eslint-disable @typescript-eslint/no-require-imports -- Guest receives this standalone CommonJS adapter without a package loader. */

// Fixed Mota adapter: serves validated copies, never executes project Node code.
const http = require('node:http');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MARKER = '.wsl-mota-copy';
const MARKER_CONTENT = 'mota-managed-copy-v1\n';
const MAX_BODY = 1024 * 1024;
const MAX_FILE = 12 * 1024 * 1024;
const FLOOR_FILE = 'project/floors/MT1.js';
const EDITOR_HEADER = 'x-wsl-editor-session';
const OWNER_LIMIT = 1024;
const OPERATION_LIMIT = 1024;
const SESSION_LIMIT = 256;
const QUEUE_LIMIT = 128;
const WRITABLE = new Set(['project/floors/MT1.js', '_server/config.json']);
const ROOT_FILES = new Set(['index.html', 'editor.html', 'editor-mobile.html', 'styles.css', 'main.js', 'logo.png']);
const ROOT_DIRS = new Set(['project', 'libs', 'extensions', '_server', '_docs']);
const REQUIRED_FILES = [
  'index.html',
  'editor.html',
  'main.js',
  'libs/core.js',
  'project/data.js',
  'project/floors/MT1.js',
  '_server/editor.js',
  '_server/editor_file.js',
];
// Mirrored from protocol/mota for the standalone guest; parity is checked in mota-server.test.ts.
const EXCLUDED_NAMES = new Set([
  'node_modules',
  '__pycache__',
  'credentials',
  'credential',
  'secrets',
  'secret',
  'password',
  'passwords',
  'passwd',
  'token',
  'tokens',
  'access_token',
  'refresh_token',
  'authorized_keys',
  'known_hosts',
]);
const CREDENTIAL_FILE =
  /^(?:credentials?|secrets?|passwords?|passwd|tokens?|access_token|refresh_token)\.(?:json|txt|ya?ml|toml|ini|conf|env)$/i;
const PRIVATE_KEY_FILE = /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)(?:\.|$)/i;
const EXCLUDED_EXTENSION = /\.(?:pem|key|p12|pfx|keystore|py|pyc|sh|bash|zsh|bat|cmd|ps1|exe|dll|so|dylib)$/i;
const SERVER_ENTRY = /^(?:(?:safe-)?mota-)?server\.(?:js|cjs|mjs|py)$/i;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.cur': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.animate': 'text/plain; charset=utf-8',
  '.g4': 'text/plain; charset=utf-8',
};
const CSP =
  "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

function fail(code, status = 400) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  throw error;
}
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function hasControl(value) {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function identityValue(value) {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (
    !exactKeys(value, ['workspaceId', 'environmentId', 'projectId', 'appInstanceId']) ||
    typeof value.workspaceId !== 'string' ||
    !value.workspaceId ||
    value.workspaceId.length > 200 ||
    hasControl(value.workspaceId) ||
    value.environmentId !== 'sandbox' ||
    typeof value.projectId !== 'string' ||
    !uuid.test(value.projectId) ||
    typeof value.appInstanceId !== 'string' ||
    !uuid.test(value.appInstanceId)
  )
    fail('invalid_identity');
  return Object.freeze({
    workspaceId: value.workspaceId,
    environmentId: 'sandbox',
    projectId: value.projectId,
    appInstanceId: value.appInstanceId,
  });
}
function sameIdentity(left, right) {
  return Object.keys(left).every((key) => left[key] === right[key]);
}
function originValue(value) {
  if (typeof value !== 'string') fail('invalid_origin');
  let url;
  try {
    url = new URL(value);
  } catch {
    fail('invalid_origin');
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    url.origin !== value
  )
    fail('invalid_origin');
  return value;
}
function isMotaSourcePath(value) {
  if (typeof value !== 'string' || !value || value.length > 500 || /[\\%?#:]/.test(value) || hasControl(value)) return false;
  const parts = value.split('/');
  if (
    parts.some(
      (name) =>
        !name ||
        name.startsWith('.') ||
        EXCLUDED_NAMES.has(name.toLowerCase()) ||
        CREDENTIAL_FILE.test(name) ||
        PRIVATE_KEY_FILE.test(name) ||
        EXCLUDED_EXTENSION.test(name) ||
        SERVER_ENTRY.test(name),
    )
  )
    return false;
  return parts.length === 1 ? ROOT_FILES.has(value) : ROOT_DIRS.has(parts[0]);
}
function relativeName(value, directory = false) {
  if (typeof value !== 'string') fail('invalid_path');
  const name = value.startsWith('./') ? value.slice(2) : value;
  if (!(directory && ROOT_DIRS.has(name)) && !isMotaSourcePath(name)) fail('invalid_path');
  return name;
}
function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}
async function rootUnchanged(root) {
  const current = await fs.lstat(root.path);
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    !sameFile(current, root.stat) ||
    current.uid !== root.stat.uid ||
    (current.mode & 0o077) !== 0 ||
    (await fs.realpath(root.path)) !== root.path
  )
    fail('root_changed', 403);
}
async function checkedPath(root, input, missingLeaf = false, directory = false) {
  await rootUnchanged(root);
  const name = relativeName(input, directory);
  const parts = name.split('/');
  let current = root.path;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (missingLeaf && index === parts.length - 1 && error.code === 'ENOENT') {
        if ((await fs.realpath(path.dirname(current))) !== path.dirname(current)) fail('path_changed', 403);
        return current;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) fail('symlink_rejected', 403);
    if (index < parts.length - 1 && !stat.isDirectory()) fail('parent_not_directory', 403);
    if (!stat.isDirectory() && !stat.isFile()) fail('special_file_rejected', 403);
    if (stat.isFile() && stat.nlink !== 1) fail('hardlink_rejected', 403);
  }
  if ((await fs.realpath(current)) !== current) fail('path_changed', 403);
  return current;
}
async function readSafe(root, name) {
  const filename = await checkedPath(root, name);
  const expected = await fs.lstat(filename);
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE || !sameFile(stat, expected)) fail('invalid_file', 403);
    await checkedPath(root, name);
    const data = await handle.readFile();
    const after = await handle.stat();
    if (data.length > MAX_FILE || after.nlink !== 1 || stat.size !== after.size || stat.mtimeMs !== after.mtimeMs)
      fail('file_changed', 409);
    return data;
  } finally {
    await handle.close();
  }
}
async function copyRoot(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) fail('copy_root_required');
  const absolute = path.resolve(input);
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(absolute)) !== absolute) fail('copy_root_required');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail('copy_owner_mismatch');
  if ((stat.mode & 0o077) !== 0) fail('copy_root_must_be_private_0700');
  const root = { path: absolute, stat };
  const marker = await fs.open(path.join(absolute, MARKER), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const markerStat = await marker.stat();
    if (
      !markerStat.isFile() ||
      markerStat.nlink !== 1 ||
      markerStat.size !== Buffer.byteLength(MARKER_CONTENT) ||
      (await marker.readFile('utf8')) !== MARKER_CONTENT
    )
      fail('copy_marker_required');
  } finally {
    await marker.close();
  }
  let count = 0;
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (++count > 20000) fail('copy_too_many_files');
      const item = path.join(directory, entry.name);
      const info = await fs.lstat(item);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) fail('copy_contains_link');
      if (info.isDirectory()) await walk(item);
      else if (!info.isFile()) fail('copy_contains_special_file');
    }
  }
  await walk(absolute);
  for (const name of REQUIRED_FILES) await readSafe(root, name);
  await checkedPath(root, '_server', false, true);
  return root;
}
function checkSource(req, origin) {
  if (!origin) fail('origin_not_bound', 403);
  for (const header of ['host', 'origin', 'referer']) {
    const count = req.rawHeaders.filter((_, index) => index % 2 === 0).filter((key) => key.toLowerCase() === header).length;
    if ((header === 'host' && count !== 1) || count > 1) fail('duplicate_or_missing_header', 403);
  }
  if (req.headers.host !== new URL(origin).host) fail('host_not_allowed', 403);
  if (req.headers.origin !== undefined && req.headers.origin !== origin) fail('origin_mismatch', 403);
  if (req.method === 'POST' && req.headers.origin !== origin) fail('origin_required', 403);
  const entry =
    ['GET', 'HEAD'].includes(req.method) &&
    req.headers['sec-fetch-mode'] === 'navigate' &&
    req.headers['sec-fetch-dest'] === 'document' &&
    ['/', '/index.html', '/editor.html', '/editor-mobile.html'].includes(req.url);
  const site = req.headers['sec-fetch-site'];
  const navigation = entry && ['cross-site', 'same-site'].includes(site);
  if (site !== undefined && site !== 'same-origin' && site !== 'none' && !navigation) fail('cross_site_request', 403);
  if (req.headers.referer !== undefined) {
    let referer;
    try {
      referer = new URL(req.headers.referer);
    } catch {
      fail('invalid_referer', 403);
    }
    if (referer.origin !== origin && !navigation) fail('referer_mismatch', 403);
  }
}
async function bodyText(req) {
  const declared = req.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY)) fail('body_too_large', 413);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) fail('body_too_large', 413);
    chunks.push(chunk);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    fail('invalid_utf8');
  }
}
function parseRead(body) {
  const match = /^type=(utf8|base64)&name=(.+)$/s.exec(body);
  if (!match) fail('invalid_read_body');
  return { encoding: match[1], name: relativeName(match[2]) };
}
function parseWrite(body) {
  // The upstream editor sends raw UTF-8 and unescaped base64 '+' characters.
  const match = /^type=(utf8|base64)&name=([^&]+)&value=([\s\S]*)$/.exec(body);
  if (!match) fail('invalid_write_body');
  const name = relativeName(match[2]);
  if (!WRITABLE.has(name)) fail('write_not_allowed', 403);
  if (match[1] === 'base64' && !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(match[3])) fail('invalid_base64');
  const data = Buffer.from(match[3], match[1]);
  if (data.length > 256 * 1024) fail('write_too_large', 413);
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    fail('invalid_utf8');
  }
  try {
    if (name === 'project/floors/MT1.js') {
      if (!/^\s*main\.floors\.MT1\s*=/.test(source)) fail('invalid_MT1_assignment');
      const parsed = JSON.parse(source.replace(/^\s*main\.floors\.MT1\s*=\s*/, '').replace(/;?\s*$/, ''));
      if (!parsed || parsed.floorId !== 'MT1' || !Array.isArray(parsed.map)) fail('invalid_MT1_data');
    } else {
      const parsed = JSON.parse(source);
      if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') fail('invalid_config');
    }
  } catch {
    fail('write_must_be_expected_json');
  }
  return { name, data };
}
async function version(root, name) {
  try {
    return sha256(await readSafe(root, name));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function writeSafe(root, name, data, versions, closing, expectedHash = versions.get(name), committed = () => {}) {
  const target = await checkedPath(root, name, name === '_server/config.json');
  if (expectedHash !== versions.get(name) || (await version(root, name)) !== expectedHash) fail('source_changed', 409);
  const parent = await fs.open(path.dirname(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const directory = process.platform === 'linux' ? `/proc/self/fd/${parent.fd}` : path.dirname(target);
  const temporary = path.join(directory, `.mota-write-${crypto.randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    let temporaryIdentity;
    try {
      await handle.writeFile(data);
      await handle.sync();
      temporaryIdentity = await handle.stat();
    } finally {
      await handle.close();
    }
    await checkedPath(root, name, name === '_server/config.json');
    if (!sameFile(await parent.stat(), await fs.lstat(path.dirname(target)))) fail('path_changed', 403);
    if (expectedHash !== versions.get(name) || (await version(root, name)) !== expectedHash) fail('source_changed', 409);
    if (closing()) fail('server_closing', 503);
    const pending = await fs.lstat(temporary);
    if (!pending.isFile() || pending.nlink !== 1 || !sameFile(pending, temporaryIdentity)) fail('temporary_changed', 409);
    await fs.rename(temporary, path.join(directory, path.basename(target)));
    versions.set(name, sha256(data));
    committed();
    await parent.sync();
  } finally {
    try {
      await fs.rm(temporary, { force: true });
    } finally {
      await parent.close();
    }
  }
}

const BINDING_KEYS = [
  'workspaceId',
  'environmentId',
  'projectId',
  'appInstanceId',
  'runId',
  'sessionId',
  'resourceId',
  'browserInstanceId',
  'browserGeneration',
  'webContentsId',
  'documentGeneration',
];
const CONTROL_METHODS = ['acquire', 'release', 'map.read', 'map.set', 'operation.read'];
const UUID =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;
const HASH = /^[0-9a-f]{64}$/;
function controlRequest(value) {
  if (
    !exactKeys(value, ['type', 'requestId', 'binding', 'method', 'input']) ||
    value.type !== 'mota-control' ||
    typeof value.requestId !== 'string' ||
    !UUID.test(value.requestId) ||
    !CONTROL_METHODS.includes(value.method) ||
    !exactKeys(value.binding, BINDING_KEYS)
  )
    fail('invalid_control_frame');
  const binding = value.binding;
  for (const key of BINDING_KEYS) {
    const item = binding[key];
    if (key === 'environmentId') {
      if (item !== 'sandbox') fail('invalid_control_frame');
    } else if (['browserGeneration', 'documentGeneration', 'webContentsId'].includes(key)) {
      if (!Number.isSafeInteger(item) || item < (key === 'webContentsId' ? 1 : 0)) fail('invalid_control_frame');
    } else if (typeof item !== 'string' || item.length < 1 || item.length > 200) fail('invalid_control_frame');
  }
  const input = value.input;
  if (value.method === 'map.set') {
    if (
      !exactKeys(input, ['operationId', 'expectedSha256', 'x', 'y']) ||
      typeof input.operationId !== 'string' ||
      !UUID.test(input.operationId) ||
      typeof input.expectedSha256 !== 'string' ||
      !HASH.test(input.expectedSha256) ||
      ![input.x, input.y].every((n) => Number.isInteger(n) && n >= 0 && n <= 63)
    )
      fail('invalid_control_frame');
  } else if (value.method === 'operation.read') {
    if (!exactKeys(input, ['operationId']) || typeof input.operationId !== 'string' || !UUID.test(input.operationId))
      fail('invalid_control_frame');
  } else if (!exactKeys(input, [])) fail('invalid_control_frame');
  return value;
}
function sameBinding(left, right) {
  return BINDING_KEYS.every((key) => left[key] === right[key]);
}
function controlFailure(code) {
  const error = new Error(code);
  error.controlCode = code;
  throw error;
}
// Parse JSON only, recording literal spans rather than executing floor JavaScript.
// Reject duplicate object keys so a source cannot give the parser and splicer
// different meanings for "map" (including escaped spellings of the key).
function floorDocument(data) {
  if (data.length > 256 * 1024) controlFailure('unsupported');
  let source;
  try {
    source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data);
  } catch {
    controlFailure('unsupported');
  }
  const prefix = /^\s*main\.floors\.MT1\s*=\s*/.exec(source);
  if (!prefix) controlFailure('unsupported');
  const json = source.slice(prefix[0].length).replace(/;?\s*$/, '');
  let floor;
  try {
    floor = JSON.parse(json);
  } catch {
    controlFailure('unsupported');
  }
  const cells = new Map();
  let position = 0;
  const whitespace = () => {
    while (/\s/.test(json[position] || '') && position < json.length) position++;
  };
  const stringToken = () => {
    // JSON.parse above has already rejected raw control characters.
    const match = /^"(?:[^"\\]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(json.slice(position));
    if (!match) controlFailure('unsupported');
    position += match[0].length;
    return JSON.parse(match[0]);
  };
  function walk(keys, depth = 0) {
    if (depth > 64) controlFailure('unsupported');
    whitespace();
    const start = position;
    if (json[position] === '{') {
      position++;
      whitespace();
      const seen = new Set();
      if (json[position] !== '}')
        while (true) {
          whitespace();
          const key = stringToken();
          if (seen.has(key)) controlFailure('unsupported');
          seen.add(key);
          whitespace();
          if (json[position++] !== ':') controlFailure('unsupported');
          walk([...keys, key], depth + 1);
          whitespace();
          if (json[position] !== ',') break;
          position++;
        }
      if (json[position++] !== '}') controlFailure('unsupported');
    } else if (json[position] === '[') {
      position++;
      whitespace();
      let index = 0;
      if (json[position] !== ']')
        while (true) {
          walk([...keys, index++], depth + 1);
          whitespace();
          if (json[position] !== ',') break;
          position++;
        }
      if (json[position++] !== ']') controlFailure('unsupported');
    } else if (json[position] === '"') stringToken();
    else {
      const match = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(json.slice(position));
      if (!match) controlFailure('unsupported');
      position += match[0].length;
    }
    if (keys.length === 3 && keys[0] === 'map' && typeof keys[1] === 'number' && typeof keys[2] === 'number') {
      cells.set(`${keys[2]},${keys[1]}`, [prefix[0].length + start, prefix[0].length + position]);
    }
  }
  walk([]);
  whitespace();
  if (
    position !== json.length ||
    !floor ||
    Array.isArray(floor) ||
    floor.floorId !== 'MT1' ||
    !Array.isArray(floor.map) ||
    floor.map.length < 1 ||
    floor.map.length > 64 ||
    !Array.isArray(floor.map[0])
  )
    controlFailure('unsupported');
  const height = floor.map.length;
  const width = floor.map[0].length;
  if (
    width < 1 ||
    width > 64 ||
    !floor.map.every(
      (row) => Array.isArray(row) && row.length === width && row.every((n) => Number.isInteger(n) && n >= 0 && n <= 100000),
    ) ||
    (floor.width !== undefined && floor.width !== width) ||
    (floor.height !== undefined && floor.height !== height)
  )
    controlFailure('unsupported');
  return { source, floor, cells, data: { floorId: 'MT1', sha256: sha256(data), width, height, map: floor.map } };
}
function coinEdit(document, x, y) {
  const { floor, data, cells, source } = document;
  if (x >= data.width || y >= data.height || floor.map[y][x] !== 0) controlFailure('invalid_cell');
  const key = `${x},${y}`;
  for (const name of [
    'events',
    'changeFloor',
    'afterBattle',
    'beforeBattle',
    'afterGetItem',
    'afterOpenDoor',
    'cannotMove',
    'cannotMoveIn',
    'autoEvent',
  ]) {
    const value = floor[name];
    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value))) controlFailure('unsupported');
    if (value && Object.hasOwn(value, key)) controlFailure('invalid_cell');
  }
  for (const name of ['upFloor', 'downFloor']) {
    const location = floor[name];
    if (location !== undefined && (!Array.isArray(location) || location.length !== 2 || !location.every(Number.isInteger)))
      controlFailure('unsupported');
    if (location && location[0] === x && location[1] === y) controlFailure('invalid_cell');
  }
  for (const name of ['fgmap', 'fg2map']) {
    const layer = floor[name];
    if (layer === undefined || (Array.isArray(layer) && layer.length === 0)) continue;
    if (
      !Array.isArray(layer) ||
      layer.length !== data.height ||
      !layer.every((row) => Array.isArray(row) && row.length === data.width && row.every((n) => Number.isInteger(n) && n >= 0))
    )
      controlFailure('unsupported');
    if (layer[y][x] !== 0) controlFailure('invalid_cell');
  }
  const span = cells.get(key);
  if (!span || source.slice(span[0], span[1]) !== '0') controlFailure('invalid_cell');
  return Buffer.from(source.slice(0, span[0]) + '53' + source.slice(span[1]));
}

// This fixed bootstrap is injected into responses only, before editor scripts.
// The nonce selects the server-side load snapshot; it never grants AI control.
function editorBootstrap(nonce) {
  const requests = new WeakMap();
  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    let selected = false;
    try {
      const target = new URL(url, window.location.href);
      selected =
        String(method).toUpperCase() === 'POST' &&
        target.origin === window.location.origin &&
        target.pathname === '/writeFile' &&
        !target.search &&
        !target.hash &&
        !target.username &&
        !target.password;
    } catch {
      /* Invalid URLs keep the native XHR error behavior. */
    }
    requests.set(this, selected);
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    if (requests.get(this)) this.setRequestHeader('X-WSL-Editor-Session', nonce);
    return send.apply(this, args);
  };
  // The original fs helper reduces non-200 replies to "HTTP <status>".
  // Keep its callback route and translate only the two concurrency failures.
  const wrap = (value) => {
    if (!value || typeof value !== 'object') return value;
    let write = value.writeFile;
    const decorate = (fn) =>
      typeof fn !== 'function'
        ? fn
        : function (...args) {
            const callback = args[3];
            if (typeof callback === 'function')
              args[3] = function (error, ...result) {
                if (typeof error === 'string' && error.includes('HTTP 409'))
                  error = '地图已被其他操作更新，请刷新编辑器后重新检查再保存（409）。';
                if (typeof error === 'string' && error.includes('HTTP 423')) error = 'AI 正在编辑地图，请等待任务结束后再保存（423）。';
                return callback.call(this, error, ...result);
              };
            return fn.apply(this, args);
          };
    let current = decorate(write);
    Object.defineProperty(value, 'writeFile', {
      configurable: true,
      enumerable: true,
      get: () => current,
      set: (fn) => {
        write = fn;
        current = decorate(write);
      },
    });
    return value;
  };
  let filesystem = wrap(window.fs);
  Object.defineProperty(window, 'fs', {
    configurable: true,
    enumerable: true,
    get: () => filesystem,
    set: (value) => {
      filesystem = wrap(value);
    },
  });
}
function editorDocument(data, nonce) {
  const html = new TextDecoder('utf-8', { fatal: true }).decode(data);
  const script = `<script data-wsl-editor-session="${nonce}">(${editorBootstrap.toString()})(${JSON.stringify(nonce)});</script>`;
  if (/<head(?:\s[^>]*)?>/i.test(html)) return Buffer.from(html.replace(/<head(?:\s[^>]*)?>/i, (head) => head + script));
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  const index = doctype ? doctype[0].length : 0;
  return Buffer.from(html.slice(0, index) + script + html.slice(index));
}
function cliArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!['--root', '--identity', '--bind-address'].includes(key) || !value || values.has(key)) fail('invalid_arguments');
    values.set(key, value);
  }
  let identity;
  try {
    identity = identityValue(JSON.parse(values.get('--identity')));
  } catch {
    fail('invalid_identity');
  }
  const bindAddress = values.get('--bind-address') || '127.0.0.1';
  if (!['127.0.0.1', '0.0.0.0'].includes(bindAddress) || !values.has('--root')) fail('invalid_arguments');
  return { root: values.get('--root'), identity, bindAddress };
}
async function run(options) {
  const root = await copyRoot(options.root);
  const versions = new Map();
  for (const name of WRITABLE) versions.set(name, await version(root, name));
  const identity = options.identity;
  let origin = null;
  let closing = false;
  let queue = Promise.resolve();
  let queued = 0;
  let lease = null;
  const owners = new Map();
  const operations = new Map();
  const editorSessions = new Map();
  const emit = (event) => process.stdout.write(JSON.stringify(event) + '\n');
  const enqueue = (execute, rejected) => {
    if (queued >= QUEUE_LIMIT) {
      rejected();
      return;
    }
    queued++;
    const run = async () => {
      try {
        await execute();
      } finally {
        queued--;
      }
    };
    queue = queue.then(run, run);
  };
  async function control(command) {
    const response = { type: 'mota-control-result', requestId: command.requestId, binding: command.binding, method: command.method };
    try {
      if (closing) controlFailure('cancelled');
      if (!sameIdentity(identity, command.binding)) controlFailure('stale_instance');
      let owner = owners.get(command.binding.runId);
      if (owner && !sameBinding(owner.binding, command.binding)) controlFailure('stale_instance');
      if (command.method === 'release') {
        if (!owner) {
          if (owners.size >= OWNER_LIMIT) controlFailure('budget_exceeded');
          owner = { binding: command.binding, revoked: true, acquired: false, seenAcquire: false };
          owners.set(command.binding.runId, owner);
        }
        owner.revoked = true;
        if (lease === owner) lease = null;
        if (!owner.seenAcquire) controlFailure('owner_unknown');
        emit({ ...response, ok: true, data: { settled: true } });
        return;
      }
      if (command.method === 'operation.read') {
        const saved = operations.get(command.input.operationId);
        if (saved && !sameBinding(saved.binding, command.binding)) controlFailure('operation_conflict');
        emit({
          ...response,
          ok: true,
          data: {
            operationId: command.input.operationId,
            status: saved?.receipt ? 'completed' : 'unknown',
            receipt: saved?.receipt ?? null,
          },
        });
        return;
      }
      if (owner?.revoked) controlFailure('lease_revoked');
      if (command.method === 'acquire') {
        if (!owner) {
          if (owners.size >= OWNER_LIMIT) controlFailure('budget_exceeded');
          owner = { binding: command.binding, revoked: false, acquired: false, seenAcquire: true };
          owners.set(command.binding.runId, owner);
        }
        if (lease && lease !== owner) controlFailure('busy');
        owner.acquired = true;
        lease = owner;
        emit({ ...response, ok: true, data: { settled: true } });
        return;
      }
      if (!owner || lease !== owner || !owner.acquired) controlFailure('owner_unknown');
      if (command.method === 'map.read') {
        const document = floorDocument(await readSafe(root, FLOOR_FILE));
        if (document.data.sha256 !== versions.get(FLOOR_FILE)) controlFailure('stale_source');
        emit({ ...response, ok: true, data: document.data });
        return;
      }
      const input = command.input;
      const saved = operations.get(input.operationId);
      if (saved) {
        if (
          !sameBinding(saved.binding, command.binding) ||
          !['operationId', 'expectedSha256', 'x', 'y'].every((key) => saved.input[key] === input[key])
        )
          controlFailure('operation_conflict');
        if (!saved.receipt) controlFailure(saved.error ?? 'owner_unknown');
        emit({ ...response, ok: true, data: saved.receipt });
        return;
      }
      if (operations.size >= OPERATION_LIMIT) controlFailure('budget_exceeded');
      const operation = { binding: command.binding, input, receipt: null, error: null };
      operations.set(input.operationId, operation);
      try {
        const document = floorDocument(await readSafe(root, FLOOR_FILE));
        if (document.data.sha256 !== input.expectedSha256 || document.data.sha256 !== versions.get(FLOOR_FILE))
          controlFailure('stale_source');
        const updated = coinEdit(document, input.x, input.y);
        const receipt = {
          operationId: input.operationId,
          floorId: 'MT1',
          beforeSha256: input.expectedSha256,
          afterSha256: sha256(updated),
          change: { x: input.x, y: input.y, before: 0, after: 53 },
        };
        await writeSafe(
          root,
          FLOOR_FILE,
          updated,
          versions,
          () => closing || owner.revoked || lease !== owner,
          input.expectedSha256,
          () => {
            operation.receipt = receipt;
            for (const session of editorSessions.values()) session.revoked = true;
          },
        );
        emit({ ...response, ok: true, data: operation.receipt });
      } catch (error) {
        // Rename is the commit point. A later directory sync/close failure must
        // retain the applied change's receipt, never invite a duplicate edit.
        if (operation.receipt) {
          emit({ ...response, ok: true, data: operation.receipt });
          return;
        }
        operation.error = error.controlCode ?? (error.code === 'source_changed' ? 'stale_source' : 'unsupported');
        throw error;
      }
    } catch (error) {
      const code = error.controlCode ?? (error.code === 'source_changed' ? 'stale_source' : 'unsupported');
      emit({ ...response, ok: false, error: { code, message: code } });
    }
  }
  const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    const execute = async () => {
      try {
        if (closing) fail('server_closing', 503);
        checkSource(req, origin);
        if (!['GET', 'HEAD', 'POST'].includes(req.method)) fail('method_not_allowed', 405);
        if (!req.url.startsWith('/') || req.url.startsWith('//')) fail('invalid_url');
        let pathname;
        try {
          pathname = decodeURIComponent(req.url.split('?')[0]);
        } catch {
          fail('invalid_url');
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
          let data;
          if (pathname === '/api/health') {
            res.setHeader('Content-Type', 'application/json; charset=utf-8');
            data = Buffer.from(JSON.stringify({ ok: true, templateId: 'mota-web', templateVersion: '1.0.0', identity }));
          } else {
            const name = relativeName(pathname === '/' ? 'index.html' : pathname.slice(1));
            const mime = MIME[path.extname(name).toLowerCase()];
            if (!mime) fail('file_type_not_exposed', 403);
            data = await readSafe(root, name);
            if (['editor.html', 'editor-mobile.html'].includes(name) && req.method === 'GET') {
              const nonce = crypto.randomBytes(24).toString('hex');
              const baseline = new Map();
              for (const writable of WRITABLE) baseline.set(writable, await version(root, writable));
              if (editorSessions.size >= SESSION_LIMIT) editorSessions.delete(editorSessions.keys().next().value);
              editorSessions.set(nonce, { baseline, revoked: false });
              data = editorDocument(data, nonce);
            }
            res.setHeader('Content-Type', mime);
          }
          res.setHeader('Content-Length', data.length);
          res.end(req.method === 'HEAD' ? undefined : data);
        } else {
          if (!['/listFile', '/readFile', '/writeFile'].includes(pathname)) fail('endpoint_disabled', 404);
          const body = await bodyText(req);
          if (pathname === '/listFile') {
            if (!body.startsWith('name=')) fail('invalid_list_body');
            const name = relativeName(body.slice(5), true);
            const directory = await checkedPath(root, name, false, true);
            const entries = await fs.readdir(directory, { withFileTypes: true });
            for (const entry of entries) if (!entry.name.startsWith('.')) await checkedPath(root, `${name}/${entry.name}`);
            res.end(JSON.stringify(entries.filter((entry) => !entry.name.startsWith('.')).map((entry) => entry.name)));
          } else if (pathname === '/readFile') {
            const { name, encoding } = parseRead(body);
            res.end((await readSafe(root, name)).toString(encoding));
          } else {
            const { name, data } = parseWrite(body);
            const nonce = req.headers[EDITOR_HEADER];
            if (typeof nonce !== 'string' || !/^[0-9a-f]{48}$/.test(nonce)) fail('editor_session_required', 403);
            const session = editorSessions.get(nonce);
            if (lease) fail('editor_busy', 423);
            if (!session || session.revoked || session.baseline.get(name) !== (await version(root, name))) fail('editor_stale', 409);
            await writeSafe(root, name, data, versions, () => closing || lease !== null, session.baseline.get(name));
            session.baseline.set(name, sha256(data));
            res.end('');
          }
        }
      } catch (error) {
        const status = error.status || (error.code === 'ENOENT' ? 404 : 500);
        if (!res.headersSent) res.writeHead(status);
        const detail =
          error.code === 'editor_busy'
            ? 'AI 正在编辑地图，请等待任务结束后再保存（423）。'
            : error.code === 'editor_stale'
              ? '地图已被其他操作更新，请刷新编辑器后重新检查再保存（409）。'
              : error.status
                ? error.code
                : status === 404
                  ? 'not_found'
                  : 'request_failed';
        if (!res.writableEnded) res.end(`error: ${detail}`);
      }
    };
    enqueue(execute, () => {
      res.writeHead(503);
      res.end('error: queue_budget_exceeded');
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 1000;
  server.maxRequestsPerSocket = 100;
  function stop(code, exitCode) {
    if (closing) return;
    closing = true;
    clearTimeout(deadline);
    process.stderr.write(`mota-server:${code}\n`);
    process.exitCode = exitCode;
    server.close();
    server.closeAllConnections();
    process.stdin.destroy();
  }
  let deadline;
  server.on('error', () => stop('server_error', 1));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, options.bindAddress, resolve);
  });
  let buffered = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (closing) return;
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) >= 0) {
      const frame = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (Buffer.byteLength(frame) > 4096) return stop('invalid_control_frame', 1);
      try {
        const command = JSON.parse(frame);
        if (origin && command?.type === 'mota-control') {
          controlRequest(command);
          enqueue(
            () => control(command),
            () =>
              emit({
                type: 'mota-control-result',
                requestId: command.requestId,
                binding: command.binding,
                method: command.method,
                ok: false,
                error: { code: 'budget_exceeded', message: 'budget_exceeded' },
              }),
          );
          continue;
        }
        if (origin) fail('duplicate_binding');
        if (
          !exactKeys(command, ['type', 'requestId', 'origin', 'identity']) ||
          command.type !== 'bind-origin' ||
          typeof command.requestId !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(command.requestId)
        )
          fail('invalid_control_frame');
        if (!sameIdentity(identity, identityValue(command.identity))) fail('identity_mismatch');
        origin = originValue(command.origin);
        clearTimeout(deadline);
        emit({ event: 'mota-origin-bound', requestId: command.requestId, origin, identity });
      } catch {
        return stop('invalid_control_frame', 1);
      }
    }
    if (Buffer.byteLength(buffered) > 4096) stop('invalid_control_frame', 1);
  });
  process.stdin.on('end', () => stop(buffered ? 'incomplete_control_frame' : 'stdin_eof', buffered ? 1 : 0));
  process.stdin.on('error', () => stop('stdin_error', 1));
  process.once('SIGTERM', () => stop('sigterm', 0));
  process.once('SIGINT', () => stop('sigint', 0));
  // AppService may spend 3 × 20 s listing/publishing/verifying ports before binding,
  // plus persistence and scheduling time. HTTP stays blocked throughout this finite wait.
  deadline = setTimeout(() => stop('bind_timeout', 1), 90000);
  emit({ event: 'mota-listening', guestPort: server.address().port, identity });
}

if (require.main === module) {
  Promise.resolve()
    .then(() => run(cliArgs(process.argv.slice(2))))
    .catch(() => {
      process.stderr.write('mota-server:startup_failed\n');
      process.exitCode = 1;
    });
}

module.exports = { isMotaSourcePath };
