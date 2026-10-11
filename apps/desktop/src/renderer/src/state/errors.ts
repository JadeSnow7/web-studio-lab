import { statusPresentationActions } from './status-view';

export type { UiError } from './status-view';

/** IPC 或界面动作失败时在这里登记，由 Toast 队列展示，不静默吞掉。底层写入展示状态 statusPresentationStore.uiErrors。 */
export function reportError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  // Electron 会给 invoke 失败加上通道前缀，这里只保留主进程给出的原因。
  const cleaned = message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  statusPresentationActions.pushUiError(context, cleaned);
}

export function dismissError(id: number): void {
  statusPresentationActions.dismissUiError(id);
}

/** 执行一个 IPC 调用，失败时登记错误。 */
export function track<T>(context: string, promise: Promise<T>): Promise<T | undefined> {
  return promise.catch((error: unknown) => {
    reportError(context, error);
    return undefined;
  });
}
