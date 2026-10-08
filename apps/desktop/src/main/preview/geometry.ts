import type { ElementSummary } from '@wsl/protocol';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 截图区域限制在视图内；完全落在视口外时没有可截区域。 */
export function clampToViewport(rect: NonNullable<ElementSummary['rect']>, viewport: { width: number; height: number }): Rect | null {
  const x = Math.max(0, Math.floor(rect.x));
  const y = Math.max(0, Math.floor(rect.y));
  const right = Math.min(viewport.width, Math.ceil(rect.x + rect.width));
  const bottom = Math.min(viewport.height, Math.ceil(rect.y + rect.height));
  if (right - x < 1 || bottom - y < 1) return null;
  return { x, y, width: right - x, height: bottom - y };
}
