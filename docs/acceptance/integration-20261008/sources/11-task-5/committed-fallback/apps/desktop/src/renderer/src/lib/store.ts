import { useSyncExternalStore } from 'react';

/** 极小的外部状态容器：状态更新只通过纯函数完成，便于单独测试。 */
export interface Store<S> {
  get(): S;
  set(update: (state: S) => S): void;
  subscribe(listener: () => void): () => void;
}

export function createStore<S>(initial: S): Store<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(update) {
      const next = update(state);
      if (next === state) return;
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** selector 必须返回状态中已有的引用或原始值，否则会触发无限重渲染。 */
export function useStore<S, T>(store: Store<S>, selector: (state: S) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}
