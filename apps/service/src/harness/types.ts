import type { HarnessDescriptor } from '@wsl/protocol';

/**
 * service 侧 Harness 适配器契约（ADR-0003 决定 1）。
 *
 * 适配器只负责“怎样启动这个 CLI、怎样读它的输出”；会话槽、轮次生命周期、清理确认、观察与控制面路由、
 * 写入许可等都由通用执行核心与 Main 负责，适配器不持有业务状态。
 */

/** 归一化事件。执行核心只消费这一组事件，不识别各 Harness 的原始事件类型。 */
export type HarnessEvent =
  /** fresh：Agent 无法恢复上一轮会话而新建了会话；执行核心据此替换会话身份而不判为冲突。 */
  | { type: 'session'; ref: string; fresh?: boolean }
  | { type: 'message'; id: string; text: string }
  | { type: 'warning'; text: string }
  | {
      type: 'tool';
      id: string;
      /** 完整命令；mcp 调用以 `mcp:` 开头，执行核心据此决定超出总预算时的裁剪方式。 */
      command: string;
      /** 已按单条 16000 字符预算裁剪的输出。 */
      output: string;
      exitCode: number | null;
      truncated: boolean;
    }
  | { type: 'turn_completed' }
  | { type: 'turn_failed'; message: string };

/** guest helper 挂载 wsl_space MCP 的方式；由 service 显式声明，helper 不再按 argv 识别 Harness。 */
export type GuestMcpInjection = 'codex-config';

/**
 * Profile 的无模型自检（W4）：在运行环境内以该 Profile 的配置目录运行两条命令。
 * parseStatus 只从退出码与输出中取出登录状态；其余输出（可能含账号邮箱、组织）由调用方丢弃，不保存、不转发。
 */
export interface ProfileSelfCheck {
  readonly versionArgv: string[];
  readonly statusArgv: string[];
  /** stdout 与 stderr 分开传入：各 CLI 输出状态的流不同（Codex 写在 stderr，Claude Code 的 JSON 在 stdout）。 */
  parseStatus(exitCode: number | null, stdout: string, stderr: string): 'logged_in' | 'logged_out' | 'undetermined';
}

export interface NativeHarnessAdapter {
  /** 出现在错误消息中的简称，例如“Codex 协议错误”。 */
  readonly label: string;
  readonly mcpInjection: GuestMcpInjection;
  /** 成功轮次是否必须返回会话身份（用于续轮）。 */
  readonly requiresSessionRef: boolean;
  /** 单个协议行的字符上限，超过即判为协议错误。 */
  readonly maxLineChars: number;
  readonly harnessId: string;
  /** 该 CLI 选择配置与登录目录的环境变量；Profile 经它切换账号（W4）。 */
  readonly configDirEnv: 'CODEX_HOME' | null;
  readonly selfCheck: ProfileSelfCheck;
  descriptor(version: string | null): HarnessDescriptor;
  /** 本轮命令行；sessionRef 为上一轮返回的会话身份，首轮为 null。提示词经 stdin 传入。 */
  argv(sessionRef: string | null): string[];
  /**
   * 解析一行输出。返回 null 表示不是本协议的已知事件（忽略且不发布快照）；
   * 返回数组（可为空）表示已知事件。字段缺失等协议违约直接抛出 Error，由执行核心记为协议错误。
   */
  parseLine(line: string): HarnessEvent[] | null;
}
