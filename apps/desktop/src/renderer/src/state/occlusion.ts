import { createStore } from '../lib/store';
export function createOcclusion(hide: () => Promise<boolean>) {
  const store = createStore<Record<string, { token: number; visible: boolean }>>({});
  let token = 0;
  return {
    store,
    blocked: () => Object.keys(store.get()).length > 0,
    top: () => Object.entries(store.get()).sort((a, b) => b[1].token - a[1].token)[0]?.[0] ?? null,
    visible: (source: string) => store.get()[source]?.visible ?? false,
    async open(source: string): Promise<boolean> {
      const current = ++token;
      // Pending sources suppress native layout before the asynchronous hide acknowledgement.
      store.set((state) => ({ ...state, [source]: { token: current, visible: false } }));
      let ok: boolean;
      try {
        ok = await hide();
      } catch (error) {
        if (store.get()[source]?.token === current) this.close(source);
        throw error;
      }
      if (store.get()[source]?.token !== current) return false;
      if (!ok) {
        this.close(source);
        return false;
      }
      store.set((state) => ({ ...state, [source]: { token: current, visible: true } }));
      return true;
    },
    close(source: string) {
      store.set((state) => {
        const next = { ...state };
        delete next[source];
        return next;
      });
    },
  };
}
let hideBrowsers: () => Promise<boolean> = async () => {
  throw new Error('原生遮挡服务尚未装配');
};
export const occlusion = createOcclusion(() => hideBrowsers());
export function installOcclusionHider(hide: () => Promise<boolean>) {
  hideBrowsers = hide;
}
