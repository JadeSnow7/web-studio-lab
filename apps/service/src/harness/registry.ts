import type { ChatHarness } from '../codex-chat';
import { codexAdapter } from './codex/adapter';
import { claudeCodeAcp } from './acp/agents';

/**
 * 服务启动时选择执行核心使用的 Harness（W3b）。
 *
 * 在 W4 的 Profile 与 Harness 选择器之前，用开发期环境变量 WSL_HARNESS 切换：缺省为 codex；claude-code 走 ACP。
 * 未知取值直接报错，不静默回退。
 */
export const HARNESSES: Record<string, ChatHarness> = {
  codex: { kind: 'native', adapter: codexAdapter },
  'claude-code': { kind: 'acp', spec: claudeCodeAcp },
};

export function selectHarness(id: string | undefined): ChatHarness {
  const key = id?.trim() || 'codex';
  const harness = HARNESSES[key];
  if (!harness) throw new Error(`未知的 WSL_HARNESS：${key}（可选：${Object.keys(HARNESSES).join('、')}）`);
  return harness;
}
