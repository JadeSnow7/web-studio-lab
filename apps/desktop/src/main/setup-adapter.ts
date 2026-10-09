import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { DependencyManifestSchema, type DependencyManifest } from '@wsl/protocol';
import { SetupError, type SetupAdapter } from './setup';

const SBX_URL = 'https://github.com/docker/sbx-releases/releases/download/v0.47.0/DockerSandboxes-darwin.tar.gz';
const SBX_HASH = '947e68826c62b12de2fa0ba5b0a67a953911a2321203c04f7c0982ccfc0f1694';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** Never include child output in an error: auth/tool output can contain credentials. */
export function setupCommand(binary: string, args: string[], signal: AbortSignal, timeout = 120000): Promise<string> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const env = { ...process.env };
    delete env['SSH_AUTH_SOCK'];
    const child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let failed = false;
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      child.kill('SIGTERM');
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeout);
    signal.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > 1024 * 1024) {
        failed = true;
        stop();
      }
    });
    child.stderr.resume();
    child.on('error', () => {
      failed = true;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal.removeEventListener('abort', stop);
      if (signal.aborted) reject(new SetupError('cancelled', '操作已取消'));
      else if (timedOut) reject(new SetupError('command-timeout', '工具执行超时；重试将核对实际资源'));
      else if (code !== 0 || failed)
        reject(
          new SetupError(
            'command-failed',
            `工具 ${path.basename(binary)} ${args[0] ?? ''} 退出码 ${code ?? 'unknown'}，请检查当前安装阶段后重试`,
          ),
        );
      else resolve(output);
    });
  });
}
export async function downloadSbx(archive: string, signal: AbortSignal) {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(5 * 60 * 1000)]);
  const response = await fetch(SBX_URL, { signal: bounded });
  if (!response.ok || !response.body) throw new SetupError('download-failed', 'sbx 下载失败，请检查网络后重试');
  const file = await open(archive, 'wx', 0o600);
  const hash = createHash('sha256');
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      bounded.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 1024 * 1024 * 1024) throw new SetupError('download-size', 'sbx 下载超出固定载荷大小限制');
      hash.update(chunk.value);
      await file.writeFile(chunk.value);
    }
    if (hash.digest('hex') !== SBX_HASH) throw new SetupError('download-corrupt', 'sbx 下载校验失败');
  } finally {
    try {
      await reader.cancel();
    } finally {
      await file.close();
    }
  }
}
export class NativeSetupAdapter implements SetupAdapter {
  constructor(
    private readonly resourceRoot: string,
    private readonly appPath: string,
    private readonly userData: string,
  ) {}
  async check(signal: AbortSignal) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || Number(os.release().split('.')[0]) < 23)
      throw new SetupError('unsupported-system', '需要 macOS 14 或更新版本及 Apple Silicon');
    if (!this.appPath.startsWith('/Applications/') && !this.appPath.startsWith(path.join(os.homedir(), 'Applications') + '/'))
      throw new SetupError('installation-location', '请将应用拖到 Applications 后打开');
    let manifest: DependencyManifest;
    try {
      manifest = DependencyManifestSchema.parse(JSON.parse(await readFile(path.join(this.resourceRoot, 'dependencies.json'), 'utf8')));
    } catch {
      throw new SetupError('payload-missing', '安装载荷缺失或清单无效，请重新获取完整安装包');
    }
    for (const payload of [manifest.python, manifest.guest]) {
      let bytes: Buffer;
      try {
        bytes = await readFile(path.join(this.resourceRoot, payload.path));
      } catch {
        throw new SetupError('payload-missing', '安装载荷缺失，请重新获取完整安装包');
      }
      if (digest(bytes) !== payload.sha256) throw new SetupError('payload-corrupt', '安装载荷校验失败，请重新获取完整安装包');
    }
    const python = path.resolve(this.resourceRoot, manifest.python.executable);
    if (!python.startsWith(this.resourceRoot + path.sep)) throw new SetupError('payload-invalid', 'Python 路径超出安装包');
    await access(python, constants.X_OK);
    await setupCommand('/usr/bin/codesign', ['--verify', '--deep', '--strict', this.appPath], signal);
    await setupCommand('/usr/bin/codesign', ['--verify', '--strict', python], signal);
    const free = await statfs(os.homedir());
    if (free.bavail * free.bsize < manifest.minimumFreeBytes) throw new SetupError('disk-space', '可用磁盘空间低于安装载荷估算要求');
    return manifest;
  }
  private async verifySbx(app: string, signal: AbortSignal) {
    await setupCommand(
      '/usr/bin/codesign',
      ['--verify', '--deep', '--strict', '-R', '=anchor apple generic and certificate leaf[subject.OU] = "9BNSXJN65R"', app],
      signal,
    );
    const binary = path.join(app, 'Contents/MacOS/sbx');
    const version = await setupCommand(binary, ['version'], signal);
    if (!/^sbx version: v0\.47\.0(?:\s|$)/.test(version.trim()))
      throw new SetupError('sbx-version-conflict', '已有 sbx 版本不兼容；请保留已有任务并处理版本冲突');
    return binary;
  }
  async installSbx(signal: AbortSignal) {
    const target = path.join(os.homedir(), 'Applications/Sbx.app');
    try {
      await lstat(target);
      return await this.verifySbx(target, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Respect a system-wide installation rather than creating a second daemon installation.
    try {
      await lstat('/Applications/Sbx.app');
      return await this.verifySbx('/Applications/Sbx.app', signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = await mkdtemp(path.join(path.dirname(target), '.wsl-sbx-'));
    try {
      const archive = path.join(temporary, 'sbx.tar.gz');
      await downloadSbx(archive, signal);
      await setupCommand('/usr/bin/tar', ['-xzf', archive, '-C', temporary], signal);
      const extracted = path.join(temporary, 'Sbx.app');
      await this.verifySbx(extracted, signal);
      signal.throwIfAborted();
      // No overwrite: the destination must still be absent before the atomic move.
      try {
        await lstat(target);
        throw new SetupError('installation-conflict', 'sbx 安装路径已被其他操作创建');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await rename(extracted, target);
      return await this.verifySbx(target, signal);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  async sandboxExists(binary: string, name: string, signal: AbortSignal) {
    return (await setupCommand(binary, ['ls', '-q'], signal)).split(/\r?\n/).includes(name);
  }
  async createSandbox(binary: string, name: string, manifest: DependencyManifest, signal: AbortSignal) {
    await setupCommand(
      binary,
      ['create', '--name', name, '--skills', 'off', '--cpus', '2', '--memory', '4g', '-t', manifest.baseImage, 'codex'],
      signal,
      20 * 60 * 1000,
    );
  }
  async inspectSandbox(binary: string, name: string, manifest: DependencyManifest, signal: AbortSignal) {
    const raw = await setupCommand(binary, ['inspect', '--json', name], signal);
    const parsed = z
      .object({
        name: z.literal(name),
        agent: z.literal('codex'),
        runtime_mounts: z.array(z.unknown()).length(0),
        image_digest: z.literal(manifest.baseImage.split('@')[1]),
        cpus: z.literal(2),
        memory: z.literal('4g'),
        daemon_version: z.literal('v0.47.0'),
        state: z.enum(['running', 'stopped']),
      })
      .safeParse(JSON.parse(raw));
    if (!parsed.success) throw new SetupError('sandbox-conflict', '已有沙箱与固定隔离环境不一致，未修改该沙箱');
  }
  async installTools(binary: string, name: string, manifest: DependencyManifest, signal: AbortSignal) {
    const guestPath = '/tmp/wsl-competition-tools.tar.gz';
    await setupCommand(binary, ['cp', path.join(this.resourceRoot, manifest.guest.path), name + ':' + guestPath], signal);
    const install =
      'set -eu; printf "%s  %s\\n" ' +
      manifest.guest.sha256 +
      ' ' +
      guestPath +
      ' | sha256sum -c -; sudo -n tar -xzf ' +
      guestPath +
      ' -C /; sudo -n rm -- ' +
      guestPath;
    await setupCommand(binary, ['exec', name, 'sh', '-c', install], signal);
  }
  async probe(binary: string, name: string, signal: AbortSignal) {
    const script =
      'set -eu; test "$(/usr/local/bin/node --version)" = v24.21.0; test "$(/usr/local/bin/pnpm --version)" = 10.34.6; test "$(/usr/local/bin/codex --version)" = "codex-cli 0.160.0"; git --version >/dev/null; test -s /etc/ssl/certs/ca-certificates.crt; python3 -c "import pty, ssl, os; a,b=pty.openpty(); os.close(a); os.close(b)"';
    await setupCommand(binary, ['exec', '-w', '/home/agent/workspace', name, 'sh', '-c', script], signal);
  }
  async modelConfigured(binary: string, signal: AbortSignal) {
    const raw = await setupCommand(binary, ['secret', 'ls', '--service', 'openai', '--global', '--json'], signal);
    const metadata = z
      .object({ secrets: z.array(z.object({ scope: z.string(), name: z.string(), type: z.string() })) })
      .parse(JSON.parse(raw));
    return metadata.secrets.length > 0;
  }
  async login(binary: string, provider: 'docker' | 'openai', signal: AbortSignal, operationId: string, resume = false) {
    if (!resume) signal.throwIfAborted();
    await mkdir(this.userData, { recursive: true });
    const directory = path.join(this.userData, 'login-' + operationId);
    if (!resume) await mkdir(directory, { mode: 0o700 });
    else {
      try {
        await lstat(directory);
      } catch {
        throw new SetupError('cleanup-unconfirmed', '登录记录缺失，进程退出未确认');
      }
    }
    const cancel = path.join(directory, 'cancel');
    const result = path.join(directory, 'result.json');
    const runner = path.join(directory, 'runner.py');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const args = provider === 'docker' ? ['login'] : ['secret', 'set', 'openai', '--oauth'];
    const code = `import json, os, pathlib, signal, subprocess, time
root = pathlib.Path(__file__).parent
cancel = root / "cancel"
result = root / "result.json"
def interrupt(signum, frame):
    cancel.touch()
for signum in [signal.SIGTERM, signal.SIGHUP, signal.SIGINT]:
    signal.signal(signum, interrupt)
child = None
status = 1
try:
    if not cancel.exists():
        env = dict(os.environ)
        env.pop("SSH_AUTH_SOCK", None)
        child = subprocess.Popen(${JSON.stringify([binary, ...args])}, env=env, start_new_session=True)
        (root / "started").touch()
        deadline = time.monotonic() + 900
        while child.poll() is None:
            if cancel.exists() or time.monotonic() >= deadline:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.wait()
                break
            time.sleep(0.2)
        status = child.returncode
finally:
    temporary = root / "result.tmp"
    temporary.write_text(json.dumps({"exitCode": status}))
    temporary.replace(result)
`;
    if (!resume) await writeFile(runner, code, { mode: 0o600 });
    const command = path.join(directory, 'login.command');
    await writeFile(
      command,
      '#!/bin/sh\nexec ' + quote(path.join(this.resourceRoot, 'python/bin/python3')) + ' -I -B ' + quote(runner) + '\n',
      { mode: 0o700 },
    );
    const controller = new AbortController();
    if (!resume) signal.throwIfAborted();
    if (!resume) await setupCommand('/usr/bin/open', ['-a', 'Terminal', command], controller.signal);
    let completed = false;
    let stopDeadline: number | null = null;
    const deadline = Date.now() + 15 * 60 * 1000;
    try {
      while (!completed) {
        if (signal.aborted || Date.now() > deadline) {
          await writeFile(cancel, '', { mode: 0o600 });
          stopDeadline ??= Date.now() + 20000;
        }
        try {
          const value = z
            .object({ exitCode: z.number().int() })
            .strict()
            .parse(JSON.parse(await readFile(result, 'utf8')));
          completed = true;
          if (signal.aborted) throw new SetupError('cancelled', '登录已取消');
          if (Date.now() > deadline) throw new SetupError('login-timeout', '登录超时，请重新开始');
          if (value.exitCode !== 0) throw new SetupError('login-failed', '登录未完成，请在登录窗口确认并重试');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          if ((stopDeadline && Date.now() > stopDeadline) || Date.now() > deadline + 20000)
            throw new SetupError('cleanup-unconfirmed', '登录进程退出未确认，请关闭登录窗口后重试');
        }
        if (!completed) await delay(250);
      }
    } finally {
      if (completed) await rm(directory, { recursive: true, force: true });
      else await writeFile(cancel, '', { mode: 0o600 });
    }
  }
}
