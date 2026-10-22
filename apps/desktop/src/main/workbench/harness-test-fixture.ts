import type { HarnessRef, TurnHarness } from '@wsl/protocol';
import type { WorkbenchRuntime } from './ports';

/** 测试用：Codex 内置 Profile 的解析结果。执行记录冻结的出处与真实 host 一致。 */
export const CODEX_TEST_REF: HarnessRef = {
  harnessId: 'codex',
  displayName: 'Codex CLI',
  adapter: 'native',
  version: 'codex-cli fixture',
  profileId: 'codex:default',
};
export const CODEX_TEST_TURN: TurnHarness = { harnessId: 'codex', profileId: 'codex:default', profileDir: null };

/** 测试用运行时的 Harness 部分：总是解析到 Codex 内置 Profile，启动前无需自检。 */
export const codexHarnessRuntime: Pick<WorkbenchRuntime, 'resolveHarness' | 'prepareHarness'> = {
  resolveHarness: () => ({ ref: structuredClone(CODEX_TEST_REF), turn: structuredClone(CODEX_TEST_TURN) }),
  prepareHarness: async () => undefined,
};
