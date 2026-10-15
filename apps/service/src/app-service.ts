import type { EduVerificationLease } from '@wsl/protocol';
import { ASSESSMENT_PREFIX, MAX_ASSESSMENT_FRAME } from './edu-assessment';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  AgentCliEnvelopeSchema,
  AppOperationReceiptSchema,
  type AgentCliEnvelope,
  type AppAgentOperation,
  type AppAgentResult,
  type AppLogs,
  AppProfileSchema,
  EduSourceSchema,
  EDU_REQUIRED_FILES,
  isEduSourcePath,
  type AppProfile,
  type AppSource,
  type EduSource,
  type EduTaskBinding,
} from '@wsl/protocol';
import { type GuestProcess, type SbxConnection } from './sbx';
import rawHelper from './app-helper.py?raw';
import ownedProcess from './edu-owned-process.py?raw';
const helper = rawHelper.replace('OWNED_PROCESS_BASE64 = ""', `OWNED_PROCESS_BASE64 = "${Buffer.from(ownedProcess).toString('base64')}"`);
import { assertEduTaskSource, assertEduTaskCandidate, eduTaskMetadata } from './edu-task';
import type { GuestWorkspace } from './sbx';

const exec = promisify(execFile);
const keySchema = z
  .object({ workspaceId: z.string().min(1).max(128), projectId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/) })
  .strict();
const fileSchema = z.object({ path: z.string().min(1).max(512), base64: z.string() }).strict();
export type AppKey = z.infer<typeof keySchema>;
export type AppSourceFile = z.infer<typeof fileSchema>;
export interface AppSnapshot extends AppKey {
  profile: AppProfile;
  sourceSha256?: string;
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
  process: (Pick<GuestProcess, 'done' | 'close'> & Partial<Pick<GuestProcess, 'write' | 'closeInput'>>) | null;
  operation: Promise<AppSnapshot> | null;
  commandProcess: Pick<GuestProcess, 'done' | 'close'> | null;
  stopping: Promise<AppSnapshot> | null;
  cancelled: boolean;
  port: Port | null;
  portPending: boolean;
  log: string;
  readyPort: number | null;
  readyError: string | null;
  processExited: boolean;
  /** 每次启动随机生成，仅经 guest 进程环境传给受管开发实例的 /api/__agent；停止即作废。 */
  agentToken: string | null;
  agentProcess: Pick<GuestProcess, 'done' | 'close'> | null;
  recoveryInstanceId?: string | null;
  recoveryUrl?: string | null;
  processExpected?: boolean;
  portRemovalPending?: boolean;
  agentAdmission?: Promise<void>;
  httpOperation: { operationId: string; operation: 'seed' | 'reset'; appInstanceId: string } | null;
}
export interface AppServiceOptions {
  /** Trusted service wiring, never populated from renderer input. */
  ports?: (args: string[]) => Promise<string>;
  fetch?: typeof fetch;
  startupTimeoutMs?: number;
  reconciliationTimeoutMs?: number;
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

function validateEduSources(files: AppSourceFile[], baseline: EduSource, importing: boolean): string {
  validateAppSources(files);
  const current = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((file) => {
      if (!isEduSourcePath(file.path)) throw new Error('不支持的 edu 源码路径');
      const bytes = Buffer.from(file.base64, 'base64');
      return { path: file.path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    });
  for (const name of EDU_REQUIRED_FILES) if (!current.some((file) => file.path === name)) throw new Error('edu 工程缺少必需源码：' + name);
  const digest = createHash('sha256').update(JSON.stringify(current)).digest('hex');
  if (importing && (digest !== baseline.sourceSha256 || JSON.stringify(current) !== JSON.stringify(baseline.files)))
    throw new Error('edu 源码与来源散列不匹配');
  const protectedFiles = (metadata: EduSource['files']) => metadata.filter((file) => !file.path.startsWith('admin/src/'));
  if (!importing && JSON.stringify(protectedFiles(current)) !== JSON.stringify(protectedFiles(baseline.files)))
    throw new Error('edu 后端或锁文件变化，需要显式重新导入来源');
  return digest;
}

const standardProfile: AppProfile = { projectKind: 'standard-app', profileVersion: 1 };
const registryApp = keySchema.extend({
  cleanupConfirmed: z.boolean(),
  state: z.enum(['created', 'starting', 'running', 'stopping', 'stopped', 'failed']),
});
const registrySchema = z.discriminatedUnion('version', [
  z
    .object({
      version: z.literal(3),
      sandbox: z.string().min(1),
      apps: z.array(
        registryApp.extend({
          profile: AppProfileSchema,
          sourceSha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
          appInstanceId: z.string().uuid().nullable(),
          url: z.string().nullable(),
          guestPort: z.number().int().min(1).max(65535).nullable(),
          portPending: z.boolean(),
          portRemovalPending: z.boolean(),
          port: portSchema.nullable(),
          processExpected: z.boolean(),
        }),
      ),
    })
    .strict(),
  z.object({ version: z.literal(1), sandbox: z.string().min(1), apps: z.array(registryApp) }).strict(),
  z
    .object({
      version: z.literal(2),
      sandbox: z.string().min(1),
      apps: z.array(
        registryApp.extend({
          profile: AppProfileSchema,
          sourceSha256: z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .optional(),
        }),
      ),
    })
    .strict(),
]);

/** One project service owner, independent of Codex task completion. */
export class AppService {
  private entries = new Map<string, Entry>();
  private closing = false;
  private verification = new Map<string, { lease: EduVerificationLease; request: (line: string) => void; fail: () => void }>();
  private persistence: Promise<void> = Promise.resolve();
  private options: AppServiceOptions;
  private loaded: Promise<void> | null = null;
  private registrySandbox: string | null = null;
  private legacyRegistry: string | null = null;
  constructor(
    private connection: Pick<SbxConnection, 'getStatus' | 'runtimeTarget'> & {
      start: (...args: Parameters<SbxConnection['start']>) => Pick<GuestProcess, 'done' | 'close'>;
    },
    options: AppServiceOptions = {},
  ) {
    this.options = options;
  }
  private ensureLoaded(): Promise<void> {
    return (this.loaded ??= this.load().catch((error: unknown) => {
      this.loaded = null;
      throw new Error(`应用注册表读取失败（${this.options.registryPath}）：${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }));
  }
  private async load(): Promise<void> {
    if (!this.options.registryPath) return;
    let contents: string;
    try {
      contents = await readFile(this.options.registryPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const registry = registrySchema.parse(JSON.parse(contents));
    if (registry.sandbox !== this.connection.getStatus().sandbox) throw new Error('应用注册表沙箱身份不匹配');
    if (new Set(registry.apps.map((item) => item.projectId)).size !== registry.apps.length) throw new Error('应用注册表包含重复项目身份');
    this.registrySandbox = registry.sandbox;
    this.legacyRegistry = registry.version === 1 ? contents : null;
    // Registry restores source ownership only. No process or port is replayed.
    for (const saved of registry.apps) {
      const key = { workspaceId: saved.workspaceId, projectId: saved.projectId };
      const confirmed = saved.cleanupConfirmed && !['running', 'starting', 'stopping'].includes(saved.state);
      this.entries.set(this.id(key), {
        snapshot: {
          ...key,
          profile: 'profile' in saved ? saved.profile : { ...standardProfile },
          ...('sourceSha256' in saved ? { sourceSha256: saved.sourceSha256 } : {}),
          environmentId: 'sandbox',
          appInstanceId: null,
          state: confirmed ? 'stopped' : 'failed',
          url: null,
          guestCwd: `/home/agent/workspace/.wsl-apps/${key.projectId}`,
          guestPort: 'guestPort' in saved && !confirmed ? saved.guestPort : null,
          error: confirmed ? null : '上次运行中断，需核对沙箱进程与端口',
          cleanupConfirmed: confirmed,
        },
        recoveryInstanceId: 'appInstanceId' in saved ? saved.appInstanceId : null,
        recoveryUrl: 'url' in saved ? saved.url : null,
        processExpected: 'processExpected' in saved ? saved.processExpected : false,
        portRemovalPending: 'portRemovalPending' in saved ? saved.portRemovalPending : false,
        process: null,
        operation: null,
        commandProcess: null,
        stopping: null,
        cancelled: false,
        port: 'port' in saved ? saved.port : null,
        portPending: 'portPending' in saved ? saved.portPending : false,
        log: '',
        readyPort: null,
        readyError: null,
        processExited: false,
        agentToken: null,
        agentProcess: null,
        httpOperation: null,
      });
    }
  }
  private persist(): Promise<void> {
    if (!this.options.registryPath) return Promise.resolve();
    const target = this.options.registryPath;
    // Capture in invocation order, then publish in that order across all projects.
    const contents = JSON.stringify({
      version: 3,
      sandbox: z.string().min(1).parse(this.registrySandbox),
      apps: [...this.entries.values()].map(
        ({ snapshot, recoveryInstanceId, recoveryUrl, port, portPending, processExpected, portRemovalPending }) => ({
          workspaceId: snapshot.workspaceId,
          projectId: snapshot.projectId,
          state: snapshot.state,
          cleanupConfirmed: snapshot.cleanupConfirmed,
          profile: snapshot.profile,
          sourceSha256: snapshot.sourceSha256,
          appInstanceId: snapshot.appInstanceId ?? recoveryInstanceId ?? null,
          url: snapshot.url ?? recoveryUrl ?? null,
          guestPort: snapshot.guestPort,
          port,
          portPending,
          portRemovalPending: portRemovalPending ?? false,
          processExpected: processExpected ?? false,
        }),
      ),
    });
    const legacy = this.legacyRegistry;
    const saving = this.persistence.then(async () => {
      await mkdir(path.dirname(target), { recursive: true });
      if (legacy !== null) {
        const backup = target + '.schema-v1.json';
        try {
          await writeFile(backup, legacy, { flag: 'wx', mode: 0o400 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || (await readFile(backup, 'utf8')) !== legacy) throw error;
        }
      }
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, contents, { mode: 0o600 });
      await rename(temporary, target);
      this.legacyRegistry = null;
    });
    // A failed publication rejects its owner without poisoning later cleanup writes.
    this.persistence = saving.then(
      () => undefined,
      () => undefined,
    );
    return saving;
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
    return structuredClone(this.entry(key).snapshot);
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
  private launch(entry: Entry, operation: 'create' | 'start' | 'export' | 'apply-task', files?: AppSourceFile[], task?: EduTaskBinding) {
    const { workspaceId, projectId, appInstanceId } = entry.snapshot;
    entry.log = '';
    entry.readyPort = null;
    entry.readyError = null;
    let stdout = '';
    let sourceSeen = false;
    const verification = operation === 'start' ? this.verification.get(this.id(entry.snapshot)) : undefined;
    const child = this.connection.start(
      {
        ...(operation === 'start' && entry.snapshot.profile.projectKind === 'edu-web'
          ? {
              eduOwner: {
                identity: { workspaceId, projectId, environmentId: 'sandbox' as const, appInstanceId: appInstanceId! },
                sourceSha256: entry.snapshot.sourceSha256 ?? entry.snapshot.profile.source.sourceSha256,
              },
            }
          : {}),
        type: 'start',
        mode: 'codex',
        argv: ['python3', '-u', '-c', helper],
        ...(verification ? { duplex: true } : {}),
        prompt:
          JSON.stringify({
            operation,
            ...(verification ? { verification: verification.lease } : {}),
            workspaceId,
            projectId,
            appInstanceId,
            profile: entry.snapshot.profile,
            ...(files ? { files } : {}),
            ...(task ? { task } : {}),
            ...(operation === 'start' && entry.agentToken ? { agentToken: entry.agentToken } : {}),
          }) + (verification ? '\n' : ''),
      },
      (frame) => {
        if (frame.type === 'output') {
          if (!verification) entry.log = (entry.log + frame.data).slice(-12 * 1024 * 1024);
          if (operation === 'start' && frame.stream === 'stdout') {
            stdout += frame.data;
            const lines = stdout.split('\n');
            stdout = lines.pop() ?? '';
            const frameBudget =
              verification && (stdout.startsWith(ASSESSMENT_PREFIX) || ASSESSMENT_PREFIX.startsWith(stdout)) ? MAX_ASSESSMENT_FRAME : 65536;
            if (Buffer.byteLength(stdout) > frameBudget) {
              verification?.fail();
              entry.readyError = '应用就绪回执超过预算';
              stdout = '';
            }
            for (const line of lines) {
              if (!line.startsWith(ASSESSMENT_PREFIX) && Buffer.byteLength(line) > 65536) {
                entry.readyError = '应用就绪回执超过预算';
                verification?.fail();
                continue;
              }
              if (verification && line.startsWith(ASSESSMENT_PREFIX)) {
                if (entry.readyPort === null || Buffer.byteLength(line + '\n') > MAX_ASSESSMENT_FRAME) verification.fail();
                else verification.request(line + '\n');
                continue;
              }
              if (verification && (line.startsWith('WSL_EDU') || entry.readyPort !== null)) {
                verification.fail();
                continue;
              }
              if (line.startsWith('WSL_APP_SOURCE:')) {
                const digest = line.slice('WSL_APP_SOURCE:'.length);
                if (entry.snapshot.profile.projectKind !== 'edu-web' || sourceSeen || !/^[a-f0-9]{64}$/.test(digest))
                  entry.readyError = '应用源码回执无效';
                else {
                  if (verification && digest !== verification.lease.sourceSha256) {
                    verification.fail();
                    entry.readyError = 'verification_source_mismatch';
                    continue;
                  }
                  entry.snapshot.sourceSha256 = digest;
                  sourceSeen = true;
                }
                continue;
              }
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
              if (!parsed.success || entry.readyPort !== null || (entry.snapshot.profile.projectKind === 'edu-web' && !sourceSeen))
                entry.readyError = '应用就绪端口、身份或源码回执不匹配';
              else {
                entry.readyPort = parsed.data.port;
                entry.snapshot.guestPort = parsed.data.port;
              }
            }
          }
        }
      },
    );
    if (!entry.process) {
      entry.process = child;
      entry.processExited = false;
      void child.done.then(() => {
        if (entry.process === child) {
          entry.processExited = true;
          verification?.fail();
        }
      });
      entry.snapshot.cleanupConfirmed = false;
    }
    // Applying source does not change the running app's ownership/state. Publishing
    // its old source here would queue a rollback behind the committed RPC receipt.
    if (operation !== 'apply-task') this.options.onSnapshot?.(structuredClone(entry.snapshot));
    return child;
  }
  private async command(entry: Entry, operation: 'create' | 'export' | 'apply-task', files?: AppSourceFile[], task?: EduTaskBinding) {
    const activeProcess = entry.process;
    const cleanupConfirmed = entry.snapshot.cleanupConfirmed;
    const child = this.launch(entry, operation, files, task);
    entry.commandProcess = child;
    const timeout = setTimeout(() => {
      entry.cancelled = true;
      void child.close();
    }, 30000);
    try {
      const result = await child.done;
      if (!activeProcess) entry.snapshot.cleanupConfirmed = result.confirmed;
      if (result.confirmed && entry.process === child) entry.process = null;
      if (entry.cancelled || result.error || !result.confirmed || result.exitCode !== 0)
        throw new Error(entry.cancelled ? '应用操作已取消或超时' : (result.error ?? entry.log.slice(-4000)));
      const line = entry.log.split('\n').find((line) => line.startsWith('WSL_APP_RESULT:'));
      if (!line) throw new Error('应用操作缺少回执');
      return JSON.parse(line.slice('WSL_APP_RESULT:'.length)) as unknown;
    } finally {
      clearTimeout(timeout);
      entry.commandProcess = null;
      if (activeProcess) {
        entry.snapshot.cleanupConfirmed = cleanupConfirmed;
      }
    }
  }
  async create(input: AppKey & { files: AppSourceFile[] }): Promise<AppSnapshot> {
    return this.createProject(input, { ...standardProfile });
  }
  async importEdu(input: AppKey & { files: AppSourceFile[]; source: EduSource }): Promise<AppSnapshot> {
    const { source: supplied, ...project } = input;
    const source = EduSourceSchema.parse(supplied);
    validateEduSources(project.files, source, true);
    return this.createProject(project, { projectKind: 'edu-web', profileVersion: 1, source });
  }
  private async createProject(input: AppKey & { files: AppSourceFile[] }, profile: AppProfile): Promise<AppSnapshot> {
    await this.ensureLoaded();
    if (this.closing) throw new Error('应用服务正在关闭');
    const sandbox = this.connection.getStatus().sandbox;
    if (!sandbox) throw new Error('应用沙箱身份未初始化');
    if (this.registrySandbox && this.registrySandbox !== sandbox) throw new Error('应用注册表沙箱身份不匹配');
    this.registrySandbox = sandbox;
    const { files, ...key } = input;
    keySchema.parse(key);
    validateAppSources(files);
    if (this.entries.has(this.id(key))) throw new Error('应用项目已创建');
    if ([...this.entries.values()].some((entry) => entry.snapshot.projectId === key.projectId)) throw new Error('应用项目已绑定其他空间');
    const entry: Entry = {
      snapshot: {
        ...key,
        profile: structuredClone(profile),
        ...(profile.projectKind === 'edu-web' ? { sourceSha256: profile.source.sourceSha256 } : {}),
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
      commandProcess: null,
      stopping: null,
      cancelled: false,
      port: null,
      portPending: false,
      log: '',
      readyPort: null,
      readyError: null,
      processExited: false,
      agentToken: null,
      agentProcess: null,
      httpOperation: null,
    };
    this.entries.set(this.id(key), entry);
    entry.operation = (async () => {
      try {
        await this.command(entry, 'create', files);
      } catch (error) {
        entry.snapshot.state = 'failed';
        entry.snapshot.error = String(error);
      }
      await this.persist();
      return structuredClone(entry.snapshot);
    })();
    try {
      return await entry.operation;
    } finally {
      entry.operation = null;
    }
  }
  async start(
    key: AppKey,
    verification?: { lease: EduVerificationLease; request: (line: string) => void; fail: () => void },
    reservedInstanceId?: string,
  ): Promise<AppSnapshot> {
    await this.ensureLoaded();
    if (this.closing) throw new Error('应用服务正在关闭');
    const entry = this.entry(key);
    if (entry.operation || entry.stopping) throw new Error('应用操作进行中');
    if (entry.agentProcess || entry.httpOperation) throw new Error('应用控制面操作或结果待确认');
    if (entry.snapshot.state === 'running') return this.get(key);
    if (!entry.snapshot.cleanupConfirmed || entry.portPending || entry.process) throw new Error('上次应用清理尚未确认');
    if ([...this.entries.values()].some((other) => other !== entry && ['starting', 'running', 'stopping'].includes(other.snapshot.state)))
      throw new Error('首版仅允许一个应用服务运行');
    entry.cancelled = false;
    entry.agentToken = entry.snapshot.profile.projectKind === 'edu-web' ? null : randomBytes(32).toString('hex');
    entry.snapshot = {
      ...entry.snapshot,
      appInstanceId:
        verification?.lease.identity.appInstanceId ?? (reservedInstanceId ? z.string().uuid().parse(reservedInstanceId) : randomUUID()),
      state: 'starting',
      error: null,
      url: null,
      guestPort: null,
    };
    entry.recoveryInstanceId = entry.snapshot.appInstanceId;
    entry.recoveryUrl = null;
    entry.processExpected = true;
    if (verification) this.verification.set(this.id(key), verification);
    else this.verification.delete(this.id(key));
    entry.operation = (async () => {
      try {
        await this.persist();
        return await this.startEntry(entry);
      } finally {
        await this.persist();
      }
    })();
    let result: AppSnapshot;
    try {
      result = await entry.operation;
    } finally {
      entry.operation = null;
    }
    // The operation's final persist must succeed before publishing completion.
    // A concurrent stop/exit may supersede the captured startup result meanwhile.
    if (
      entry.snapshot.appInstanceId === result.appInstanceId &&
      entry.snapshot.state === result.state &&
      ['running', 'failed'].includes(result.state)
    )
      this.options.onSnapshot?.(structuredClone(entry.snapshot));
    return result;
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
      this.options.onSnapshot?.(structuredClone(entry.snapshot));
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
      if (this.options.dependencyArchivePath && entry.snapshot.profile.projectKind === 'standard-app')
        await this.importDependencies(entry, this.options.dependencyArchivePath);
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
      await this.persist();
      const receipt = await this.ports(['--publish', `${guestPort}/tcp4`]);
      const published = /^Published 127\.0\.0\.1:(\d+) -> (\d+)\/tcp4\s*$/m.exec(receipt);
      if (!published || Number(published[2]) !== guestPort) throw new Error('端口发布回执未知，不能推断映射所有权');
      entry.port = portSchema.parse({ host_ip: '127.0.0.1', host_port: Number(published[1]), sandbox_port: guestPort, protocol: 'tcp4' });
      entry.recoveryUrl = `http://127.0.0.1:${entry.port.host_port}`;
      await this.persist();
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
                templateId: z.literal(entry.snapshot.profile.projectKind === 'edu-web' ? 'edu-web' : 'wsl-standard-app'),
                templateVersion: entry.snapshot.profile.projectKind === 'edu-web' ? z.literal('1.0.0') : z.enum(['1.0.0', '1.1.0']),
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
        this.options.onSnapshot?.(structuredClone(entry.snapshot));
      });
    } catch (error) {
      entry.snapshot.error = String(error);
      await this.cleanup(entry);
      entry.snapshot.state = 'failed';
    } finally {
      clearTimeout(timer);
    }
    return structuredClone(entry.snapshot);
  }
  private async cleanup(entry: Entry): Promise<void> {
    entry.snapshot.url = null;
    entry.agentToken = null;
    let confirmed = entry.process !== null || entry.snapshot.cleanupConfirmed || entry.agentProcess !== null;
    let agentConfirmed = entry.agentProcess === null;
    if (entry.agentProcess) {
      try {
        const outcome = await entry.agentProcess.close();
        agentConfirmed = outcome.confirmed;
        if (outcome.confirmed) entry.agentProcess = null;
        else entry.snapshot.error = [entry.snapshot.error, outcome.error ?? 'agent-cli 清理未确认'].filter(Boolean).join('; ');
      } catch (error) {
        entry.snapshot.error = [entry.snapshot.error, String(error)].filter(Boolean).join('; ');
      }
    }
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
        entry.portRemovalPending = true;
        await this.persist();
        await this.ports(['--unpublish', `${ownedPort.sandbox_port}/${ownedPort.protocol}`]);
        if ((await this.listPorts()).some((port) => port.sandbox_port === ownedPort.sandbox_port))
          throw new Error('应用端口仍有映射，清理未确认');
        entry.port = null;
        entry.portPending = false;
        entry.portRemovalPending = false;
      } catch (error) {
        confirmed = false;
        entry.snapshot.error = [entry.snapshot.error, String(error)].filter(Boolean).join('; ');
      }
    }
    if (entry.process) {
      try {
        const outcome = await entry.process.close();
        confirmed = confirmed && outcome.confirmed;
        if (outcome.confirmed) entry.process = null;
        if (!outcome.confirmed)
          entry.snapshot.error = [entry.snapshot.error, outcome.error ?? '应用进程清理未确认'].filter(Boolean).join('; ');
      } catch (error) {
        confirmed = false;
        entry.snapshot.error = [entry.snapshot.error, String(error)].filter(Boolean).join('; ');
      }
    }
    entry.snapshot.cleanupConfirmed = confirmed && agentConfirmed;
    if (entry.snapshot.cleanupConfirmed) {
      entry.processExpected = false;
      entry.recoveryUrl = null;
    }
    if (entry.snapshot.cleanupConfirmed) entry.httpOperation = null;
  }
  async inspectRecovery(key: AppKey): Promise<{
    appInstanceId: string | null;
    sourceSha256: string | undefined;
    url: string | null;
    processExpected: boolean;
    cleanupConfirmed: boolean;
    portPending: boolean;
    port: Port | null;
  }> {
    await this.ensureLoaded();
    const entry = this.entry(key);
    return {
      appInstanceId: entry.snapshot.appInstanceId ?? entry.recoveryInstanceId ?? null,
      sourceSha256: entry.snapshot.sourceSha256,
      url: entry.snapshot.url ?? entry.recoveryUrl ?? null,
      processExpected: entry.processExpected ?? false,
      cleanupConfirmed: entry.snapshot.cleanupConfirmed,
      portPending: entry.portPending,
      port: entry.port ? structuredClone(entry.port) : null,
    };
  }
  async captureRecoverySource(key: AppKey, fromStop = false): Promise<string> {
    await this.ensureLoaded();
    const entry = this.entry(key);
    if (entry.snapshot.profile.projectKind !== 'edu-web' || entry.operation || (entry.stopping && !fromStop))
      throw new Error('verification_recovery_app_busy');
    const confirmed = entry.snapshot.cleanupConfirmed;
    const cancelled = entry.cancelled;
    entry.cancelled = false;
    try {
      const result = z
        .object({ files: z.array(fileSchema) })
        .strict()
        .parse(await this.command(entry, 'export'));
      return validateEduSources(result.files, entry.snapshot.profile.source, false);
    } finally {
      entry.snapshot.cleanupConfirmed = confirmed;
      entry.cancelled = cancelled;
    }
  }
  async recoverOwned(key: AppKey, appInstanceId: string, sourceSha256: string, fromStop = false): Promise<AppSnapshot> {
    await this.ensureLoaded();
    const entry = this.entry(key);
    const before = await this.inspectRecovery(key);
    if (
      before.appInstanceId !== appInstanceId ||
      before.sourceSha256 !== sourceSha256 ||
      entry.snapshot.profile.projectKind !== 'edu-web' ||
      entry.process ||
      entry.operation ||
      (entry.stopping && !fromStop)
    )
      throw new Error('verification_recovery_identity_mismatch');
    if (entry.portPending && !entry.port) throw new Error('verification_recovery_publish_unknown');
    if (!entry.processExpected) {
      if (!entry.snapshot.cleanupConfirmed || entry.portPending) throw new Error('verification_recovery_cleanup_unknown');
      return structuredClone(entry.snapshot);
    }
    let output = '',
      failure = false;
    const child = this.connection.start(
      {
        type: 'start',
        mode: 'codex',
        duplex: true,
        argv: ['python3', '-u', '-c', helper],
        prompt:
          JSON.stringify({
            operation: 'recover-owned',
            ...key,
            appInstanceId,
            profile: entry.snapshot.profile,
            owner: { identity: { ...key, environmentId: 'sandbox', appInstanceId }, sourceSha256 },
          }) + '\n',
      },
      (frame) => {
        if (frame.type === 'output' && frame.stream === 'stdout') {
          output += frame.data;
          if (Buffer.byteLength(output) > 1048576) failure = true;
        }
        if (frame.type === 'error') failure = true;
      },
    );
    let exited = false;
    void child.done.then(() => {
      exited = true;
    });
    try {
      const deadline = Date.now() + 12000;
      let line: string | undefined;
      while (!(line = output.split('\n').find((line) => line.startsWith('WSL_APP_RESULT:')))) {
        if (failure || exited || Date.now() > deadline) throw new Error('verification_recovery_guest_unconfirmed');
        await delay(25);
      }
      const checkKeeper = () => {
        if (exited || failure) throw new Error('verification_recovery_keeper_lost');
      };
      checkKeeper();
      const identity = z.object({ ...keySchema.shape, environmentId: z.literal('sandbox'), appInstanceId: z.string().uuid() }).strict();
      const pid = z.object({ pid: z.number().int().positive(), startTicks: z.string().regex(/^\d+$/) }).strict();
      const raw: unknown = JSON.parse(line.slice('WSL_APP_RESULT:'.length));
      if (raw && typeof raw === 'object' && 'recoveryError' in raw) {
        const code = z
          .object({
            recoveryError: z.enum([
              'verification_recovery_receipt_missing',
              'verification_recovery_receipt_invalid',
              'verification_recovery_receipt_mismatch',
              'verification_recovery_receipt_unconfirmed',
              'verification_recovery_boot_changed',
              'verification_recovery_helper_lost',
              'verification_recovery_processes_remain',
            ]),
          })
          .strict()
          .parse(raw);
        throw new Error(code.recoveryError);
      }
      const receipt = z
        .object({
          cleanupConfirmed: z.literal(true),
          identity,
          sourceSha256: z.literal(sourceSha256),
          bootId: z.string().uuid(),
          bootReplacement: z.object({ previousBootId: z.string().uuid(), currentBootId: z.string().uuid() }).strict().optional(),
          leader: pid,
          members: z.array(pid).max(4096),
        })
        .strict()
        .refine(
          (value) =>
            !value.bootReplacement ||
            (value.bootReplacement.previousBootId === value.bootId && value.bootReplacement.currentBootId !== value.bootId),
        )
        .parse(raw);
      if (
        receipt.identity.workspaceId !== key.workspaceId ||
        receipt.identity.projectId !== key.projectId ||
        receipt.identity.appInstanceId !== appInstanceId
      )
        throw new Error('verification_recovery_receipt_mismatch');
      if (entry.portPending) {
        const port = entry.port!;
        const matches = (await this.listPorts()).filter((p) => p.sandbox_port === port.sandbox_port);
        if (
          (matches.length === 0 && !entry.portRemovalPending) ||
          matches.length > 1 ||
          (matches.length === 1 && !this.samePort(matches[0]!, port))
        )
          throw new Error('verification_recovery_mapping_changed');
        checkKeeper();
        entry.portRemovalPending = true;
        await this.persist();
        checkKeeper();
        if (matches.length === 1) await this.ports(['--unpublish', `${port.sandbox_port}/${port.protocol}`]);
        checkKeeper();
        if ((await this.listPorts()).some((p) => p.sandbox_port === port.sandbox_port))
          throw new Error('verification_recovery_mapping_remains');
        checkKeeper();
        entry.port = null;
        entry.portPending = false;
        entry.portRemovalPending = false;
        await this.persist();
      }
      const outcome = await child.close();
      if (!outcome.confirmed || outcome.error) throw new Error('verification_recovery_keeper_unconfirmed');
      entry.snapshot = { ...entry.snapshot, state: 'stopped', cleanupConfirmed: true, url: null, error: null };
      entry.processExpected = false;
      entry.recoveryUrl = null;
      await this.persist();
      return structuredClone(entry.snapshot);
    } catch (error) {
      const outcome = await child.close();
      entry.snapshot.cleanupConfirmed = false;
      if (!outcome.confirmed) throw new Error('verification_recovery_keeper_unconfirmed', { cause: error });
      throw error;
    }
  }
  writeVerification(key: AppKey, sessionId: string, data: string): void {
    if (this.verification.get(this.id(key))?.lease.sessionId !== sessionId) throw new Error('verification_session_mismatch');
    const process = this.entry(key).process;
    if (!process?.write) throw new Error('verification_channel_closed');
    process.write({ type: 'input', data });
  }
  closeVerificationInput(key: AppKey, sessionId: string): void {
    if (this.verification.get(this.id(key))?.lease.sessionId !== sessionId) return;
    const entry = this.entry(key);
    if (!entry.processExited) entry.process?.closeInput?.();
  }
  async stop(key: AppKey): Promise<AppSnapshot> {
    await this.ensureLoaded();
    const entry = this.entry(key);
    if (entry.stopping) return entry.stopping;
    entry.cancelled = true;
    entry.snapshot.state = 'stopping';
    const operation = entry.operation;
    entry.stopping = (async () => {
      // An ended transport's failed done promise cannot perform another cleanup.
      // Release only that edu handle; ownership/source/mapping facts stay intact
      // and the durable recovery helper must establish an independent proof.
      if (
        entry.snapshot.profile.projectKind === 'edu-web' &&
        entry.processExited &&
        !entry.snapshot.cleanupConfirmed &&
        !operation &&
        !entry.commandProcess
      )
        entry.process = null;
      // A v3 receipt can recover only this lost edu owner, never a process inferred from cwd.
      const recoverInterrupted = async () => {
        try {
          const facts = await this.inspectRecovery(key);
          if (!facts.appInstanceId || !facts.sourceSha256) throw new Error('verification_recovery_identity_missing');
          if ((await this.captureRecoverySource(key, true)) !== facts.sourceSha256) throw new Error('verification_recovery_source_changed');
          const recovered = await this.recoverOwned(key, facts.appInstanceId, facts.sourceSha256, true);
          this.options.onSnapshot?.(structuredClone(recovered));
          return recovered;
        } catch (error) {
          entry.snapshot.state = 'failed';
          entry.snapshot.cleanupConfirmed = false;
          entry.snapshot.error =
            error instanceof Error && /^verification_[a-z0-9_]+$/.test(error.message) ? error.message : 'verification_recovery_unconfirmed';
          await this.persist();
          this.options.onSnapshot?.(structuredClone(entry.snapshot));
          return structuredClone(entry.snapshot);
        }
      };
      if (
        entry.snapshot.profile.projectKind === 'edu-web' &&
        !entry.process &&
        !entry.snapshot.cleanupConfirmed &&
        !entry.commandProcess &&
        !operation
      )
        return recoverInterrupted();
      // Finite create/export helpers own no published mapping. Cancel them now;
      // a running app must retain its process until cleanup removes that mapping.
      if (entry.commandProcess) await entry.commandProcess.close();
      // The operation reports its own failure; stop separately confirms cleanup.
      if (operation) await Promise.allSettled([operation]);
      if (entry.agentAdmission) await Promise.allSettled([entry.agentAdmission]);
      await this.cleanup(entry);
      // Shutdown closes the shared sbx connection after this stop settles. A
      // failed close that has now ended must recover here, not on a later RPC.
      if (
        entry.snapshot.profile.projectKind === 'edu-web' &&
        entry.processExited &&
        !entry.snapshot.cleanupConfirmed &&
        !entry.commandProcess &&
        !entry.operation
      ) {
        entry.process = null;
        return recoverInterrupted();
      }
      entry.snapshot.state = entry.snapshot.cleanupConfirmed ? 'stopped' : 'failed';
      await this.persist();
      this.options.onSnapshot?.(structuredClone(entry.snapshot));
      return structuredClone(entry.snapshot);
    })();
    try {
      return await entry.stopping;
    } finally {
      entry.stopping = null;
    }
  }
  /** 当前或最近一次启动进程的 stdout/stderr 尾部（按 UTF-8 字节截断）。 */
  async logs(key: AppKey, maxBytes: number): Promise<AppLogs> {
    await this.ensureLoaded();
    const log = this.entry(key).log;
    const bytes = Buffer.from(log, 'utf8');
    const tail = bytes.subarray(Math.max(0, bytes.length - Math.min(maxBytes, 65536))).toString('utf8');
    return { text: tail.replace(/^\uFFFD+/, ''), truncated: bytes.length > maxBytes, totalBytes: bytes.length };
  }

  /**
   * 控制面后端操作。运行中的受管开发实例走回环 HTTP（实例令牌）；应用停止且清理已确认时，
   * 只读操作经 app-helper 在 guest cwd 内执行 agent-cli。与 start/stop/export 互斥；写操作要求
   * 请求的 appInstanceId 仍是当前运行实例（Main 已核对，此处防止迟到请求越过实例更换）。
   */
  async agent(key: AppKey, appInstanceId: string | null, operation: AppAgentOperation, signal: AbortSignal): Promise<AppAgentResult> {
    await this.ensureLoaded();
    if (this.closing) throw new Error('应用服务正在关闭');
    const entry = this.entry(key);
    const fail = (code: string, message: string, mode: 'http' | 'cli' = 'http'): AppAgentResult => ({
      mode,
      cleanupConfirmed: true,
      envelope: { ok: false, error: { code, message } },
    });
    if (entry.snapshot.profile.projectKind === 'edu-web')
      return { ...fail('unsupported', 'edu profile 不支持标准应用 Hono/PGlite 控制面'), operationDispatched: false };
    if (signal.aborted)
      return {
        ...fail('cancelled', '控制面请求已取消'),
        ...(operation.op !== 'reconcile' && operation.op !== 'reconcile-cli' ? { operationDispatched: false as const } : {}),
      };
    const write = operation.op === 'seed' || operation.op === 'reset';
    if (operation.op === 'reconcile-cli')
      return {
        ...fail('unavailable', 'agent-cli 清理仍待确认', 'cli'),
        cleanupConfirmed: !entry.agentProcess && entry.snapshot.cleanupConfirmed,
      };
    if (operation.op === 'reconcile') return this.reconcileAgent(entry, appInstanceId, operation.operationId, operation.operation);
    if (entry.operation || entry.stopping || (write && entry.httpOperation))
      return { ...fail('app_busy', '应用操作进行中'), operationDispatched: false };
    if (entry.snapshot.state === 'running') {
      if (appInstanceId !== null && appInstanceId !== entry.snapshot.appInstanceId)
        return {
          ...fail('stale_instance', '请求绑定的应用实例已不是当前运行实例'),
          ...(write ? { operationDispatched: false as const } : {}),
        };
      if (!entry.snapshot.url || !entry.agentToken)
        return { ...fail('unsupported', '运行实例未开启 Agent 控制面'), ...(write ? { operationDispatched: false as const } : {}) };
      if (write) {
        const capability = await this.agent(key, appInstanceId, { op: 'describe' }, signal);
        if (!capability.envelope.ok || capability.envelope.data.operationTrackingVersion !== 1)
          return { ...fail('unsupported', '项目不支持操作追踪协议，拒绝数据写入'), operationDispatched: false };
      }
      if (write) {
        if (
          signal.aborted ||
          entry.stopping ||
          entry.snapshot.state !== 'running' ||
          entry.snapshot.appInstanceId !== appInstanceId ||
          !entry.agentToken ||
          !entry.snapshot.url
        )
          return { ...fail('cancelled', '数据写入派发前实例已停止或取消'), operationDispatched: false };
        if (entry.httpOperation) return { ...fail('app_busy', '数据操作结果仍待确认'), operationDispatched: false };
        entry.httpOperation = { operationId: operation.operationId, operation: operation.op, appInstanceId: appInstanceId! };
      }
      const [method, path, body] =
        operation.op === 'describe'
          ? (['GET', '/api/__agent/describe', undefined] as const)
          : operation.op === 'query'
            ? (['POST', '/api/__agent/db/query', { sql: operation.sql, limit: operation.limit }] as const)
            : operation.op === 'snapshot'
              ? (['GET', '/api/__agent/db/snapshot', undefined] as const)
              : (['POST', `/api/__agent/db/${operation.op}`, {}] as const);
      try {
        const response = await (this.options.fetch ?? fetch)(entry.snapshot.url + path, {
          method,
          headers: {
            'x-wsl-agent-token': entry.agentToken,
            ...(body ? { 'content-type': 'application/json' } : {}),
            ...(write ? { 'x-wsl-agent-operation-id': operation.operationId } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          redirect: 'error',
          signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
        });
        if (response.status === 404) {
          if (write) return this.reconcileAgent(entry, appInstanceId, operation.operationId, operation.op);
          return fail('unsupported', '项目未包含 Agent 控制面（模板 1.0.0）');
        }
        const text = await response.text();
        if (Buffer.byteLength(text, 'utf8') > 1048576) {
          if (write) return this.reconcileAgent(entry, appInstanceId, operation.operationId, operation.op);
          return fail('budget_exceeded', '控制面结果超过 1 MiB');
        }
        const envelope = AgentCliEnvelopeSchema.parse(JSON.parse(text));
        if (write && !envelope.ok && envelope.error.code === 'operation_capacity') {
          entry.httpOperation = null;
          return { mode: 'http', cleanupConfirmed: true, envelope, operationDispatched: false };
        }
        if (write) return this.reconcileAgent(entry, appInstanceId, operation.operationId, operation.op, false);
        return { mode: 'http', cleanupConfirmed: true, envelope };
      } catch (error) {
        if (write) return this.reconcileAgent(entry, appInstanceId, operation.operationId, operation.op);
        if (signal.aborted) return fail('cancelled', '控制面请求已取消');
        return fail('unavailable', error instanceof Error ? error.message : String(error));
      }
    }
    if (write) return { ...fail('app_not_running', '数据写操作只允许作用于当前运行的受管实例'), operationDispatched: false };
    if (entry.process || entry.agentProcess || !entry.snapshot.cleanupConfirmed || entry.portPending)
      return { ...fail('app_busy', '应用进程或清理尚未确认', 'cli'), cleanupConfirmed: false };
    const args =
      operation.op === 'describe'
        ? ['describe']
        : operation.op === 'query'
          ? ['db', 'query', operation.sql, '--limit', String(operation.limit)]
          : ['db', 'snapshot'];
    let stdout = '';
    let admitted!: () => void;
    // Stop must wait until the reserved CLI either registers its process or cancels before launch.
    entry.agentAdmission = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    entry.snapshot.cleanupConfirmed = false;
    let child: Pick<GuestProcess, 'done' | 'close'>;
    try {
      await this.persist();
      if (signal.aborted || entry.stopping || this.closing) {
        entry.snapshot.cleanupConfirmed = true;
        await this.persist();
        return { ...fail('cancelled', 'CLI 启动前已停止或取消', 'cli'), operationDispatched: false };
      }
      child = this.connection.start(
        {
          type: 'start',
          mode: 'codex',
          argv: ['python3', '-u', '-c', helper],
          prompt: JSON.stringify({ operation: 'agent', workspaceId: key.workspaceId, projectId: key.projectId, args }),
        },
        (frame) => {
          if (frame.type === 'output' && frame.stream === 'stdout') stdout = (stdout + frame.data).slice(-2 * 1024 * 1024);
        },
      );
      entry.agentProcess = child;
    } finally {
      entry.agentAdmission = undefined;
      admitted();
    }
    let cliConfirmed = false;
    let closeFailed!: (outcome: Awaited<GuestProcess['done']>) => void;
    const closeFailure = new Promise<Awaited<GuestProcess['done']>>((resolve) => {
      closeFailed = resolve;
    });
    const abort = () => {
      void child.close().then(
        (outcome) => {
          if (!outcome.confirmed) closeFailed(outcome);
        },
        (error) => closeFailed({ confirmed: false, exitCode: null, error: String(error) }),
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(abort, 30000);
    try {
      const outcome = await Promise.race([child.done, closeFailure]);
      cliConfirmed = outcome.confirmed;
      if (!outcome.confirmed) entry.snapshot.error = outcome.error ?? 'agent-cli 清理未确认';
      if (signal.aborted) return { ...fail('cancelled', '控制面请求已取消', 'cli'), cleanupConfirmed: outcome.confirmed };
      const line = stdout.split('\n').find((item) => item.startsWith('WSL_APP_RESULT:'));
      if (!outcome.confirmed || outcome.error || !line)
        return { ...fail('unavailable', outcome.error ?? 'agent-cli 未返回回执', 'cli'), cleanupConfirmed: outcome.confirmed };
      const receipt = z
        .union([
          z.object({ unsupported: z.string() }).strict(),
          z.object({ exitCode: z.number().int(), stdout: z.string(), stderr: z.string() }).strict(),
        ])
        .parse(JSON.parse(line.slice('WSL_APP_RESULT:'.length)));
      if ('unsupported' in receipt) return fail('unsupported', receipt.unsupported, 'cli');
      const last = receipt.stdout.trim().split('\n').at(-1) ?? '';
      let envelope: AgentCliEnvelope;
      try {
        envelope = AgentCliEnvelopeSchema.parse(JSON.parse(last));
      } catch {
        return fail('unavailable', `agent-cli 输出无效（退出码 ${receipt.exitCode}）：${receipt.stderr.slice(-1000)}`, 'cli');
      }
      return { mode: 'cli', cleanupConfirmed: true, envelope };
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      if (cliConfirmed && entry.agentProcess === child) entry.agentProcess = null;
      entry.snapshot.cleanupConfirmed = cliConfirmed;
      await this.persist();
    }
  }

  private async reconcileAgent(
    entry: Entry,
    appInstanceId: string | null,
    operationId: string,
    operation: 'seed' | 'reset',
    cancel = true,
  ): Promise<AppAgentResult> {
    let lastFailure = '操作没有匹配的终态回执';
    const unknown = (): AppAgentResult => ({
      mode: 'http',
      cleanupConfirmed: false,
      envelope: { ok: false, error: { code: 'unavailable', message: 'App 数据操作结果待确认：' + lastFailure } },
    });
    if (!entry.agentToken || !entry.snapshot.url || appInstanceId !== entry.snapshot.appInstanceId) return unknown();
    const url = entry.snapshot.url + '/api/__agent/operations/' + operationId;
    const headers = { 'x-wsl-agent-token': entry.agentToken, 'content-type': 'application/json' };
    const deadline = Date.now() + (this.options.reconciliationTimeoutMs ?? 30000);
    const request = async (method: 'GET' | 'POST') => {
      const response = await (this.options.fetch ?? fetch)(url + (method === 'POST' ? '/cancel' : ''), {
        method,
        headers,
        ...(method === 'POST' ? { body: JSON.stringify({ operation }) } : {}),
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))),
      });
      const text = await response.text();
      if (Buffer.byteLength(text) > 1048576) throw new Error('操作回执超过预算');
      const envelope = AgentCliEnvelopeSchema.parse(JSON.parse(text));
      if (!envelope.ok) return null;
      const receipt = AppOperationReceiptSchema.parse(envelope.data);
      if (receipt.operationId !== operationId || receipt.appInstanceId !== appInstanceId || receipt.operation !== operation) return null;
      return receipt;
    };
    if (cancel) {
      try {
        await request('POST');
      } catch (error) {
        lastFailure = String(error);
      }
    }
    do {
      try {
        const receipt = await request('GET');
        if (receipt && receipt.state !== 'running' && receipt.envelope) {
          if (entry.httpOperation?.operationId === operationId) entry.httpOperation = null;
          return { mode: 'http', cleanupConfirmed: true, envelope: receipt.envelope, operation: receipt };
        }
      } catch (error) {
        lastFailure = String(error);
      }
      if (Date.now() >= deadline) break;
      await delay(Math.min(1000, deadline - Date.now()));
    } while (Date.now() < deadline);
    return unknown();
  }

  async export(key: AppKey, taskSnapshot = false): Promise<AppSource> {
    await this.ensureLoaded();
    if (this.closing) throw new Error('应用服务正在关闭');
    const entry = this.entry(key);
    if (
      entry.operation ||
      entry.stopping ||
      entry.agentProcess ||
      entry.httpOperation ||
      ((!taskSnapshot || entry.snapshot.profile.projectKind !== 'edu-web' || entry.snapshot.state !== 'running') &&
        (entry.process || !entry.snapshot.cleanupConfirmed))
    )
      throw new Error('请先停止应用并确认清理，再导出源码');
    entry.cancelled = false;
    let result: { files: AppSourceFile[] } | undefined;
    entry.operation = (async () => {
      try {
        result = z.object({ files: z.array(fileSchema) }).parse(await this.command(entry, 'export'));
        validateAppSources(result.files);
        if (entry.snapshot.profile.projectKind === 'edu-web')
          entry.snapshot.sourceSha256 = validateEduSources(result.files, entry.snapshot.profile.source, false);
        return structuredClone(entry.snapshot);
      } finally {
        await this.persist();
      }
    })();
    try {
      await entry.operation;
      if (!result) throw new Error('缺少源码导出回执');
      return {
        files: result.files,
        sha256: createHash('sha256').update(JSON.stringify(result.files)).digest('hex'),
        profile: structuredClone(entry.snapshot.profile),
      };
    } finally {
      entry.operation = null;
    }
  }
  async assertTaskAdmission(workspaceId: string | null, binding?: EduTaskBinding): Promise<void> {
    await this.ensureLoaded();
    const edu = [...this.entries.values()].find(
      (entry) => entry.snapshot.workspaceId === workspaceId && entry.snapshot.profile.projectKind === 'edu-web',
    );
    if (edu && (!binding || binding.workspaceId !== workspaceId || binding.projectId !== edu.snapshot.projectId))
      throw new Error('denied: edu tasks require a frozen candidate workspace');
  }
  async taskSource(binding: EduTaskBinding): Promise<GuestWorkspace> {
    await this.ensureLoaded();
    const entry = this.entry({ workspaceId: binding.workspaceId, projectId: binding.projectId });
    if (
      entry.snapshot.profile.projectKind !== 'edu-web' ||
      entry.snapshot.state !== 'running' ||
      entry.snapshot.appInstanceId !== binding.appInstanceId
    )
      throw new Error('conflict: edu task application instance changed');
    const source = await this.export({ workspaceId: binding.workspaceId, projectId: binding.projectId }, true);
    if (entry.snapshot.state !== 'running' || entry.snapshot.appInstanceId !== binding.appInstanceId)
      throw new Error('conflict: edu task application stopped during snapshot');
    assertEduTaskSource(binding, source.files);
    return { runId: binding.runId, files: source.files };
  }
  private readonly preparedTasks = new Map<string, string>();
  async prepareTask(binding: EduTaskBinding, candidate: GuestWorkspace): Promise<void> {
    await this.taskSource(binding);
    assertEduTaskCandidate(binding, candidate);
    this.preparedTasks.set(binding.runId, JSON.stringify({ binding, candidate }));
  }
  async applyTask(binding: EduTaskBinding, candidate: GuestWorkspace): Promise<AppSnapshot> {
    if (this.preparedTasks.get(binding.runId) !== JSON.stringify({ binding, candidate }))
      throw new Error('conflict: edu task candidate was not prepared');
    this.preparedTasks.delete(binding.runId);
    const entry = this.entry({ workspaceId: binding.workspaceId, projectId: binding.projectId });
    if (entry.operation || entry.stopping || entry.snapshot.state !== 'running' || entry.snapshot.appInstanceId !== binding.appInstanceId)
      throw new Error('conflict: edu application is busy or instance changed');
    entry.cancelled = false;
    entry.operation = (async () => {
      z.object({ applied: z.literal(true) })
        .strict()
        .parse(await this.command(entry, 'apply-task', candidate.files, binding));
      entry.snapshot.sourceSha256 = createHash('sha256')
        .update(JSON.stringify(eduTaskMetadata(candidate.files)))
        .digest('hex');
      return structuredClone(entry.snapshot);
    })();
    let applied = false;
    try {
      const result = await entry.operation;
      applied = true;
      return result;
    } finally {
      entry.operation = null;
      await this.persist();
      // Source facts become observable only after the committed registry is durable.
      if (applied) this.options.onSnapshot?.(structuredClone(entry.snapshot));
    }
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await this.ensureLoaded();
    const errors: unknown[] = [];
    // Each stop persists the shared registry; settle sequentially to avoid stale writes.
    for (const entry of this.entries.values()) {
      try {
        await this.stop({ workspaceId: entry.snapshot.workspaceId, projectId: entry.snapshot.projectId });
        if (!entry.snapshot.cleanupConfirmed) throw new Error(entry.snapshot.error ?? '应用清理未确认');
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new AggregateError(errors, errors.map((error: unknown) => (error instanceof Error ? error.message : String(error))).join('\n'));
  }
}
