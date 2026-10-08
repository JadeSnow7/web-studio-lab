import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { ResourceBundleSchema, type ChatStatus, type ResourceBundle, type WorkspaceObservationResult } from '@wsl/protocol';
import helper from './guest-helper.py?raw';
import resourceMcp from './resource_mcp.py?raw';
import terminalRc from './terminal-bash-integration.sh?raw';

const guestHelper = helper
  .replace('TERMINAL_RC_BASE64 = ""', `TERMINAL_RC_BASE64 = "${Buffer.from(terminalRc).toString('base64')}"`)
  .replace('RESOURCE_MCP_BASE64 = ""', `RESOURCE_MCP_BASE64 = "${Buffer.from(resourceMcp).toString('base64')}"`);

export const GUEST_CWD = '/home/agent/workspace';
const PREFIX = 'WSL_GUEST_FRAME:';
const FrameSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('observation-call'),
      id: z.string().uuid(),
      tool: z.string().max(80),
      args: z.record(z.string(), z.unknown()).refine((args) => Buffer.byteLength(JSON.stringify(args), 'utf8') <= 16384),
    })
    .strict(),
  z.object({ type: z.literal('observation-cancel'), id: z.string().uuid() }).strict(),
  z.object({ type: z.literal('ready'), pid: z.number().int().positive() }),
  z.object({ type: z.literal('output'), stream: z.enum(['stdout', 'stderr']), data: z.string() }),
  z.object({ type: z.literal('exit'), exitCode: z.number().int().nullable() }),
  z.object({ type: z.literal('cleanup'), ok: z.boolean(), error: z.string().optional() }),
  z.object({ type: z.literal('error'), error: z.string() }),
]);
export type GuestFrame = z.infer<typeof FrameSchema>;
export interface GuestOutcome {
  error: string | null;
  exitCode: number | null;
  confirmed: boolean;
}
export type GuestStart =
  | {
      type: 'start';
      mode: 'codex';
      argv: string[];
      prompt?: string;
      resourceBundle?: ResourceBundle;
      observation?: boolean;
      observationImages?: boolean;
    }
  | { type: 'start'; mode: 'terminal'; cols: number; rows: number };

export async function resolveSbxBinary(override = process.env['WSL_SBX_BIN']): Promise<string> {
  const candidates = override
    ? [override]
    : [
        ...(process.env['PATH'] ?? '')
          .split(path.delimiter)
          .filter(Boolean)
          .map((dir) => path.join(dir, 'sbx')),
        '/opt/homebrew/bin/sbx',
        '/usr/local/bin/sbx',
      ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch (error) {
      if (override) throw new Error(`sbx 不可执行：${candidate}`, { cause: error });
      if (!['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  throw new Error('未找到 sbx，请安装 Docker Sandboxes。');
}

/** stdout 只接受 helper 帧与目标 sandbox 的已知启动说明。 */
export class GuestProcess {
  private child: ChildProcessWithoutNullStreams;
  readonly done: Promise<GuestOutcome>;
  private finish!: (outcome: GuestOutcome) => void;
  private error: string | null = null;
  private confirmed = false;
  private exitCode: number | null = null;
  private ready = false;
  private closing = false;
  private ended = false;
  private stderr = '';
  private timer: ReturnType<typeof setTimeout>;
  constructor(binary: string, sandbox: string, start: GuestStart, onFrame: (frame: GuestFrame) => void) {
    if (start.mode === 'codex' && start.resourceBundle) ResourceBundleSchema.parse(start.resourceBundle);
    this.done = new Promise((resolve) => {
      this.finish = resolve;
    });
    this.child = spawn(binary, ['exec', '-i', '-w', GUEST_CWD, sandbox, 'python3', '-u', '-c', guestHelper], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.timer = setTimeout(() => this.fail('guest helper 启动超时'), 30000);
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', (line) => {
      try {
        if (line === `Sandbox ${sandbox} started successfully`) return;
        if (!line.startsWith(PREFIX)) throw new Error('收到未封装的 sbx 输出');
        const frame = FrameSchema.parse(JSON.parse(line.slice(PREFIX.length)));
        if (this.confirmed) throw new Error('清理回执后仍收到 guest 事件');
        if (frame.type === 'ready') {
          if (this.ready) throw new Error('重复 guest ready');
          this.ready = true;
          clearTimeout(this.timer);
        }
        if (frame.type === 'exit') this.exitCode = frame.exitCode;
        if (frame.type === 'cleanup') {
          this.confirmed = frame.ok;
          if (!frame.ok) this.error ??= frame.error ?? 'guest 清理失败';
        }
        if (frame.type === 'error') this.error ??= frame.error;
        onFrame(frame);
      } catch (error) {
        this.fail(`guest 协议错误：${(error as Error).message}`);
      }
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
    });
    this.child.on('error', (error) => {
      this.error ??= `sbx 启动失败：${error.message}`;
    });
    this.child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') this.fail(error.message);
    });
    this.child.once('close', (code) => {
      this.ended = true;
      clearTimeout(this.timer);
      lines.close();
      if (!this.confirmed) this.error ??= `guest 清理未确认${this.stderr.trim() ? `：${this.stderr.trim()}` : ''}`;
      if (code !== 0) this.error ??= `sbx 退出失败（${code}）${this.stderr.trim() ? `：${this.stderr.trim()}` : ''}`;
      if (!this.ready && !this.error) this.error = 'guest 未返回 ready';
      this.finish({ error: this.error, exitCode: this.exitCode, confirmed: this.confirmed });
    });
    this.write(start);
  }
  write(
    frame:
      | { type: 'observation-result'; id: string; result: WorkspaceObservationResult }
      | GuestStart
      | { type: 'input'; data: string }
      | { type: 'resize'; cols: number; rows: number }
      | { type: 'close' },
  ) {
    if (this.ended) throw new Error('guest 传输已关闭');
    this.child.stdin.write(JSON.stringify(frame) + '\n');
  }
  private fail(reason: string) {
    this.error ??= reason;
    this.close();
  }
  close(): Promise<GuestOutcome> {
    if (!this.closing && !this.ended) {
      this.closing = true;
      clearTimeout(this.timer);
      this.write({ type: 'close' });
      // 只结束失联的本地传输；缺 guest 确认仍是失败，绝不宣称远端已停止。
      this.timer = setTimeout(() => {
        this.error ??= 'guest 清理回执超时，远端进程状态未知';
        this.child.kill('SIGKILL');
      }, 10000);
    }
    return this.done;
  }
}

export class SbxConnection {
  private probe: GuestProcess | null = null;
  private closing = false;
  private cleanupUnknown = false;
  private binary: string | null = null;
  private status: ChatStatus = { available: false, reason: '正在检查 sbx…', version: null, sandbox: null, cwd: null };
  async initialize(): Promise<ChatStatus> {
    const sandbox = process.env['WSL_SBX_NAME']?.trim();
    this.status.sandbox = sandbox || null;
    this.status.cwd = sandbox ? GUEST_CWD : null;
    try {
      if (!sandbox) throw new Error('未配置 WSL_SBX_NAME，请选择现有 sbx 沙箱。');
      this.binary = await resolveSbxBinary();
      if (this.closing) throw new Error('sbx 服务正在关闭');
      const inspect = spawnSync(this.binary, ['inspect', '--json', sandbox], { encoding: 'utf8', timeout: 20000 });
      if (inspect.error || inspect.status !== 0) throw new Error(inspect.error?.message ?? (inspect.stderr.trim() || 'sbx inspect 失败'));
      const target = z
        .object({
          name: z.literal(sandbox),
          agent: z.literal('codex'),
          state: z.enum(['running', 'stopped']),
          runtime_mounts: z.array(z.unknown()).length(0),
        })
        .parse(JSON.parse(inspect.stdout));
      this.status.sandbox = target.name;
      let version = '';
      const probe = new GuestProcess(this.binary, sandbox, { type: 'start', mode: 'codex', argv: ['codex', '--version'] }, (frame) => {
        if (frame.type === 'output' && frame.stream === 'stdout') version += frame.data;
      });
      this.probe = probe;
      const outcome = await probe.done;
      if (outcome.confirmed) this.probe = null;
      if (outcome.error || !outcome.confirmed || outcome.exitCode !== 0 || !version.trim())
        throw new Error(outcome.error ?? 'guest Codex CLI 版本检查失败');
      if (this.closing) throw new Error('sbx 服务正在关闭');
      this.status = { ...this.status, available: true, reason: null, version: version.trim() };
    } catch (error) {
      this.status = { ...this.status, available: false, reason: `sbx 不可用：${(error as Error).message}`, version: null };
    }
    return this.getStatus();
  }
  getStatus(): ChatStatus {
    return { ...this.status };
  }
  getCleanupPending(): boolean {
    return this.probe !== null || this.cleanupUnknown;
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    if (!this.probe) return;
    const outcome = await this.probe.close();
    if (outcome.confirmed) this.probe = null;
    if (!outcome.confirmed) throw new Error(outcome.error ?? 'guest probe 清理未确认');
  }
  start(start: GuestStart, onFrame: (frame: GuestFrame) => void): GuestProcess {
    if (this.closing) throw new Error('sbx 服务正在关闭');
    if (!this.status.available || !this.binary || !this.status.sandbox) throw new Error(this.status.reason ?? 'sbx 不可用');
    const guest = new GuestProcess(this.binary, this.status.sandbox, start, onFrame);
    void guest.done.then((outcome) => {
      if (!outcome.confirmed) this.cleanupUnknown = true;
    });
    return guest;
  }
}
