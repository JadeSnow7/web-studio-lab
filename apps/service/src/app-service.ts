import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { type GuestProcess, type SbxConnection } from './sbx';
import helper from './app-helper.py?raw';

const exec = promisify(execFile);
const keySchema = z
  .object({ workspaceId: z.string().min(1).max(128), projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/) })
  .strict();
const fileSchema = z.object({ path: z.string().min(1).max(512), base64: z.string() }).strict();
export type AppKey = z.infer<typeof keySchema>;
export type AppSourceFile = z.infer<typeof fileSchema>;
export interface AppSnapshot extends AppKey {
  environmentId: 'sandbox';
  appInstanceId: string | null;
  state: 'created' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed';
  url: string | null;
  guestCwd: string;
  guestPort: number | null;
  error: string | null;
  cleanupConfirmed: boolean;
}
const portSchema = z.object({
  host_ip: z.literal('127.0.0.1'),
  host_port: z.coerce.number().int().min(1).max(65535),
  sandbox_port: z.coerce.number().int(),
  protocol: z.string(),
});
type Port = z.infer<typeof portSchema>;
interface Entry {
  snapshot: AppSnapshot;
  process: Pick<GuestProcess, 'done' | 'close'> | null;
  operation: Promise<AppSnapshot> | null;
  cancelled: boolean;
  port: Port | null;
  portPending: boolean;
  log: string;
  readyPort: number | null;
  readyError: string | null;
  processExited: boolean;
}
export interface AppServiceOptions {
  /** Trusted service wiring, never populated from renderer input. */
  ports?: (args: string[]) => Promise<string>;
  fetch?: typeof fetch;
  startupTimeoutMs?: number;
  registryPath?: string;
  dependencyArchivePath?: string;
  dependencyManifest?: { archiveSha256: string; lockSha256: string; platform: 'linux'; arch: 'arm64'; libc: 'glibc' };
  onSnapshot?: (snapshot: AppSnapshot) => void;
}

export function validateAppSources(files: AppSourceFile[]): void {
  z.array(fileSchema).min(1).max(256).parse(files);
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    if (
      file.path.includes('\\') ||
      file.path.includes('\0') ||
      file.path.startsWith('.wsl-') ||
      file.path.split('/').some((part) => !part || part === '.' || part === '..') ||
      /^(node_modules|dist|data|\.data|\.git|\.vite|\.wsl-identity\.json)(\/|$)/.test(file.path)
    )
      throw new Error('不安全的应用源码路径');
    if (seen.has(file.path)) throw new Error('重复应用源码路径');
    seen.add(file.path);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) throw new Error('无效源码编码');
    total += Buffer.from(file.base64, 'base64').length;
  }
  // GuestStart is bounded to 1 MiB, including JSON/base64 overhead.
  if (total > 524288) throw new Error('应用源码超出传输预算');
}

/** One project service owner, independent of Codex task completion. */
export class AppService {
  private entries = new Map<string, Entry>();
  private closing = false;
  private options: AppServiceOptions;
  private loaded: Promise<void> | null = null;
  constructor(
    private connection: Pick<SbxConnection, 'getStatus' | 'runtimeTarget'> & {
      start: (...args: Parameters<SbxConnection['start']>) => Pick<GuestProcess, 'done' | 'close'>;
    },
    options: AppServiceOptions = {},
  ) {
    this.options = options;
  }
  private ensureLoaded(): Promise<void> {
    return (this.loaded ??= this.load());
  }
  private async load(): Promise<void> {
    if (!this.options.registryPath) return;
    let data: unknown;
    try {
      data = JSON.parse(await readFile(this.options.registryPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const registry = z
      .object({
        version: z.literal(1),
        sandbox: z.string(),
        apps: z.array(
          keySchema.extend({
            cleanupConfirmed: z.boolean(),
            state: z.enum(['created', 'starting', 'running', 'stopping', 'stopped', 'failed']),
          }),
        ),
      })
      .strict()
      .parse(data);
    if (registry.sandbox !== this.connection.getStatus().sandbox) throw new Error('应用注册表沙箱身份不匹配');
    // Registry restores source ownership only. No process or port is replayed.
    for (const saved of registry.apps) {
      const key = { workspaceId: saved.workspaceId, projectId: saved.projectId };
      const confirmed = saved.cleanupConfirmed && !['running', 'starting', 'stopping'].includes(saved.state);
      this.entries.set(this.id(key), {
        snapshot: {
          ...key,
          environmentId: 'sandbox',
          appInstanceId: null,
          state: confirmed ? 'stopped' : 'failed',
          url: null,
          guestCwd: `/home/agent/workspace/.wsl-apps/${key.projectId}`,
          guestPort: null,
          error: confirmed ? null : '上次运行中断，需核对沙箱进程与端口',
          cleanupConfirmed: confirmed,
        },
        process: null,
        operation: null,
        cancelled: false,
        port: null,
        portPending: false,
        log: '',
        readyPort: null,
        readyError: null,
        processExited: false,
      });
    }
  }
  private async persist(): Promise<void> {
    if (!this.options.registryPath) return;
    const target = this.options.registryPath;
    await mkdir(path.dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        version: 1,
        sandbox: this.connection.getStatus().sandbox,
        apps: [...this.entries.values()].map(({ snapshot }) => ({
          workspaceId: snapshot.workspaceId,
          projectId: snapshot.projectId,
          state: snapshot.state,
          cleanupConfirmed: snapshot.cleanupConfirmed,
        })),
      }),
      { mode: 0o600 },
    );
    await rename(temporary, target);
  }
  private id(key: AppKey) {
    return `${key.workspaceId}\0${key.projectId}`;
  }
  private entry(key: AppKey) {
    keySchema.parse(key);
    const entry = this.entries.get(this.id(key));
    if (!entry) throw new Error('应用项目未创建');
    return entry;
  }
  async restore(key: AppKey): Promise<AppSnapshot> {
    await this.ensureLoaded();
    return this.get(key);
  }
  get(key: AppKey): AppSnapshot {
    return { ...this.entry(key).snapshot };
  }
  private async ports(args: string[]): Promise<string> {
    if (this.options.ports) return this.options.ports(args);
    const { binary, sandbox } = this.connection.runtimeTarget();
    const result = await exec(binary, ['ports', sandbox, ...args], { timeout: 20000, maxBuffer: 1024 * 1024 });
    return result.stdout;
  }
  private async listPorts() {
    const data: unknown = JSON.parse(await this.ports(['--json']));
    const raw = Array.isArray(data) ? data : z.object({ ports: z.array(z.unknown()) }).parse(data).ports;
    return raw.map((item) =>
      z
        .object({
          host_ip: z.string(),
          host_port: z.coerce.number().int().min(1).max(65535),
          sandbox_port: z.coerce.number().int().min(1).max(65535),
          protocol: z.string(),
        })
        .parse(item),
    );
  }
  private samePort(first: { host_ip: string; host_port: number; sandbox_port: number; protocol: string }, second: Port): boolean {
    return (
      first.host_ip === second.host_ip &&
      first.host_port === second.host_port &&
      first.sandbox_port === second.sandbox_port &&
      first.protocol === second.protocol
    );
  }
  private launch(entry: Entry, operation: 'create' | 'start' | 'export', files?: AppSourceFile[]) {
    const { workspaceId, projectId, appInstanceId } = entry.snapshot;
    entry.log = '';
    entry.readyPort = null;
    entry.readyError = null;
    let stdout = '';
    const child = this.connection.start(
      {
        type: 'start',
        mode: 'codex',
        argv: ['python3', '-u', '-c', helper],
        prompt: JSON.stringify({ operation, workspaceId, projectId, appInstanceId, ...(files ? { files } : {}) }),
      },
      (frame) => {
        if (frame.type === 'output') {
          entry.log = (entry.log + frame.data).slice(-12 * 1024 * 1024);
          if (operation === 'start' && frame.stream === 'stdout') {
            stdout += frame.data;
            const lines = stdout.split('\n');
            stdout = lines.pop() ?? '';
            if (stdout.length > 65536) {
              entry.readyError = '应用就绪回执超过预算';
              stdout = '';
            }
            for (const line of lines) {
              if (!line.startsWith('{')) continue;
              let message: unknown;
              try {
                message = JSON.parse(line);
              } catch {
                continue;
              }
              if (!message || typeof message !== 'object' || !('event' in message) || message.event !== 'app-ready') continue;
              const parsed = z
                .object({
                  event: z.literal('app-ready'),
                  port: z.number().int().min(1).max(65535),
                  identity: z
                    .object({
                      workspaceId: z.literal(workspaceId),
                      environmentId: z.literal('sandbox'),
                      projectId: z.literal(projectId),
                      appInstanceId: z.literal(appInstanceId),
                    })
                    .strict(),
                })
                .strict()
                .safeParse(message);
              if (!parsed.success || entry.readyPort !== null) entry.readyError = '应用就绪端口或身份回执不匹配';
              else {
                entry.readyPort = parsed.data.port;
                entry.snapshot.guestPort = parsed.data.port;
              }
            }
          }
        }
      },
    );
    entry.process = child;
    entry.processExited = false;
    void child.done.then(() => {
      if (entry.process === child) entry.processExited = true;
    });
    entry.snapshot.cleanupConfirmed = false;
    this.options.onSnapshot?.({ ...entry.snapshot });
    return child;
  }
  private async command(entry: Entry, operation: 'create' | 'export', files?: AppSourceFile[]) {
    const child = this.launch(entry, operation, files);
    const timeout = setTimeout(() => {
      entry.cancelled = true;
      void child.close();
    }, 30000);
    try {
      const result = await child.done;
      entry.snapshot.cleanupConfirmed = result.confirmed;
      if (result.confirmed) entry.process = null;
      if (entry.cancelled || result.error || !result.confirmed || result.exitCode !== 0)
        throw new Error(entry.cancelled ? '应用操作已取消或超时' : (result.error ?? entry.log.slice(-4000)));
      const line = entry.log.split('\n').find((line) => line.startsWith('WSL_APP_RESULT:'));
      if (!line) throw new Error('应用操作缺少回执');
      return JSON.parse(line.slice('WSL_APP_RESULT:'.length)) as unknown;
    } finally {
      clearTimeout(timeout);
    }
  }
  async create(input: AppKey & { files: AppSourceFile[] }): Promise<AppSnapshot> {
    await this.ensureLoaded();
    if (this.closing) throw new Error('应用服务正在关闭');
    const { files, ...key } = input;
    keySchema.parse(key);
    validateAppSources(files);
    if (this.entries.has(this.id(key))) throw new Error('应用项目已创建');
    if ([...this.entries.values()].some((entry) => entry.snapshot.projectId === key.projectId)) throw new Error('应用项目已绑定其他空间');
    const entry: Entry = {
      snapshot: {
        ...key,
        environmentId: 'sandbox',
        appInstanceId: null,
        state: 'created',
        url: null,
        guestCwd: `/home/agent/workspace/.wsl-apps/${key.projectId}`,
        guestPort: null,
        error: null,
        cleanupConfirmed: true,
      },
      process: null,
      operation: null,
      cancelled: false,
      port: null,
      portPending: false,
      log: '',
      readyPort: null,
      readyError: null,
      processExited: false,
    };
    this.entries.set(this.id(key), entry);
    entry.operation = (async () => {
      try {
        await this.command(entry, 'create', files);
      } catch (error) {
        entry.snapshot.state = 'failed';
        entry.snapshot.error = String(error);
      }
      return { ...entry.snapshot };
    })();
    try {
      return await entry.operation;
    } finally {
      entry.operation = null;
      await this.persist();
    }
  }
  async start(key: AppKey): Promise<AppSnapshot> {
    await this.ensureLoaded();
    if (this.closing) throw new Error('应用服务正在关闭');
    const entry = this.entry(key);
    if (entry.operation) throw new Error('应用操作进行中');
    if (entry.snapshot.state === 'running') return this.get(key);
    if (!entry.snapshot.cleanupConfirmed || entry.portPending || entry.process) throw new Error('上次应用清理尚未确认');
    if ([...this.entries.values()].some((other) => other !== entry && ['starting', 'running', 'stopping'].includes(other.snapshot.state)))
      throw new Error('首版仅允许一个应用服务运行');
    entry.cancelled = false;
    entry.snapshot = { ...entry.snapshot, appInstanceId: randomUUID(), state: 'starting', error: null, url: null, guestPort: null };
    entry.operation = this.persist().then(() => this.startEntry(entry));
    try {
      return await entry.operation;
    } finally {
      entry.operation = null;
      await this.persist();
    }
  }
  private async importDependencies(entry: Entry, archivePath: string): Promise<void> {
    const { binary, sandbox } = this.connection.runtimeTarget();
    const manifest = z
      .object({
        archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
        lockSha256: z.string().regex(/^[a-f0-9]{64}$/),
        platform: z.literal('linux'),
        arch: z.literal('arm64'),
      })
      .strict()
      .parse(
        this.options.dependencyManifest
          ? {
              archiveSha256: this.options.dependencyManifest.archiveSha256,
              lockSha256: this.options.dependencyManifest.lockSha256,
              platform: this.options.dependencyManifest.platform,
              arch: this.options.dependencyManifest.arch,
            }
          : JSON.parse(await readFile(`${archivePath}.json`, 'utf8')),
      );
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
    if (entry.cancelled) throw new Error('应用启动已取消');
    const archiveSha256 = hash.digest('hex');
    if (archiveSha256 !== manifest.archiveSha256) throw new Error('离线依赖归档与清单哈希不符');
    const request = JSON.stringify({
      operation: 'dependencies',
      workspaceId: entry.snapshot.workspaceId,
      projectId: entry.snapshot.projectId,
      sha256: archiveSha256,
      lockSha256: manifest.lockSha256,
      platform: manifest.platform,
      arch: manifest.arch,
    });
    const child = spawn(binary, ['exec', '-i', '-w', '/home/agent/workspace', sandbox, 'python3', '-u', '-c', helper, request], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stream = createReadStream(archivePath);
    let output = '';
    let error = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4096);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      error = (error + chunk.toString()).slice(-4096);
    });
    child.stdin.on('error', (failure: NodeJS.ErrnoException) => {
      if (failure.code !== 'EPIPE') error = failure.message;
    });
    stream.on('error', (failure) => {
      error = failure.message;
      child.stdin.end();
    });
    // Closing stdin is the only cancellation action: this helper has no children
    // and must finish its bounded hash check before cleanup can be confirmed.
    const interval = setInterval(() => {
      if (entry.cancelled) {
        stream.destroy();
        child.stdin.end();
      }
    }, 100);
    const timer = setTimeout(() => {
      error = '依赖导入回执超时，需核对沙箱';
      child.kill('SIGKILL');
    }, 60000);
    entry.snapshot.cleanupConfirmed = false;
    try {
      const done = new Promise<number | null>((resolve, reject) => {
        child.once('close', resolve);
        child.once('error', reject);
      });
      stream.pipe(child.stdin);
      this.options.onSnapshot?.({ ...entry.snapshot });
      const code = await done;
      entry.snapshot.cleanupConfirmed = output.split('\n').includes('WSL_APP_RESULT:{"dependenciesCleanup":true}');
      if (code !== 0 || !output.includes('"dependenciesImported":true') || !entry.snapshot.cleanupConfirmed)
        throw new Error(entry.cancelled ? '应用启动已取消或超时（依赖导入已结束）' : error || '依赖归档导入未确认');
      entry.snapshot.cleanupConfirmed = true;
    } finally {
      clearTimeout(timer);
      clearInterval(interval);
      stream.destroy();
      child.stdin.end();
    }
  }
  private async startEntry(entry: Entry): Promise<AppSnapshot> {
    const deadline = Date.now() + (this.options.startupTimeoutMs ?? 240000);
    const check = () => {
      if (Date.now() >= deadline) throw new Error('应用启动超时');
      if (entry.cancelled) throw new Error('应用启动已取消');
    };
    const timer = setTimeout(
      () => {
        entry.cancelled = true;
      },
      Math.max(1, deadline - Date.now()),
    );
    try {
      check();
      if (this.options.dependencyArchivePath && !entry.snapshot.appInstanceId) throw new Error('缺少应用实例身份');
      if (this.options.dependencyArchivePath) await this.importDependencies(entry, this.options.dependencyArchivePath);
      check();
      const child = this.launch(entry, 'start');
      let exited = false;
      void child.done.then(() => {
        exited = true;
      });
      while (entry.readyPort === null) {
        check();
        if (entry.readyError) throw new Error(entry.readyError);
        if (exited) throw new Error(`应用就绪前退出：${entry.log.slice(-4000)}`);
        await delay(50);
      }
      check();
      if (entry.readyError) throw new Error(entry.readyError);
      const guestPort = entry.readyPort;
      if ((await this.listPorts()).some((port) => port.sandbox_port === guestPort)) throw new Error('应用实际端口已有未知映射');
      check();
      // Register uncertain publication before asking sandboxd to mutate bindings.
      entry.portPending = true;
      const receipt = await this.ports(['--publish', `${guestPort}/tcp4`]);
      const published = /^Published 127\.0\.0\.1:(\d+) -> (\d+)\/tcp4\s*$/m.exec(receipt);
      if (!published || Number(published[2]) !== guestPort) throw new Error('端口发布回执未知，不能推断映射所有权');
      entry.port = portSchema.parse({ host_ip: '127.0.0.1', host_port: Number(published[1]), sandbox_port: guestPort, protocol: 'tcp4' });
      check();
      const ports = await this.listPorts();
      const ownedPort = entry.port;
      if (!ports.some((port) => this.samePort(port, ownedPort))) throw new Error('映射核对与发布回执不同');
      const url = `http://127.0.0.1:${entry.port.host_port}`;
      while (true) {
        check();
        if (exited) throw new Error(`应用启动进程退出：${entry.log.slice(-4000)}`);
        try {
          const response = await (this.options.fetch ?? fetch)(`${url}/api/health`, {
            signal: AbortSignal.timeout(1500),
            redirect: 'error',
          });
          if (response.ok) {
            const health = z
              .object({
                ok: z.literal(true),
                templateId: z.literal('wsl-standard-app'),
                templateVersion: z.literal('1.0.0'),
                identity: z
                  .object({
                    workspaceId: z.literal(entry.snapshot.workspaceId),
                    environmentId: z.literal('sandbox'),
                    projectId: z.literal(entry.snapshot.projectId),
                    appInstanceId: z.literal(entry.snapshot.appInstanceId),
                  })
                  .strict(),
              })
              .parse(await response.json());
            if (health.ok) break;
          }
        } catch (error) {
          // Identity/schema failures are final, unlike a not-yet-listening socket.
          if (error instanceof z.ZodError) throw new Error('应用健康身份不匹配', { cause: error });
        }
        await delay(200);
      }
      check();
      entry.snapshot.state = 'running';
      entry.snapshot.url = url;
      void child.done.then(async (outcome) => {
        if (entry.process !== child || entry.snapshot.state !== 'running') return;
        entry.snapshot.state = 'failed';
        entry.snapshot.error = outcome.error ?? `应用进程意外退出（${outcome.exitCode}）`;
        await this.cleanup(entry);
        await this.persist();
        this.options.onSnapshot?.({ ...entry.snapshot });
      });
    } catch (error) {
      entry.snapshot.error = String(error);
      await this.cleanup(entry);
      entry.snapshot.state = 'failed';
    } finally {
      clearTimeout(timer);
    }
    return { ...entry.snapshot };
  }
  private async cleanup(entry: Entry): Promise<void> {
    entry.snapshot.url = null;
    let confirmed = entry.process !== null || entry.snapshot.cleanupConfirmed;
    // Keep the guest session alive while removing its published mapping. Closing
    // the last session first can stop/restart the VM and rebind an ephemeral port.
    if (entry.portPending) {
      try {
        const ownedPort = entry.port;
        if (!ownedPort) throw new Error('映射发布结果未知，不能清理未归属端口');
        if (entry.processExited) throw new Error('guest进程已退出，沙箱映射连续性未知；不触碰可能重绑定的端口');
        const before = await this.listPorts();
        const matches = before.filter((port) => port.sandbox_port === ownedPort.sandbox_port);
        if (matches.length > 1) throw new Error('所属端口映射重复，清理状态未知');
        if (matches.length !== 1 || !this.samePort(matches[0]!, ownedPort)) throw new Error('所属端口映射已变化或丢失，清理状态未知');
        // Remove the original persistent request, not only its current ephemeral host binding.
        // sbx's resolved host:guest form leaves the request alive across an idle VM restart.
        await this.ports(['--unpublish', `${ownedPort.sandbox_port}/${ownedPort.protocol}`]);
        if ((await this.listPorts()).some((port) => port.sandbox_port === ownedPort.sandbox_port))
          throw new Error('应用端口仍有映射，清理未确认');
        entry.port = null;
        entry.portPending = false;
      } catch (error) {
        confirmed = false;
        entry.snapshot.error = [entry.snapshot.error, String(error)].filter(Boolean).join('; ');
      }
    }
    if (entry.process) {
      const outcome = await entry.process.close();
      confirmed = confirmed && outcome.confirmed;
      if (outcome.confirmed) entry.process = null;
      if (!outcome.confirmed)
        entry.snapshot.error = [entry.snapshot.error, outcome.error ?? '应用进程清理未确认'].filter(Boolean).join('; ');
    }
    entry.snapshot.cleanupConfirmed = confirmed;
  }
  async stop(key: AppKey): Promise<AppSnapshot> {
    await this.ensureLoaded();
    const entry = this.entry(key);
    entry.cancelled = true;
    entry.snapshot.state = 'stopping';
    if (entry.operation) await entry.operation;
    await this.cleanup(entry);
    entry.snapshot.state = entry.snapshot.cleanupConfirmed ? 'stopped' : 'failed';
    await this.persist();
    this.options.onSnapshot?.({ ...entry.snapshot });
    return { ...entry.snapshot };
  }
  async export(key: AppKey): Promise<{ files: AppSourceFile[]; sha256: string }> {
    await this.ensureLoaded();
    const entry = this.entry(key);
    if (entry.operation || entry.process || !entry.snapshot.cleanupConfirmed) throw new Error('请先停止应用并确认清理，再导出源码');
    entry.cancelled = false;
    let result: { files: AppSourceFile[] } | undefined;
    entry.operation = (async () => {
      result = z.object({ files: z.array(fileSchema) }).parse(await this.command(entry, 'export'));
      validateAppSources(result.files);
      return { ...entry.snapshot };
    })();
    try {
      await entry.operation;
      if (!result) throw new Error('缺少源码导出回执');
      return { files: result.files, sha256: createHash('sha256').update(JSON.stringify(result.files)).digest('hex') };
    } finally {
      entry.operation = null;
      await this.persist();
    }
  }
  async shutdown(): Promise<void> {
    await this.ensureLoaded();
    this.closing = true;
    for (const entry of this.entries.values()) {
      await this.stop({ workspaceId: entry.snapshot.workspaceId, projectId: entry.snapshot.projectId });
      if (!entry.snapshot.cleanupConfirmed) throw new Error(entry.snapshot.error ?? '应用清理未确认');
    }
  }
}
