import type { SetupSnapshot } from '@wsl/protocol';
import { createStore } from '../lib/store';
export const setupStore = createStore<{ snapshot: SetupSnapshot | null; error: string | null }>({ snapshot: null, error: null });
export function initializeSetup() {
  let events = 0;
  let active = true;
  const unsubscribe = window.studio.setup.onStatus((snapshot) => {
    events++;
    setupStore.set(() => ({ snapshot, error: null }));
  });
  void window.studio.setup.status().then(
    (snapshot) => {
      if (active && !events) setupStore.set(() => ({ snapshot, error: null }));
    },
    () => setupStore.set((state) => ({ ...state, error: '安装设置读取失败，请重启应用后检查' })),
  );
  return () => {
    active = false;
    unsubscribe();
  };
}
