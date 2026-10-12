import type { PageCapture, StatusDomain, StatusFact, StatusKind } from '@wsl/protocol';
import { createStore, useStore } from '../lib/store';
import { chatStore } from './chat';
import { environmentStore } from './execution';
import { occlusion } from './occlusion';
import { setupStore } from './setup';
import { derivedStatus, statusPresentationStore, type StatusView } from './status-view';
import { workspaceStore } from './workspace';

/*
 * 诊断面板的展示状态（status-interface.md §8.3）。只有「面板是否打开」与过滤选择属于 UI；
 * 事实与转换来自 Main 的 debug:status，不在这里计算，也不写回 Main。
 */

export const DEBUG_OCCLUSION = 'debug-panel';

export const debugStore = createStore<{ open: boolean }>({ open: false });

/** preload 只在 Main 启用诊断通道时暴露 `studio.debug`。 */
export const debugAvailable = (): boolean => window.studio.debug !== undefined;

export const debugActions = {
  /** 进入遮挡集合后才打开：原生网页让位，面板不会被盖住。 */
  async open(): Promise<void> {
    if (!debugAvailable() || debugStore.get().open) return;
    if (await occlusion.open(DEBUG_OCCLUSION)) debugStore.set(() => ({ open: true }));
  },
  close(): void {
    debugStore.set(() => ({ open: false }));
    occlusion.close(DEBUG_OCCLUSION);
  },
  /** 菜单 / 快捷键：打开中则关闭；遮挡尚在确认时再次触发视为关闭，避免残留遮挡。 */
  async toggle(): Promise<void> {
    if (!debugAvailable()) return;
    if (debugStore.get().open || occlusion.store.get()[DEBUG_OCCLUSION]) debugActions.close();
    else await debugActions.open();
  },
};

/* ---------- 事实列表 ---------- */

export const KIND_ORDER: readonly StatusKind[] = ['control', 'unresolved', 'progress', 'problem', 'confirmation', 'steady', 'capability'];

export interface DebugFilter {
  domain: StatusDomain | 'all';
  kind: StatusKind | 'all';
}

export const matchesFilter = (filter: DebugFilter, fact: { key: string; kind: StatusKind; domain?: StatusDomain }): boolean =>
  (filter.domain === 'all' || (fact.domain ?? fact.key.split(':', 1)[0]) === filter.domain) &&
  (filter.kind === 'all' || fact.kind === filter.kind);

/** 按 domain 分组（保持事实在快照中的先后顺序），组内按 kind 的展示顺序、再按 key 排。 */
export function groupFacts(facts: readonly StatusFact[]): Array<{ domain: StatusDomain; facts: StatusFact[] }> {
  const groups = new Map<StatusDomain, StatusFact[]>();
  for (const fact of facts) {
    const list = groups.get(fact.domain);
    if (list) list.push(fact);
    else groups.set(fact.domain, [fact]);
  }
  return [...groups].map(([domain, list]) => ({
    domain,
    facts: [...list].sort(
      (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    ),
  }));
}

export function kindCounts(facts: readonly StatusFact[]): Record<StatusKind | 'all', number> {
  const counts = Object.fromEntries(KIND_ORDER.map((kind) => [kind, 0])) as Record<StatusKind, number>;
  for (const fact of facts) counts[fact.kind] += 1;
  return { ...counts, all: facts.length };
}

/** Renderer 展示层对同一批事实的通道与可见性（按 key 对照）；Main 的事实本身不含通道。 */
export function useRendererViews(): ReadonlyMap<string, StatusView> {
  const snapshot = useStore(workspaceStore, (s) => s.snapshot);
  const workspaceError = useStore(workspaceStore, (s) => s.error);
  const chat = useStore(chatStore, (s) => s.status);
  const setup = useStore(setupStore, (s) => s.snapshot);
  const execution = useStore(environmentStore, (s) => s.execution);
  const presentation = useStore(statusPresentationStore, (s) => s);
  const derived = derivedStatus({ snapshot, chat, setup, execution, presentation, workspaceError });
  return new Map(derived.views.map((view) => [view.key, view]));
}

/* ---------- 会话现场（不可导出） ---------- */

/** 面板内展示的单个字符串上限；页面可控的 title / console message 可能很长。 */
export const DISPLAY_STRING_LIMIT = 2000;

/**
 * 不用正则切分 data URL：页面可控的字符串以 `data:` 开头且没有逗号时，回溯式正则会二次增长。
 * 这里只做 startsWith + indexOf，线性时间。
 */
function describeString(value: string): string {
  if (value.startsWith('data:')) {
    const comma = value.indexOf(',');
    if (comma !== -1) {
      const type = value.slice(5, comma).split(';', 1)[0] ?? '';
      return `[${type} 数据，约 ${Math.ceil(((value.length - comma - 1) * 3) / 4)} 字节]`;
    }
  }
  return value.length > DISPLAY_STRING_LIMIT ? `${value.slice(0, DISPLAY_STRING_LIMIT)}…（已截断，共 ${value.length} 字符）` : value;
}

export function describeCapture(capture: PageCapture): unknown {
  return JSON.parse(JSON.stringify(capture), (_key, value: unknown) => {
    return typeof value === 'string' ? describeString(value) : value;
  });
}
