import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { parse, type DefaultTreeAdapterMap } from 'parse5';

export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
export const MAX_TEXT_BYTES = 65536;
const REQUEST_DEADLINE_MS = 20000;
const MAX_REDIRECTS = 5;

export interface PublicDocument {
  requestedUrl: string;
  url: string;
  title: string;
  text: string;
  capturedAt: string;
  sourceSha256: string;
  contentSha256: string;
  extractionVersion: 'html-text-v1';
  truncated: boolean;
}
interface ResolvedAddress {
  address: string;
  family: number;
}
interface PublicResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
}
export interface PublicFetchDependencies {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
  request(url: URL, address: ResolvedAddress, signal: AbortSignal): Promise<PublicResponse>;
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, part) => value * 256 + Number(part), 0);
}
function ipv4In(address: number, base: string, bits: number): boolean {
  const size = 2 ** (32 - bits);
  return Math.floor(address / size) === Math.floor(ipv4Number(base) / size);
}
function ipv6Number(address: string): bigint {
  const [left = '', right] = address.split('::');
  const first = left ? left.split(':') : [];
  const last = right ? right.split(':') : [];
  const groups = right === undefined ? first : [...first, ...Array<string>(8 - first.length - last.length).fill('0'), ...last];
  return groups.reduce((value, part) => (value << 16n) | BigInt(`0x${part}`), 0n);
}
function ipv6In(address: bigint, base: string, bits: number): boolean {
  const shift = BigInt(128 - bits);
  return address >> shift === ipv6Number(base) >> shift;
}

/** 连接前拒绝本地、文档、多播及地址转换网段。 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return !(
      [
        ['0.0.0.0', 8],
        ['10.0.0.0', 8],
        ['100.64.0.0', 10],
        ['127.0.0.0', 8],
        ['169.254.0.0', 16],
        ['172.16.0.0', 12],
        ['192.0.0.0', 24],
        ['192.0.2.0', 24],
        ['192.88.99.0', 24],
        ['192.168.0.0', 16],
        ['198.18.0.0', 15],
        ['198.51.100.0', 24],
        ['203.0.113.0', 24],
        ['224.0.0.0', 4],
        ['240.0.0.0', 4],
      ] as const
    ).some(([base, bits]) => ipv4In(value, base, bits));
  }
  // 只允许普通全球单播；拒绝映射 IPv4、NAT64、6to4 与特殊用途网段。
  if (family !== 6 || address.includes('.') || address.includes('%')) return false;
  const value = ipv6Number(address);
  return (
    ipv6In(value, '2000::', 3) &&
    !(
      [
        ['2001::', 23],
        ['2001:db8::', 32],
        ['2002::', 16],
        ['3fff::', 20],
      ] as const
    ).some(([base, bits]) => ipv6In(value, base, bits))
  );
}

export function parsePublicUrl(input: string): URL {
  if (input.length > 2048 || [...input].some((character) => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127))
    throw new Error('公开网址格式无效');
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password)
    throw new Error('公开文档仅允许无凭据的 HTTPS 443 地址');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    !hostname ||
    hostname.endsWith('.') ||
    hostname === 'localhost' ||
    /\.(localhost|local|internal|home|lan|test|invalid|example|onion)$/u.test(hostname)
  )
    throw new Error('不允许本地或保留域名');
  if (isIP(hostname) && !isPublicAddress(hostname)) throw new Error('不允许私网或保留地址');
  if (!isIP(hostname) && !hostname.includes('.')) throw new Error('公开文档需要完整公网域名');
  url.hash = '';
  return url;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('公开文档加载超时或已取消'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

const dependencies: PublicFetchDependencies = {
  resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  request: (url, address, signal) =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let received = 0;
      const request = httpsRequest(
        url,
        {
          method: 'GET',
          family: address.family,
          rejectUnauthorized: true,
          agent: false,
          signal,
          maxHeaderSize: 16384,
          headers: { Accept: 'text/html', 'Accept-Encoding': 'identity', 'User-Agent': 'WebStudioLab-ReadonlyDocument/1.0' },
          // Host 与 SNI 保持原域名；lookup 不能再次解析到 DNS 重绑定后的地址。
          lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        },
        (response) => {
          const declaredLength = Number(response.headers['content-length']);
          if (Number.isFinite(declaredLength) && declaredLength > MAX_SOURCE_BYTES) {
            response.destroy(new Error('公开文档响应超过 2 MiB'));
          }
          response.on('data', (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_SOURCE_BYTES) response.destroy(new Error('公开文档响应超过 2 MiB'));
            else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: Object.fromEntries(
                Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value]),
              ),
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      request.on('error', reject);
      request.end();
    }),
};

export async function fetchPublicDocument(
  input: string,
  fetchDependencies: PublicFetchDependencies = dependencies,
  signal = AbortSignal.timeout(REQUEST_DEADLINE_MS),
): Promise<PublicDocument> {
  const requestedUrl = parsePublicUrl(input).href;
  let url = new URL(requestedUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(fetchDependencies.resolve(hostname), signal);
    if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address) || isIP(address) !== family))
      throw new Error('DNS 包含私网、保留或无效地址，已阻止连接');
    const response = await abortable(fetchDependencies.request(url, addresses[0]!, signal), signal);
    if (response.body.length > MAX_SOURCE_BYTES) throw new Error('公开文档响应超过 2 MiB');
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === MAX_REDIRECTS || !response.headers.location) throw new Error('公开文档重定向超出限制或缺少地址');
      url = parsePublicUrl(new URL(response.headers.location, url).href);
      continue;
    }
    if (response.status !== 200) throw new Error(`公开文档加载失败：HTTP ${response.status}`);
    const contentType = response.headers['content-type'] ?? '';
    if (!/^text\/html(?:\s*;|\s*$)/iu.test(contentType)) throw new Error('仅支持 HTML 公开文档');
    const charset = /charset\s*=\s*["']?([^\s;"']+)/iu.exec(contentType)?.[1];
    if (charset && !/^utf-?8$/iu.test(charset)) throw new Error('仅支持 UTF-8 公开文档');
    if (response.headers['content-encoding'] && response.headers['content-encoding'].toLowerCase() !== 'identity')
      throw new Error('不支持压缩的公开文档响应');
    return extractPublicDocument(response.body, requestedUrl, url.href);
  }
  throw new Error('公开文档重定向超出限制');
}

type HtmlNode = DefaultTreeAdapterMap['node'];
const excludedElements = new Set([
  'script',
  'style',
  'template',
  'noscript',
  'iframe',
  'object',
  'embed',
  'svg',
  'canvas',
  'audio',
  'video',
]);
const blockElements = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'td',
  'th',
  'tr',
  'ul',
]);
function childNodes(node: HtmlNode): HtmlNode[] {
  return 'childNodes' in node ? node.childNodes : [];
}
function textOf(root: HtmlNode): string {
  const parts: string[] = [];
  const stack: (HtmlNode | string)[] = [root];
  while (stack.length) {
    const node = stack.pop()!;
    if (typeof node === 'string') {
      parts.push(node);
      continue;
    }
    if (node.nodeName === '#text') {
      parts.push((node as DefaultTreeAdapterMap['textNode']).value);
      continue;
    }
    if ('tagName' in node) {
      if (
        excludedElements.has(node.tagName) ||
        node.attrs.some(
          ({ name, value }) =>
            name === 'hidden' ||
            (name === 'aria-hidden' && value === 'true') ||
            (name === 'style' && /(?:display\s*:\s*none|visibility\s*:\s*hidden)/iu.test(value)),
        )
      )
        continue;
      if (blockElements.has(node.tagName)) {
        parts.push('\n');
        stack.push('\n');
      }
    }
    const children = childNodes(node);
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
  }
  return parts
    .join('')
    .replace(/[\t\r\f ]+/gu, ' ')
    .replace(/ *\n */gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}
function truncateUtf8(text: string, limit: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= limit) return { text, truncated: false };
  const buffer = Buffer.from(text);
  let end = limit;
  while ((buffer[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString('utf8'), truncated: true };
}

export function extractPublicDocument(bytes: Buffer, requestedUrl: string, url: string): PublicDocument {
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error('公开文档响应超过 2 MiB');
  const html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const document = parse(html);
  const stack: HtmlNode[] = [document];
  let title = '';
  let body: HtmlNode | undefined;
  while (stack.length) {
    const node = stack.pop()!;
    if ('tagName' in node) {
      if (node.tagName === 'title' && title === '')
        title = textOf(node)
          .replace(/[\t\n\f\r ]+/gu, ' ')
          .trim();
      if (node.tagName === 'body') body = node;
      if (node.tagName === 'meta') {
        const attributes = new Map(node.attrs.map(({ name, value }) => [name, value]));
        const declared =
          attributes.get('charset') ??
          (attributes.get('http-equiv')?.toLowerCase() === 'content-type'
            ? /charset\s*=\s*["']?([^\s;"']+)/iu.exec(attributes.get('content') ?? '')?.[1]
            : undefined);
        if (declared && !/^utf-?8$/iu.test(declared)) throw new Error('HTML 声明了非 UTF-8 编码');
      }
    }
    const children = childNodes(node);
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
  }
  const extracted = truncateUtf8(body ? textOf(body) : '', MAX_TEXT_BYTES);
  return {
    requestedUrl,
    url,
    title: truncateUtf8(title, 1024).text.trim(),
    ...extracted,
    capturedAt: new Date().toISOString(),
    sourceSha256: createHash('sha256').update(bytes).digest('hex'),
    contentSha256: createHash('sha256').update(extracted.text).digest('hex'),
    extractionVersion: 'html-text-v1',
  };
}
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
export const READER_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};
export function renderReaderDocument(document: PublicDocument): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(document.title)}</title><style>body{font:16px/1.7 system-ui,sans-serif;color:#1d1d1f;margin:36px;max-width:900px}header{border-bottom:1px solid #ddd;padding-bottom:20px}small{color:#666}h1{font-size:28px;line-height:1.3}p{overflow-wrap:anywhere}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}</style></head><body><header><small>公开网页 · 只读文档</small><h1>${escapeHtml(document.title)}</h1><p>${escapeHtml(document.url)}</p><small>${escapeHtml(document.capturedAt)}${document.truncated ? ' · 正文已截断至 64 KiB' : ''}</small></header><main><pre>${escapeHtml(document.text)}</pre></main></body></html>`;
}
