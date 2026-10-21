/** Only scalar diagnostic fields leave this parser; arbitrary registry values never do. */
export interface IoregLocks {
  IOConsoleLocked?: boolean;
  kCGSSessionOnConsoleKey?: boolean;
  kCGSessionLoginDoneKey?: boolean;
  CGSSessionScreenIsLocked?: boolean;
  CGSSessionScreenLockedTime?: string;
}
type Value = { kind: 'scalar'; text: string } | { kind: 'dict'; entries: [string, Value][] } | { kind: 'list'; values: Value[] };
type Dict = Extract<Value, { kind: 'dict' }>;

function registry(output: string): Dict[] | undefined {
  const tree = /^[ \t|]*\+-o /m.test(output);
  if (tree) output = output.replace(/^[ \t|]*\+-o [^\r\n]*(?:\r?\n|$)/gm, '').replace(/^[ \t|]+(?=[{}"]|$)/gm, '');
  const tokens: { text: string; start: number; end: number }[] = [];
  let end = 0;
  for (const match of output.matchAll(/<(?:(?:"(?:\\.|[^"\\])*"|[^>"]))*?>|"(?:\\.|[^"\\])*"|[{}()[\]=,]|[^\s{}()[\]=,"<]+/g)) {
    if (/\S/.test(output.slice(end, match.index))) return undefined;
    end = match.index + match[0].length;
    tokens.push({ text: match[0], start: match.index, end });
  }
  if (/\S/.test(output.slice(end))) return undefined;
  // ioreg's tree header is not a property list. Begin at its first property dictionary,
  // or at a quoted assignment for synthetic/flat registry fixtures.
  let cursor = tokens.findIndex((token, i) => token.text === '{' || (token.text.startsWith('"') && tokens[i + 1]?.text === '='));
  if (cursor !== 0) return undefined;
  const fail = (): never => {
    throw new Error('Invalid registry structure');
  };
  function dictionary(braced: boolean): Dict {
    const entries: [string, Value][] = [];
    if (braced) cursor++;
    while (cursor < tokens.length && tokens[cursor]?.text !== '}') {
      const key = tokens[cursor++];
      if (!key || !key.text.startsWith('"') || tokens[cursor++]?.text !== '=') return fail();
      const value = readValue();
      entries.push([key.text.slice(1, -1), value]);
      const next = tokens[cursor];
      if (next?.text === ',') cursor++;
      else if (next && next.text !== '}' && !/[\r\n]/.test(output.slice(tokens[cursor - 1]?.end, next.start))) fail();
    }
    if (braced && tokens[cursor++]?.text !== '}') fail();
    return { kind: 'dict', entries };
  }
  function readValue(): Value {
    const token = tokens[cursor];
    if (!token) return fail();
    if (token.text === '{') return dictionary(true);
    if (token.text === '(' || token.text === '[') {
      const close = token.text === '(' ? ')' : ']';
      const values: Value[] = [];
      cursor++;
      while (tokens[cursor]?.text !== close) {
        values.push(readValue());
        if (tokens[cursor]?.text === ',') cursor++;
        else if (tokens[cursor]?.text !== close) fail();
      }
      cursor++;
      return { kind: 'list', values };
    }
    // ioreg represents some absent registry values as an empty slot, e.g. key=, .
    if (token.text === ',' || token.text === '}' || token.text === ')') return { kind: 'scalar', text: '' };
    if (/^[{}()[\]=,]$/.test(token.text)) return fail();
    cursor++;
    return { kind: 'scalar', text: token.text };
  }
  try {
    const roots = [dictionary(tokens[cursor]?.text === '{')];
    while (cursor < tokens.length) {
      if (tree && tokens[cursor]?.text === '{') {
        roots.push(dictionary(true));
        continue;
      }
      return undefined;
    }
    return roots;
  } catch {
    return undefined;
  }
}
function property(dict: Dict, key: string): Value | undefined {
  const matches = dict.entries.filter(([name]) => name === key);
  return matches.length === 1 ? matches[0]?.[1] : undefined;
}
function scalar(dict: Dict, key: string): string | undefined {
  const value = property(dict, key);
  return value?.kind === 'scalar' ? value.text : undefined;
}
function sessionScalar(root: Dict, key: string): string | undefined {
  const sessions = property(root, 'IOConsoleUsers');
  if (sessions?.kind !== 'list' || !sessions.values.length) return undefined;
  let result: string | undefined;
  for (const session of sessions.values) {
    if (session.kind !== 'dict') return undefined;
    const value = scalar(session, key);
    if (value === undefined || (result !== undefined && result !== value)) return undefined;
    result = value;
  }
  return result;
}
export function ioregScalar(output: string, key: 'HIDIdleTime' | 'CGSSessionScreenLockedTime'): string | undefined {
  const roots = registry(output);
  const values = roots
    ?.map((root) => (key === 'HIDIdleTime' ? scalar(root, key) : sessionScalar(root, key)))
    .filter((value) => value !== undefined);
  const value = values?.length && values.every((entry) => entry === values[0]) ? values[0] : undefined;
  return value !== undefined && /^\d+$/.test(value) ? value : undefined;
}
export function parseIoregLocks(output: string): IoregLocks {
  const roots = registry(output);
  const root = roots?.length === 1 ? roots[0] : undefined;
  const result: IoregLocks = {};
  if (!root) return result;
  for (const key of ['IOConsoleLocked', 'kCGSSessionOnConsoleKey', 'kCGSessionLoginDoneKey', 'CGSSessionScreenIsLocked'] as const) {
    const value = key === 'IOConsoleLocked' ? scalar(root, key) : sessionScalar(root, key);
    if (value === 'Yes' || value === 'No') result[key] = value === 'Yes';
  }
  const time = sessionScalar(root, 'CGSSessionScreenLockedTime');
  if (time !== undefined && /^\d+$/.test(time)) result.CGSSessionScreenLockedTime = time;
  return result;
}
