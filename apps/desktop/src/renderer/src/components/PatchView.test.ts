import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { PatchView } from './PatchView';

afterEach(() => vi.unstubAllGlobals());
it('renders at most 500 patch lines even when the bounded evidence contains over 100000 short lines', () => {
  vi.stubGlobal('React', React);
  const patch = 'diff --git a/file b/file\n@@ -0,0 +1,110000 @@\n' + '+\n'.repeat(110000);
  expect(new TextEncoder().encode(patch).byteLength).toBeLessThan(256 * 1024);
  const html = renderToStaticMarkup(
    React.createElement(PatchView, {
      files: [{ path: 'file', change: 'added', additions: 110000, deletions: 0 }],
      patch,
    }),
  );
  expect((html.match(/class="diff-(?:meta|hunk|add|del|ctx)"/g) ?? []).length).toBe(500);
  expect(html).toContain('源码 diff 分页');
  expect((html.match(/class="btn"/g) ?? []).length).toBe(4);
  expect(html).toContain('仅本页');
  expect(html).toContain('1–500');
  expect(patch.split('\n')).toHaveLength(110003);
});
it('preserves small and empty/demo patch rendering without pagination controls', () => {
  vi.stubGlobal('React', React);
  const html = renderToStaticMarkup(React.createElement(PatchView, { files: [], patch: '-before\n+after\n' }));
  expect(html).toContain('diff-del');
  expect(html).toContain('diff-add');
  expect(html).not.toContain('源码 diff 分页');
  const empty = renderToStaticMarkup(React.createElement(PatchView, { files: [], patch: null, emptyText: 'empty fixture' }));
  expect(empty).toContain('empty fixture');
  expect(empty).not.toContain('<pre');
});
