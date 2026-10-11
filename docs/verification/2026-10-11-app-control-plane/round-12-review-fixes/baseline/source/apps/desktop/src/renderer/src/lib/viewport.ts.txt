import { useSyncExternalStore } from 'react';

function subscribe(listener: () => void) {
  window.addEventListener('resize', listener);
  return () => window.removeEventListener('resize', listener);
}

export function useViewportWidth(): number {
  return useSyncExternalStore(subscribe, () => window.innerWidth);
}
