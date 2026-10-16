import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isMotaSourcePath,
  MOTA_REQUIRED_FILES,
  MOTA_ROOT_DIRS,
  MOTA_ROOT_FILES,
  MotaControlRequestSchema,
  MotaControlResponseSchema,
  type MotaTaskBinding,
} from '@wsl/protocol';

const serverFile = fileURLToPath(new URL('./mota-server.cjs', import.meta.url));
const floorName = 'project/floors/MT1.js';
const originalFloor = 'main.floors.MT1 = {"floorId":"MT1","map":[[0,1],[2,3]]};\n';
const editedFloor = 'main.floors.MT1 = {"floorId":"MT1","map":[[9,1],[2,3]],"title":"合成示范"};\n';
const identity = { workspaceId: 'synthetic-mota', environmentId: 'sandbox', projectId: randomUUID(), appInstanceId: randomUUID() };
const roots: string[] = [];
type Frame = Record<string, unknown>;
type OwnedChild = {
  process: ChildProcessWithoutNullStreams;
  frames: Frame[];
  stderr: () => string;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};
const children: OwnedChild[] = [];
const guestPolicy = createRequire(import.meta.url)(serverFile) as { isMotaSourcePath(value: string): boolean };

async function fixture() {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'wsl-mota-server-')));
  roots.push(directory);
  const root = path.join(directory, 'copy');
  await mkdir(path.join(root, 'project/floors'), { recursive: true });
  await chmod(root, 0o700);
  await mkdir(path.join(root, '_server'));
  await writeFile(path.join(root, '.wsl-mota-copy'), 'mota-managed-copy-v1\n');
  for (const name of MOTA_REQUIRED_FILES) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), 'synthetic static source');
  }
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Synthetic Mota</title>');
  await writeFile(path.join(root, 'editor.html'), '<!doctype html><title>Synthetic editor</title>');
  await writeFile(path.join(root, 'editor-mobile.html'), '<!doctype html><title>Synthetic mobile editor</title>');
  await writeFile(path.join(root, floorName), originalFloor);
  await writeFile(path.join(root, 'project/floors/MT2.js'), 'protected second floor');
  const outside = path.join(directory, 'outside.js');
  await writeFile(outside, 'outside source stays unchanged');
  return { root, outside };
}
function launch(root: string, extraArgs: string[] = [], preload?: string) {
  const child = spawn(
    process.execPath,
    [...(preload ? ['--require', preload] : []), serverFile, '--root', root, '--identity', JSON.stringify(identity), ...extraArgs],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const frames: Frame[] = [];
  let partial = '';
  let errors = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (data: string) => {
    partial += data;
    let newline: number;
    while ((newline = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, newline);
      partial = partial.slice(newline + 1);
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid server frame');
      frames.push(parsed as Frame);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (data: string) => {
    errors += data;
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const owned = { process: child, frames, stderr: () => errors, exit };
  children.push(owned);
  return owned;
}
async function waitFrame(child: OwnedChild, event: string) {
  await expect.poll(() => child.frames.find((frame) => frame.event === event)).toBeDefined();
  const frame = child.frames.find((candidate) => candidate.event === event);
  if (!frame) throw new Error(`missing ${event} frame`);
  return frame;
}
async function listening(child: OwnedChild) {
  const frame = await waitFrame(child, 'mota-listening');
  expect(frame).toEqual({ event: 'mota-listening', guestPort: expect.any(Number), identity });
  if (typeof frame.guestPort !== 'number') throw new Error('missing guest port');
  expect(frame.guestPort).toBeGreaterThan(0);
  expect(frame.guestPort).toBeLessThanOrEqual(65535);
  return frame.guestPort;
}
function bind(child: OwnedChild, origin: string, overrides: Record<string, unknown> = {}) {
  child.process.stdin.write(JSON.stringify({ type: 'bind-origin', requestId: 'bind-1', origin, identity, ...overrides }) + '\n');
}
async function bound(root: string, preload?: string) {
  const child = launch(root, ['--bind-address', '127.0.0.1'], preload);
  const port = await listening(child);
  // The published host port is deliberately distinct from the guest socket.
  const origin = `http://127.0.0.1:${port === 51379 ? 51380 : 51379}`;
  bind(child, origin);
  expect(await waitFrame(child, 'mota-origin-bound')).toEqual({ event: 'mota-origin-bound', requestId: 'bind-1', origin, identity });
  return { child, port, origin, editorHeaders: await editorHeaders(port, origin) };
}
async function editorHeaders(port: number, origin: string, name = '/editor.html') {
  const response = await http(port, origin, name);
  expect(response.status).toBe(200);
  const match = /data-wsl-editor-session="([a-f0-9]{48})"/.exec(response.body);
  if (!match?.[1]) throw new Error('missing editor bootstrap nonce');
  return { 'X-WSL-Editor-Session': match[1] };
}
function http(
  port: number,
  origin: string,
  resource: string,
  options: { method?: string; body?: string | Buffer; headers?: Record<string, string>; originHeader?: boolean } = {},
) {
  return new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const body = options.body === undefined ? undefined : Buffer.from(options.body);
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path: resource,
        method: options.method ?? 'GET',
        headers: {
          Host: new URL(origin).host,
          ...(options.originHeader === false ? {} : { Origin: origin }),
          ...(body ? { 'Content-Length': String(body.length) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.once('error', reject);
        res.once('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      },
    );
    req.once('error', reject);
    req.setTimeout(2000, () => req.destroy(new Error('local HTTP response timeout')));
    req.end(body);
  });
}
const writeBody = (name: string, value: string, encoding: 'utf8' | 'base64' = 'utf8') =>
  `type=${encoding}&name=${name}&value=${encoding === 'base64' ? Buffer.from(value).toString('base64') : value}`;
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function taskBinding(): MotaTaskBinding {
  return {
    ...identity,
    environmentId: 'sandbox',
    runId: randomUUID(),
    sessionId: randomUUID(),
    resourceId: randomUUID(),
    browserInstanceId: randomUUID(),
    browserGeneration: 1,
    webContentsId: 2,
    documentGeneration: 3,
  };
}
function sendControl(child: OwnedChild, binding: MotaTaskBinding, method: string, input: unknown = {}) {
  const command = MotaControlRequestSchema.parse({ type: 'mota-control', requestId: randomUUID(), binding, method, input });
  child.process.stdin.write(JSON.stringify(command) + '\n');
  return command.requestId;
}
async function controlResult(child: OwnedChild, requestId: string) {
  await expect.poll(() => child.frames.find((frame) => frame.requestId === requestId)).toBeDefined();
  return MotaControlResponseSchema.parse(child.frames.find((frame) => frame.requestId === requestId));
}
async function control(child: OwnedChild, binding: MotaTaskBinding, method: string, input: unknown = {}) {
  return controlResult(child, sendControl(child, binding, method, input));
}
const changeInput = (source = originalFloor, overrides = {}) => ({
  operationId: randomUUID(),
  expectedSha256: hash(source),
  x: 0,
  y: 0,
  ...overrides,
});

afterEach(async () => {
  const cleanupErrors: unknown[] = [];
  for (const child of children.splice(0)) {
    child.process.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        child.exit,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('owned Mota server did not exit after stdin EOF')), 2000);
        }),
      ]);
    } catch (error) {
      cleanupErrors.push(error);
      child.process.kill('SIGKILL');
      await child.exit;
    } finally {
      clearTimeout(timer);
    }
  }
  for (const directory of roots.splice(0)) await rm(directory, { recursive: true, force: true });
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Mota server cleanup failed');
});

describe('managed Mota server local HTTP boundary', () => {
  it('keeps the standalone guest source path policy equal to the shared import policy', () => {
    const names = [
      ...MOTA_ROOT_FILES,
      ...MOTA_ROOT_DIRS,
      '',
      '.',
      '..',
      '.env',
      'credentials.json',
      'PASSWORDS.txt',
      'server.js',
      'server.py',
      'safe-mota-server.cjs',
      'mota-server.mjs',
      'id_rsa',
      'id_ed25519.pub',
      'access_token',
      'refresh_token.json',
      'node_modules',
      '__pycache__',
      'private.pem',
      'signing.key',
      'run.sh',
      'app.exe',
      'token.png',
      'key.png',
      'config.json',
      'editor_file.js',
      'MT1.js',
    ];
    for (const name of names) {
      for (const prefix of ['', 'project/', '_server/', 'project/nested/']) {
        expect(guestPolicy.isMotaSourcePath(prefix + name)).toBe(isMotaSourcePath(prefix + name));
      }
    }
    for (const name of [
      'project/../index.html',
      'project//a.js',
      'project/./a.js',
      './project/a.js',
      'project/%2e%2e/a.js',
      'project/a.js?x',
      'project/a.js#x',
      'project/a:b.js',
      'project\\a.js',
      `project/${'a'.repeat(500)}.js`,
      'project/line\nfeed.js',
    ]) {
      expect(guestPolicy.isMotaSourcePath(name)).toBe(isMotaSourcePath(name));
      expect(guestPolicy.isMotaSourcePath(name)).toBe(false);
    }
  });
  it('blocks every route before binding and reports only the fixed identity after the exact origin ACK', async () => {
    const f = await fixture();
    const child = launch(f.root);
    const port = await listening(child);
    const origin = `http://127.0.0.1:${port}`;
    for (const resource of ['/api/health', '/', '/editor.html']) {
      expect(await http(port, origin, resource)).toMatchObject({ status: 403, body: 'error: origin_not_bound' });
    }
    expect(await http(port, origin, '/writeFile', { method: 'POST', body: writeBody(floorName, editedFloor) })).toMatchObject({
      status: 403,
    });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(originalFloor);
    bind(child, origin);
    await waitFrame(child, 'mota-origin-bound');
    const health = await http(port, origin, '/api/health', { originHeader: false });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true, templateId: 'mota-web', templateVersion: '1.0.0', identity });
    expect((await http(port, origin, '/editor.html')).body).toContain('Synthetic editor');
    expect(health.headers['access-control-allow-origin']).toBeUndefined();
    expect(health.headers['cache-control']).toBe('no-store');
    expect(health.body).not.toContain(f.root);
  });

  it('keeps unbound HTTP closed beyond 15 seconds, then accepts binding and exits on EOF', async () => {
    const f = await fixture();
    const child = launch(f.root);
    const port = await listening(child);
    const origin = `http://127.0.0.1:${port}`;
    // Real child time must cross the previous deadline; no product clock is replaced.
    await delay(16000);
    for (const resource of ['/api/health', '/', '/editor.html']) {
      expect(await http(port, origin, resource)).toMatchObject({ status: 403, body: 'error: origin_not_bound' });
    }
    expect(await http(port, origin, '/writeFile', { method: 'POST', body: writeBody(floorName, editedFloor) })).toMatchObject({
      status: 403,
    });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(originalFloor);
    bind(child, origin);
    expect(await waitFrame(child, 'mota-origin-bound')).toEqual({ event: 'mota-origin-bound', requestId: 'bind-1', origin, identity });
    const health = await http(port, origin, '/api/health', { originHeader: false });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toEqual({ ok: true, templateId: 'mota-web', templateVersion: '1.0.0', identity });
    child.process.stdin.end();
    expect(await child.exit).toEqual({ code: 0, signal: null });
    expect(child.stderr()).toBe('mota-server:stdin_eof\n');
    await expect(http(port, origin, '/api/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  }, 25000);

  it('requires the published Host and exact Origin and rejects cross-site API traffic', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    expect(await http(s.port, s.origin, '/api/health', { headers: { Host: `127.0.0.1:${s.port}` } })).toMatchObject({ status: 403 });
    for (const foreign of ['http://localhost:51379', 'http://127.0.0.1:1', 'https://127.0.0.1:51379', 'null']) {
      expect(await http(s.port, s.origin, '/api/health', { headers: { Origin: foreign } })).toMatchObject({ status: 403 });
    }
    expect(await http(s.port, s.origin, '/api/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).toMatchObject({ status: 403 });
    expect(
      await http(s.port, s.origin, '/writeFile', {
        method: 'POST',
        body: writeBody(floorName, editedFloor),
        originHeader: false,
        headers: { Referer: `${s.origin}/editor.html` },
      }),
    ).toMatchObject({ status: 403, body: 'error: origin_required' });
    expect(
      await http(s.port, s.origin, '/editor.html', {
        originHeader: false,
        headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' },
      }),
    ).toMatchObject({ status: 200 });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(originalFloor);
  });

  it('rejects raw and encoded traversal before URL normalization and disables extra server endpoints', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    for (const resource of [
      '/../outside.js',
      '/project/../../outside.js',
      '/%2e%2e/outside.js',
      '/project/%2e%2e/%2e%2e/outside.js',
      '/project%5cfloors/MT1.js',
      '//project/floors/MT1.js',
      '/.wsl-mota-copy',
    ]) {
      expect((await http(s.port, s.origin, resource)).status).toBe(400);
    }
    for (const name of [
      '../outside.js',
      'project/../../outside.js',
      'project/%2e%2e/outside.js',
      '/etc/passwd',
      'project\\floors\\MT1.js',
    ]) {
      expect(await http(s.port, s.origin, '/readFile', { method: 'POST', body: `type=utf8&name=${name}` })).toMatchObject({ status: 400 });
    }
    expect(await http(s.port, s.origin, '/exec', { method: 'POST', body: 'command=echo synthetic' })).toMatchObject({ status: 404 });
    expect(await http(s.port, s.origin, '/', { method: 'PUT' })).toMatchObject({ status: 405 });
    expect(await readFile(f.outside, 'utf8')).toBe('outside source stays unchanged');
  });

  it.each(['symlink', 'hardlink'] as const)('rejects a %s introduced after startup for reads and writes', async (kind) => {
    const f = await fixture();
    const s = await bound(f.root);
    await unlink(path.join(f.root, floorName));
    if (kind === 'symlink') await symlink(f.outside, path.join(f.root, floorName));
    else await link(f.outside, path.join(f.root, floorName));
    expect(await http(s.port, s.origin, `/${floorName}`)).toMatchObject({ status: 403 });
    expect(await http(s.port, s.origin, '/readFile', { method: 'POST', body: `type=utf8&name=${floorName}` })).toMatchObject({
      status: 403,
    });
    expect(
      await http(s.port, s.origin, '/writeFile', { method: 'POST', headers: s.editorHeaders, body: writeBody(floorName, editedFloor) }),
    ).toMatchObject({
      status: 403,
    });
    expect(await readFile(f.outside, 'utf8')).toBe('outside source stays unchanged');
  });

  it('does not expose credentials or supplied server entrypoints added to the copy', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    for (const name of ['project/credentials.json', 'project/private.pem', 'project/server.js', '_server/safe-mota-server.cjs']) {
      await writeFile(path.join(f.root, name), 'synthetic excluded content');
      const response = await http(s.port, s.origin, '/readFile', { method: 'POST', body: `type=utf8&name=${name}` });
      expect(response).toMatchObject({ status: 400, body: 'error: invalid_path' });
      expect(response.body).not.toContain('synthetic excluded content');
    }
  });

  it('reads and lists editor assets, saves only MT1/config atomically, and serves the saved floor', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    const listing = await http(s.port, s.origin, '/listFile', { method: 'POST', body: 'name=project/floors' });
    expect(JSON.parse(listing.body).sort()).toEqual(['MT1.js', 'MT2.js']);
    expect(await http(s.port, s.origin, '/readFile', { method: 'POST', body: `type=utf8&name=./${floorName}` })).toMatchObject({
      status: 200,
      body: originalFloor,
    });
    expect(
      await http(s.port, s.origin, '/writeFile', {
        method: 'POST',
        headers: s.editorHeaders,
        body: writeBody(floorName, editedFloor, 'base64'),
      }),
    ).toMatchObject({ status: 200, body: '' });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(editedFloor);
    expect(await http(s.port, s.origin, `/${floorName}`)).toMatchObject({ status: 200, body: editedFloor });
    expect(
      await http(s.port, s.origin, '/writeFile', {
        method: 'POST',
        headers: s.editorHeaders,
        body: writeBody('_server/config.json', '{"lastFloorId":"MT1"}'),
      }),
    ).toMatchObject({ status: 200 });
    expect(JSON.parse(await readFile(path.join(f.root, '_server/config.json'), 'utf8'))).toEqual({ lastFloorId: 'MT1' });
    expect(
      await http(s.port, s.origin, '/writeFile', { method: 'POST', headers: s.editorHeaders, body: writeBody(floorName, originalFloor) }),
    ).toMatchObject({
      status: 200,
    });
    for (const name of ['project/floors/MT2.js', 'project/enemys.js', 'index.html']) {
      expect(
        await http(s.port, s.origin, '/writeFile', { method: 'POST', headers: s.editorHeaders, body: writeBody(name, editedFloor) }),
      ).toMatchObject({
        status: 403,
      });
    }
    for (const invalid of ['main.floors.MT2 = {};', 'main.floors.MT1 = (() => { throw 1; })();', 'main.floors.MT1 = {"floorId":"MT1"};']) {
      expect(
        await http(s.port, s.origin, '/writeFile', { method: 'POST', headers: s.editorHeaders, body: writeBody(floorName, invalid) }),
      ).toMatchObject({
        status: 400,
      });
    }
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(originalFloor);
  });

  it.each([floorName, '_server/config.json'])('rejects external changes to %s without overwriting them', async (name) => {
    const f = await fixture();
    const s = await bound(f.root);
    const external = name === floorName ? originalFloor.replace('[0,1]', '[7,1]') : '{"external":true}';
    await writeFile(path.join(f.root, name), external);
    expect(
      await http(s.port, s.origin, '/writeFile', {
        method: 'POST',
        headers: s.editorHeaders,
        body: writeBody(name, name === floorName ? editedFloor : '{}'),
      }),
    ).toMatchObject({ status: 409, body: expect.stringContaining('刷新编辑器') });
    expect(await readFile(path.join(f.root, name), 'utf8')).toBe(external);
  });
});

describe('Mota task controls and editor snapshot saves', () => {
  it('uses exact binding, literal byte edits and idempotent operation receipts', async () => {
    const f = await fixture();
    const source =
      '\ufeffmain.floors.MT1 =\n{ "floorId": "MT1", "map": [[ 0, 1 ], [2, 3]], "events": {}, "note":"map: [[0]] 非目标" };\r\n';
    await writeFile(path.join(f.root, floorName), source);
    const s = await bound(f.root);
    const binding = taskBinding();
    expect(await control(s.child, binding, 'acquire')).toMatchObject({ ok: true, data: { settled: true } });
    expect(await control(s.child, binding, 'map.read')).toMatchObject({
      ok: true,
      data: {
        floorId: 'MT1',
        width: 2,
        height: 2,
        map: [
          [0, 1],
          [2, 3],
        ],
        sha256: hash(source),
      },
    });
    const input = changeInput(source);
    const expected = source.replace('[[ 0, 1 ]', '[[ 53, 1 ]');
    const result = await control(s.child, binding, 'map.set', input);
    expect(result).toMatchObject({
      ok: true,
      data: {
        operationId: input.operationId,
        floorId: 'MT1',
        beforeSha256: hash(source),
        afterSha256: hash(expected),
        change: { x: 0, y: 0, before: 0, after: 53 },
      },
    });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(expected);
    const replay = await control(s.child, binding, 'map.set', input);
    if (!result.ok || result.method !== 'map.set' || !replay.ok || replay.method !== 'map.set')
      throw new Error('missing committed receipt');
    expect(replay.data).toEqual(result.data);
    expect(await control(s.child, binding, 'map.set', { ...input, x: 1 })).toMatchObject({
      ok: false,
      error: { code: 'operation_conflict' },
    });
    expect(await control(s.child, binding, 'release')).toMatchObject({ ok: true, data: { settled: true } });
    expect(await control(s.child, binding, 'operation.read', { operationId: input.operationId })).toMatchObject({
      ok: true,
      data: { status: 'completed', receipt: result.data },
    });
    expect(await control(s.child, binding, 'map.set', input)).toMatchObject({ ok: false, error: { code: 'lease_revoked' } });
    expect(await control(s.child, binding, 'acquire')).toMatchObject({ ok: false, error: { code: 'lease_revoked' } });
  });

  it('tombstones unknown release without confirming an owner and permits known busy cleanup', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    const cancelled = taskBinding();
    for (let i = 0; i < 2; i++)
      expect(await control(s.child, cancelled, 'release')).toMatchObject({ ok: false, error: { code: 'owner_unknown' } });
    expect(await control(s.child, cancelled, 'acquire')).toMatchObject({ ok: false, error: { code: 'lease_revoked' } });
    const active = taskBinding();
    const busy = taskBinding();
    expect(await control(s.child, active, 'acquire')).toMatchObject({ ok: true });
    expect(await control(s.child, busy, 'acquire')).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(await control(s.child, busy, 'release')).toMatchObject({ ok: true, data: { settled: true } });
    expect(await control(s.child, busy, 'acquire')).toMatchObject({ ok: false, error: { code: 'lease_revoked' } });
    expect(await control(s.child, active, 'map.read')).toMatchObject({ ok: true });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(originalFloor);
  });

  it('rejects every changed frozen owner field without releasing the actual owner', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    const binding = taskBinding();
    await control(s.child, binding, 'acquire');
    for (const key of [
      'workspaceId',
      'projectId',
      'appInstanceId',
      'sessionId',
      'resourceId',
      'browserInstanceId',
      'browserGeneration',
      'webContentsId',
      'documentGeneration',
    ] as const) {
      const current = binding[key];
      const changed = { ...binding, [key]: typeof current === 'number' ? current + 1 : 'different-' + current };
      expect(await control(s.child, changed, 'release')).toMatchObject({ ok: false, error: { code: 'stale_instance' } });
    }
    expect(await control(s.child, binding, 'map.read')).toMatchObject({ ok: true });
    expect(await control(s.child, binding, 'release')).toMatchObject({ ok: true });
  });

  it('serializes a queued edit before release and rejects a late edit after release', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    const binding = taskBinding();
    await control(s.child, binding, 'acquire');
    const edit = sendControl(s.child, binding, 'map.set', changeInput());
    const release = sendControl(s.child, binding, 'release');
    const late = sendControl(s.child, binding, 'map.set', changeInput());
    expect(await controlResult(s.child, edit)).toMatchObject({ ok: true });
    expect(await controlResult(s.child, release)).toMatchObject({ ok: true, data: { settled: true } });
    expect(await controlResult(s.child, late)).toMatchObject({ ok: false, error: { code: 'lease_revoked' } });
    expect(s.child.frames.findIndex((frame) => frame.requestId === edit)).toBeLessThan(
      s.child.frames.findIndex((frame) => frame.requestId === release),
    );
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(originalFloor.replace('[[0,1]', '[[53,1]'));
  });

  it('rejects stale hashes and never replays a failed operation under changed input', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    const binding = taskBinding();
    await control(s.child, binding, 'acquire');
    const input = changeInput('different source');
    expect(await control(s.child, binding, 'map.set', input)).toMatchObject({ ok: false, error: { code: 'stale_source' } });
    expect(await control(s.child, binding, 'map.set', { ...input, expectedSha256: hash(originalFloor) })).toMatchObject({
      ok: false,
      error: { code: 'operation_conflict' },
    });
    expect(await control(s.child, binding, 'operation.read', { operationId: input.operationId })).toMatchObject({
      ok: true,
      data: { status: 'unknown', receipt: null },
    });
    expect(await control(s.child, taskBinding(), 'operation.read', { operationId: input.operationId })).toMatchObject({
      ok: false,
      error: { code: 'operation_conflict' },
    });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(originalFloor);
  });

  it.each(['events', 'changeFloor', 'afterGetItem', 'autoEvent', 'upFloor', 'downFloor', 'fgmap', 'fg2map', 'occupied', 'outside'])(
    'rejects a coin edit on a protected %s cell',
    async (kind) => {
      const f = await fixture();
      const floor: Record<string, unknown> = {
        floorId: 'MT1',
        width: 2,
        height: 2,
        map: [
          [0, 1],
          [2, 3],
        ],
      };
      if (['upFloor', 'downFloor'].includes(kind)) floor[kind] = [0, 0];
      else if (['fgmap', 'fg2map'].includes(kind))
        floor[kind] = [
          [1, 0],
          [0, 0],
        ];
      else if (!['occupied', 'outside'].includes(kind)) floor[kind] = { '0,0': [] };
      const source = 'main.floors.MT1=' + JSON.stringify(floor);
      await writeFile(path.join(f.root, floorName), source);
      const s = await bound(f.root);
      const binding = taskBinding();
      await control(s.child, binding, 'acquire');
      const input = changeInput(source, { x: kind === 'occupied' ? 1 : kind === 'outside' ? 63 : 0 });
      expect(await control(s.child, binding, 'map.set', input)).toMatchObject({ ok: false, error: { code: 'invalid_cell' } });
      expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(source);
    },
  );

  it.each([
    'main.floors.MT1={"floorId":"MT1","map":[[0]],"m\\u0061p":[[0]]}',
    'main.floors.MT1={"floorId":"MT1","map":[[0],[0,1]]}',
    'main.floors.MT1=(()=>{throw new Error("must never execute")})()',
  ])('rejects ambiguous or non-data floor source', async (source) => {
    const f = await fixture();
    await writeFile(path.join(f.root, floorName), source);
    const s = await bound(f.root);
    const binding = taskBinding();
    await control(s.child, binding, 'acquire');
    expect(await control(s.child, binding, 'map.read')).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(source);
  });

  it('requires an editor nonce and advances only the successful page snapshot', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    const other = await editorHeaders(s.port, s.origin, '/editor-mobile.html');
    expect(await http(s.port, s.origin, '/writeFile', { method: 'POST', body: writeBody(floorName, editedFloor) })).toMatchObject({
      status: 403,
    });
    expect(
      await http(s.port, s.origin, '/writeFile', { method: 'POST', headers: s.editorHeaders, body: writeBody(floorName, editedFloor) }),
    ).toMatchObject({ status: 200 });
    expect(
      await http(s.port, s.origin, '/writeFile', { method: 'POST', headers: other, body: writeBody(floorName, originalFloor) }),
    ).toMatchObject({ status: 409, body: expect.stringContaining('刷新编辑器') });
    expect(
      await http(s.port, s.origin, '/writeFile', { method: 'POST', headers: s.editorHeaders, body: writeBody(floorName, originalFloor) }),
    ).toMatchObject({ status: 200 });
    expect(await readFile(path.join(f.root, 'editor.html'), 'utf8')).toBe('<!doctype html><title>Synthetic editor</title>');
  });

  it('excludes manual saves during AI ownership and invalidates old pages after a commit', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    const binding = taskBinding();
    await control(s.child, binding, 'acquire');
    expect(
      await http(s.port, s.origin, '/writeFile', { method: 'POST', headers: s.editorHeaders, body: writeBody(floorName, editedFloor) }),
    ).toMatchObject({ status: 423, body: expect.stringContaining('AI 正在编辑') });
    expect(await control(s.child, binding, 'map.set', changeInput())).toMatchObject({ ok: true });
    await control(s.child, binding, 'release');
    for (const name of [floorName, '_server/config.json']) {
      expect(
        await http(s.port, s.origin, '/writeFile', {
          method: 'POST',
          headers: s.editorHeaders,
          body: writeBody(name, name === floorName ? editedFloor : '{}'),
        }),
      ).toMatchObject({ status: 409 });
    }
    const refreshed = await editorHeaders(s.port, s.origin);
    expect(
      await http(s.port, s.origin, '/writeFile', { method: 'POST', headers: refreshed, body: writeBody(floorName, editedFloor) }),
    ).toMatchObject({ status: 200 });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(editedFloor);
  });

  it('rejects an AI edit based on a snapshot preceding a completed manual save', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    const binding = taskBinding();
    expect(
      await http(s.port, s.origin, '/writeFile', { method: 'POST', headers: s.editorHeaders, body: writeBody(floorName, editedFloor) }),
    ).toMatchObject({ status: 200 });
    await control(s.child, binding, 'acquire');
    expect(await control(s.child, binding, 'map.set', changeInput())).toMatchObject({ ok: false, error: { code: 'stale_source' } });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(editedFloor);
  });

  it('retains committed evidence if directory sync fails after the atomic rename', async () => {
    const f = await fixture();
    const preload = path.join(path.dirname(f.root), 'directory-sync-fault.cjs');
    await writeFile(
      preload,
      `const fs=require('node:fs/promises'); const open=fs.open;
fs.open=async function(name,...args){ const handle=await open.call(this,name,...args);
if(String(name).endsWith('/project/floors')) handle.sync=async()=>{throw new Error('synthetic directory sync failure')}; return handle; };`,
    );
    const s = await bound(f.root, preload);
    const binding = taskBinding();
    await control(s.child, binding, 'acquire');
    const input = changeInput();
    const result = await control(s.child, binding, 'map.set', input);
    if (!result.ok || result.method !== 'map.set') throw new Error('missing applied receipt');
    expect(hash(await readFile(path.join(f.root, floorName)))).toBe(result.data.afterSha256);
    expect(await control(s.child, binding, 'operation.read', { operationId: input.operationId })).toMatchObject({
      ok: true,
      data: { status: 'completed', receipt: result.data },
    });
    expect(await control(s.child, binding, 'map.set', input)).toMatchObject({ ok: true, data: result.data });
  });

  it('keeps owner tombstones bounded without confirming an unrecorded release', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    for (let group = 0; group < 16; group++) {
      const requests = Array.from({ length: 64 }, () => sendControl(s.child, taskBinding(), 'release'));
      const last = requests.at(-1);
      if (!last) throw new Error('missing request');
      await controlResult(s.child, last);
      for (const id of requests)
        expect(MotaControlResponseSchema.parse(s.child.frames.find((frame) => frame.requestId === id))).toMatchObject({
          ok: false,
          error: { code: 'owner_unknown' },
        });
    }
    const binding = taskBinding();
    expect(await control(s.child, binding, 'release')).toMatchObject({ ok: false, error: { code: 'budget_exceeded' } });
    expect(await control(s.child, binding, 'acquire')).toMatchObject({ ok: false, error: { code: 'budget_exceeded' } });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(originalFloor);
  });

  it('bounds operation evidence and refuses new edits instead of evicting old receipts', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    const binding = taskBinding();
    await control(s.child, binding, 'acquire');
    for (let group = 0; group < 16; group++) {
      const requests = Array.from({ length: 64 }, () => sendControl(s.child, binding, 'map.set', changeInput(originalFloor, { x: 1 })));
      const last = requests.at(-1);
      if (!last) throw new Error('missing request');
      await controlResult(s.child, last);
    }
    expect(await control(s.child, binding, 'map.set', changeInput())).toMatchObject({ ok: false, error: { code: 'budget_exceeded' } });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(originalFloor);
  }, 10000);

  it('injects a scoped XHR nonce and preserves callback failures with Chinese 409/423 messages', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    const response = await http(s.port, s.origin, '/editor.html');
    const match = /<script data-wsl-editor-session="([a-f0-9]{48})">([\s\S]*?)<\/script>/.exec(response.body);
    if (!match?.[1] || !match[2]) throw new Error('missing injected script');
    class FakeXHR {
      headers: Record<string, string> = {};
      calls = 0;
      open(_method: string, _url: string) {
        this.headers = {};
      }
      setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
      }
      send(_body: string) {
        this.calls++;
      }
    }
    type Write = (name: string, data: string, encoding: string, callback: (error: unknown, data?: unknown) => void) => void;
    const browser: { location: { origin: string; href: string }; fs?: { writeFile: Write } } = {
      location: { origin: s.origin, href: s.origin + '/editor.html' },
    };
    runInNewContext(match[2], { window: browser, XMLHttpRequest: FakeXHR, URL });
    for (const target of ['/writeFile', s.origin + '/writeFile', '/readFile', '/writeFile?x=1', 'http://localhost:1/writeFile']) {
      const xhr = new FakeXHR();
      xhr.open('POST', target);
      xhr.send('body');
      expect(xhr.calls).toBe(1);
      expect(xhr.headers['X-WSL-Editor-Session']).toBe(['/writeFile', s.origin + '/writeFile'].includes(target) ? match[1] : undefined);
    }
    let calls = 0;
    let error: unknown;
    browser.fs = {
      writeFile: (_name, _data, _encoding, callback) => {
        calls++;
        callback('HTTP 409：请检查服务');
      },
    };
    browser.fs.writeFile('project/floors/MT1.js', 'data', 'base64', (value) => {
      error = value;
    });
    expect(error).toBe('地图已被其他操作更新，请刷新编辑器后重新检查再保存（409）。');
    browser.fs.writeFile = (_name, _data, _encoding, callback) => {
      calls++;
      callback('HTTP 423');
    };
    browser.fs.writeFile('project/floors/MT1.js', 'data', 'base64', (value) => {
      error = value;
    });
    expect(error).toBe('AI 正在编辑地图，请等待任务结束后再保存（423）。');
    expect(calls).toBe(2);
    expect(match[2]).not.toMatch(/\b(?:alert|confirm)\s*\(/);
  });
});

describe('managed Mota server ownership lifecycle', () => {
  it.each(['symlink', 'hardlink', 'wrong-marker', 'public-root'] as const)('rejects a startup copy with %s', async (kind) => {
    const f = await fixture();
    if (kind === 'symlink') await symlink(f.outside, path.join(f.root, 'project/linked.js'));
    if (kind === 'hardlink') await link(f.outside, path.join(f.root, 'project/linked.js'));
    if (kind === 'wrong-marker') await writeFile(path.join(f.root, '.wsl-mota-copy'), 'not a managed copy');
    if (kind === 'public-root') await chmod(f.root, 0o755);
    const child = launch(f.root);
    expect(await child.exit).toEqual({ code: 1, signal: null });
    expect(child.frames).toEqual([]);
    expect(child.stderr()).toBe('mota-server:startup_failed\n');
    expect(await readFile(f.outside, 'utf8')).toBe('outside source stays unchanged');
  });

  it.each(['foreign-identity', 'foreign-origin', 'unknown-command', 'extra-field', 'second-binding'] as const)(
    'fails closed for %s control input',
    async (kind) => {
      const f = await fixture();
      const child = launch(f.root);
      const port = await listening(child);
      const origin = `http://127.0.0.1:${port}`;
      if (kind === 'second-binding') {
        bind(child, origin);
        await waitFrame(child, 'mota-origin-bound');
      }
      bind(child, origin, {
        ...(kind === 'foreign-identity' ? { identity: { ...identity, appInstanceId: randomUUID() } } : {}),
        ...(kind === 'foreign-origin' ? { origin: 'http://localhost:12345' } : {}),
        ...(kind === 'unknown-command' ? { type: 'exec' } : {}),
        ...(kind === 'extra-field' ? { command: 'not executable' } : {}),
      });
      expect(await child.exit).toEqual({ code: 1, signal: null });
      expect(child.stderr()).toBe('mota-server:invalid_control_frame\n');
      await expect(http(port, origin, '/api/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    },
  );

  it.each(['stdin', 'sigterm'] as const)('exits and releases its socket after %s without modifying source', async (kind) => {
    const f = await fixture();
    const s = await bound(f.root);
    if (kind === 'stdin') s.child.process.stdin.end();
    else s.child.process.kill('SIGTERM');
    expect(await s.child.exit).toEqual({ code: 0, signal: null });
    expect(s.child.stderr()).toBe(`mota-server:${kind === 'stdin' ? 'stdin_eof' : 'sigterm'}\n`);
    await expect(http(s.port, s.origin, '/api/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(originalFloor);
  });

  it.each(['partial', 'oversized'] as const)('closes on a %s control frame without granting access', async (kind) => {
    const f = await fixture();
    const child = launch(f.root);
    const port = await listening(child);
    if (kind === 'partial') child.process.stdin.end('{"type":"bind-origin"');
    else child.process.stdin.write('x'.repeat(4097));
    expect(await child.exit).toEqual({ code: 1, signal: null });
    expect(child.frames.filter((frame) => frame.event === 'mota-origin-bound')).toEqual([]);
    expect(child.stderr()).toBe(`mota-server:${kind === 'partial' ? 'incomplete_control_frame' : 'invalid_control_frame'}\n`);
    await expect(http(port, `http://127.0.0.1:${port}`, '/api/health')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
