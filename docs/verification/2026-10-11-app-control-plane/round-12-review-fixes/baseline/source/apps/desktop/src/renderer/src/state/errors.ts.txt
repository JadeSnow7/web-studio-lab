import { createStore } from '../lib/store';

export interface UiError {
  id: number;
  context: string;
  message: string;
}

/** IPC 或界面动作失败时在这里登记，由界面展示，不静默吞掉。 */
export const errorStore = createStore<readonly UiError[]>([]);

let nextId = 1;

export function reportError(context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  // Electron 会给 invoke 失败加上通道前缀，这里只保留主进程给出的原因。
  const cleaned = message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  errorStore.set((list) => [...list.slice(-4), { id: nextId++, context, message: cleaned }]);
}

export function dismissError(id: number): void {
  errorStore.set((list) => list.filter((e) => e.id !== id));
}

/** 执行一个 IPC 调用，失败时登记错误。 */
export function track<T>(context: string, promise: Promise<T>): Promise<T | undefined> {
  return promise.catch((error: unknown) => {
    reportError(context, error);
    return undefined;
  });
}
