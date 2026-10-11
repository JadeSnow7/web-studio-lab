import type { DebugStatusSnapshot, StatusFact, StatusTransition } from '@wsl/protocol';

/*
 * 状态数据出口脱敏（status-interface.md §8.4）。
 * 纯 TypeScript：不依赖 React、Electron 或 Node API，不读取 process.env；家目录与授权根由调用方传入。
 */

export interface RedactContext {
  /** 当前用户家目录的绝对路径；出现时替换为 `~`。 */
  homeDir?: string | null;
  /** 授权根的绝对路径；根内路径改写为相对根的路径，根本身写作 `.`。 */
  roots?: readonly string[];
  /** 需要隐藏的 SSH 主机与用户名；每个值替换为 `ssh:<sha256 前 8 位>`。 */
  sshIdentities?: readonly string[];
}

export const TEXT_LIMIT = 300;
export const REDACTED = '[redacted]';

/** 按码点截断，超出时以省略号结尾，结果长度不超过 max。 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max - 1);
  const last = text.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1; // 不把代理对拆开
  return `${text.slice(0, end)}…`;
}

/* ---------- SHA-256（纯 TS，同步） ---------- */

const primes = (() => {
  const found: number[] = [];
  for (let n = 2; found.length < 64; n += 1) if (found.every((p) => n % p !== 0)) found.push(n);
  return found;
})();
const fraction = (value: number) => Math.floor((value - Math.floor(value)) * 2 ** 32) >>> 0;
const ROUND_CONSTANTS = primes.map((p) => fraction(Math.cbrt(p)));
const INITIAL_HASH = primes.slice(0, 8).map((p) => fraction(Math.sqrt(p)));

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    let code = char.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) code = 0xfffd; // 孤立代理项，与 TextEncoder 一致
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
  }
  return bytes;
}

/** 字符串的 UTF-8 字节数，不依赖 TextEncoder。 */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** UTF-8 文本的 SHA-256，小写十六进制。 */
export function sha256Hex(text: string): string {
  const data = utf8Bytes(text);
  const bitLength = data.length * 8;
  data.push(0x80);
  while (data.length % 64 !== 56) data.push(0);
  const high = Math.floor(bitLength / 2 ** 32);
  const low = bitLength >>> 0;
  for (const word of [high, low]) data.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255);
  const hash = Uint32Array.from(INITIAL_HASH);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      const j = offset + i * 4;
      w[i] = ((data[j]! << 24) | (data[j + 1]! << 16) | (data[j + 2]! << 8) | data[j + 3]!) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as unknown as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choose + ROUND_CONSTANTS[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const next = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 8; i += 1) hash[i] = (hash[i]! + next[i]!) >>> 0;
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, '0')).join('');
}

/** SSH 主机或用户的稳定别名：`ssh:<sha256 前 8 位>`。 */
export function sshAlias(value: string): string {
  return `ssh:${sha256Hex(value).slice(0, 8)}`;
}

/* ---------- 凭据 ---------- */

// 四组模式依据 status-interface.md §8.4（私钥块、OpenAI / GitHub token、AWS access key，与发布扫描 publication-scan 同类）。
// publication-scan 的模式文件不在本仓库中，因此这里按公开的 token 格式独立编写；AWS 一组额外包含临时凭据前缀 ASIA。
const SECRET_PATTERNS: readonly RegExp[] = [
  // 私钥块；缺少结束行时一直替换到文本末尾，避免截断后残留密钥正文。
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, REDACTED), text);
}

/* ---------- 路径 ---------- */

const trimSlash = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 授权根优先于家目录：根内路径为相对路径，其余家目录内路径以 `~` 开头。 */
export function redactPath(path: string, context: RedactContext = {}): string {
  const roots = [...(context.roots ?? [])].map(trimSlash).filter((root) => root.length > 1);
  roots.sort((a, b) => b.length - a.length);
  for (const root of roots) {
    if (path === root) return '.';
    if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  }
  const home = context.homeDir ? trimSlash(context.homeDir) : null;
  if (home && home.length > 1) {
    if (path === home) return '~';
    if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
  }
  return path;
}

/* ---------- URL ---------- */

const OPAQUE_PROTOCOLS = new Set(['data:', 'javascript:', 'blob:']);

/** 保留协议、主机、路径；去掉用户信息、查询串与片段；`file:` 按本地路径处理。 */
export function redactUrl(value: string, context: RedactContext = {}): string {
  let parsed: URL | null;
  try {
    parsed = new URL(value);
  } catch {
    parsed = null;
  }
  if (!parsed) return value.replace(/[?#].*$/s, '');
  if (parsed.protocol === 'file:') {
    let path = parsed.pathname;
    try {
      path = decodeURIComponent(path);
    } catch {
      // 保留未解码的路径
    }
    return redactPath(path, context);
  }
  if (OPAQUE_PROTOCOLS.has(parsed.protocol)) return `${parsed.protocol}${REDACTED}`;
  return parsed.host ? `${parsed.protocol}//${parsed.host}${parsed.pathname}` : `${parsed.protocol}${parsed.pathname}`;
}

/* ---------- 文本 ---------- */

// URL 一直匹配到空白或引号 / 尖括号为止（含非 ASCII 的查询值，查询串整体会被去掉，不会残留尾部）；
// 末尾的中英文标点是句子的一部分，不属于 URL，剥掉后原样接回。
const URL_IN_TEXT = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s"'<>`]+/g;
const URL_TRAILING_PUNCTUATION = /[.,;:!?)\]，。；：！？、）】》」』]+$/;
const PATH_BOUNDARY_BEFORE = '(?<![A-Za-z0-9_.~-])';
// 路径到此结束：文本末尾、非路径字符，或句末的 `.`。
const PATH_BOUNDARY_AFTER = '(?=$|[^A-Za-z0-9_.-]|\\.(?![A-Za-z0-9_-]))';

/**
 * 自由文本（label、detail、错误文本）的完整脱敏：凭据 → URL → 授权根 / 家目录 → SSH → 截断到 300 字符。
 * 随机 ID 不处理，保留给排障使用。
 */
export function redact(text: string, context: RedactContext = {}): string {
  let result = redactSecrets(text);
  result = result.replace(URL_IN_TEXT, (match) => {
    const trailing = URL_TRAILING_PUNCTUATION.exec(match)?.[0] ?? '';
    return redactUrl(trailing ? match.slice(0, -trailing.length) : match, context) + trailing;
  });
  const roots = [...(context.roots ?? [])].map(trimSlash).filter((root) => root.length > 1);
  roots.sort((a, b) => b.length - a.length);
  for (const root of roots) {
    const pattern = new RegExp(`${PATH_BOUNDARY_BEFORE}${escapeRegExp(root)}(?:(/)|${PATH_BOUNDARY_AFTER})`, 'g');
    result = result.replace(pattern, (_match, slash: string | undefined) => (slash ? '' : '.'));
  }
  const home = context.homeDir ? trimSlash(context.homeDir) : null;
  if (home && home.length > 1)
    result = result.replace(new RegExp(`${PATH_BOUNDARY_BEFORE}${escapeRegExp(home)}(?=/|${PATH_BOUNDARY_AFTER})`, 'g'), '~');
  const identities = [...new Set(context.sshIdentities ?? [])].filter((value) => value.length > 0);
  identities.sort((a, b) => b.length - a.length);
  for (const identity of identities)
    result = result.replace(new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(identity)}(?![A-Za-z0-9_-])`, 'g'), sshAlias(identity));
  return truncateText(result, TEXT_LIMIT);
}

/* ---------- 事实 / 转换 / 快照 ---------- */

function redactRaw(raw: StatusFact['raw']): StatusFact['raw'] {
  // raw 已按白名单构造，只含枚举、数值与标识；仍对字符串做凭据扫描作为兜底。
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, typeof value === 'string' ? redactSecrets(value) : value]),
  ) as StatusFact['raw'];
}

/** 复制 / 导出 / NDJSON 出口使用：label、detail、动作文案与 raw 都经过脱敏，并保持 label ≤120、detail ≤300。 */
export function redactFact(fact: StatusFact, context: RedactContext = {}): StatusFact {
  const result = {
    ...fact,
    label: truncateText(redact(fact.label, context), 120),
    raw: redactRaw(fact.raw),
  } as StatusFact;
  if (fact.detail !== undefined) result.detail = redact(fact.detail, context);
  return result;
}

export function redactTransition(transition: StatusTransition, context: RedactContext = {}): StatusTransition {
  const endpoint = (value: StatusTransition['from']) => (value ? { ...value, label: redact(value.label, context) } : null);
  return { ...transition, from: endpoint(transition.from), to: endpoint(transition.to) };
}

export function redactDebugSnapshot(snapshot: DebugStatusSnapshot, context: RedactContext = {}): DebugStatusSnapshot {
  return {
    ...snapshot,
    facts: snapshot.facts.map((fact) => redactFact(fact, context)),
    transitions: snapshot.transitions.map((transition) => redactTransition(transition, context)),
  };
}
