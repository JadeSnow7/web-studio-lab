import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, cp, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { request, type IncomingHttpHeaders } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isMotaSourcePath,
  MOTA_REQUIRED_FILES,
  MOTA_ROOT_DIRS,
  MOTA_ROOT_FILES,
  MotaControlRequestSchema,
  MotaControlResponseSchema,
  type MotaTaskBinding,
  MotaEditorRequestSchema,
  MotaEditorFrameResultSchema,
  type MotaEditorFrame,
} from '@wsl/protocol';
import { MotaEditors } from './mota-editor';

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
  return { child, port, origin, editor: await privateEditor(child) };
}
// Pipe units exercise the real guest/fs/queue without claiming HTTP coverage.
// Real HTTP regressions above/below continue to use bound() and a real listener.
async function pipeBound(root: string, extraPreload = '') {
  const preload = path.join(path.dirname(root), 'pipe-listener-fixture.cjs');
  await writeFile(
    preload,
    `const http=require('node:http');const {EventEmitter}=require('node:events');
http.createServer=()=>Object.assign(new EventEmitter(),{listen(_port,_host,ready){ready();},address(){return {port:43187};},close(){},closeAllConnections(){}});
${extraPreload}`,
  );
  return bound(root, preload);
}
const editorOwners = new WeakMap<OwnedChild, { service: MotaEditors; epoch: number }>();
async function privateEditor(child: OwnedChild, advanceEpoch = 1) {
  let context = editorOwners.get(child);
  if (!context) {
    const service = new MotaEditors();
    context = { service, epoch: 0 };
    editorOwners.set(child, context);
    let seen = child.frames.length;
    child.process.stdout.on('data', () => {
      for (const frame of child.frames.slice(seen)) service.receive(frame, identity.appInstanceId);
      seen = child.frames.length;
    });
  }
  context.epoch += advanceEpoch;
  const binding = {
    ...identity,
    environmentId: 'sandbox',
    resourceId: 'editor',
    resourceInstanceId: randomUUID(),
    resourceGeneration: 1,
    browserInstanceId: randomUUID(),
    browserGeneration: 1,
    documentGeneration: 1,
    editorEpoch: context.epoch,
  };
  const editorSessionId = randomUUID();
  const service = context.service;
  const write = (frame: MotaEditorFrame) => child.process.stdin.write(JSON.stringify(frame) + '\n');
  const call = (method: string, input = {}, requestId = randomUUID()) =>
    service.call(MotaEditorRequestSchema.parse({ binding, editorSessionId, requestId, method, input }), write);
  expect(await call('editor.open')).toMatchObject({ ok: true });
  const baseline = new Map<string, string | null>();
  const read = async (file: string) => {
    const result = await call('editor.read', { file });
    if (result.ok && result.data && 'contentHash' in result.data) baseline.set(file, result.data.contentHash);
    return result;
  };
  await read(floorName);
  await read('_server/config.json');
  const save = async (file: string, content: string, requestId = randomUUID(), expectedHash = baseline.get(file) ?? null) => {
    const input = { file, expectedHash, contentLength: Buffer.byteLength(content), contentHash: hash(content) };
    const staged = await call('editor.stage', { ...input, content }, requestId);
    if (!staged.ok || (staged.data && 'status' in staged.data && staged.data.status !== 'staged')) return staged;
    const result = await call('editor.commit', input, requestId);
    if (result.ok && result.data && 'receipt' in result.data && result.data.receipt) baseline.set(file, result.data.receipt.afterHash);
    return result;
  };
  return { call, read, save, binding, editorSessionId, write };
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
function editorWire(child: OwnedChild, command: Record<string, unknown>) {
  const from = child.frames.length;
  return new Promise<ReturnType<typeof MotaEditorFrameResultSchema.parse>>((resolve, reject) => {
    const receive = () => {
      const result = child.frames.slice(from).find((frame) => frame.type === 'mota-editor-result' && frame.requestId === command.requestId);
      if (!result) return;
      clearTimeout(timer);
      child.process.stdout.off('data', receive);
      try {
        resolve(MotaEditorFrameResultSchema.parse(result));
      } catch (error) {
        reject(error);
      }
    };
    const timer = setTimeout(() => {
      child.process.stdout.off('data', receive);
      reject(new Error('private editor frame response timeout'));
    }, 5000);
    child.process.stdout.on('data', receive);
    child.process.stdin.write(JSON.stringify(command) + '\n');
  });
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
  it.each([
    { name: floorName, value: editedFloor },
    { name: '_server/config.json', value: '{"lastFloorId":"MT1","extension":{"label":"保留数据"}}\n' },
  ])('R6 denies legacy HTTP writes to $name after same-origin editor/nonce disclosure', async ({ name, value }) => {
    const f = await fixture();
    const prior = path.join(path.dirname(f.root), 'prior');
    await cp(f.root, prior, { recursive: true });
    async function bytes(file: string): Promise<Buffer | null> {
      try {
        return await readFile(file);
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
        throw error;
      }
    }
    const files = [
      { label: 'copy/MT1', file: path.join(f.root, floorName) },
      { label: 'copy/config', file: path.join(f.root, '_server/config.json') },
      { label: 'copy/MT2', file: path.join(f.root, 'project/floors/MT2.js') },
      { label: 'prior/MT1', file: path.join(prior, floorName) },
      { label: 'prior/config', file: path.join(prior, '_server/config.json') },
      { label: 'prior/MT2', file: path.join(prior, 'project/floors/MT2.js') },
      { label: 'outside', file: f.outside },
    ];
    const before = await Promise.all(files.map(({ file }) => bytes(file)));
    expect(before[0]?.equals(Buffer.from(originalFloor))).toBe(true);
    expect(before[1]).toBeNull();
    const expectedHash = name === floorName ? hash(originalFloor) : null;
    const child = launch(f.root, ['--bind-address', '127.0.0.1']);
    const port = await listening(child);
    const origin = `http://127.0.0.1:${port}`;
    bind(child, origin);
    await waitFrame(child, 'mota-origin-bound');
    const game = await http(port, origin, '/index.html');
    expect(game.status).toBe(200);
    const editor = await http(port, origin, '/editor.html', { headers: { Referer: `${origin}/index.html` } });
    expect(editor.status).toBe(200);
    const nonce = /data-wsl-editor-session="([a-f0-9]{48})"/.exec(editor.body)?.[1];
    // Still send the attack after cutover: removal of bootstrap must not skip POST.
    const token = nonce ?? '0'.repeat(48);
    const body = writeBody(name, value, 'base64');
    const response = await http(port, origin, '/writeFile', {
      method: 'POST',
      body,
      headers: {
        Referer: `${origin}/index.html`,
        'Sec-Fetch-Site': 'same-origin',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-WSL-Editor-Session': token,
      },
    });
    const after = await Promise.all(files.map(({ file }) => bytes(file)));
    const digest = (data: Buffer | null | undefined) => (data == null ? null : { bytes: data.length, sha256: hash(data) });
    const target = after[name === floorName ? 0 : 1];
    console.info(
      JSON.stringify({
        event: 'R6-http-authorization-counterexample',
        target: name,
        requests: [
          { method: 'GET', path: '/index.html', status: game.status, responseBytes: Buffer.byteLength(game.body) },
          { method: 'GET', path: '/editor.html', status: editor.status, responseBytes: Buffer.byteLength(editor.body) },
          {
            method: 'POST',
            path: '/writeFile',
            status: response.status,
            requestBytes: Buffer.byteLength(body),
            responseBytes: Buffer.byteLength(response.body),
          },
        ],
        noncePresent: nonce !== undefined,
        tokenSource: nonce === undefined ? 'forged-old-looking-token' : 'disclosed-editor-html',
        expectedHash,
        candidate: digest(Buffer.from(value)),
        successfulUnauthorizedWrite: response.status === 200 && target?.equals(Buffer.from(value)) === true,
        trustedMainSaveInvocations: 0,
        files: files.map(({ label }, index) => ({ label, before: digest(before[index]), after: digest(after[index]) })),
      }),
    );
    expect.soft(response.status).toBe(403);
    for (const [index, { label }] of files.entries()) {
      const original = before[index];
      const actual = after[index];
      expect.soft(original == null ? actual === null : actual?.equals(original) === true, `${label}: exact bytes preserved`).toBe(true);
    }
  });

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
    expect(await s.editor.save(floorName, editedFloor)).toMatchObject({ ok: false, error: { code: 'invalid_content' } });
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
    expect(await s.editor.save(floorName, editedFloor)).toMatchObject({
      ok: true,
      data: { status: 'committed', receipt: { expectedHash: hash(originalFloor), afterHash: hash(editedFloor) } },
    });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(editedFloor);
    expect(await http(s.port, s.origin, `/${floorName}`)).toMatchObject({ status: 200, body: editedFloor });
    expect(await s.editor.save('_server/config.json', '{"lastFloorId":"MT1"}')).toMatchObject({
      ok: true,
      data: { status: 'committed', receipt: { expectedHash: null } },
    });
    expect(JSON.parse(await readFile(path.join(f.root, '_server/config.json'), 'utf8'))).toEqual({ lastFloorId: 'MT1' });
    expect(await s.editor.save(floorName, originalFloor)).toMatchObject({ ok: true, data: { status: 'committed' } });
    for (const name of ['project/floors/MT2.js', 'project/enemys.js', 'index.html']) {
      await expect(s.editor.save(name, editedFloor)).rejects.toThrow();
    }
    for (const invalid of ['main.floors.MT2 = {};', 'main.floors.MT1 = (() => { throw 1; })();', 'main.floors.MT1 = {"floorId":"MT1"};']) {
      expect(await s.editor.save(floorName, invalid)).toMatchObject({ ok: false, error: { code: 'invalid_content' } });
    }
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(originalFloor);
  });

  it.each([floorName, '_server/config.json'])('rejects external changes to %s without overwriting them', async (name) => {
    const f = await fixture();
    const s = await bound(f.root);
    const external = name === floorName ? originalFloor.replace('[0,1]', '[7,1]') : '{"external":true}';
    await writeFile(path.join(f.root, name), external);
    expect(await s.editor.save(name, name === floorName ? editedFloor : '{}')).toMatchObject({
      ok: false,
      error: { code: 'source_changed' },
    });
    expect(await s.editor.read(name)).toMatchObject({ ok: false, error: { code: 'source_changed' } });
    expect((await http(s.port, s.origin, '/readFile', { method: 'POST', body: `type=utf8&name=${name}` })).body).toBe(external);
    expect(await s.editor.read(name)).toMatchObject({ ok: false, error: { code: 'source_changed' } });
    expect(await readFile(path.join(f.root, name), 'utf8')).toBe(external);
  });
});

describe('Mota task controls and editor snapshot saves', () => {
  it('preserves existing non-UUID AppInstance identity in the private editor pipe', async () => {
    const f = await fixture();
    const preload = path.join(path.dirname(f.root), 'existing-identity-listener-fixture.cjs');
    const existing = { ...identity, appInstanceId: 'existing-app-instance' };
    await writeFile(
      preload,
      `const http=require('node:http');const {EventEmitter}=require('node:events');
http.createServer=()=>Object.assign(new EventEmitter(),{listen(_port,_host,ready){ready();},address(){return {port:43187};},close(){},closeAllConnections(){}});
const index=process.argv.indexOf('--identity');process.argv[index+1]=JSON.stringify(${JSON.stringify(existing)});`,
    );
    const child = launch(f.root, [], preload);
    expect((await waitFrame(child, 'mota-listening')).identity).toEqual(existing);
    bind(child, 'http://127.0.0.1:51379', { identity: existing });
    expect((await waitFrame(child, 'mota-origin-bound')).identity).toEqual(existing);
    const response = await editorWire(child, {
      type: 'mota-editor',
      editorSessionId: randomUUID(),
      requestId: randomUUID(),
      sessionIndex: 1,
      editorEpoch: 1,
      frameSeq: 0,
      method: 'editor.open',
      phase: 'single',
      input: {
        ...existing,
        resourceId: 'editor',
        resourceInstanceId: 'resource',
        resourceGeneration: 1,
        browserInstanceId: 'browser',
        browserGeneration: 1,
        documentGeneration: 1,
        editorEpoch: 1,
      },
    });
    expect(response).toMatchObject({ ok: true, method: 'editor.open' });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(originalFloor);
  });
  it('orders private saves with AI ownership and makes both old baselines stale after the other writer commits', async () => {
    const f = await fixture();
    const s = await pipeBound(f.root);
    const binding = taskBinding();
    await control(s.child, binding, 'acquire');
    expect(await s.editor.save(floorName, editedFloor)).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(originalFloor);
    expect(await control(s.child, binding, 'map.set', changeInput())).toMatchObject({ ok: true });
    await control(s.child, binding, 'release');
    expect(await s.editor.save(floorName, editedFloor)).toMatchObject({ ok: false, error: { code: 'revoked' } });
    await s.editor.call('editor.revoke');
    const fresh = await privateEditor(s.child);
    expect(await fresh.save(floorName, editedFloor)).toMatchObject({ ok: true, data: { status: 'committed' } });
    const next = taskBinding();
    await control(s.child, next, 'acquire');
    expect(await control(s.child, next, 'map.set', changeInput())).toMatchObject({ ok: false, error: { code: 'stale_source' } });
    await control(s.child, next, 'release');
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(editedFloor);
  });

  it.each(['commit-first', 'revoke-first'])('reports actual %s queue order without claiming preemption', async (order) => {
    const f = await fixture();
    const s = await pipeBound(f.root);
    const input = {
      file: floorName,
      expectedHash: hash(originalFloor),
      contentHash: hash(editedFloor),
      contentLength: Buffer.byteLength(editedFloor),
    };
    const requestId = randomUUID();
    expect(await s.editor.call('editor.stage', { ...input, content: editedFloor }, requestId)).toMatchObject({ ok: true });
    const open = s.child.frames.find((frame) => frame.type === 'mota-editor-result' && frame.method === 'editor.open');
    if (!open) throw new Error('missing open');
    const base = {
      type: 'mota-editor',
      editorSessionId: s.editor.editorSessionId,
      sessionIndex: open.sessionIndex,
      editorEpoch: 1,
      phase: 'single',
      frameSeq: 0,
    };
    const commit = { ...base, requestId, method: 'editor.commit', input };
    const revoke = { ...base, requestId: randomUUID(), method: 'editor.revoke', input: {} };
    // Promise construction writes frames synchronously in the selected order.
    const first = editorWire(s.child, order === 'commit-first' ? commit : revoke);
    const second = editorWire(s.child, order === 'commit-first' ? revoke : commit);
    const results = [await first, await second];
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject(order === 'commit-first' ? { ok: true } : { ok: false, error: { code: 'revoked' } });
    const status = await s.editor.call('editor.status', { operationRequestId: requestId });
    expect(status).toMatchObject({ ok: true, data: { status: order === 'commit-first' ? 'committed' : 'failed' } });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(order === 'commit-first' ? editedFloor : originalFloor);
  });
  it('reads and saves the full 256 KiB with split Chinese/emoji and bounded stop-and-wait envelopes', async () => {
    const f = await fixture();
    const prefix = 'main.floors.MT1 = {"floorId":"MT1","map":[[0,1],[2,3]],"extension":"';
    const suffix = '"};\n';
    const characters = '中😀'.repeat(Math.floor((262144 - Buffer.byteLength(prefix + suffix)) / 7));
    const source = prefix + characters + ' '.repeat(262144 - Buffer.byteLength(prefix + characters + suffix)) + suffix;
    expect(Buffer.byteLength(source)).toBe(262144);
    await writeFile(path.join(f.root, floorName), source);
    const s = await pipeBound(f.root);
    const read = await s.editor.read(floorName);
    expect(read).toMatchObject({ ok: true, data: { content: source, contentLength: 262144, contentHash: hash(source) } });
    const updated = source.replace('[0,1]', '[9,1]');
    const result = await s.editor.save(floorName, updated);
    expect(result).toMatchObject({
      ok: true,
      data: { status: 'committed', receipt: { expectedHash: hash(source), afterHash: hash(updated), contentLength: 262144 } },
    });
    expect((await readFile(path.join(f.root, floorName))).equals(Buffer.from(updated))).toBe(true);
    const frames = s.child.frames.filter((frame) => frame.type === 'mota-editor-result');
    expect(frames.every((frame) => Buffer.byteLength(JSON.stringify(frame) + '\n') <= 4096)).toBe(true);
    const readFrames = frames.filter((frame) => frame.requestId === read.requestId);
    expect(readFrames).toHaveLength(258);
    expect(readFrames.filter((frame) => frame.phase === 'chunk')).toHaveLength(256);
    expect(frames.filter((frame) => frame.requestId === result.requestId)).toHaveLength(259);
  });

  it('retains manual committed receipts across duplicate input, revoke, status and post-rename sync failure', async () => {
    const f = await fixture();
    const s = await pipeBound(
      f.root,
      `const fs=require('node:fs/promises');const open=fs.open;fs.open=async function(name,...args){const h=await open.call(this,name,...args);if(String(name).endsWith('/project/floors'))h.sync=async()=>{throw Error('sync fault')};return h;};`,
    );
    const requestId = randomUUID();
    const result = await s.editor.save(floorName, editedFloor, requestId);
    expect(result).toMatchObject({
      ok: true,
      data: { status: 'committed', receipt: { durabilityError: 'post_rename_io_failed', afterHash: hash(editedFloor) } },
    });
    const content = {
      file: floorName,
      expectedHash: hash(originalFloor),
      contentLength: Buffer.byteLength(editedFloor),
      contentHash: hash(editedFloor),
    };
    const original = s.child.frames.find((frame) => frame.type === 'mota-editor-result' && frame.requestId === requestId);
    if (!original) throw new Error('missing stage envelope');
    const envelope = {
      type: 'mota-editor',
      editorSessionId: s.editor.editorSessionId,
      requestId,
      editorEpoch: 1,
      sessionIndex: original.sessionIndex,
      frameSeq: 0,
      method: 'editor.commit',
      phase: 'single',
      input: content,
    };
    expect(await editorWire(s.child, envelope)).toMatchObject({ ok: true, data: result.data });
    expect(await editorWire(s.child, { ...envelope, input: { ...content, expectedHash: hash(editedFloor) } })).toMatchObject({
      ok: false,
      error: { code: 'operation_conflict' },
    });
    expect(await s.editor.call('editor.revoke')).toMatchObject({ ok: true, data: { settled: true, operation: result.data } });
    expect(await s.editor.call('editor.status', { operationRequestId: requestId })).toMatchObject({ ok: true, data: result.data });
    expect(await s.editor.call('editor.commit', content, requestId)).toMatchObject({ ok: true, data: result.data });
    expect(await editorWire(s.child, envelope)).toMatchObject({ ok: true, data: result.data });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(editedFloor);
  });

  it.each(['repeat', 'missing', 'request', 'session', 'index', 'epoch', 'hash', 'length', 'utf8', 'json', 'extra'])(
    'rejects a %s upload without changing its target',
    async (fault) => {
      const f = await fixture();
      const s = await pipeBound(f.root);
      const open = s.child.frames.find((frame) => frame.type === 'mota-editor-result' && frame.method === 'editor.open');
      if (!open) throw new Error('missing open envelope');
      const requestId = randomUUID();
      const bytes = fault === 'utf8' ? Buffer.from([0xff]) : Buffer.from(fault === 'json' ? 'not JSON' : editedFloor);
      const base = {
        type: 'mota-editor',
        editorSessionId: s.editor.editorSessionId,
        requestId,
        sessionIndex: open.sessionIndex,
        editorEpoch: 1,
        method: 'editor.stage',
      };
      const metadata = {
        file: floorName,
        expectedHash: hash(originalFloor),
        contentLength: bytes.length + (fault === 'length' ? 1 : 0),
        contentHash: fault === 'hash' ? '0'.repeat(64) : hash(bytes),
      };
      expect(await editorWire(s.child, { ...base, phase: 'begin', frameSeq: 0, input: metadata })).toMatchObject({ ok: true });
      let bad;
      const chunk = {
        ...base,
        phase: 'chunk',
        frameSeq: fault === 'missing' ? 2 : 1,
        input: { base64: bytes.toString('base64') },
        ...(fault === 'request' ? { requestId: randomUUID() } : {}),
        ...(fault === 'session' ? { editorSessionId: randomUUID() } : {}),
        ...(fault === 'index' ? { sessionIndex: 999 } : {}),
        ...(fault === 'epoch' ? { editorEpoch: 99 } : {}),
        ...(fault === 'extra' ? { root: '/forged' } : {}),
      };
      const first = await editorWire(s.child, chunk);
      if (['missing', 'request', 'session', 'index', 'epoch', 'length', 'extra'].includes(fault)) bad = first;
      else if (fault === 'repeat') bad = await editorWire(s.child, chunk);
      else bad = await editorWire(s.child, { ...base, phase: 'end', frameSeq: 2, input: {} });
      expect(bad).toMatchObject({ ok: false });
      expect(
        await editorWire(s.child, { ...base, method: 'editor.revoke', phase: 'single', frameSeq: 0, requestId: randomUUID(), input: {} }),
      ).toMatchObject({ ok: true, data: { settled: true } });
      expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(originalFloor);
    },
  );

  it('tombstones a revoke before delayed open and rejects unsupported private reads without rebasing', async () => {
    const f = await fixture();
    const s = await pipeBound(f.root);
    expect(await s.editor.call('editor.revoke')).toMatchObject({ ok: true });
    const sessionId = randomUUID();
    const base = {
      type: 'mota-editor',
      editorSessionId: sessionId,
      requestId: randomUUID(),
      sessionIndex: 9,
      editorEpoch: 2,
      frameSeq: 0,
      phase: 'single',
    };
    expect(await editorWire(s.child, { ...base, method: 'editor.revoke', input: {} })).toMatchObject({ ok: true });
    expect(
      await editorWire(s.child, {
        ...base,
        requestId: randomUUID(),
        method: 'editor.open',
        input: { ...s.editor.binding, editorEpoch: 2 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'revoked' } });
    await writeFile(path.join(f.root, floorName), originalFloor + ' '.repeat(262144));
    const next = await privateEditor(s.child, 2);
    expect(await next.read(floorName)).toMatchObject({ ok: false, error: { code: 'invalid_content' } });
    expect((await readFile(path.join(f.root, floorName))).length).toBeGreaterThan(262144);
    await writeFile(path.join(f.root, floorName), editedFloor);
    expect(await next.read(floorName)).toMatchObject({ ok: false, error: { code: 'source_changed' } });
  });

  it.each(['oversize', 'unsupported'])('refuses %s initial read bytes intact rather than truncating a saveable snapshot', async (kind) => {
    const f = await fixture();
    const source = kind === 'oversize' ? '{"extension":"' + 'x'.repeat(262144) + '"}' : '[]';
    await writeFile(path.join(f.root, '_server/config.json'), source);
    const s = await pipeBound(f.root);
    expect(await s.editor.read('_server/config.json')).toMatchObject({ ok: false, error: { code: 'invalid_content' } });
    expect(await readFile(path.join(f.root, '_server/config.json'), 'utf8')).toBe(source);
  });
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

  it('requires a private owner and advances only its successful read baseline', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    expect(await http(s.port, s.origin, '/writeFile', { method: 'POST', body: writeBody(floorName, editedFloor) })).toMatchObject({
      status: 403,
    });
    expect(await s.editor.save(floorName, editedFloor)).toMatchObject({ ok: true, data: { status: 'committed' } });
    expect(await s.editor.save(floorName, originalFloor, randomUUID(), hash(originalFloor))).toMatchObject({
      ok: false,
      error: { code: 'source_changed' },
    });
    expect(await s.editor.save(floorName, originalFloor)).toMatchObject({ ok: true, data: { status: 'committed' } });
    expect(await readFile(path.join(f.root, 'editor.html'), 'utf8')).toBe('<!doctype html><title>Synthetic editor</title>');
  });

  it('excludes manual saves during AI ownership and invalidates old pages after a commit', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    const binding = taskBinding();
    await control(s.child, binding, 'acquire');
    expect(await s.editor.save(floorName, editedFloor)).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(await control(s.child, binding, 'map.set', changeInput())).toMatchObject({ ok: true });
    await control(s.child, binding, 'release');
    for (const name of [floorName, '_server/config.json']) {
      expect(await s.editor.save(name, name === floorName ? editedFloor : '{}')).toMatchObject({ ok: false, error: { code: 'revoked' } });
    }
    expect(await s.editor.call('editor.revoke')).toMatchObject({ ok: true, data: { settled: true } });
    const refreshed = await privateEditor(s.child);
    expect(await refreshed.save(floorName, editedFloor)).toMatchObject({ ok: true, data: { status: 'committed' } });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(editedFloor);
  });

  it('rejects an AI edit based on a snapshot preceding a completed manual save', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    const binding = taskBinding();
    expect(await s.editor.save(floorName, editedFloor)).toMatchObject({ ok: true, data: { status: 'committed' } });
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

  it('serves unchanged untrusted editor HTML without nonce, script or an HTTP save capability', async () => {
    const f = await fixture();
    const s = await bound(f.root);
    const response = await http(s.port, s.origin, '/editor.html');
    expect(response.body).toBe(await readFile(path.join(f.root, 'editor.html'), 'utf8'));
    expect(response.body).not.toMatch(/data-wsl-editor-session|<script|X-WSL-Editor-Session/);
    expect((await http(s.port, s.origin, '/editor-mobile.html')).body).toBe(
      await readFile(path.join(f.root, 'editor-mobile.html'), 'utf8'),
    );
    const legacyHeaders: Record<string, string>[] = [{}, { 'X-WSL-Editor-Session': '0'.repeat(48) }];
    for (const headers of legacyHeaders)
      expect(
        await http(s.port, s.origin, '/writeFile', { method: 'POST', headers, body: writeBody(floorName, editedFloor) }),
      ).toMatchObject({ status: 403, body: 'error: http_write_disabled' });
    expect(await readFile(path.join(f.root, floorName), 'utf8')).toBe(originalFloor);
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
