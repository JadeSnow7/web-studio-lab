import path from 'node:path';
import { z } from 'zod';
import type {
  EnvironmentDescription,
  ObservationRequest,
  ObservationResult,
  ResourceInstanceIdentity,
  FileInvalidationHint,
} from '@wsl/protocol';
import { FileObservationProvider, FileObservationError } from './observation-files';
import { LocalTerminal } from './local-terminal';
import { SshTerminal } from './ssh-terminal';
import { SshObservationConnection, type SshObservationConfig } from './observation-ssh';
import { Terminal } from './terminal';
import type { SbxConnection } from './sbx';
import type { TerminalSnapshot } from '@wsl/protocol';

const Root = z.string().min(1).max(4096).refine(path.isAbsolute, 'An absolute authorized root is required');
const SshConfig = z
  .object({
    host: z.string().min(1).max(253),
    port: z.coerce.number().int().min(1).max(65535).default(22),
    username: z.string().min(1).max(200),
    hostKeySha256: z.string().regex(/^[a-f0-9]{64}$/i),
    agent: z.string().min(1).max(4096),
    root: Root,
  })
  .strict();
type RuntimeTerminal = Terminal | LocalTerminal | SshTerminal;
interface Entry {
  identity: ResourceInstanceIdentity;
  retired: boolean;
  files?: FileObservationProvider;
  filesOpening?: Promise<FileObservationProvider | null>;
  terminalOpening?: boolean;
  terminal?: RuntimeTerminal;
}

/** Runtime leases are supplied by Main. Configured roots and credentials never enter its snapshot. */
export class EnvironmentResources {
  private readonly entries = new Map<string, Entry>();
  private readonly localRoot: string | null;
  private readonly sshConfig: (SshObservationConfig & { root: string }) | null;
  private readonly configurationErrors = new Map<string, string>();
  private ssh: Promise<SshObservationConnection> | null = null;
  constructor(
    private readonly sandbox: SbxConnection,
    private readonly onTerminal: (snapshot: TerminalSnapshot, identity: ResourceInstanceIdentity) => void,
    private readonly onHint: (hint: FileInvalidationHint) => void,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    const local = env['WSL_OBSERVATION_ROOT'] ? Root.safeParse(env['WSL_OBSERVATION_ROOT']) : null;
    this.localRoot = local?.success ? local.data : null;
    if (local && !local.success) this.configurationErrors.set('local', 'WSL_OBSERVATION_ROOT must be an absolute authorized root');
    const hasSsh = ['WSL_SSH_HOST', 'WSL_SSH_USER', 'WSL_SSH_HOST_KEY_SHA256', 'WSL_SSH_ROOT'].some((key) => env[key]);
    const ssh = hasSsh
      ? SshConfig.safeParse({
          host: env['WSL_SSH_HOST'],
          port: env['WSL_SSH_PORT'],
          username: env['WSL_SSH_USER'],
          hostKeySha256: env['WSL_SSH_HOST_KEY_SHA256'],
          agent: env['SSH_AUTH_SOCK'],
          root: env['WSL_SSH_ROOT'],
        })
      : null;
    this.sshConfig = ssh?.success ? ssh.data : null;
    if (ssh && !ssh.success)
      this.configurationErrors.set('ssh', 'SSH requires host, user, valid port, trusted SHA256 pin, authorized root and agent socket');
  }
  list(): EnvironmentDescription[] {
    const status = this.sandbox.getStatus();
    return [
      {
        environmentId: 'local',
        kind: 'local',
        label: '本设备',
        state: 'configured',
        reason: this.localRoot ? null : (this.configurationErrors.get('local') ?? '未配置 WSL_OBSERVATION_ROOT；本地文件和终端不可用'),
        capabilities: { browser: true, files: !!this.localRoot, terminal: !!this.localRoot },
      },
      {
        environmentId: 'sandbox',
        kind: 'sandbox',
        label: status.sandbox ?? 'Codex sandbox',
        state: status.available ? 'configured' : 'unavailable',
        reason: status.reason,
        capabilities: { browser: false, files: false, terminal: status.available },
      },
      {
        environmentId: 'ssh',
        kind: 'ssh',
        label: 'SSH',
        state: this.sshConfig ? 'configured' : 'unavailable',
        reason: this.sshConfig ? null : (this.configurationErrors.get('ssh') ?? '未配置可信 SSH 环境'),
        capabilities: { browser: false, files: !!this.sshConfig, terminal: !!this.sshConfig },
      },
    ];
  }
  private async sshConnection() {
    if (!this.sshConfig) throw new FileObservationError('unavailable', 'Trusted SSH environment is not configured');
    if (!this.ssh) {
      const attempt = SshObservationConnection.connect(this.sshConfig);
      this.ssh = attempt;
      try {
        await attempt;
      } catch (error) {
        if (this.ssh === attempt) this.ssh = null;
        throw error;
      }
    }
    const connection = await this.ssh;
    if (!connection.available) throw new FileObservationError('unavailable', 'SSH connection closed; explicit resource reopen is required');
    return connection;
  }
  async register(identity: ResourceInstanceIdentity) {
    if (identity.kind === 'browser') throw new FileObservationError('unsupported', 'Browser instances belong to Main');
    const previous = this.entries.get(identity.resourceId);
    if (previous) {
      if (
        previous.identity.workspaceId !== identity.workspaceId ||
        previous.identity.environmentId !== identity.environmentId ||
        previous.identity.kind !== identity.kind
      )
        throw new FileObservationError('unauthorized', 'Resource lease belongs to a different workspace or environment');
      if (previous.identity.instanceId === identity.instanceId && previous.identity.instanceGeneration === identity.instanceGeneration) {
        if (previous.retired) throw new FileObservationError('unavailable', 'Resource lease is retired');
        return;
      }
      if (identity.instanceGeneration <= previous.identity.instanceGeneration)
        throw new FileObservationError('unavailable', 'Resource instance generation is stale');
      previous.retired = true;
      await previous.filesOpening;
      await previous.terminal?.shutdown();
      await previous.files?.close();
      if (identity.environmentId === 'ssh' && this.ssh && !(await this.ssh).available) this.ssh = null;
    }
    this.entries.set(identity.resourceId, { identity: Object.freeze({ ...identity }), retired: false });
  }
  private entry(identity: ResourceInstanceIdentity) {
    const entry = this.entries.get(identity.resourceId);
    if (
      !entry ||
      entry.retired ||
      ['workspaceId', 'environmentId', 'resourceId', 'kind', 'instanceId', 'instanceGeneration'].some(
        (key) => entry.identity[key as keyof ResourceInstanceIdentity] !== identity[key as keyof ResourceInstanceIdentity],
      )
    )
      throw new FileObservationError('unauthorized', 'Resource instance is not registered in this environment');
    return entry;
  }
  async openTerminal(identity: ResourceInstanceIdentity, cols: number, rows: number) {
    const entry = this.entry(identity);
    if (identity.kind !== 'terminal') throw new FileObservationError('unsupported', 'Not a terminal resource');
    if (entry.terminalOpening) throw new FileObservationError('unavailable', 'Terminal is already opening');
    entry.terminalOpening = true;
    try {
      if (!entry.terminal) {
        const terminalIdentity = { ...identity, kind: 'terminal' as const };
        const emit = (snapshot: TerminalSnapshot) => this.onTerminal(snapshot, identity);
        if (identity.environmentId === 'sandbox') entry.terminal = new Terminal(this.sandbox, terminalIdentity, emit);
        else if (identity.environmentId === 'local') {
          if (!this.localRoot) throw new FileObservationError('unavailable', 'No authorized local root is configured');
          entry.terminal = new LocalTerminal(this.localRoot, terminalIdentity, emit);
        } else if (identity.environmentId === 'ssh') {
          const connection = await this.sshConnection();
          this.entry(identity);
          entry.terminal = new SshTerminal(connection, terminalIdentity, emit);
        } else throw new FileObservationError('unauthorized', 'Environment is not configured');
      }
      return await entry.terminal.open(cols, rows);
    } catch (error) {
      // No adapter was acquired: connection/configuration failure happened
      // before any shell request, so there is no process with unknown ownership.
      if (!entry.terminal && !entry.retired)
        this.onTerminal(
          {
            ...this.terminalSnapshot(identity),
            seq: 1,
            state: 'failed',
            cleanupPending: false,
            error: (error as Error).message,
          },
          identity,
        );
      throw error;
    } finally {
      entry.terminalOpening = false;
    }
  }
  identity(resourceId: string) {
    const entry = this.entries.get(resourceId);
    if (!entry || entry.retired) throw new FileObservationError('unavailable', 'Resource is not registered');
    return entry.identity;
  }
  terminal(identity: ResourceInstanceIdentity) {
    const terminal = this.entry(identity).terminal;
    if (!terminal) throw new FileObservationError('unavailable', 'Terminal instance is not open');
    return terminal;
  }
  terminalSnapshot(identity: ResourceInstanceIdentity): TerminalSnapshot {
    const entry = this.entry(identity);
    if (identity.kind !== 'terminal') throw new FileObservationError('unsupported', 'Not a terminal resource');
    if (entry.terminal) return entry.terminal.get();
    return {
      seq: 0,
      sessionId: null,
      sandbox: identity.environmentId === 'sandbox' ? this.sandbox.getStatus().sandbox : null,
      cwd: null,
      state: 'idle',
      output: '',
      outputOffset: 0,
      cleanupPending: false,
      error: null,
    };
  }
  private async openFiles(entry: Entry) {
    let files: FileObservationProvider;
    if (entry.identity.environmentId === 'local') {
      if (!this.localRoot) throw new FileObservationError('unavailable', 'No authorized local root is configured');
      files = new FileObservationProvider({ ...entry.identity, root: this.localRoot, onInvalidated: this.onHint });
    } else if (entry.identity.environmentId === 'ssh' && this.sshConfig) {
      const transport = await (await this.sshConnection()).fileTransport();
      files = new FileObservationProvider({ ...entry.identity, root: this.sshConfig.root, transport });
    } else throw new FileObservationError('unsupported', 'File observation is unavailable in this environment');
    entry.files = files;
    if (entry.retired || this.entries.get(entry.identity.resourceId) !== entry) {
      await files.close();
      entry.files = undefined;
      return null;
    }
    return files;
  }
  async observe(request: ObservationRequest, signal?: AbortSignal): Promise<ObservationResult> {
    try {
      if (signal?.aborted) return { error: 'cancelled', message: 'Observation cancelled' };
      if (!request.target || request.target.workspaceId !== request.workspaceId)
        throw new FileObservationError('unauthorized', 'An explicit resource instance is required');
      const entry = this.entry(request.target);
      const args = request.args;
      let result: ObservationResult;
      if (request.tool.startsWith('files.')) {
        if (entry.identity.kind !== 'file') throw new FileObservationError('unsupported', 'Not a file resource');
        if (!entry.files) {
          if (!entry.filesOpening) {
            const opening = this.openFiles(entry).finally(() => {
              if (entry.filesOpening === opening) entry.filesOpening = undefined;
            });
            entry.filesOpening = opening;
          }
          await entry.filesOpening;
        }
        const files = entry.files;
        if (!files) throw new FileObservationError('unavailable', 'Resource was retired while opening files');
        if (request.tool === 'files.read')
          result = await files.read(
            z
              .object({
                path: z.string().min(1).max(4096),
                cursor: z.string().max(4096).optional(),
                maxBytes: z.number().int().min(4).max(65536).optional(),
              })
              .strict()
              .parse(args),
            Date.now() + 5000,
            signal,
          );
        else if (request.tool === 'files.list')
          result = await files.list(
            z
              .object({ path: z.string().max(4096).optional(), limit: z.number().int().min(1).max(500).optional() })
              .strict()
              .parse(args),
            signal,
          );
        else if (request.tool === 'files.search')
          result = await files.search(
            z
              .object({
                path: z.string().max(4096).optional(),
                query: z.string().min(1).max(512),
                limit: z.number().int().min(1).max(100).optional(),
              })
              .strict()
              .parse(args),
            signal,
          );
        else throw new FileObservationError('unsupported', 'Unsupported file observation');
      } else {
        const observer = entry.terminal?.observation;
        if (!observer) throw new FileObservationError('unavailable', 'No live PTY observation is available');
        if (request.tool === 'terminal.read_screen')
          result = await observer.readScreen(
            z
              .object({ viewportY: z.number().int().nonnegative().optional(), maxLines: z.number().int().min(1).max(300).optional() })
              .strict()
              .parse(args),
          );
        else if (request.tool === 'terminal.read_output')
          result = observer.readOutput(
            z
              .object({ cursor: z.string().max(4096).optional(), maxChars: z.number().int().min(1).max(65536).optional() })
              .strict()
              .parse(args),
          );
        else if (request.tool === 'terminal.read_command')
          result = await observer.readCommand(
            z
              .object({ commandId: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional() })
              .strict()
              .parse(args),
          );
        else throw new FileObservationError('unsupported', 'Unsupported environment observation');
      }
      if (signal?.aborted) return { error: 'cancelled', message: 'Observation cancelled' };
      if (this.entries.get(entry.identity.resourceId) !== entry)
        return { error: 'unavailable', message: 'Resource instance was replaced during observation' };
      if (entry.retired) return { error: 'unavailable', message: 'Resource lease retired' };
      return result;
    } catch (error) {
      if (error instanceof z.ZodError) return { error: 'invalid_request', message: 'Invalid observation arguments' };
      if (error instanceof FileObservationError) return { error: error.code, message: error.message };
      return { error: 'unavailable', message: error instanceof Error ? error.message : String(error) };
    }
  }
  async shutdown() {
    for (const entry of this.entries.values()) entry.retired = true;
    const results = await Promise.allSettled(
      [...this.entries.values()]
        .map(async (entry) => {
          if (entry.filesOpening) await entry.filesOpening;
          await entry.terminal?.shutdown();
          await entry.files?.close();
        })
        .filter((task): task is Promise<void> => !!task),
    );
    if (this.ssh) (await this.ssh).close();
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    this.entries.clear();
  }
}
