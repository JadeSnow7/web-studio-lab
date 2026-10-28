import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  APP_SOURCE_TRANSPORT,
  AgentCliEnvelopeSchema,
  AppSourceSchema,
  AppProfileSchema,
  AppImportRequestSchema,
  AppImportTargetSchema,
  type AppProfile,
  type AppSource,
  type AppImportRequest,
  type AppImportTarget,
  type AppImportOutcome,
  AppTargetSchema,
  type AppSourceSnapshotResult,
  STANDARD_APP_EXPORT_BUDGET,
  AppOperationReceiptSchema,
  type AgentCliEnvelope,
  type AppAgentOperation,
  type AppAgentResult,
  type AppLogs,
} from '@wsl/protocol';
import { type GuestOutcome, type GuestProcess, type SbxConnection } from './sbx';
import rawHelper from './app-helper.py?raw';
import ownedProcess from './edu-owned-process.py?raw';
import { AppImports } from './app-imports';
import { validateEduSources } from './app-kinds/edu-web';
import { appKindOf } from './app-kinds/registry';
const helper = rawHelper.replace('OWNED_PROCESS_BASE64 = ""', `OWNED_PROCESS_BASE64 = "${Buffer.from(ownedProcess).toString('base64')}"`);
if (Buffer.byteLength(JSON.stringify(helper), 'utf8') > APP_SOURCE_TRANSPORT.helperJsonBytes)
  throw new Error('application helper exceeds encoded transport budget');
import { SourceSnapshotReader } from './source-snapshot';

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
  process: Pick<GuestProcess, 'done' | 'close'> | null;
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
  processOutcomeUnknown?: boolean;
  exitCompletion?: Promise<AppSnapshot>;
  /** 每次启动随机生成，仅经 guest 进程环境传给受管开发实例的 /api/__agent；停止即作废。 */
  agentToken: string | null;
  agentProcess: Pick<GuestProcess, 'done' | 'close'> | null;
  agentAdmission?: Promise<void>;
  recoveryInstanceId?: string | null;
  recoveryUrl?: string | null;
  processExpected?: boolean;
  portRemovalPending?: boolean;
  httpOperation: { operationId: string; operation: 'seed' | 'reset'; appInstanceId: string } | null;
}
export interface AppServiceOptions {
  /** Trusted service wiring, never populated from renderer input. */
  ports?: (args: string[]) => Promise<string>;
  fetch?: typeof fetch;
  startupTimeoutMs?: number;
  sourceSnapshotTimeoutMs?: number;
  reconciliationTimeoutMs?: number;
  registryPath?: string;
  dependencyArchivePath?: string;
  dependencyManifest?: { archiveSha256: string; lockSha256: string; platform: 'linux'; arch: 'arm64'; libc: 'glibc' };
  onSnapshot?: (snapshot: AppSnapshot) => void | Promise<void>;
}

function validateAppSourcePath(sourcePath: string, seen: Set<string>): void {
  if (
    sourcePath.includes('\\') ||
    sourcePath.includes('\0') ||
    sourcePath.startsWith('.wsl-') ||
    sourcePath.split('/').some((part) => !part || part === '.' || part === '..') ||
    /^(node_modules|dist|data|\.data|\.git|\.vite|\.wsl-identity\.json)(\/|$)/.test(sourcePath)
  )
    throw new Error('不安全的应用源码路径');
  if (seen.has(sourcePath)) throw new Error('重复应用源码路径');
  seen.add(sourcePath);
}

export function validateAppSources(files: AppSourceFile[]): void {
  z.array(fileSchema).min(1).max(256).parse(files);
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    validateAppSourcePath(file.path, seen);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.base64)) throw new Error('无效源码编码');
    total += Buffer.from(file.base64, 'base64').length;
  }
  // Decoded source is separately bounded from the encoded 3 MiB start frame.
  if (total > 524288) throw new Error('应用源码超出传输预算');
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
  private readonly sourceProcesses = new Map<string, { stop: () => Promise<GuestOutcome>; settled: Promise<void> }>();
  private persistence: Promise<void> = Promise.resolve();
  private options: AppServiceOptions;
  private loaded: Promise<void> | null = null;
  private registrySandbox: string | null = null;
  private legacyRegistry: string | null = null;
  private readonly imports: AppImports;
  constructor(
    private connection: Pick<SbxConnection, 'getStatus' | 'runtimeTarget'> & {
      start: (...args: Parameters<SbxConnection['start']>) => Pick<GuestProcess, 'done' | 'close'>;
    },
    options: AppServiceOptions = {},
  ) {
    this.options = options;
    this.imports = new AppImports(connection, {
      journalPath: options.registryPath ? options.registryPath + '.imports.json' : undefined,
      helper,
      app: (target) => {
        const entry = this.entries.get(this.id(target));
        return entry ? structuredClone(entry.snapshot) : null;
      },
      publish: async (target, profile) => {
        const key = { workspaceId: target.workspaceId, projectId: target.projectId };
        const existing = this.entries.get(this.id(key));
        if (existing) {
          if (JSON.stringify(existing.snapshot.profile) !== JSON.stringify(profile)) throw new Error('import_target_conflict');
          await this.persist();
          return structuredClone(existing.snapshot);
        }
        if ([...this.entries.values()].some((entry) => entry.snapshot.projectId === key.projectId))
          throw new Error('import_target_conflict');
        const entry = this.newEntry(key, profile);
        this.entries.set(this.id(key), entry);
        await this.persist();
        await this.options.onSnapshot?.(structuredClone(entry.snapshot));
        return structuredClone(entry.snapshot);
      },
    });
  }
  private ensureLoaded(): Promise<void> {
    return (this.loaded ??= this.load()
      .then(() => this.imports.ready())
      .catch((error: unknown) => {
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
  private kind(entry: Entry) {
    return appKindOf(entry.snapshot.profile);
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
  private launch(entry: Entry, operation: 'create' | 'start' | 'export', files?: AppSourceFile[]) {
    const snapshot = entry.snapshot;
    const { workspaceId, projectId, appInstanceId } = snapshot;
    const pinned = this.kind(entry).pinnedSource !== null;
    const expectedSourceSha256 =
      operation === 'start' && pinned
        ? z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(snapshot.sourceSha256)
        : null;
    entry.log = '';
    entry.readyPort = null;
    entry.readyError = null;
    let stdout = '';
    let sourceSeen = false;
    const child = this.connection.start(
      {
        type: 'start',
        mode: 'codex',
        argv: ['python3', '-I', '-u', '-c', helper],
        ...(expectedSourceSha256
          ? {
              eduOwner: {
                identity: { workspaceId, projectId, environmentId: 'sandbox' as const, appInstanceId: z.uuid().parse(appInstanceId) },
                sourceSha256: expectedSourceSha256,
              },
            }
          : {}),
        prompt: JSON.stringify({
          operation,
          workspaceId,
          projectId,
          appInstanceId,
          profile: snapshot.profile,
          ...(expectedSourceSha256 ? { expectedSourceSha256 } : {}),
          ...(files ? { files } : {}),
          ...(operation === 'export' ? { exportBudget: STANDARD_APP_EXPORT_BUDGET } : {}),
          ...(operation === 'start' && entry.agentToken ? { agentToken: entry.agentToken } : {}),
        }),
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
              if (line.startsWith('WSL_APP_SOURCE:')) {
                const digest = line.slice('WSL_APP_SOURCE:'.length);
                if (!pinned || sourceSeen || digest !== expectedSourceSha256) entry.readyError = '应用源码回执无效';
                else {
                  snapshot.sourceSha256 = digest;
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
              if (!parsed.success || entry.readyPort !== null || (pinned && !sourceSeen)) entry.readyError = '应用就绪端口或身份回执不匹配';
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
    entry.processOutcomeUnknown = false;
    child.done.then(
      () => {
        if (entry.process === child && entry.snapshot === snapshot) entry.processExited = true;
      },
      (error: unknown) => {
        if (entry.process !== child || entry.snapshot !== snapshot) return;
        // A rejected notification proves neither process exit nor remote cleanup.
        entry.processOutcomeUnknown = true;
        entry.readyError = `应用进程完成通知失败：${String(error).slice(0, 1000)}`;
        this.appendFailure(snapshot, entry.readyError);
      },
    );
    entry.snapshot.cleanupConfirmed = false;
    this.notify(entry);
    return child;
  }
  private async command(entry: Entry, operation: 'create' | 'export', files?: AppSourceFile[]) {
    const child = this.launch(entry, operation, files);
    entry.commandProcess = child;
    const timeout = setTimeout(() => {
      entry.cancelled = true;
      child.close().catch((error: unknown) => {
        if (entry.commandProcess !== child) return;
        entry.snapshot.state = 'failed';
        entry.snapshot.cleanupConfirmed = false;
        this.appendFailure(entry.snapshot, error);
      });
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
      if (entry.snapshot.cleanupConfirmed && entry.commandProcess === child) entry.commandProcess = null;
    }
  }
  async importSource(input: AppImportRequest): Promise<AppImportOutcome> {
    let parsed: AppImportRequest;
    try {
      parsed = AppImportRequestSchema.parse(input);
      // 导入请求在 protocol 中只携带 edu 来源。
      validateEduSources(parsed.files, parsed.source, true);
    } catch {
      throw new Error('import_input_invalid');
    }
    try {
      await this.ensureLoaded();
    } catch {
      throw new Error('import_registry_invalid');
    }
    if (this.closing) throw new Error('import_service_closing');
    this.assertImportSandbox();
    return this.imports.import(parsed);
  }
  async cancelImport(input: AppImportTarget): Promise<AppImportOutcome> {
    let parsed: AppImportTarget;
    try {
      parsed = AppImportTargetSchema.parse(input);
    } catch {
      throw new Error('import_input_invalid');
    }
    try {
      await this.ensureLoaded();
    } catch {
      throw new Error('import_registry_invalid');
    }
    this.assertImportSandbox();
    return this.imports.cancel(parsed);
  }
  private assertImportSandbox() {
    const sandbox = this.connection.getStatus().sandbox;
    if (!sandbox && !this.connection.getStatus().available && !this.registrySandbox) return;
    if (!sandbox || (this.registrySandbox && this.registrySandbox !== sandbox)) throw new Error('import_sandbox_changed');
    this.registrySandbox = sandbox;
  }
  private newEntry(key: AppKey, profile: AppProfile): Entry {
    const pinned = appKindOf(profile).pinnedSource;
    return {
      snapshot: {
        ...key,
        profile: structuredClone(profile),
        ...(pinned ? { sourceSha256: pinned.initialSha256(profile) } : {}),
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
  }
  async create(input: AppKey & { files: AppSourceFile[] }): Promise<AppSnapshot> {
    await this.ensureLoaded();
    if (this.closing) throw new Error('应用服务正在关闭');
    const sandbox = this.connection.getStatus().sandbox;
    if (!sandbox) throw new Error('应用沙箱身份未初始化');
    if (this.registrySandbox && this.registrySandbox !== sandbox) throw new Error('应用注册表沙箱身份不匹配');
    this.registrySandbox = sandbox;
    const { files, ...key } = input;
    keySchema.parse(key);
    validateAppSources(files);
    if (this.imports.busy(key)) throw new Error('import_in_progress');
    if (this.entries.has(this.id(key))) throw new Error('应用项目已创建');
    if ([...this.entries.values()].some((entry) => entry.snapshot.projectId === key.projectId)) throw new Error('应用项目已绑定其他空间');
    const entry: Entry = {
      snapshot: {
        ...key,
        profile: { ...standardProfile },
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
      return { ...entry.snapshot };
    })();
    try {
      return await entry.operation;
    } finally {
      entry.operation = null;
    }
  }
  async start(key: AppKey): Promise<AppSnapshot> {
    await this.ensureLoaded();
    if (this.closing) throw new Error('应用服务正在关闭');
    const entry = this.entry(key);
    if (this.imports.busy(key)) throw new Error('import_in_progress');
    if (entry.exitCompletion || entry.operation || entry.stopping || entry.commandProcess || this.sourceProcesses.has(this.id(key)))
      throw new Error('应用操作进行中');
    if (entry.agentProcess || entry.httpOperation) throw new Error('应用控制面操作或结果待确认');
    if (entry.snapshot.state === 'running') return this.get(key);
    if (!entry.snapshot.cleanupConfirmed || entry.portPending || entry.process) throw new Error('上次应用清理尚未确认');
    if (
      [...this.entries.values()].some(
        (other) =>
          other !== entry && (other.exitCompletion !== undefined || ['starting', 'running', 'stopping'].includes(other.snapshot.state)),
      )
    )
      throw new Error('首版仅允许一个应用服务运行');
    entry.cancelled = false;
    entry.agentToken = this.kind(entry).unavailable.agent === undefined ? randomBytes(32).toString('hex') : null;
    entry.snapshot = { ...entry.snapshot, appInstanceId: randomUUID(), state: 'starting', error: null, url: null, guestPort: null };
    entry.recoveryInstanceId = entry.snapshot.appInstanceId;
    entry.recoveryUrl = null;
    entry.processExpected = true;
    entry.operation = (async () => {
      try {
        await this.persist();
        return await this.startEntry(entry);
      } finally {
        await this.persist();
      }
    })();
    try {
      return await entry.operation;
    } finally {
      entry.operation = null;
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
      this.notify(entry);
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
    const kind = this.kind(entry);
    try {
      check();
      if (kind.pinnedSource) {
        const source = z
          .object({ files: AppSourceSchema.shape.files })
          .strict()
          .parse(await this.command(entry, 'export'));
        entry.snapshot.sourceSha256 = kind.pinnedSource.verify(source.files, entry.snapshot.profile, false);
        await this.persist();
        check();
      }
      if (this.options.dependencyArchivePath && !entry.snapshot.appInstanceId) throw new Error('缺少应用实例身份');
      if (this.options.dependencyArchivePath && kind.installsDependencyArchive)
        await this.importDependencies(entry, this.options.dependencyArchivePath);
      check();
      const child = this.launch(entry, 'start');
      const snapshot = entry.snapshot;
      let childOutcome: GuestOutcome | null = null;
      const done = child.done.then(
        (outcome) => (childOutcome = outcome),
        (error: unknown): GuestOutcome =>
          (childOutcome = { confirmed: false, exitCode: null, error: `应用进程结果未知：${String(error).slice(0, 1000)}` }),
      );
      const checkChild = () => {
        if (childOutcome) throw new Error(childOutcome.error ?? `应用启动进程退出（${childOutcome.exitCode}）：${entry.log.slice(-4000)}`);
      };
      while (entry.readyPort === null) {
        check();
        if (entry.readyError) throw new Error(entry.readyError);
        checkChild();
        await delay(50);
      }
      check();
      if (entry.readyError) throw new Error(entry.readyError);
      const guestPort = entry.readyPort;
      const initialPorts = await this.listPorts();
      checkChild();
      if (initialPorts.some((port) => port.sandbox_port === guestPort)) throw new Error('应用实际端口已有未知映射');
      check();
      // Register uncertain publication before asking sandboxd to mutate bindings.
      entry.portPending = true;
      if (kind.recoversOwnedInstance) await this.persist();
      const receipt = await this.ports(['--publish', `${guestPort}/tcp4`]);
      const published = /^Published 127\.0\.0\.1:(\d+) -> (\d+)\/tcp4\s*$/m.exec(receipt);
      if (!published || Number(published[2]) !== guestPort) throw new Error('端口发布回执未知，不能推断映射所有权');
      entry.port = portSchema.parse({ host_ip: '127.0.0.1', host_port: Number(published[1]), sandbox_port: guestPort, protocol: 'tcp4' });
      entry.recoveryUrl = `http://127.0.0.1:${entry.port.host_port}`;
      if (kind.recoversOwnedInstance) await this.persist();
      checkChild();
      check();
      const ports = await this.listPorts();
      checkChild();
      const ownedPort = entry.port;
      if (!ports.some((port) => this.samePort(port, ownedPort))) throw new Error('映射核对与发布回执不同');
      const url = `http://127.0.0.1:${entry.port.host_port}`;
      while (true) {
        check();
        checkChild();
        try {
          const response = await (this.options.fetch ?? fetch)(`${url}/api/health`, {
            signal: AbortSignal.timeout(1500),
            redirect: 'error',
          });
          if (response.ok) {
            const health = z
              .object({
                ok: z.literal(true),
                templateId: z.literal(kind.health.templateId),
                templateVersion: z.enum(kind.health.templateVersions),
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
      checkChild();
      check();
      snapshot.state = 'running';
      snapshot.url = url;
      done
        .then((outcome) => {
          if (entry.process !== child || entry.snapshot !== snapshot || snapshot.state !== 'running') return;
          snapshot.state = 'failed';
          this.appendFailure(snapshot, outcome.error ?? `应用进程意外退出（${outcome.exitCode}）`);
          const completion = (async () => {
            try {
              await this.cleanup(entry);
              await this.persist();
            } catch (error) {
              this.appendFailure(snapshot, error);
            }
            if (entry.snapshot === snapshot) {
              try {
                await this.options.onSnapshot?.({ ...snapshot });
              } catch (error) {
                this.appendFailure(snapshot, error);
              }
            }
            return { ...snapshot };
          })().finally(() => {
            if (entry.exitCompletion === completion) entry.exitCompletion = undefined;
          });
          entry.exitCompletion = completion;
          return completion;
        })
        .catch((error: unknown) => {
          if (entry.snapshot !== snapshot) return;
          this.appendFailure(snapshot, error);
        });
    } catch (error) {
      this.appendFailure(entry.snapshot, error);
      await this.cleanup(entry);
      entry.snapshot.state = 'failed';
    } finally {
      clearTimeout(timer);
    }
    return { ...entry.snapshot };
  }
  private notify(entry: Entry): void {
    const snapshot = entry.snapshot;
    // Preserve synchronous publisher failures. An asynchronous notification does
    // not delay dispatch or change process/cleanup facts; retain its owned error.
    const publication = this.options.onSnapshot?.({ ...snapshot });
    if (publication)
      publication.catch((error: unknown) => {
        if (entry.snapshot === snapshot) this.appendFailure(snapshot, error);
      });
  }
  private appendFailure(snapshot: AppSnapshot, error: unknown): void {
    // Match the existing 4000 UTF-16 code-unit startup diagnostic budget. Keep each
    // recent cause's prefix and bound the accumulated tail, independent of flags.
    const message = String(error).slice(0, 1000);
    snapshot.error = [snapshot.error, message].filter(Boolean).join('; ').slice(-4000);
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
        else this.appendFailure(entry.snapshot, outcome.error ?? 'agent-cli 清理未确认');
      } catch (error) {
        this.appendFailure(entry.snapshot, error);
      }
    }
    // Keep the guest session alive while removing its published mapping. Closing
    // the last session first can stop/restart the VM and rebind an ephemeral port.
    if (entry.portPending) {
      try {
        const ownedPort = entry.port;
        if (!ownedPort) throw new Error('映射发布结果未知，不能清理未归属端口');
        const checkContinuity = () => {
          if (entry.processExited || entry.processOutcomeUnknown)
            throw new Error('guest进程已退出或结果未知，沙箱映射连续性未知；不触碰可能重绑定的端口');
        };
        checkContinuity();
        const before = await this.listPorts();
        checkContinuity();
        const matches = before.filter((port) => port.sandbox_port === ownedPort.sandbox_port);
        if (matches.length > 1) throw new Error('所属端口映射重复，清理状态未知');
        if (matches.length !== 1 || !this.samePort(matches[0]!, ownedPort)) throw new Error('所属端口映射已变化或丢失，清理状态未知');
        // Remove the original persistent request, not only its current ephemeral host binding.
        // sbx's resolved host:guest form leaves the request alive across an idle VM restart.
        entry.portRemovalPending = true;
        if (this.kind(entry).recoversOwnedInstance) await this.persist();
        await this.ports(['--unpublish', `${ownedPort.sandbox_port}/${ownedPort.protocol}`]);
        if ((await this.listPorts()).some((port) => port.sandbox_port === ownedPort.sandbox_port))
          throw new Error('应用端口仍有映射，清理未确认');
        entry.port = null;
        entry.portPending = false;
        entry.portRemovalPending = false;
      } catch (error) {
        confirmed = false;
        this.appendFailure(entry.snapshot, error);
      }
    }
    if (entry.process) {
      try {
        const outcome = await entry.process.close();
        confirmed = confirmed && outcome.confirmed;
        if (outcome.confirmed) entry.process = null;
        if (!outcome.confirmed) this.appendFailure(entry.snapshot, outcome.error ?? '应用进程清理未确认');
      } catch (error) {
        confirmed = false;
        this.appendFailure(entry.snapshot, error);
      }
    }
    entry.snapshot.cleanupConfirmed = confirmed && agentConfirmed;
    if (entry.snapshot.cleanupConfirmed) {
      entry.httpOperation = null;
      entry.processExpected = false;
      entry.recoveryUrl = null;
    }
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
    const kind = this.kind(entry);
    const pinned = kind.pinnedSource;
    if (!kind.recoversOwnedInstance || !pinned || entry.exitCompletion || entry.operation || (entry.stopping && !fromStop))
      throw new Error('verification_recovery_app_busy');
    const confirmed = entry.snapshot.cleanupConfirmed;
    const cancelled = entry.cancelled;
    entry.cancelled = false;
    try {
      const result = z
        .object({ files: z.array(fileSchema) })
        .strict()
        .parse(await this.command(entry, 'export'));
      return pinned.verify(result.files, entry.snapshot.profile, false);
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
      !this.kind(entry).recoversOwnedInstance ||
      entry.process ||
      entry.commandProcess ||
      entry.exitCompletion ||
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
          if (Buffer.byteLength(output) + Buffer.byteLength(frame.data) > 1048576) failure = true;
          else output += frame.data;
        }
        if (frame.type === 'error') failure = true;
      },
    );
    entry.commandProcess = child;
    let exited = false;
    child.done
      .then(() => {
        exited = true;
      })
      .catch(() => {
        failure = true;
      });
    try {
      const deadline = Date.now() + 12000;
      let line: string | undefined;
      const receipts = () =>
        output
          .split('\n')
          .slice(0, -1)
          .filter((line) => line.startsWith('WSL_APP_RESULT:'));
      while (!(line = receipts()[0])) {
        if (failure || exited || Date.now() > deadline) throw new Error('verification_recovery_guest_unconfirmed');
        await delay(25);
      }
      const checkKeeper = () => {
        if (exited || failure || receipts().length !== 1) throw new Error('verification_recovery_keeper_lost');
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
      if (outcome.confirmed && entry.commandProcess === child) entry.commandProcess = null;
      if (!outcome.confirmed || outcome.error) throw new Error('verification_recovery_keeper_unconfirmed');
      entry.snapshot = { ...entry.snapshot, state: 'stopped', cleanupConfirmed: true, url: null, error: null };
      entry.processExpected = false;
      entry.recoveryUrl = null;
      await this.persist();
      return structuredClone(entry.snapshot);
    } catch (error) {
      const outcome = await child.close();
      if (outcome.confirmed && entry.commandProcess === child) entry.commandProcess = null;
      entry.snapshot.cleanupConfirmed = false;
      if (!outcome.confirmed) throw new Error('verification_recovery_keeper_unconfirmed', { cause: error });
      throw error;
    }
  }
  async stop(key: AppKey): Promise<AppSnapshot> {
    await this.ensureLoaded();
    const entry = this.entry(key);
    if (entry.stopping) return entry.stopping;
    entry.cancelled = true;
    entry.snapshot.state = 'stopping';
    const operation = entry.operation;
    const exitCompletion = entry.exitCompletion;
    const recoverable = this.kind(entry).recoversOwnedInstance;
    entry.stopping = (async () => {
      if (exitCompletion) await exitCompletion;
      if (recoverable && entry.processExited && !entry.snapshot.cleanupConfirmed && !operation && !entry.commandProcess)
        entry.process = null;
      const recoverInterrupted = async () => {
        try {
          const facts = await this.inspectRecovery(key);
          if (!facts.appInstanceId || !facts.sourceSha256) throw new Error('verification_recovery_identity_missing');
          if ((await this.captureRecoverySource(key, true)) !== facts.sourceSha256) throw new Error('verification_recovery_source_changed');
          const recovered = await this.recoverOwned(key, facts.appInstanceId, facts.sourceSha256, true);
          await this.options.onSnapshot?.(structuredClone(recovered));
          return recovered;
        } catch (error) {
          entry.snapshot.state = 'failed';
          entry.snapshot.cleanupConfirmed = false;
          this.appendFailure(entry.snapshot, error);
          await this.persist();
          await this.options.onSnapshot?.(structuredClone(entry.snapshot));
          return structuredClone(entry.snapshot);
        }
      };
      if (recoverable && !entry.process && !entry.snapshot.cleanupConfirmed && !entry.commandProcess && !operation)
        return recoverInterrupted();
      // Finite create/export helpers own no published mapping. Cancel them now;
      // a running app must retain its process until cleanup removes that mapping.
      if (entry.commandProcess) {
        const command = entry.commandProcess;
        const outcome = await command.close();
        if (outcome.confirmed && entry.commandProcess === command) entry.commandProcess = null;
      }
      // The operation reports its own failure; stop separately confirms cleanup.
      if (operation) await Promise.allSettled([operation]);
      if (entry.agentAdmission) await Promise.allSettled([entry.agentAdmission]);
      await this.cleanup(entry);
      if (entry.commandProcess) entry.snapshot.cleanupConfirmed = false;
      if (recoverable && entry.processExited && !entry.snapshot.cleanupConfirmed && !entry.commandProcess && !entry.operation) {
        entry.process = null;
        return recoverInterrupted();
      }
      entry.snapshot.state = entry.snapshot.cleanupConfirmed ? 'stopped' : 'failed';
      await this.persist();
      await this.options.onSnapshot?.({ ...entry.snapshot });
      return { ...entry.snapshot };
    })();
    try {
      return await entry.stopping;
    } catch (error) {
      entry.snapshot.state = 'failed';
      this.appendFailure(entry.snapshot, error);
      throw error;
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
    const unsupported = this.kind(entry).unavailable.agent;
    if (unsupported !== undefined) return { ...fail('unsupported', unsupported), operationDispatched: false };
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
    if (entry.exitCompletion || entry.operation || entry.stopping || (write && entry.httpOperation))
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

  async sourceSnapshot(key: AppKey, signal?: AbortSignal): Promise<AppSourceSnapshotResult> {
    const target = AppTargetSchema.parse(key);
    const id = this.id(key);
    const unavailable = (error: string, cleanupConfirmed: boolean): AppSourceSnapshotResult => ({
      ok: false,
      target,
      cleanupConfirmed,
      error: error.slice(0, 1000),
    });
    try {
      await this.ensureLoaded();
      const entry = this.entry(key);
      const unsupported = this.kind(entry).unavailable.sourceSnapshot;
      if (unsupported !== undefined) return unavailable(unsupported, true);
      if (this.imports.busy(key)) return unavailable('工程导入尚未结清', true);
      if (this.sourceProcesses.has(id)) return unavailable('上次源码 helper 尚未确认清理', false);
      if (this.closing || signal?.aborted) return unavailable('源码采集已取消或服务正在关闭', true);
      if (entry.exitCompletion || entry.operation || entry.stopping || entry.commandProcess)
        return unavailable('工程有限 helper 正在运行或清理未确认；未启动源码采集', true);
      if (!this.connection.getStatus().available) return unavailable('源码采集服务不可用；未启动 helper', true);
    } catch {
      return unavailable('源码工程不可用或未创建；未启动 helper', !this.sourceProcesses.has(id));
    }
    const reader = new SourceSnapshotReader();
    let failure: string | null = null;
    let accepting = true;
    let stop: (() => Promise<GuestOutcome>) | undefined;
    const unknownHandle = {
      stop: async (): Promise<GuestOutcome> => ({ confirmed: false, exitCode: null, error: '源码 helper 派发结果未知' }),
      settled: Promise.resolve(),
    };
    this.sourceProcesses.set(id, unknownHandle);
    let child: Pick<GuestProcess, 'done' | 'close'>;
    try {
      child = this.connection.start(
        {
          type: 'start',
          mode: 'codex',
          argv: ['python3', '-I', '-u', '-c', helper],
          prompt: JSON.stringify({ operation: 'source-snapshot', ...target }),
        },
        (frame) => {
          if (!accepting || failure || frame.type !== 'output' || frame.stream !== 'stdout') return;
          try {
            reader.accept(frame.data);
          } catch {
            failure = '源码采集回执无效或超过路径、数量、字节预算';
            if (stop)
              stop().catch(() => {
                failure = '源码 helper 清理失败';
              });
          }
        },
      );
    } catch {
      accepting = false;
      return unavailable('源码 helper 派发结果未知；不能确认清理', false);
    }
    let resolveStopped: ((outcome: GuestOutcome) => void) | undefined;
    let resolveSettled: (() => void) | undefined;
    const stopped = new Promise<GuestOutcome>((resolve) => {
      resolveStopped = resolve;
    });
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    let stopping: Promise<GuestOutcome> | undefined;
    stop = () => {
      if (!stopping) {
        stopping = Promise.resolve()
          .then(() => child.close())
          .catch((): GuestOutcome => ({ confirmed: false, exitCode: null, error: '源码 helper 清理失败' }))
          .then((outcome) => {
            resolveStopped?.(outcome);
            if (!outcome.confirmed) stopping = undefined;
            return outcome;
          });
      }
      return stopping;
    };
    const handle = { stop, settled };
    this.sourceProcesses.set(id, handle);
    const cancel = () => {
      failure ??= '源码采集已取消或超时';
      handle.stop().catch(() => {
        failure = '源码 helper 清理失败';
      });
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (failure || signal?.aborted) cancel();
    const timer = setTimeout(cancel, this.options.sourceSnapshotTimeoutMs ?? 120000);
    let confirmed = false;
    try {
      const outcome = await Promise.race([
        child.done.catch((): GuestOutcome => ({ confirmed: false, exitCode: null, error: '源码 helper 传输失败' })),
        stopped,
      ]);
      const cleanup = stopping ? await stopping : outcome;
      confirmed = outcome.confirmed && cleanup.confirmed;
      if (!confirmed) throw new Error('源码 helper 清理未确认；保留所属句柄');
      if (failure || this.closing) throw new Error(failure ?? '源码采集已取消，服务正在关闭');
      if (outcome.error || outcome.exitCode !== 0) throw new Error('源码采集未完成：路径、链接、文件变化或预算限制；整份快照不可用');
      return { ok: true, cleanupConfirmed: true, snapshot: reader.result(target) };
    } catch (error) {
      return unavailable(error instanceof Error ? error.message : '源码采集失败', confirmed);
    } finally {
      accepting = false;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      stop = undefined;
      if (confirmed && this.sourceProcesses.get(id) === handle) this.sourceProcesses.delete(id);
      resolveSettled?.();
    }
  }

  async export(key: AppKey): Promise<AppSource> {
    await this.ensureLoaded();
    if (this.closing) throw new Error('应用服务正在关闭');
    const entry = this.entry(key);
    if (this.imports.busy(key)) throw new Error('import_in_progress');
    if (this.sourceProcesses.has(this.id(key))) throw new Error('source_helper_busy');
    if (
      entry.exitCompletion ||
      entry.operation ||
      entry.stopping ||
      entry.process ||
      entry.agentProcess ||
      entry.httpOperation ||
      !entry.snapshot.cleanupConfirmed
    )
      throw new Error('请先停止应用并确认清理，再导出源码');
    entry.cancelled = false;
    let result: { files: AppSourceFile[] } | undefined;
    entry.operation = (async () => {
      try {
        result = AppSourceSchema.omit({ sha256: true }).parse(await this.command(entry, 'export'));
        // Export encoding and decoded budget are checked by the shared wire contract.
        const paths = new Set<string>();
        for (const file of result.files) validateAppSourcePath(file.path, paths);
        const pinned = this.kind(entry).pinnedSource;
        if (pinned) entry.snapshot.sourceSha256 = pinned.verify(result.files, entry.snapshot.profile, false);
        return { ...entry.snapshot };
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
  async assertTaskAdmission(workspaceId: string | null): Promise<void> {
    await this.ensureLoaded();
    if (this.imports.blocksWorkspace(workspaceId)) throw new Error('denied: source import ownership is pending');
    for (const entry of this.entries.values()) {
      const denied = entry.snapshot.workspaceId === workspaceId ? this.kind(entry).unavailable.task : undefined;
      if (denied !== undefined) throw new Error(denied);
    }
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await this.ensureLoaded();
    const errors: unknown[] = [];
    try {
      await this.imports.shutdown();
    } catch (error) {
      errors.push(error);
    }
    for (const [id, handle] of this.sourceProcesses) {
      const outcome = await handle.stop();
      await handle.settled;
      if (outcome.confirmed && this.sourceProcesses.get(id) === handle) this.sourceProcesses.delete(id);
      else if (!outcome.confirmed) errors.push(new Error('源码 helper 清理未确认'));
    }
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
