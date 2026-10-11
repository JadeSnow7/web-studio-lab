import type { AppControlErrorCode } from '@wsl/protocol';

/** 控制面执行中的可辨别失败；dispatcher 把它转换成协议错误，其他异常归为 unavailable。 */
export class AppControlFailure extends Error {
  constructor(
    readonly code: AppControlErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
