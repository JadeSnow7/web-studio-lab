import * as acorn from 'acorn';
import { canonical, LIMITS } from './contract';

/**
 * 合同 §1 的静态校验：只解析不执行。
 * 返回 {ok:true, meta} 或 {ok:false, code:'script_rejected', reason, line, column}。
 */

export interface ScriptMeta {
  name: string;
  description: string;
  phases?: string[];
  size?: 'small' | 'medium' | 'large';
  /**
   * W9：Ultra 受理标记（默认 false）。只许布尔字面量——非布尔/非字面量在 analyze 拒绝
   * （fail-closed）。Ultra 是 run 级展示/实验分组标记，零特权：不跳审批、不改预算、不改路由。
   */
  ultra?: boolean;
}

export interface ScriptRejected {
  ok: false;
  code: 'script_rejected';
  reason: string;
  line: number;
  column: number;
}

export type AnalyzeResult = { ok: true; meta: ScriptMeta } | ScriptRejected;

const BANNED_IDENTIFIERS = new Set([
  'import',
  'require',
  'process',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'WebAssembly',
  'crypto',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'Atomics',
  'SharedArrayBuffer',
  'Worker',
]);

type Node = acorn.Node & Record<string, unknown>;

export function analyzeScript(source: string): AnalyzeResult {
  let program: acorn.Program;
  try {
    program = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  } catch (error) {
    const e = error as { loc?: { line: number; column: number }; message: string };
    return reject(`语法解析失败：${e.message}`, e.loc?.line ?? 0, e.loc?.column ?? 0);
  }
  const body = program.body as unknown as Node[];

  const banned = findBanned(program as unknown as Node);
  if (banned) return reject(`禁用标识符 ${banned.name}`, banned.line, banned.column);

  const isolation = findInvalidIsolation(program as unknown as Node);
  if (isolation) return reject(`isolation 只允许 'readonly' 或 'lane'（未授权值在受理前拒绝）`, isolation.line, isolation.column);

  const laneInFanout = findLaneInFanout(program as unknown as Node, { parallel: 0, pipeline: 0 });
  if (laneInFanout)
    return reject(
      `lane_not_serializable：isolation:'lane' 只允许顶层或恰好一层 parallel() 直接实参内（嵌套 fanout 与 pipeline 内不允许）`,
      laneInFanout.line,
      laneInFanout.column,
    );

  if (body.length < 1 || body[0]?.type !== 'ExportNamedDeclaration') {
    return reject('第一条语句必须是 export const meta', body[0]?.loc?.start.line ?? 0, body[0]?.loc?.start.column ?? 0);
  }
  const metaResult = readMeta(body[0]);
  if (!metaResult.ok) return metaResult;

  if (body.length !== 2) {
    const extra = body[1];
    return reject('顶层只允许 meta 与一条 export default async function main', extra?.loc?.start.line ?? 0, extra?.loc?.start.column ?? 0);
  }
  const second = body[1];
  if (second?.type !== 'ExportDefaultDeclaration') {
    return reject('第二条语句必须是 export default async function main', second?.loc?.start.line ?? 0, second?.loc?.start.column ?? 0);
  }
  const decl = second.declaration as Node | undefined;
  if (decl?.type !== 'FunctionDeclaration' || decl.async !== true || (decl.id as Node | undefined)?.name !== 'main') {
    return reject('export default 必须是 async function main', decl?.loc?.start.line ?? 0, decl?.loc?.start.column ?? 0);
  }

  if (Buffer.byteLength(canonical(metaResult.meta), 'utf8') > LIMITS.META_BYTES) {
    return reject('meta 序列化超过 4 KiB', body[0].loc?.start.line ?? 0, body[0].loc?.start.column ?? 0);
  }
  return { ok: true, meta: metaResult.meta };
}

function reject(reason: string, line: number, column: number): AnalyzeResult {
  return { ok: false, code: 'script_rejected', reason, line, column };
}

function findBanned(node: Node): { name: string; line: number; column: number } | null {
  let found: { name: string; line: number; column: number } | null = null;
  walk(node, (n) => {
    if (found) return;
    if (n.type === 'ImportExpression') {
      found = { name: 'import()', line: n.loc?.start.line ?? 0, column: n.loc?.start.column ?? 0 };
      return;
    }
    if (n.type === 'MetaProperty') {
      found = { name: 'import.meta', line: n.loc?.start.line ?? 0, column: n.loc?.start.column ?? 0 };
      return;
    }
    if (n.type === 'Identifier' && BANNED_IDENTIFIERS.has(n.name as string)) {
      found = { name: n.name as string, line: n.loc?.start.line ?? 0, column: n.loc?.start.column ?? 0 };
    }
  });
  return found;
}

function propertyName(n: Node): unknown {
  const key = n.key as Node | undefined;
  return key?.type === 'Identifier' ? key.name : key?.type === 'Literal' ? (key.value as unknown) : undefined;
}

/**
 * 字面量级 isolation 检查：opts 对象里 `isolation: <非 'readonly'/'lane' 字面量>` 在受理前拒绝。
 * 非字面量取值（变量、拼接）无法在静态期判定，仍由派发前 validateOpts 的
 * unsupported_option 兜底；字符串字面量集合之外一律拒绝（含数字/布尔字面量）。
 * W6a 起 'lane' 成为合法取值，其位置约束由 findLaneInFanout 单独检查。
 */
function findInvalidIsolation(node: Node): { line: number; column: number } | null {
  let found: { line: number; column: number } | null = null;
  walk(node, (n) => {
    if (found) return;
    if (n.type !== 'Property' && n.type !== 'PropertyDefinition') return;
    if (propertyName(n) !== 'isolation') return;
    const value = n.value as Node | undefined;
    if (value?.type === 'Literal' && value.value !== 'readonly' && value.value !== 'lane') {
      found = { line: n.loc?.start.line ?? 0, column: n.loc?.start.column ?? 0 };
    }
  });
  return found;
}

/**
 * W6a/W8：lane 只允许出现在可串行化或固定波次的上下文。fanout 上下文跟踪
 * 所在实参链上 parallel()/pipeline() 的层数；isolation:'lane' 字面量合法
 * 当且仅当 pipeline 层数为 0 且 parallel 层数 ≤1（顶层或恰好一层 parallel
 * 直接实参——嵌套 parallel、parallel 内的 pipeline、pipeline 内一律拒绝）。
 * 字面量之外的取值由 validateOpts 在派发前兜底；实参通过外部变量间接提供的
 * lane 调用不在静态期拒绝，运行时仍按波次语义执行。
 */
function findLaneInFanout(node: unknown, fanout: { parallel: number; pipeline: number }): { line: number; column: number } | null {
  if (node === null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findLaneInFanout(item, fanout);
      if (found) return found;
    }
    return null;
  }
  const n = node as Node;
  if (typeof n.type !== 'string') return null;
  if (
    (n.type === 'Property' || n.type === 'PropertyDefinition') &&
    propertyName(n) === 'isolation' &&
    (n.value as Node | undefined)?.type === 'Literal' &&
    (n.value as Node | undefined)?.value === 'lane' &&
    (fanout.pipeline > 0 || fanout.parallel > 1)
  ) {
    return { line: n.loc?.start.line ?? 0, column: n.loc?.start.column ?? 0 };
  }
  const callee = n.type === 'CallExpression' ? (n.callee as Node | undefined) : undefined;
  const fanoutKind = callee?.type === 'Identifier' && (callee.name === 'parallel' || callee.name === 'pipeline') ? callee.name : null;
  for (const key of Object.keys(n)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
    const childFanout = fanoutKind !== null && key === 'arguments' ? { ...fanout, [fanoutKind]: fanout[fanoutKind] + 1 } : fanout;
    const found = findLaneInFanout(n[key], childFanout);
    if (found) return found;
  }
  return null;
}

function walk(node: unknown, visit: (n: Node) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  const n = node as Node;
  if (typeof n.type !== 'string') return;
  visit(n);
  for (const key of Object.keys(n)) {
    if (key === 'loc' || key === 'range' || key === 'start' || key === 'end') continue;
    walk(n[key], visit);
  }
}

type MetaRead = { ok: true; meta: ScriptMeta } | ScriptRejected;
type LiteralRead = { ok: true; value: unknown } | ScriptRejected;

function readMeta(statement: Node): MetaRead {
  const decl = statement.declaration as Node | undefined;
  const bad = (reason: string): MetaRead => reject(reason, statement.loc?.start.line ?? 0, statement.loc?.start.column ?? 0) as MetaRead;
  if (decl?.type !== 'VariableDeclaration' || decl.kind !== 'const') return bad('第一条语句必须是 export const meta');
  const declarators = decl.declarations as Node[];
  if (declarators.length !== 1) return bad('meta 必须是单个 const 声明');
  const declarator = declarators[0]!;
  if ((declarator.id as Node).type !== 'Identifier' || (declarator.id as Node).name !== 'meta') {
    return bad('第一条导出必须命名为 meta');
  }
  const init = declarator.init as Node | null | undefined;
  if (!init) return bad('meta 缺少初始化字面量');
  const value = literalValue(init);
  if (!value.ok) return value;
  const meta = value.value as ScriptMeta;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return bad('meta 必须是对象字面量');
  if (typeof meta.name !== 'string' || meta.name.length === 0) return bad('meta.name 必填非空字符串');
  if (typeof meta.description !== 'string' || meta.description.length === 0) return bad('meta.description 必填非空字符串');
  if (meta.phases !== undefined) {
    if (!Array.isArray(meta.phases) || meta.phases.some((p) => typeof p !== 'string' || p.length === 0)) {
      return bad('meta.phases 必须是非空字符串数组');
    }
  }
  // W9：meta.ultra 只收布尔字面量（literalValue 已保证字面量级，非布尔一律拒绝——
  // fail-closed，不容忍 'true'/1/表达式 等近似写法）。
  if (meta.ultra !== undefined && typeof meta.ultra !== 'boolean') {
    return bad('meta.ultra 必须是布尔字面量');
  }
  return { ok: true, meta };
}

function literalValue(node: Node): LiteralRead {
  const fail = (reason: string): ScriptRejected => ({
    ok: false,
    code: 'script_rejected',
    reason,
    line: node.loc?.start.line ?? 0,
    column: node.loc?.start.column ?? 0,
  });
  switch (node.type) {
    case 'Literal':
      return { ok: true, value: node.value };
    case 'ObjectExpression': {
      const out: Record<string, unknown> = {};
      for (const prop of node.properties as Node[]) {
        if (prop.type !== 'Property') return fail('meta 字面量不允许 spread');
        if (prop.computed === true) return fail('meta 字面量不允许计算键');
        if (prop.kind !== 'init') return fail('meta 字面量不允许 getter/setter');
        const keyNode = prop.key as Node;
        let key: string;
        if (keyNode.type === 'Identifier') key = keyNode.name as string;
        else if (keyNode.type === 'Literal' && typeof keyNode.value === 'string') key = keyNode.value;
        else return fail('meta 键必须是标识符或字符串字面量');
        const v = literalValue(prop.value as Node);
        if (!v.ok) return v;
        out[key] = v.value;
      }
      return { ok: true, value: out };
    }
    case 'ArrayExpression': {
      const arr: unknown[] = [];
      for (const el of node.elements as (Node | null)[]) {
        if (el === null) return fail('meta 数组不允许空洞');
        if (el.type === 'SpreadElement') return fail('meta 字面量不允许 spread');
        const v = literalValue(el);
        if (!v.ok) return v;
        arr.push(v.value);
      }
      return { ok: true, value: arr };
    }
    case 'UnaryExpression': {
      if ((node.operator === '-' || node.operator === '+') && (node.argument as Node).type === 'Literal') {
        const raw = (node.argument as Node).value;
        if (typeof raw === 'number') return { ok: true, value: node.operator === '-' ? -raw : raw };
      }
      return fail('meta 字面量只允许负数等一元数字');
    }
    default:
      return fail(`meta 只允许 JSON 可表达字面量，不允许 ${node.type}`);
  }
}
