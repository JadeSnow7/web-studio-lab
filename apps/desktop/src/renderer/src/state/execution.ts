import type { AppInfo, CheckerCapability, CheckerUnavailableReason, ExecutionStatus } from '@wsl/protocol';
import { createStore } from '../lib/store';

export interface EnvironmentState {
  execution: ExecutionStatus | null;
  appInfo: AppInfo | null;
}

/** 主进程报告的执行服务状态与应用信息，启动时读取一次。 */
export const environmentStore = createStore<EnvironmentState>({ execution: null, appInfo: null });

/** Main 发布的独立检查器能力；尚未读取时为 null（界面按“未接入”收起入口，但不声称未接入）。 */
export const checkerCapability = (state: EnvironmentState): CheckerCapability | null => state.execution?.checker ?? null;

/**
 * 未接入的演示入口（首页搜索 / 打开、会话页联系人与群聊、任务页演示记录）只在 Main 报告诊断模式时显示（OPS-1 S4）。
 * 判定只在 Main（AppInfo.diagnostics）；读取前按正式构建处理。renderer 不读环境变量，也不从 `studio.debug` 推断。
 */
export const demoEntriesVisible = (state: EnvironmentState): boolean => state.appInfo?.diagnostics === true;

/** 检查器未接入时检查区与设置页共用的说明。 */
export const CHECKER_UNAVAILABLE_NOTE: Record<CheckerUnavailableReason, string> = {
  not_integrated: '产品检查器尚未接入，无法在此运行检查。',
};
