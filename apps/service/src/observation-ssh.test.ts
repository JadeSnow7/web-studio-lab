import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync, statSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Server, utils } from 'ssh2';
import { afterEach, expect, it } from 'vitest';
import { SshObservationConnection } from './observation-ssh';
import { FileObservationProvider } from './observation-files';
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup
    .splice(0)
    .reverse()
    .forEach((fn) => fn()),
);
it('real loopback SSH handshake rejects bad host pin and reads filesystem through SFTP; shell channel survives false', async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const parsed = utils.parseKey(key);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('test key failed');
  const pin = createHash('sha256').update(parsed.getPublicSSH()).digest('hex');
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'wsl-real-sftp-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'hello.txt'), '真实 SFTP content\nsecond line');
  let stallReads = false;
  const server = new Server({ hostKeys: [key] }, (client) => {
    client.on('error', () => {
      /* Expected for the rejected host pin handshake. */
    });
    client.on('authentication', (ctx) => (ctx.method === 'publickey' ? ctx.accept() : ctx.reject()));
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept();
        session.on('pty', (acceptPty) => acceptPty?.());
        session.on('shell', (acceptShell) => {
          const stream = acceptShell();
          // Isolated real shell process; this service tests transport, not VT emulation.
          const shell = spawn('/bin/sh', [], { stdio: ['pipe', 'pipe', 'pipe'] });
          cleanup.push(() => shell.kill());
          stream.pipe(shell.stdin);
          shell.stdout.pipe(stream);
          shell.stderr.pipe(stream);
          shell.on('exit', (code) => {
            stream.exit(code ?? 1);
            stream.end();
          });
          stream.on('close', () => shell.kill());
        });
        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map<string, { file: string; listed: boolean }>();
          let next = 0;
          const attrs = (file: string) => {
            const s = statSync(file);
            return {
              mode: s.mode,
              uid: s.uid,
              gid: s.gid,
              size: s.size,
              atime: Math.floor(s.atimeMs / 1000),
              mtime: Math.floor(s.mtimeMs / 1000),
            };
          };
          const checked = (file: string) => {
            const actual = realpathSync(file);
            if (actual !== root && !actual.startsWith(root + '/')) throw new Error('scope');
            return actual;
          };
          sftp.on('REALPATH', (id, file) => {
            try {
              sftp.name(id, [{ filename: checked(file), longname: '', attrs: attrs(file) }]);
            } catch {
              sftp.status(id, 3);
            }
          });
          const opening = (id: number, file: string) => {
            try {
              const handle = Buffer.from(String(++next));
              handles.set(handle.toString(), { file: checked(file), listed: false });
              sftp.handle(id, handle);
            } catch {
              sftp.status(id, 3);
            }
          };
          sftp.on('OPEN', opening);
          sftp.on('OPENDIR', opening);
          sftp.on('FSTAT', (id, handle) => {
            const entry = handles.get(handle.toString());
            if (entry) sftp.attrs(id, attrs(entry.file));
            else sftp.status(id, 4);
          });
          sftp.on('READ', (id, handle, offset, length) => {
            if (stallReads) return;
            const entry = handles.get(handle.toString());
            if (!entry) {
              sftp.status(id, 4);
              return;
            }
            const content = readFileSync(entry.file);
            if (offset >= content.length) sftp.status(id, 1);
            else sftp.data(id, content.subarray(offset, offset + length));
          });
          sftp.on('READDIR', (id, handle) => {
            const entry = handles.get(handle.toString());
            if (!entry || entry.listed) {
              sftp.status(id, 1);
              return;
            }
            entry.listed = true;
            sftp.name(
              id,
              readdirSync(entry.file).map((name) => ({ filename: name, longname: name, attrs: attrs(path.join(entry.file, name)) })),
            );
          });
          sftp.on('CLOSE', (id, handle) => {
            handles.delete(handle.toString());
            sftp.status(id, 0);
          });
        });
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  cleanup.push(() => server.close());
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  const config = { host: '127.0.0.1', port: address.port, username: 'isolated-test', hostKeySha256: pin, privateKey: Buffer.from(key) };
  await expect(SshObservationConnection.connect({ ...config, hostKeySha256: '0'.repeat(64) })).rejects.toMatchObject({
    code: 'unavailable',
  });
  const connection = await SshObservationConnection.connect(config);
  cleanup.push(() => connection.close());
  const files = new FileObservationProvider({
    workspaceId: 'test',
    resourceId: 'ssh-files',
    instanceId: 'ssh-instance',
    instanceGeneration: 1,
    environmentId: `ssh:${connection.connectionId}`,
    root,
    transport: await connection.fileTransport(),
  });
  expect((await files.list()).data).toMatchObject({ entries: [{ name: 'hello.txt', kind: 'file' }] });
  const first = await files.read({ path: 'hello.txt', maxBytes: 8 });
  expect(first.source).toBe('sftp');
  expect(first.data).toMatchObject({ text: '真实 S' });
  const next = await files.read({ path: 'hello.txt', cursor: first.nextCursor });
  expect(next.data).toMatchObject({ text: 'FTP content\nsecond line' });
  expect((await files.search({ query: 'content' })).data).toMatchObject({
    matches: [{ path: 'hello.txt', line: 1, text: '真实 SFTP content' }],
  });
  let output = '';
  let finish: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const shell = await connection.openShell(
    { cols: 80, rows: 24 },
    {
      output: (text) => {
        output += text;
        if (output.includes('still-alive')) finish?.();
      },
      closed: () => {},
    },
  );
  shell.write("false\nprintf 'still-alive\\n'\n");
  await done;
  expect(output).toContain('still-alive');
  const old = connection.generation;
  stallReads = true;
  await expect((await connection.fileTransport()).read(path.join(root, 'hello.txt'), 1024, Date.now() + 30)).rejects.toMatchObject({
    code: 'unavailable',
  });
  expect(connection.generation).not.toBe(old);
  expect(connection.available).toBe(false);
  await expect(files.read({ path: 'hello.txt', cursor: first.nextCursor })).rejects.toMatchObject({ code: 'unavailable' });
}, 15000);
