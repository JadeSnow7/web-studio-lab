import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, writeFile, chmod, rm, access, symlink } from 'node:fs/promises';
import { realpathSync, statSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type * as Ssh from '../../apps/service/node_modules/@types/ssh2';
const { Server, utils } = createRequire(path.resolve('apps/service/package.json'))('ssh2') as typeof Ssh;
const run = promisify(execFile);

export interface LoopbackEnvironment {
  host: string;
  port: number;
  username: string;
  hostKeySha256: string;
  root: string;
  agent: string;
}

/** Each fixture owns its server, agent, keys, PTYs and directory. No external SSH. */
export async function sshLoopback() {
  const owned = await mkdtemp('/private/tmp/wsl-ssh-');
  const root = path.join(owned, 'files');
  await run('/bin/mkdir', ['-p', root]);
  const nonce = `SSH_${randomUUID()}`;
  await writeFile(path.join(root, '中文.txt'), `${nonce}\n真实 SFTP 中文\n`);
  await writeFile(path.join(root, 'large.txt'), `${nonce}\n` + '分页中文\n'.repeat(6000));
  await writeFile(path.join(owned, 'outside.txt'), 'must not be read');
  await symlink(path.join(owned, 'outside.txt'), path.join(root, 'escape.txt'));
  let agent: ChildProcessWithoutNullStreams | null = null;
  const clients = new Set<Ssh.Connection>();
  const ptys = new Set<ChildProcessWithoutNullStreams>();
  const pending = new Set<Promise<void>>();
  const failures: Error[] = [];
  const evidence = {
    nonce,
    connections: 0,
    authentications: 0,
    signedAuthentications: 0,
    ptysStarted: 0,
    ptysCleaned: 0,
    resize: [] as { cols: number; rows: number }[],
    transportErrors: [] as string[],
  };
  let server: InstanceType<typeof Server> | null = null;
  const stop = async () => {
    for (const client of clients) client.end();
    for (const child of ptys) if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ type: 'close' }) + '\n');
    const results = await Promise.allSettled([...pending]);
    for (const result of results) if (result.status === 'rejected') failures.push(result.reason as Error);
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    if (agent && agent.exitCode === null) {
      const exited = new Promise<void>((resolve) => agent!.once('exit', () => resolve()));
      agent.kill('SIGTERM');
      await exited;
    }
    await rm(owned, { recursive: true, force: true });
    if (failures.length) throw new AggregateError(failures, 'Owned SSH fixture cleanup failed');
  };
  try {
    for (const name of ['host', 'user']) await run('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(owned, name)]);
    const host = await readFile(path.join(owned, 'host'));
    const parsedHost = utils.parseKey(host),
      user = utils.parseKey(await readFile(path.join(owned, 'user.pub')));
    if (parsedHost instanceof Error || Array.isArray(parsedHost) || user instanceof Error || Array.isArray(user))
      throw new Error('Generated SSH keys could not be parsed');
    const authSock = path.join(owned, 'agent.sock');
    agent = spawn('/usr/bin/ssh-agent', ['-D', '-a', authSock], { stdio: ['pipe', 'pipe', 'pipe'] });
    let agentError = '';
    agent.stderr.on('data', (bytes: Buffer) => {
      agentError += bytes.toString();
    });
    for (let n = 0; ; n++) {
      try {
        await access(authSock);
        break;
      } catch (error) {
        if (n === 100 || agent.exitCode !== null) throw new Error(`Owned ssh-agent did not start: ${agentError}`, { cause: error });
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await chmod(authSock, 0o600);
    await run('/usr/bin/ssh-add', [path.join(owned, 'user')], { env: { ...process.env, SSH_AUTH_SOCK: authSock } });
    server = new Server({ hostKeys: [host] }, (client) => {
      evidence.connections++;
      clients.add(client);
      client.on('close', () => clients.delete(client));
      client.on('error', (error) => {
        evidence.transportErrors.push(error.message);
      });
      client.on('authentication', (ctx) => {
        evidence.authentications++;
        if (ctx.method !== 'publickey' || ctx.username !== 'owned-test' || !ctx.key.data.equals(user.getPublicSSH())) {
          ctx.reject();
          return;
        }
        if (ctx.signature && user.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) !== true) {
          ctx.reject();
          return;
        }
        if (ctx.signature) evidence.signedAuthentications++;
        ctx.accept();
      });
      client.on('ready', () =>
        client.on('session', (accept) => {
          const session = accept();
          let size = { cols: 80, rows: 24 };
          let child: ChildProcessWithoutNullStreams | null = null;
          session.on('pty', (acceptPty, _reject, info) => {
            size = { cols: info.cols, rows: info.rows };
            acceptPty?.();
          });
          session.on('window-change', (acceptResize, _reject, info) => {
            size = { cols: info.cols, rows: info.rows };
            evidence.resize.push(size);
            child?.stdin.write(JSON.stringify({ type: 'resize', ...size }) + '\n');
            acceptResize?.();
          });
          session.on('shell', (acceptShell) => {
            const channel = acceptShell();
            child = spawn('/usr/bin/python3', ['-u', path.resolve('apps/service/src/local-terminal.py')], {
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            const ownedChild = child;
            ptys.add(child);
            evidence.ptysStarted++;
            let cleanup = false,
              exitCode = 1,
              errors = '';
            child.stderr.on('data', (bytes: Buffer) => {
              errors += bytes.toString();
            });
            const lines = createInterface({ input: child.stdout });
            lines.on('line', (line) => {
              const frame = JSON.parse(line) as { type: string; data?: string; ok?: boolean; exitCode?: number };
              if (frame.type === 'output') channel.write(frame.data!);
              if (frame.type === 'exit') exitCode = frame.exitCode!;
              if (frame.type === 'cleanup') cleanup = frame.ok === true;
            });
            const done = new Promise<void>((resolve, reject) => {
              child!.once('error', reject);
              child!.once('close', (code) => {
                lines.close();
                ptys.delete(ownedChild);
                if (code === 0 && cleanup) {
                  evidence.ptysCleaned++;
                  channel.exit(Math.max(0, exitCode));
                  channel.end();
                  resolve();
                } else reject(new Error(`Owned PTY cleanup not confirmed: code=${code}, ${errors}`));
              });
            });
            pending.add(done);
            void done.catch((error: Error) => failures.push(error));
            channel.setEncoding('utf8');
            channel.on('data', (data: string) => {
              if (!ownedChild.stdin.destroyed) ownedChild.stdin.write(JSON.stringify({ type: 'input', data }) + '\n');
            });
            channel.on('close', () => {
              if (!ownedChild.stdin.destroyed) ownedChild.stdin.write(JSON.stringify({ type: 'close' }) + '\n');
            });
            child.stdin.write(
              JSON.stringify({ shell: '/bin/bash', cwd: root, rc: Buffer.from("PS1='PTY> '\n").toString('base64'), ...size }) + '\n',
            );
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
              const real = realpathSync(file);
              if (real !== root && !real.startsWith(root + '/')) throw new Error('Outside owned SFTP root');
              return real;
            };
            // Return canonical paths even for a symlink outside root: the product
            // must independently enforce the authorized root before opening it.
            sftp.on('REALPATH', (id, file) => {
              try {
                sftp.name(id, [{ filename: realpathSync(file), longname: '', attrs: attrs(file) }]);
              } catch {
                sftp.status(id, 2);
              }
            });
            const open = (id: number, file: string) => {
              try {
                const handle = Buffer.from(String(++next));
                handles.set(handle.toString(), { file: checked(file), listed: false });
                sftp.handle(id, handle);
              } catch {
                sftp.status(id, 3);
              }
            };
            sftp.on('OPEN', open);
            sftp.on('OPENDIR', open);
            sftp.on('STAT', (id, file) => {
              try {
                sftp.attrs(id, attrs(checked(file)));
              } catch {
                sftp.status(id, 3);
              }
            });
            sftp.on('FSTAT', (id, handle) => {
              const entry = handles.get(handle.toString());
              if (entry) sftp.attrs(id, attrs(entry.file));
              else sftp.status(id, 4);
            });
            sftp.on('READ', (id, handle, offset, length) => {
              const entry = handles.get(handle.toString());
              if (!entry) {
                sftp.status(id, 4);
                return;
              }
              const bytes = readFileSync(entry.file);
              if (offset >= bytes.length) sftp.status(id, 1);
              else sftp.data(id, bytes.subarray(offset, offset + length));
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
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Owned SSH server address unavailable');
    const environment: LoopbackEnvironment = {
      host: '127.0.0.1',
      port: address.port,
      username: 'owned-test',
      hostKeySha256: createHash('sha256').update(parsedHost.getPublicSSH()).digest('hex'),
      root,
      agent: authSock,
    };
    return {
      environment,
      profile: path.join(owned, 'profile'),
      nonce,
      evidence,
      disconnect: () => {
        for (const client of clients) client.end();
      },
      stop,
    };
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'SSH fixture setup and cleanup failed', { cause: cleanupError });
    }
    throw error;
  }
}
