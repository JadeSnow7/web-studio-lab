/**
 * Browser 区的导航白名单。比较 scheme 与 host（含端口），不比较 URL.origin：
 * 对自定义 scheme，Node 的 URL.origin 一律是 "null"。
 */
export function previewOriginOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.host === '') return null;
  return `${parsed.protocol}//${parsed.host}`;
}

export function isAllowedPreviewUrl(url: string, allowedOrigins: readonly string[]): boolean {
  const origin = previewOriginOf(url);
  return origin !== null && allowedOrigins.includes(origin);
}

export function isAllowedManagedAppUrl(url: string, leaseUrl: string): boolean {
  try {
    const current = new URL(url);
    const lease = new URL(leaseUrl);
    return (
      lease.protocol === 'http:' &&
      lease.hostname === '127.0.0.1' &&
      !!lease.port &&
      !lease.username &&
      !lease.password &&
      current.origin === lease.origin &&
      !current.username &&
      !current.password
    );
  } catch {
    return false;
  }
}
