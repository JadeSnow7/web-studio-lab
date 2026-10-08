/**
 * 工作台页面的可信来源。开发模式是 Vite dev server 的 origin，
 * 打包后是本地 renderer/index.html 的 file URL。
 */
export type TrustedRenderer = { kind: 'dev-server'; origin: string } | { kind: 'file'; url: string };

export function isTrustedRendererUrl(url: string, trusted: TrustedRenderer): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (trusted.kind === 'dev-server') return parsed.origin === trusted.origin;
  const expected = new URL(trusted.url);
  return parsed.protocol === 'file:' && parsed.pathname === expected.pathname;
}

export interface SenderInfo {
  /** 发送方 webContents 是否就是主窗口的 webContents。 */
  isMainWindow: boolean;
  /** 发送方 frame 是否是该 webContents 的顶层 frame。 */
  isTopFrame: boolean;
  frameUrl: string | null;
}

/** 只接受主窗口顶层工作台页面发来的 IPC；Browser 区视图与子 frame 一律拒绝。 */
export function assertTrustedSender(sender: SenderInfo, trusted: TrustedRenderer): void {
  if (!sender.isMainWindow || !sender.isTopFrame || sender.frameUrl === null || !isTrustedRendererUrl(sender.frameUrl, trusted)) {
    throw new Error('拒绝来自非工作台页面的 IPC 请求');
  }
}
