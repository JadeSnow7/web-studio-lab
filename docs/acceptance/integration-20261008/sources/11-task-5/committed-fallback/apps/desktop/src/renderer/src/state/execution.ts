import type { AppInfo, ExecutionStatus } from '@wsl/protocol';
import { createStore } from '../lib/store';

export interface EnvironmentState {
  execution: ExecutionStatus | null;
  appInfo: AppInfo | null;
}

/** 主进程报告的执行服务状态与应用信息，启动时读取一次。 */
export const environmentStore = createStore<EnvironmentState>({ execution: null, appInfo: null });
