#!/usr/bin/env node
// Controlled LOCAL import/startup/port mapping, never a real sbx or Setup test.
// Editor frames and replies pass unchanged through the compiled product server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { inflateSync } from 'node:zlib';

const root = process.env['WSL_MOTA_FIXTURE_ROOT'];
assert(root && path.isAbsolute(root));
const args = process.argv.slice(2);
const mapping = path.join(root, 'ports.json');
const audit = (value) =>
  fs.appendFileSync(path.join(root, 'transport.jsonl'), JSON.stringify({ ...value, at: new Date().toISOString() }) + '\n');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (args[0] === 'version') {
  console.log('sbx version: controlled-local-mota-fixture');
  process.exit(0);
}
if (args[0] === 'inspect') {
  console.log(JSON.stringify({ name: args.at(-1), agent: 'codex', state: 'running', runtime_mounts: [] }));
  process.exit(0);
}
if (args[0] === 'ports') {
  if (args.includes('--publish')) {
    const port = Number(args[args.indexOf('--publish') + 1].split('/')[0]);
    fs.writeFileSync(mapping, JSON.stringify([{ host_ip: '127.0.0.1', host_port: port, sandbox_port: port, protocol: 'tcp4' }]));
    console.log(`Published 127.0.0.1:${port} -> ${port}/tcp4`);
  } else if (args.includes('--unpublish')) {
    fs.writeFileSync(mapping, '[]');
  } else console.log(fs.existsSync(mapping) ? fs.readFileSync(mapping, 'utf8') : '[]');
  process.exit(0);
}
assert(args[0] === 'exec' && args.includes('python3'));
const frame = (value) => console.log('WSL_GUEST_FRAME:' + JSON.stringify(value));
const output = (data, stream = 'stdout') => frame({ type: 'output', stream, data });
let child;
let importBinding;
let active;
let destination;
let held;
let poll;
let finished = false;
const finish = (exitCode = 0) => {
  if (finished) return;
  finished = true;
  clearInterval(poll);
  frame({ type: 'exit', exitCode });
  // For startup this is emitted only after the retained real child close event.
  frame({ type: 'cleanup', ok: exitCode === 0 });
  audit({ event: 'fixture-exit', pid: process.pid, exitCode });
  process.stdout.write('', () => process.exit(exitCode === 0 ? 0 : 1));
};
const transfer = (value) => {
  if (value.type === 'begin') {
    importBinding = value.binding;
    destination = path.join(root, 'copy', importBinding.projectId);
    fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  }
  assert.deepEqual(value.binding, importBinding);
  if (value.type === 'file') {
    assert(!value.path.split('/').includes('..') && !path.isAbsolute(value.path));
    active = { ...value, data: Buffer.alloc(0) };
    fs.mkdirSync(path.dirname(path.join(destination, value.path)), { recursive: true, mode: 0o700 });
  }
  if (value.type === 'chunk') {
    assert.equal(value.offset, active.data.length);
    active.data = Buffer.concat([active.data, Buffer.from(value.base64, 'base64')]);
  }
  if (value.type === 'file-end') {
    assert.equal(active.data.length, value.bytes);
    assert.equal(hash(active.data), value.sha256);
    fs.writeFileSync(path.join(destination, active.path), active.data, { flag: 'wx', mode: 0o600 });
  }
  if (value.type === 'finish') {
    fs.writeFileSync(path.join(destination, '.wsl-mota-copy'), 'mota-managed-copy-v1\n', { mode: 0o600 });
    output(
      'WSL_MOTA_TRANSFER:' +
        JSON.stringify({
          type: 'receipt',
          binding: importBinding,
          seq: value.seq,
          outcome: 'imported',
          fileCount: value.fileCount,
          totalBytes: value.totalBytes,
          sourceSha256: value.sourceSha256,
        }) +
        '\n',
    );
    audit({ event: 'controlled-import', binding: importBinding });
    return;
  }
  output(
    'WSL_MOTA_TRANSFER:' +
      JSON.stringify({
        type: 'ack',
        binding: importBinding,
        seq: value.seq,
        operation: value.type,
        fileIndex: value.fileIndex ?? null,
        offset: value.type === 'chunk' ? active.data.length : value.type === 'file-end' ? value.bytes : 0,
        sha256: ['file', 'file-end'].includes(value.type) ? value.sha256 : null,
      }) +
      '\n',
  );
};
const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const value = JSON.parse(line);
  if (value.type === 'start') {
    frame({ type: 'ready', pid: process.pid });
    if (value.argv[0] === 'codex' && value.argv[1] === '--version') {
      output('codex-cli controlled-local-fixture\n');
      return finish();
    }
    const request = JSON.parse(value.prompt);
    if (request.type === 'begin') return transfer(request);
    assert.equal(request.operation, 'start');
    assert.equal(request.profile.projectKind, 'mota-web');
    // This string came from the REAL built Service's trusted Python payload.
    const encoded = /MOTA_SERVER_BASE64 = "([A-Za-z0-9+/=]+)"/.exec(value.argv.at(-1));
    assert(encoded, 'compiled product helper must contain its server payload');
    const server = inflateSync(Buffer.from(encoded[1], 'base64'));
    const serverFile = path.join(root, 'server-' + request.appInstanceId + '.cjs');
    fs.writeFileSync(serverFile, server, { flag: 'wx', mode: 0o600 });
    destination = path.join(root, 'copy', request.projectId);
    const names = new Set([...request.profile.source.files.map((item) => item.path), '_server/config.json']);
    const current = [...names]
      .sort()
      .filter((name) => fs.existsSync(path.join(destination, name)))
      .map((name) => {
        const bytes = fs.readFileSync(path.join(destination, name));
        const metadata = { path: name, sha256: hash(bytes), bytes: bytes.length };
        if (!['project/floors/MT1.js', '_server/config.json'].includes(name))
          assert.deepEqual(
            metadata,
            request.profile.source.files.find((item) => item.path === name),
          );
        return metadata;
      });
    output('WSL_APP_SOURCE:' + hash(JSON.stringify(current)) + '\n');
    child = spawn(
      process.execPath,
      [
        serverFile,
        '--root',
        destination,
        '--identity',
        JSON.stringify({
          workspaceId: request.workspaceId,
          environmentId: 'sandbox',
          projectId: request.projectId,
          appInstanceId: request.appInstanceId,
        }),
        '--bind-address',
        '127.0.0.1',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    audit({
      event: 'server-start',
      pid: child.pid,
      fixturePid: process.pid,
      appInstanceId: request.appInstanceId,
      serverHash: hash(server),
    });
    readline.createInterface({ input: child.stdout }).on('line', (reply) => {
      const data = JSON.parse(reply);
      audit({ event: 'server-reply', data });
      const gate = path.join(root, 'hold-reply');
      // Hold only an ACTUAL server response, preserving every original byte.
      if (data.type === 'mota-editor-result' && fs.existsSync(gate) && fs.readFileSync(gate, 'utf8') === data.method + ':' + data.phase) {
        assert(!held);
        held = reply;
        fs.writeFileSync(path.join(root, 'reply-held'), reply, { flag: 'wx' });
        poll = setInterval(() => {
          if (!fs.existsSync(gate)) {
            clearInterval(poll);
            output(held + '\n');
            held = undefined;
          }
        }, 10);
      } else output(reply + '\n');
    });
    child.stderr.on('data', (bytes) => output(bytes.toString(), 'stderr'));
    child.once('error', (error) => {
      throw error;
    });
    child.once('close', (code, signal) => {
      audit({ event: 'server-exit', pid: child.pid, code, signal });
      finish(code ?? 1);
    });
  } else if (value.type === 'input') {
    if (child) {
      for (const decoded of value.data.trim().split('\n')) audit({ event: 'server-input', data: JSON.parse(decoded) });
      child.stdin.write(value.data);
    } else for (const decoded of value.data.trim().split('\n')) transfer(JSON.parse(decoded));
  } else if (value.type === 'close-input' || value.type === 'close') {
    if (child) child.stdin.end();
    else finish();
  } else throw new Error('unsupported controlled transport frame');
});
input.on('close', () => (child ? child.stdin.end() : finish()));
process.once('SIGTERM', () => (child ? child.stdin.end() : finish()));
