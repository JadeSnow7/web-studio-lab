import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { net, protocol, type Session } from 'electron';
import { DEMO_SCHEME, resolveDemoFile } from './demo-path';

/**
 * 演示页面通过只注册在 Browser 区 session 上的自定义协议提供，
 * 只读取 demo/taskflow 目录内的文件。它不是生成 App，也不产生运行数据。
 */
export { DEMO_HOME_URL, DEMO_HOST, DEMO_ORIGIN, DEMO_SCHEME } from './demo-path';

/** 必须在 app ready 之前调用。 */
export function registerDemoScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: DEMO_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

export function installDemoProtocol(session: Session, root: string): void {
  session.protocol.handle(DEMO_SCHEME, async (request) => {
    const file = resolveDemoFile(root, request.url);
    if (file === null) return new Response('Not found', { status: 404 });
    const info = await stat(file).catch(() => null);
    if (info === null || !info.isFile()) return new Response('Not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}
