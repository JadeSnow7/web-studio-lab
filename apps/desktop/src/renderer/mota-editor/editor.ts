import './editor.css';
import type { MotaEditorProjection, MotaEditorReadResult } from '@wsl/protocol';

const element = <T extends HTMLElement>(id: string) => {
  const result = document.getElementById(id);
  if (!result) throw new Error('编辑器控件缺失：' + id);
  return result as T;
};
type FileName = 'project/floors/MT1.js' | '_server/config.json';
type Draft = {
  text: string;
  baseline: string | null;
  original: string;
  read: boolean;
  current: MotaEditorReadResult | null;
  conflict: boolean;
};
const drafts: Record<FileName, Draft> = {
  'project/floors/MT1.js': { text: '', baseline: null, original: '', read: false, current: null, conflict: false },
  '_server/config.json': { text: '', baseline: null, original: '', read: false, current: null, conflict: false },
};
const content = element<HTMLTextAreaElement>('content');
const select = element<HTMLSelectElement>('file');
const saveButton = element<HTMLButtonElement>('save');
const readButton = element<HTMLButtonElement>('read');
const state = element<HTMLParagraphElement>('state');
const operationState = element<HTMLParagraphElement>('operation-state');
let projection: MotaEditorProjection = { sessionIndex: null, state: 'opening', theme: 'system', error: null, operations: [] };
type Operation = MotaEditorProjection['operations'][number];
let lastSave: { sessionIndex: number; requestId: string; result: Operation | null } | null = null;
let selected: FileName = 'project/floors/MT1.js';
let busy = false;
let composing = false;
// Session storage belongs to this nonpersistent native partition. It survives a
// document reload, never a workbench restart, and carries no grant or operation ID.
function retainDrafts() {
  if (Object.values(drafts).some((draft) => draft.text.length > 262144)) {
    message('草稿超过编辑上限，仍保留在本页；请减少内容后再保存。', 'error');
    return;
  }
  try {
    sessionStorage.setItem(
      'mota-drafts',
      JSON.stringify(
        Object.fromEntries(
          Object.entries(drafts).map(([file, draft]) => [
            file,
            { text: draft.text, baseline: draft.baseline, original: draft.original, read: draft.read },
          ]),
        ),
      ),
    );
  } catch {
    message('草稿仍在本页内存中，但无法暂存到本次窗口；请先保留内容。', 'error');
  }
}
function restoreDrafts() {
  const bytes = sessionStorage.getItem('mota-drafts');
  if (!bytes) return;
  const value: unknown = JSON.parse(bytes);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('草稿记录无效');
  for (const file of ['project/floors/MT1.js', '_server/config.json'] as const) {
    const item: unknown = Reflect.get(value, file);
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('草稿文件无效');
    const text: unknown = Reflect.get(item, 'text');
    const original: unknown = Reflect.get(item, 'original');
    const baseline: unknown = Reflect.get(item, 'baseline');
    const read: unknown = Reflect.get(item, 'read');
    if (
      typeof text !== 'string' ||
      text.length > 262144 ||
      typeof original !== 'string' ||
      original.length > 262144 ||
      !(baseline === null || (typeof baseline === 'string' && /^[a-f0-9]{64}$/.test(baseline))) ||
      typeof read !== 'boolean'
    )
      throw new Error('草稿内容无效');
    drafts[file] = { text, original, baseline, read, current: null, conflict: false };
  }
}
const dirty = (draft: Draft) => draft.text !== draft.original;
const unsettled = (entry: Operation) => ['unknown', 'staging', 'staged'].includes(entry.operation.status);
const unknown = () =>
  projection.operations.find(unsettled) ?? (lastSave?.result && unsettled(lastSave.result) ? lastSave.result : undefined);
function message(text: string, kind = '') {
  state.textContent = text;
  state.dataset['kind'] = kind;
}
function savedMessage(result: Operation) {
  return result.durabilityIssue || result.operation.receipt!.durabilityError
    ? '已保存到副本，但持久化确认有异常，请核对状态。'
    : '已保存到副本。可刷新游戏查看。';
}
function rememberOperation(incoming: Operation): Operation {
  const previous = lastSave?.result;
  // A later permission projection or original reply cannot undo a known commit or durability failure.
  const operation =
    previous &&
    ((previous.operation.status === 'committed' && incoming.operation.status !== 'committed') ||
      (previous.operation.status === 'unknown' && ['staging', 'staged'].includes(incoming.operation.status)))
      ? previous.operation
      : incoming.operation;
  const receipt = operation.receipt;
  const result = {
    ...incoming,
    operation: receipt
      ? {
          ...operation,
          receipt: { ...receipt, durabilityError: receipt.durabilityError ?? previous?.operation.receipt?.durabilityError ?? null },
        }
      : operation,
    durabilityIssue: incoming.durabilityIssue ?? previous?.durabilityIssue ?? null,
  };
  lastSave = { sessionIndex: result.sessionIndex, requestId: result.operation.requestId, result };
  return result;
}
function render() {
  const draft = drafts[selected];
  if (content.value !== draft.text) content.value = draft.text;
  content.disabled = !draft.read;
  saveButton.disabled =
    busy ||
    projection.state !== 'active' ||
    !draft.read ||
    !draft.current ||
    draft.current.sessionIndex !== projection.sessionIndex ||
    !dirty(draft) ||
    new TextEncoder().encode(draft.text).length > 262144 ||
    draft.conflict ||
    !!unknown();
  readButton.disabled = busy || !!unknown();
  element('conflict').hidden = !draft.conflict;
  element<HTMLTextAreaElement>('before').value = draft.original;
  element<HTMLTextAreaElement>('current').value = draft.current?.content ?? '配置文件尚不存在';
  element('recovery').hidden = !unknown();
  // Operation facts outlive permission changes; they never confer a read baseline or grant.
  const result = lastSave?.result;
  operationState.hidden = !result;
  if (result) {
    const committed = result.operation.status === 'committed';
    const failed = result.operation.status === 'failed';
    operationState.textContent =
      (result.sessionIndex === projection.sessionIndex ? '本次保存：' : '原会话保存：') +
      (committed
        ? savedMessage(result)
        : failed
          ? describe(new Error(result.operation.error ?? '保存未完成'))
          : '保存结果待核对，不能重复提交。');
    operationState.dataset['kind'] = committed
      ? result.durabilityIssue || result.operation.receipt!.durabilityError
        ? 'unknown'
        : ''
      : failed
        ? 'error'
        : 'unknown';
    operationState.dataset['sessionIndex'] = String(result.sessionIndex);
    operationState.dataset['requestId'] = result.operation.requestId;
  }
}
function applyProjection(next: MotaEditorProjection) {
  const replaced = projection.sessionIndex !== next.sessionIndex || (projection.state === 'active' && next.state !== 'active');
  projection = next;
  const tracked = lastSave;
  const operation = tracked
    ? next.operations.find((entry) => entry.sessionIndex === tracked.sessionIndex && entry.operation.requestId === tracked.requestId)
    : next.operations.at(-1);
  if (operation) {
    const retained = rememberOperation(operation);
    projection = { ...next, operations: next.operations.map((entry) => (entry === operation ? retained : entry)) };
  }
  if (replaced) for (const draft of Object.values(drafts)) draft.current = null;
  const theme = next.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : next.theme;
  document.documentElement.dataset['theme'] = theme;
  if (unknown()) message('保存结果待核对；草稿已保留。', 'unknown');
  else if (next.error) message('编辑器暂不可用，请重新读取或核对状态。', 'error');
  else if (next.state === 'revoked') message('授权已撤销。重新打开后读取当前版本，草稿仍保留。');
  else if (next.state === 'active') message(dirty(drafts[selected]) ? '有未保存草稿，请先读取当前版本核对。' : '已连接，可读取文件。');
  render();
}
async function status(reconcile: boolean) {
  const operation = reconcile ? unknown() : undefined;
  applyProjection(
    await window.motaEditor.status({
      sessionIndex: operation?.sessionIndex ?? projection.sessionIndex,
      requestId: crypto.randomUUID(),
      ...(operation ? { operationRequestId: operation.operation.requestId } : {}),
    }),
  );
}
async function read() {
  if (busy) return;
  busy = true;
  render();
  const file = selected;
  try {
    await status(false);
    if (projection.sessionIndex === null || projection.state !== 'active') throw new Error('编辑器尚未就绪，请重新打开视图');
    const index = projection.sessionIndex;
    const result = await window.motaEditor.read({ sessionIndex: index, file, requestId: crypto.randomUUID() });
    if (projection.sessionIndex !== index || projection.state !== 'active') return;
    const draft = drafts[file];
    draft.current = result;
    if (!draft.read || !dirty(draft)) {
      draft.text = result.content ?? '';
      draft.original = draft.text;
      draft.baseline = result.contentHash;
      draft.read = true;
      draft.conflict = false;
    } else draft.conflict = draft.baseline !== result.contentHash;
    message(draft.conflict ? '版本已变化，草稿保留。请比较原始与当前内容。' : '已读取当前版本。', draft.conflict ? 'error' : '');
    retainDrafts();
  } catch (error) {
    message(describe(error), 'error');
  } finally {
    busy = false;
    render();
  }
}
async function save() {
  if (busy || composing || saveButton.disabled) return;
  const file = selected;
  const draft = drafts[file];
  const index = projection.sessionIndex;
  if (index === null) return;
  const text = draft.text;
  const requestId = crypto.randomUUID();
  lastSave = { sessionIndex: index, requestId, result: null };
  busy = true;
  message('正在保存…');
  render();
  try {
    const reply = await window.motaEditor.save({
      sessionIndex: index,
      requestId,
      file,
      expectedHash: draft.baseline,
      content: text,
    });
    if (reply.sessionIndex !== index || reply.operation.requestId !== requestId) throw new Error('保存回执与原操作不符');
    const result = rememberOperation(reply);
    projection.operations = [
      ...projection.operations.filter((entry) => entry.sessionIndex !== index || entry.operation.requestId !== requestId),
      result,
    ];
    if (projection.sessionIndex !== index) {
      await status(false);
      return;
    }
    if (result.operation.status === 'committed') {
      // A newer draft keeps its original comparison baseline. A revoked owner cannot regain a read capability.
      if (draft.text === text) {
        draft.original = text;
        draft.baseline = result.operation.receipt!.afterHash;
        draft.current =
          projection.state === 'active'
            ? {
                sessionIndex: index,
                content: text,
                contentHash: draft.baseline,
                contentLength: result.operation.receipt!.contentLength,
              }
            : null;
      } else draft.current = null;
      message(
        projection.state === 'revoked'
          ? '授权已撤销。重新打开后读取当前版本，草稿仍保留。'
          : projection.state === 'active' && (selected !== file || draft.text !== text)
            ? selected === file || dirty(drafts[selected])
              ? '有未保存草稿，请先读取当前版本核对。'
              : '已连接，可读取文件。'
            : savedMessage(result),
        result.durabilityIssue || result.operation.receipt!.durabilityError ? 'unknown' : '',
      );
      retainDrafts();
    } else
      message(
        result.operation.status === 'unknown'
          ? '保存结果待核对，不能重复提交。'
          : describe(new Error(result.operation.error ?? '保存未完成')),
        'unknown',
      );
  } catch (error) {
    message(describe(error), 'error');
  } finally {
    busy = false;
    render();
  }
}
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : '';
  if (text.includes('source_changed')) return '副本版本已变化，请读取并比较；草稿已保留。';
  if (text.includes('busy')) return '副本正在被使用，请先核对原操作或结束地图任务。';
  if (text.includes('revoked')) return '授权已撤销，请重新打开并读取；草稿已保留。';
  if (text.includes('invalid_content')) return '内容格式不受支持或超过 256 KiB；原文件未被覆盖。';
  return '操作未能确认。草稿已保留，请核对保存状态或重新打开。';
}
content.addEventListener('input', () => {
  drafts[selected].text = content.value;
  message(dirty(drafts[selected]) ? '有未保存草稿。' : '内容与读取版本一致。');
  retainDrafts();
  render();
});
content.addEventListener('compositionstart', () => {
  composing = true;
});
content.addEventListener('compositionend', () => {
  composing = false;
});
document.addEventListener('keydown', (event) => {
  if (!event.isComposing && !composing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void save();
  }
});
select.addEventListener('change', () => {
  selected = select.value === '_server/config.json' ? '_server/config.json' : 'project/floors/MT1.js';
  render();
});
readButton.addEventListener('click', () => {
  void read();
});
saveButton.addEventListener('click', () => {
  void save();
});
element('status').addEventListener('click', () => {
  void status(true).catch((error: unknown) => message(describe(error), 'unknown'));
});
element('close').addEventListener('click', () => {
  if (projection.sessionIndex !== null)
    void window.motaEditor
      .close({ sessionIndex: projection.sessionIndex, requestId: crypto.randomUUID() })
      .catch((error: unknown) => message(describe(error), 'error'));
});
element('use-current').addEventListener('click', () => {
  const draft = drafts[selected];
  if (!draft.current || !confirm('放弃此文件的未保存草稿，采用副本当前版本？')) return;
  draft.text = draft.current.content ?? '';
  draft.original = draft.text;
  draft.baseline = draft.current.contentHash;
  draft.conflict = false;
  message('已采用当前版本。');
  retainDrafts();
  render();
});
try {
  restoreDrafts();
} catch {
  message('本次窗口中的草稿记录不可读取；请保留已有内容并核对副本。', 'error');
}
window.motaEditor.onState(applyProjection);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (projection.theme === 'system') applyProjection(projection);
});
void status(false).catch((error: unknown) => message(describe(error), 'error'));
