import type { MessageBoxOptions } from 'electron';

function failureDetails(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(failureDetails).join('\n');
  return error instanceof Error ? error.message : String(error);
}

/** Independent owners both get a cleanup attempt; failure prevents automatic closure. */
export async function shutdownOwners(owners: (() => Promise<void>)[]): Promise<void> {
  const results = await Promise.allSettled(owners.map((close) => Promise.resolve().then(close)));
  const errors = results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
  if (errors.length) throw new AggregateError(errors, '运行资源清理未确认');
}

export function exitFailureDialog(error: unknown): MessageBoxOptions {
  return {
    type: 'error',
    title: 'Web Studio Lab 退出失败',
    message: '运行资源清理未确认，无法安全退出',
    detail: `${failureDetails(error)}\n\n可修复原因后重试清理。取消退出会保留窗口，但服务已进入关闭状态，不能继续新操作。\n选择“仍然退出”只关闭本地应用；未确认的沙箱或其他进程可能继续运行，清理状态不会被标记为成功。`,
    buttons: ['重试清理', '取消退出', '仍然退出'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
}

/** A timeout bounds the UI wait, not the cleanup: retries join any still-running attempt. */
export class ExitCoordinator {
  private attempt: Promise<void> | null = null;
  constructor(
    private readonly cleanup: () => Promise<void>,
    private readonly prompt: (options: MessageBoxOptions) => Promise<number>,
    private readonly timeoutMs = 30_000,
  ) {}
  async request(): Promise<boolean> {
    for (;;) {
      this.attempt ??= Promise.resolve()
        .then(this.cleanup)
        .catch((error: unknown) => {
          this.attempt = null;
          throw error;
        });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.attempt,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new Error(`清理等待超时（${this.timeoutMs / 1000} 秒）；尚未确认完成，重试将继续等待原清理操作`)),
              this.timeoutMs,
            );
          }),
        ]);
        return true;
      } catch (error) {
        // Do not keep a timeout ticking while the user considers the native dialog.
        clearTimeout(timer);
        const response = await this.prompt(exitFailureDialog(error));
        if (response === 2) return true;
        if (response !== 0) return false;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}
