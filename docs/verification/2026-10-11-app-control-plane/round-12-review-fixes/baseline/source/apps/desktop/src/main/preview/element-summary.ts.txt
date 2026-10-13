import type { ElementSummary } from '@wsl/protocol';

export type CdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

interface DescribeNodeResult {
  node: { nodeName: string; localName?: string; attributes?: string[] };
}
interface ResolveNodeResult {
  object: { objectId?: string };
}
interface CallFunctionResult {
  result: { value?: unknown };
  exceptionDetails?: { text: string };
}
interface BoxModelResult {
  model: { border: number[] };
}

const TEXT_LIMIT = 200;

// 在被点选元素上执行：只读取文本并推导一个展示用的 CSS 路径，不修改页面。
const READ_TEXT_AND_PATH = `function () {
  const text = (this.innerText || this.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, ${TEXT_LIMIT});
  const parts = [];
  let el = this;
  while (el && el.nodeType === 1 && parts.length < 5) {
    let part = el.localName;
    if (el.id) { parts.unshift(part + '#' + el.id); break; }
    const parent = el.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.localName === el.localName);
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
    }
    parts.unshift(part);
    el = parent;
  }
  return { text, selector: parts.join(' > ') };
}`;

export function attributesToMap(flat: readonly string[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!flat) return map;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    map.set(flat[i] as string, flat[i + 1] as string);
  }
  return map;
}

/** CDP 盒模型的 border quad 是 8 个数（四个角的 x、y），换算成外接矩形。 */
export function quadToRect(quad: readonly number[]): ElementSummary['rect'] {
  if (quad.length !== 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]] as number[];
  const ys = [quad[1], quad[3], quad[5], quad[7]] as number[];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** 读取被点选节点的摘要。所有信息都通过同一个 webContents 的 CDP 会话取得。 */
export async function readElementSummary(send: CdpSend, backendNodeId: number): Promise<ElementSummary> {
  const { node } = (await send('DOM.describeNode', { backendNodeId })) as DescribeNodeResult;
  const attrs = attributesToMap(node.attributes);

  const { object } = (await send('DOM.resolveNode', { backendNodeId })) as ResolveNodeResult;
  if (!object.objectId) throw new Error('无法解析被点选的节点');
  let text: string;
  let selector: string;
  try {
    const call = (await send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: READ_TEXT_AND_PATH,
      returnByValue: true,
    })) as CallFunctionResult;
    if (call.exceptionDetails) throw new Error(`读取元素文本失败：${call.exceptionDetails.text}`);
    const value = call.result.value as { text: string; selector: string };
    text = value.text;
    selector = value.selector;
  } finally {
    await send('Runtime.releaseObject', { objectId: object.objectId });
  }

  let rect: ElementSummary['rect'] = null;
  try {
    const { model } = (await send('DOM.getBoxModel', { backendNodeId })) as BoxModelResult;
    rect = quadToRect(model.border);
  } catch (error) {
    // 没有布局的节点（display:none 等）拿不到盒模型：如实记录为无位置，不估算。
    if (!(error instanceof Error) || !/box model/i.test(error.message)) throw error;
  }

  return {
    tagName: (node.localName ?? node.nodeName).toLowerCase(),
    id: attrs.get('id') ?? null,
    classes: (attrs.get('class') ?? '').split(/\s+/).filter(Boolean),
    role: attrs.get('role') ?? null,
    ariaLabel: attrs.get('aria-label') ?? null,
    testId: attrs.get('data-testid') ?? null,
    text,
    selector,
    rect,
  };
}
