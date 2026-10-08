import { useSyncExternalStore } from 'react';

/** 窗口较窄时只保留一个持续侧面板，右侧通信栏改为覆盖层。 */
export const NARROW_BREAKPOINT = 1200;

function subscribe(listener: () => void) {
  window.addEventListener('resize', listener);
  return () => window.removeEventListener('resize', listener);
}

export function useViewportWidth(): number {
  return useSyncExternalStore(subscribe, () => window.innerWidth);
}
