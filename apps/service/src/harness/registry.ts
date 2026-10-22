import type { ChatHarness } from '../codex-chat';
import { codexAdapter } from './codex/adapter';
import { claudeCodeAcp } from './acp/agents';

/**
 * 执行核心可用的 Harness（W4）。每次执行由 Main 按会话或全局默认的选择指定其一；
 * 启动时逐个探测，不可用的 Harness 保留在列表中并报告原因，不静默移除。
 */
export const REGISTERED_HARNESSES: readonly ChatHarness[] = [
  { kind: 'native', adapter: codexAdapter },
  { kind: 'acp', spec: claudeCodeAcp },
];

export function harnessIdOf(harness: ChatHarness): string {
  return harness.kind === 'native' ? harness.adapter.harnessId : harness.spec.harnessId;
}
