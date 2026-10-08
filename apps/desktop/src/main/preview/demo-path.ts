import path from 'node:path';

export const DEMO_SCHEME = 'wsl-demo';
export const DEMO_HOST = 'taskflow';
export const DEMO_ORIGIN = `${DEMO_SCHEME}://${DEMO_HOST}`;
export const DEMO_HOME_URL = `${DEMO_ORIGIN}/index.html`;

/** 把请求地址映射到演示目录内的文件；越界或其他 host 返回 null。 */
export function resolveDemoFile(root: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${DEMO_SCHEME}:` || url.host !== DEMO_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';
  const resolvedRoot = path.resolve(root);
  const full = path.resolve(resolvedRoot, `.${pathname}`);
  if (!full.startsWith(resolvedRoot + path.sep)) return null;
  return full;
}
