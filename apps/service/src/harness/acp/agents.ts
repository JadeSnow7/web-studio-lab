import type { HarnessDescriptor } from '@wsl/protocol';
import type { InitializeResult } from './protocol';
import type { ProfileSelfCheck } from '../types';

/** 一个经 ACP 接入的 Agent：怎样启动、出现在界面和错误消息中的名称。凭据只来自运行环境内 Profile 的配置目录（W4）。 */
export interface AcpAgentSpec {
  harnessId: string;
  displayName: string;
  /** 出现在错误消息中的简称。 */
  label: string;
  /** 在运行环境内启动 ACP Agent 的命令行；stdio 即 ACP 连接。 */
  command: string[];
  /** 安装来源，供 guest 准备脚本固定版本；不在运行时下载。 */
  install: { npm: string; version: string };
  /** 该 CLI 的配置与登录目录环境变量；Profile 通过它选择账号（W4）。 */
  configDirEnv: 'CLAUDE_CONFIG_DIR' | null;
  selfCheck: ProfileSelfCheck;
}

/**
 * Claude Code 的 ACP 包装器。包名于 2026 年由 @zed-industries/claude-code-acp 改为
 * @agentclientprotocol/claude-agent-acp，命令名相应改为 claude-agent-acp；版本为起草时 npm 上的最新版，安装时固定。
 */
export const claudeCodeAcp: AcpAgentSpec = {
  harnessId: 'claude-code',
  displayName: 'Claude Code',
  label: 'Claude Code',
  command: ['claude-agent-acp'],
  install: { npm: '@agentclientprotocol/claude-agent-acp', version: '0.94.0' },
  configDirEnv: 'CLAUDE_CONFIG_DIR',
  // 2026-10-22 在 guest 实测：`auth status` 输出 JSON，已登录退出 0、`loggedIn: true`，未登录退出 1、`loggedIn: false`；
  // JSON 同时含邮箱与组织，这里只读 loggedIn。
  selfCheck: {
    versionArgv: ['claude-agent-acp', '--version'],
    statusArgv: ['claude-agent-acp', '--cli', 'auth', 'status', '--json'],
    parseStatus(exitCode, stdout) {
      let loggedIn: unknown;
      try {
        loggedIn = (JSON.parse(stdout) as { loggedIn?: unknown }).loggedIn;
      } catch {
        return 'undetermined';
      }
      if (loggedIn === true && exitCode === 0) return 'logged_in';
      if (loggedIn === false && exitCode === 1) return 'logged_out';
      return 'undetermined';
    },
  },
};

/** 能力只来自本次 initialize 的实际回复（capabilitySource: probed）。Lab 暂不提供客户端 fs / terminal。 */
export function acpDescriptor(spec: AcpAgentSpec, init: InitializeResult | null): HarnessDescriptor {
  const caps = init?.agentCapabilities;
  return {
    harnessId: spec.harnessId,
    displayName: spec.displayName,
    adapter: 'acp',
    version: init?.agentInfo?.version ?? null,
    capabilities: {
      structuredEvents: init !== null,
      // stdio MCP 是 ACP Agent 的基线能力；真实挂载是否生效由 W3b 的工具列举复验确认。
      mcp: init !== null,
      resume: caps?.loadSession === true,
      permissionRequests: init !== null,
      clientFs: false,
      clientTerminal: false,
      readOnlyMode: false,
      images: caps?.promptCapabilities?.image === true,
    },
    capabilitySource: 'probed',
  };
}
