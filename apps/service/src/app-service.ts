import {
  MotaTaskBindingSchema,
  MotaControlRequestSchema,
  type MotaTaskBinding,
  type MotaControlRequest,
  type MotaControlResponse,
  AppImportRequestSchema,
  AppImportTargetSchema,
  type AppImportRequest,
  type AppImportTarget,
  type AppImportOutcome,
  type EduVerificationLease,
} from '@wsl/protocol';
import { AppImports } from './app-imports';
import { ASSESSMENT_PREFIX, MAX_ASSESSMENT_FRAME } from './edu-assessment';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import {
  AgentCliEnvelopeSchema,
  AppOperationReceiptSchema,
  AppTargetSchema,
  type AppSourceSnapshotResult,
  type AgentCliEnvelope,
  type AppAgentOperation,
  type AppAgentResult,
  type AppLogs,
  AppProfileSchema,
  EduSourceSchema,
  motaSourceIdentityInput,
  EDU_REQUIRED_FILES,
  isEduSourcePath,
  type AppProfile,
  type AppSource,
  type EduSource,
  EduTaskBindingSchema,
  type EduTaskBinding,
  type EduTaskOperation,
  type EduTaskOperationResult,
} from '@wsl/protocol';
import { type GuestOutcome, type GuestProcess, type SbxConnection } from './sbx';
import { SourceSnapshotReader } from './source-snapshot';
import { EduTaskOperations } from './edu-task-operations';
import { MotaControls } from './mota-control';
import rawHelper from './app-helper.py?raw';
import ownedProcess from './edu-owned-process.py?raw';
import motaHelper from './mota-helper.py?raw';
import motaServer from './mota-server.cjs?raw';
const helper = rawHelper
  .replace('OWNED_PROCESS_BASE64 = ""', `OWNED_PROCESS_BASE64 = "${Buffer.from(ownedProcess).toString('base64')}"`)
  .replace('MOTA_HELPER_BASE64 = ""', `MOTA_HELPER_BASE64 = "${deflateSync(Buffer.from(motaHelper)).toString('base64')}"`)
  .replace('MOTA_SERVER_BASE64 = ""', `MOTA_SERVER_BASE64 = "${deflateSync(Buffer.from(motaServer)).toString('base64')}"`);
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
  /** Bounded non-verification stderr for the current standard/edu startup only. */
  startupStderr?: string;
  readyPort: number | null;
  readyError: string | null;
  motaBinding?: { requestId: string; origin: string; confirmed: boolean };
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
  sourceSnapshotTimeoutMs?: number;
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
  private readonly motaControls = new MotaControls();
  private entries = new Map<string, Entry>();
  private readonly sourceProcesses = new Map<string, { stop: () => Promise<GuestOutcome>; settled: Promise<void> }>();
  private readonly eduTaskOperations = new EduTaskOperations();
  private closing = false;
  private verification = new Map<string, { lease: EduVerificationLease; request: (line: string) => void; fail: () => void }>();
  private persistence: Promise<void> = Promise.resolve();
  private options: AppServiceOptions;
  private loaded: Promise<void> | null = null;
  private registrySandbox: string | null = null;
  private legacyRegistry: string | null = null;
  private readonly imports: AppImports;
  constructor(
    private connection: Pick<SbxConnection, 'getStatus' | 'runtimeTarget'> & {
      start: (
        ...args: Parameters<SbxConnection['start']>
      ) => Pick<GuestProcess, 'done' | 'close'> & Partial<Pick<GuestProcess, 'write' | 'closeInput'>>;
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
        this.options.onSnapshot?.(structuredClone(entry.snapshot));
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
    entry.motaBinding = undefined;
    if (operation === 'start') entry.startupStderr = '';
    const mota = entry.snapshot.profile.projectKind === 'mota-web';
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
        argv: ['python3', '-I', '-u', '-c', helper],
        ...(verification || (mota && operation === 'start') ? { duplex: true } : {}),
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
          }) + (verification || mota ? '\n' : ''),
      },
      (frame) => {
        if (frame.type === 'output') {
          if (!verification) entry.log = (entry.log + frame.data).slice(-12 * 1024 * 1024);
          if (!verification && !mota && operation === 'start' && frame.stream === 'stderr')
            entry.startupStderr = ((entry.startupStderr ?? '') + frame.data).slice(-4000);
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
                if ((!mota && entry.snapshot.profile.projectKind !== 'edu-web') || sourceSeen || !/^[a-f0-9]{64}$/.test(digest))
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
              if (mota) {
                if (this.motaControls.receive(message)) continue;
                const identity = z
                  .object({
                    workspaceId: z.literal(workspaceId),
                    environmentId: z.literal('sandbox'),
                    projectId: z.literal(projectId),
                    appInstanceId: z.literal(appInstanceId),
                  })
                  .strict();
                const event = z
                  .discriminatedUnion('event', [
                    z.object({ event: z.literal('mota-listening'), guestPort: z.number().int().min(1).max(65535), identity }).strict(),
                    z.object({ event: z.literal('mota-origin-bound'), requestId: z.string(), origin: z.string(), identity }).strict(),
                  ])
                  .safeParse(message);
                if (!event.success) {
                  entry.readyError = '魔塔启动回执身份或格式不匹配';
                  continue;
                }
                if (event.data.event === 'mota-listening') {
                  if (entry.readyPort !== null || !sourceSeen) entry.readyError = '魔塔端口或源码回执不匹配';
                  else {
                    entry.readyPort = event.data.guestPort;
                    entry.snapshot.guestPort = event.data.guestPort;
                  }
                } else {
                  const binding = entry.motaBinding;
                  if (!binding || binding.confirmed || binding.requestId !== event.data.requestId || binding.origin !== event.data.origin)
                    entry.readyError = '魔塔来源绑定回执不匹配';
                  else binding.confirmed = true;
                }
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
    if (entry.commandProcess) throw new Error('edu_task_helper_cleanup_unknown');
    const owner = task ? this.eduTaskOperations.known(task) : undefined;
    if (task && !owner) throw new Error('edu_task_owner_unknown');
    if (owner && this.closing) throw new Error('edu_task_service_closing');
    const activeProcess = entry.process;
    const cleanupConfirmed = entry.snapshot.cleanupConfirmed;
    // A transport may dispatch before throwing. Until a precise handle is bound,
    // neither an RPC rejection nor the long-lived App state proves cleanup.
    if (owner) this.eduTaskOperations.beginDispatch(owner);
    const child = this.launch(entry, operation, files, task);
    entry.commandProcess = child;
    const timeout = owner
      ? undefined
      : setTimeout(() => {
          entry.cancelled = true;
          void child.close();
        }, 30000);
    let confirmed = false;
    try {
      const result = owner ? await this.eduTaskOperations.wait(owner, child, 30000) : await child.done;
      confirmed = result.confirmed;
      if (!activeProcess) entry.snapshot.cleanupConfirmed = result.confirmed;
      if (result.confirmed && entry.process === child) entry.process = null;
      if (entry.cancelled || owner?.cancelled || result.error || !result.confirmed || result.exitCode !== 0)
        throw new Error(
          owner
            ? owner.cancelled
              ? 'edu_task_cancelled'
              : 'edu_task_helper_failed'
            : entry.cancelled
              ? '应用操作已取消或超时'
              : (result.error ?? entry.log.slice(-4000)),
        );
      const line = entry.log.split('\n').find((line) => line.startsWith('WSL_APP_RESULT:'));
      if (!line) throw new Error('应用操作缺少回执');
      return JSON.parse(line.slice('WSL_APP_RESULT:'.length)) as unknown;
    } finally {
      clearTimeout(timeout);
      if (confirmed && entry.commandProcess === child) entry.commandProcess = null;
      if (activeProcess) entry.snapshot.cleanupConfirmed = cleanupConfirmed;
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
  async importSource(input: AppImportRequest): Promise<AppImportOutcome> {
    let parsed: AppImportRequest;
    try {
      parsed = AppImportRequestSchema.parse(input);
      if ('profile' in parsed) {
        const metadata = parsed.files.map((file) => {
          const bytes = Buffer.from(file.base64, 'base64');
          return { path: file.path, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
        });
        if (
          motaSourceIdentityInput(metadata) !== motaSourceIdentityInput(parsed.source.files) ||
          createHash('sha256').update(motaSourceIdentityInput(metadata)).digest('hex') !== parsed.source.sourceSha256
        )
          throw new Error('mota_source_mismatch');
        parsed.source.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      } else validateEduSources(parsed.files, parsed.source, true);
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
    return {
      snapshot: {
        ...key,
        profile: structuredClone(profile),
        ...(profile.projectKind !== 'standard-app' ? { sourceSha256: profile.source.sourceSha256 } : {}),
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
    if (this.imports.busy(key)) throw new Error('import_in_progress');
    if ([...this.entries.values()].some((entry) => entry.snapshot.projectId === key.projectId)) throw new Error('应用项目已绑定其他空间');
    const entry: Entry = {
      snapshot: {
        ...key,
        profile: structuredClone(profile),
        ...(profile.projectKind !== 'standard-app' ? { sourceSha256: profile.source.sourceSha256 } : {}),
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
    if (entry.snapshot.profile.projectKind === 'mota-web' && this.motaControls.hasUnsettled(key.workspaceId, key.projectId))
      throw new Error('魔塔运行租约尚未释放，不能重启应用');
    if (this.imports.busy(key)) throw new Error('import_in_progress');
    if (
      entry.operation ||
      entry.stopping ||
      entry.commandProcess ||
      this.eduTaskOperations.busy(key) ||
      this.sourceProcesses.has(this.id(key))
    )
      throw new Error('应用操作进行中或 helper 清理未确认');
    if (entry.agentProcess || entry.httpOperation) throw new Error('应用控制面操作或结果待确认');
    if (entry.snapshot.state === 'running') return this.get(key);
    if (!entry.snapshot.cleanupConfirmed || entry.portPending || entry.process) throw new Error('上次应用清理尚未确认');
    if ([...this.entries.values()].some((other) => other !== entry && ['starting', 'running', 'stopping'].includes(other.snapshot.state)))
      throw new Error('首版仅允许一个应用服务运行');
    entry.cancelled = false;
    entry.agentToken = entry.snapshot.profile.projectKind === 'standard-app' ? randomBytes(32).toString('hex') : null;
    entry.snapshot = {
      ...entry.snapshot,
      appInstanceId:
        verification?.lease.identity.appInstanceId ?? (reservedInstanceId ? z.string().uuid().parse(reservedInstanceId) : randomUUID()),
      state: 'starting',
      error: null,
      url: null,
      guestPort: null,
    };
    if (entry.snapshot.profile.projectKind === 'mota-web') this.motaControls.retireReleased(key.workspaceId, key.projectId);
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
    const child = spawn(binary, ['exec', '-i', '-w', '/home/agent/workspace', sandbox, 'python3', '-I', '-u', '-c', helper, request], {
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
    let childOutcome: GuestOutcome | null = null;
    const exitDiagnostic = (): string | null => {
      if (!childOutcome) return null;
      const markers = entry.log
        .split('\n')
        .filter((line) => /^mota-server:[a-z_]+$/.test(line))
        .slice(-4);
      const stderr = entry.snapshot.profile.projectKind !== 'mota-web' ? entry.startupStderr?.trim() : undefined;
      return `应用启动进程退出（exitCode=${childOutcome.exitCode ?? 'unknown'}，cleanupConfirmed=${childOutcome.confirmed}）${
        markers.length ? '：' + markers.join('; ') : ''
      }${stderr ? '；stderr: ' + stderr : ''}${childOutcome.error ? '；' + childOutcome.error.slice(0, 1000) : ''}`;
    };
    const checkChild = () => {
      const failure = exitDiagnostic();
      if (failure) throw new Error(failure);
    };
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
      void child.done.then((outcome) => {
        childOutcome = outcome;
      });
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
      await this.persist();
      checkChild();
      const receipt = await this.ports(['--publish', `${guestPort}/tcp4`]);
      const published = /^Published 127\.0\.0\.1:(\d+) -> (\d+)\/tcp4\s*$/m.exec(receipt);
      if (!published || Number(published[2]) !== guestPort) {
        checkChild();
        throw new Error('端口发布回执未知，不能推断映射所有权');
      }
      // Even an exited child may have acquired this exact mapping. Preserve the
      // publication receipt before reporting exit; cleanup must retain its unknown gate.
      entry.port = portSchema.parse({ host_ip: '127.0.0.1', host_port: Number(published[1]), sandbox_port: guestPort, protocol: 'tcp4' });
      entry.recoveryUrl = `http://127.0.0.1:${entry.port.host_port}`;
      await this.persist();
      checkChild();
      check();
      const ports = await this.listPorts();
      checkChild();
      const ownedPort = entry.port;
      if (!ports.some((port) => this.samePort(port, ownedPort))) throw new Error('映射核对与发布回执不同');
      const url = `http://127.0.0.1:${entry.port.host_port}`;
      if (entry.snapshot.profile.projectKind === 'mota-web') {
        if (!child.write) throw new Error('魔塔双向控制通道不可用');
        entry.motaBinding = { requestId: randomUUID(), origin: url, confirmed: false };
        child.write({
          type: 'input',
          data:
            JSON.stringify({
              type: 'bind-origin',
              requestId: entry.motaBinding.requestId,
              origin: url,
              identity: {
                workspaceId: entry.snapshot.workspaceId,
                environmentId: 'sandbox',
                projectId: entry.snapshot.projectId,
                appInstanceId: entry.snapshot.appInstanceId,
              },
            }) + '\n',
        });
        while (!entry.motaBinding.confirmed) {
          check();
          if (entry.readyError) throw new Error(entry.readyError);
          checkChild();
          await delay(25);
        }
      }
      while (true) {
        check();
        if (entry.readyError) throw new Error(entry.readyError);
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
                templateId: z.literal(
                  entry.snapshot.profile.projectKind === 'standard-app' ? 'wsl-standard-app' : entry.snapshot.profile.projectKind,
                ),
                templateVersion: entry.snapshot.profile.projectKind !== 'standard-app' ? z.literal('1.0.0') : z.enum(['1.0.0', '1.1.0']),
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
      const diagnostic = exitDiagnostic();
      entry.snapshot.error = String(error);
      if (diagnostic && !entry.snapshot.error.includes(diagnostic)) entry.snapshot.error += '; ' + diagnostic;
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
    if (
      !this.closing &&
      entry.snapshot.profile.projectKind === 'mota-web' &&
      this.motaControls.hasUnsettled(key.workspaceId, key.projectId)
    )
      throw new Error('魔塔运行租约尚未释放，不能停止应用');
    if (entry.stopping) return entry.stopping;
    entry.cancelled = true;
    entry.snapshot.state = 'stopping';
    const operation = entry.operation;
    entry.stopping = (async () => {
      const taskCleanup = await Promise.all(this.eduTaskOperations.bindings(key).map((binding) => this.cancelEduTask(binding)));
      const taskConfirmed = taskCleanup.every((result) => result.cleanupConfirmed);
      // An ended transport's failed done promise cannot perform another cleanup.
      // Release only that edu handle; ownership/source/mapping facts stay intact
      // and the durable recovery helper must establish an independent proof.
      if (
        entry.snapshot.profile.projectKind === 'edu-web' &&
        entry.processExited &&
        !entry.snapshot.cleanupConfirmed &&
        !operation &&
        !entry.commandProcess &&
        taskConfirmed
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
        !operation &&
        taskConfirmed
      )
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
      if (!taskConfirmed || entry.commandProcess) {
        entry.snapshot.cleanupConfirmed = false;
        entry.snapshot.error = 'edu_task_helper_cleanup_unknown';
      }
      // Shutdown closes the shared sbx connection after this stop settles. A
      // failed close that has now ended must recover here, not on a later RPC.
      if (
        entry.snapshot.profile.projectKind === 'edu-web' &&
        entry.processExited &&
        !entry.snapshot.cleanupConfirmed &&
        !entry.commandProcess &&
        !entry.operation &&
        taskConfirmed
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
    if (entry.snapshot.profile.projectKind !== 'standard-app')
      return { ...fail('unsupported', `${entry.snapshot.profile.projectKind} profile 不支持标准应用控制面`), operationDispatched: false };
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
          argv: ['python3', '-I', '-u', '-c', helper],
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
    let profile: AppProfile;
    try {
      await this.ensureLoaded();
      const entry = this.entry(key);
      profile = structuredClone(entry.snapshot.profile);
      if (profile.projectKind === 'mota-web') return unavailable('mota-web 暂不支持任务源码采集', true);
      if (this.sourceProcesses.has(id)) return unavailable('上次源码 helper 尚未确认清理', false);
      if (this.closing || signal?.aborted) return unavailable('源码采集已取消或服务正在关闭', true);
      if (this.imports.busy(key) || entry.operation || entry.stopping || entry.commandProcess || this.eduTaskOperations.busy(key))
        return unavailable('工程有限 helper 正在运行或清理未确认；未启动源码采集', true);
      if (!this.connection.getStatus().available) return unavailable('源码采集服务不可用；未启动 helper', true);
    } catch {
      return unavailable('源码工程不可用或未创建；未启动 helper', !this.sourceProcesses.has(id));
    }
    const reader = new SourceSnapshotReader();
    let failure: string | null = null;
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
          prompt: JSON.stringify({ operation: 'source-snapshot', ...target, profile }),
        },
        (frame) => {
          if (failure || frame.type !== 'output' || frame.stream !== 'stdout') return;
          try {
            reader.accept(frame.data);
          } catch {
            failure = '源码采集回执无效或超过路径、数量、字节预算';
            if (stop) void stop();
          }
        },
      );
    } catch {
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
          .catch((): GuestOutcome => ({ confirmed: false, exitCode: null, error: '源码 helper 清理失败' }));
        void stopping.then((outcome) => {
          resolveStopped?.(outcome);
          if (!outcome.confirmed) stopping = undefined;
        });
      }
      return stopping;
    };
    const handle = { stop, settled };
    this.sourceProcesses.set(id, handle);
    const cancel = () => {
      failure ??= '源码采集已取消或超时';
      void handle.stop();
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
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      stop = undefined;
      if (confirmed && this.sourceProcesses.get(id) === handle) this.sourceProcesses.delete(id);
      resolveSettled?.();
    }
  }
  async export(key: AppKey, taskSnapshot = false, task?: EduTaskBinding): Promise<AppSource> {
    await this.ensureLoaded();
    if (this.closing) throw new Error('应用服务正在关闭');
    const entry = this.entry(key);
    if (entry.snapshot.profile.projectKind === 'mota-web') throw new Error('unsupported: mota-web source export');
    if (this.imports.busy(key)) throw new Error('import_in_progress');
    if (this.sourceProcesses.has(this.id(key)) || (!task && this.eduTaskOperations.busy(key))) throw new Error('source_helper_busy');
    if (
      entry.operation ||
      entry.commandProcess ||
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
        result = z.object({ files: z.array(fileSchema) }).parse(await this.command(entry, 'export', undefined, task));
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
  registerMotaTask(binding: MotaTaskBinding): void {
    if (this.closing) throw new Error('mota_service_closing');
    this.motaControls.register(binding);
  }
  assertMotaTaskActive(binding: MotaTaskBinding): void {
    this.motaControls.assertActive(binding);
  }
  async motaControl(input: MotaControlRequest): Promise<MotaControlResponse> {
    const request = MotaControlRequestSchema.parse(input);
    await this.ensureLoaded();
    return this.motaControls.call(request, (command) => {
      const entry = this.entry({ workspaceId: command.binding.workspaceId, projectId: command.binding.projectId });
      if (
        this.closing ||
        entry.snapshot.profile.projectKind !== 'mota-web' ||
        entry.snapshot.state !== 'running' ||
        entry.snapshot.appInstanceId !== command.binding.appInstanceId ||
        entry.processExited ||
        !entry.process?.write ||
        !entry.motaBinding?.confirmed
      )
        throw new Error('魔塔应用实例或控制传输不可用；租约状态未知');
      entry.process.write({ type: 'input', data: JSON.stringify(command) + '\n' });
    });
  }
  async assertTaskAdmission(workspaceId: string | null, binding?: EduTaskBinding, motaInput?: MotaTaskBinding): Promise<void> {
    await this.ensureLoaded();
    const mota = [...this.entries.values()].find(
      (entry) => entry.snapshot.workspaceId === workspaceId && entry.snapshot.profile.projectKind === 'mota-web',
    );
    if (mota) {
      const bound = motaInput && MotaTaskBindingSchema.parse(motaInput);
      if (
        binding ||
        !bound ||
        bound.workspaceId !== workspaceId ||
        bound.projectId !== mota.snapshot.projectId ||
        bound.appInstanceId !== mota.snapshot.appInstanceId ||
        mota.snapshot.state !== 'running'
      )
        throw new Error('denied: mota-web requires a bound read-only task and live app lease');
      return;
    }
    if (motaInput) throw new Error('denied: Mota task does not belong to this project');
    const edu = [...this.entries.values()].find(
      (entry) => entry.snapshot.workspaceId === workspaceId && entry.snapshot.profile.projectKind === 'edu-web',
    );
    if (edu && (!binding || binding.workspaceId !== workspaceId || binding.projectId !== edu.snapshot.projectId))
      throw new Error('denied: edu tasks require a frozen candidate workspace');
  }
  /** Called synchronously at send admission, before the queued source capture. */
  registerEduTask(binding: EduTaskBinding): void {
    if (this.closing) throw new Error('edu_task_service_closing');
    this.eduTaskOperations.admit(binding);
  }
  assertEduTaskActive(binding: EduTaskBinding): void {
    if (this.closing) throw new Error('edu_task_service_closing');
    const owner = this.eduTaskOperations.known(binding);
    if (!owner) throw new Error('edu_task_owner_unknown');
    this.eduTaskOperations.assertActive(owner);
  }
  private async readTaskSource(binding: EduTaskBinding): Promise<GuestWorkspace> {
    await this.ensureLoaded();
    const entry = this.entry({ workspaceId: binding.workspaceId, projectId: binding.projectId });
    if (
      entry.snapshot.profile.projectKind !== 'edu-web' ||
      entry.snapshot.state !== 'running' ||
      entry.snapshot.appInstanceId !== binding.appInstanceId
    )
      throw new Error('conflict: edu task application instance changed');
    const source = await this.export({ workspaceId: binding.workspaceId, projectId: binding.projectId }, true, binding);
    if (entry.snapshot.state !== 'running' || entry.snapshot.appInstanceId !== binding.appInstanceId)
      throw new Error('conflict: edu task application stopped during snapshot');
    assertEduTaskSource(binding, source.files);
    return { runId: binding.runId, files: source.files };
  }
  async taskSource(input: EduTaskBinding): Promise<GuestWorkspace> {
    const binding = EduTaskBindingSchema.parse(input);
    this.registerEduTask(binding);
    const owner = this.eduTaskOperations.known(binding)!;
    return this.eduTaskOperations.run(owner, () => this.readTaskSource(binding));
  }
  private readonly preparedTasks = new Map<string, string>();
  eduTaskFailure(binding: EduTaskBinding, operation: EduTaskOperation, error: unknown): EduTaskOperationResult {
    const parsed = EduTaskBindingSchema.parse(binding);
    let cleanupConfirmed = false;
    try {
      cleanupConfirmed = this.eduTaskOperations.clean(parsed);
    } catch {
      /* mismatched ownership remains unknown */
    }
    return {
      binding: parsed,
      operation,
      ok: false,
      cleanupConfirmed,
      error: error instanceof Error && error.message ? error.message.slice(0, 1000) : 'edu_task_operation_failed',
    };
  }
  async prepareTask(input: EduTaskBinding, candidate: GuestWorkspace): Promise<EduTaskOperationResult> {
    const binding = EduTaskBindingSchema.parse(input);
    try {
      this.registerEduTask(binding);
      const owner = this.eduTaskOperations.known(binding)!;
      await this.eduTaskOperations.run(owner, async () => {
        await this.readTaskSource(binding);
        this.eduTaskOperations.assertActive(owner);
        assertEduTaskCandidate(binding, candidate);
        this.preparedTasks.set(binding.runId, JSON.stringify({ binding, candidate }));
      });
      this.eduTaskOperations.assertActive(owner);
      return { binding, operation: 'prepare', ok: true, cleanupConfirmed: true };
    } catch (error) {
      return this.eduTaskFailure(binding, 'prepare', error);
    }
  }
  async applyTask(input: EduTaskBinding, candidate: GuestWorkspace): Promise<EduTaskOperationResult> {
    const binding = EduTaskBindingSchema.parse(input);
    try {
      if (this.closing) throw new Error('edu_task_service_closing');
      const owner = this.eduTaskOperations.known(binding);
      if (!owner || this.preparedTasks.get(binding.runId) !== JSON.stringify({ binding, candidate }))
        throw new Error('conflict: edu task candidate was not prepared');
      const app = await this.eduTaskOperations.run(owner, async () => {
        if (this.closing) throw new Error('edu_task_service_closing');
        this.preparedTasks.delete(binding.runId);
        const key = { workspaceId: binding.workspaceId, projectId: binding.projectId };
        const entry = this.entry(key);
        if (
          this.imports.busy(key) ||
          this.sourceProcesses.has(this.id(key)) ||
          entry.commandProcess ||
          entry.operation ||
          entry.stopping ||
          entry.snapshot.state !== 'running' ||
          entry.snapshot.appInstanceId !== binding.appInstanceId
        )
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
          // Keep the run pending through durable publication. Cancellation must
          // settle this write before Main captures its after-source or unlocks.
          entry.operation = null;
          await this.persist();
          if (applied) this.options.onSnapshot?.(structuredClone(entry.snapshot));
        }
      });
      this.eduTaskOperations.assertActive(owner);
      return { binding, operation: 'apply', ok: true, cleanupConfirmed: true, app };
    } catch (error) {
      return this.eduTaskFailure(binding, 'apply', error);
    }
  }
  async cancelEduTask(input: EduTaskBinding): Promise<EduTaskOperationResult> {
    const binding = EduTaskBindingSchema.parse(input);
    try {
      const owner = this.eduTaskOperations.known(binding);
      const child = owner?.helper?.child;
      this.preparedTasks.delete(binding.runId);
      const confirmed = await this.eduTaskOperations.cancel(binding);
      if (confirmed && child) {
        const entry = this.entries.get(this.id(binding));
        if (entry?.commandProcess === child) entry.commandProcess = null;
        if (entry?.process === child) entry.process = null;
      }
      if (!confirmed) return { binding, operation: 'cancel', ok: false, cleanupConfirmed: false, error: 'edu_task_helper_cleanup_unknown' };
      return { binding, operation: 'cancel', ok: true, cleanupConfirmed: true };
    } catch (error) {
      return this.eduTaskFailure(binding, 'cancel', error);
    }
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    await this.ensureLoaded();
    const errors: unknown[] = [];
    for (const [id, handle] of this.sourceProcesses) {
      const outcome = await handle.stop();
      await handle.settled;
      if (outcome.confirmed) this.sourceProcesses.delete(id);
      else errors.push(new Error('源码 helper 清理未确认'));
    }
    for (const binding of this.eduTaskOperations.bindings()) {
      const result = await this.cancelEduTask(binding);
      if (!result.cleanupConfirmed) errors.push(new Error('edu_task_helper_cleanup_unknown'));
    }
    try {
      await this.eduTaskOperations.shutdown();
    } catch (error) {
      errors.push(error);
    }
    try {
      await this.imports.shutdown();
    } catch (error) {
      errors.push(error);
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
