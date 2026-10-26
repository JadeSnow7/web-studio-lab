import { describe, expect, it } from 'vitest';
import { analyzeScript } from './analyze';

const META = "{ name: 't', description: 'd', phases: ['a'] }";

describe('analyzeScript (合同 §1)', () => {
  it('accepts a minimal valid script and extracts meta', () => {
    const r = analyzeScript(`export const meta = ${META};\nexport default async function main() { return 1; }`);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.meta.name).toBe('t');
      expect(r.meta.phases).toEqual(['a']);
    }
  });

  it('rejects when meta is not the first statement', () => {
    const r = analyzeScript(`const x = 1;\nexport const meta = ${META};\nexport default async function main() {}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('script_rejected');
  });

  it('rejects extra top-level statements', () => {
    const r = analyzeScript(`export const meta = ${META};\nexport default async function main() {}\nfoo();`);
    expect(r.ok).toBe(false);
  });

  it('rejects static import', () => {
    const r = analyzeScript(`import x from 'y';\nexport const meta = ${META};\nexport default async function main() {}`);
    expect(r.ok).toBe(false);
  });

  it('rejects dynamic import()', () => {
    const r = analyzeScript(`export const meta = ${META};\nexport default async function main() { await import('y'); }`);
    expect(r.ok).toBe(false);
  });

  it('rejects import.meta', () => {
    const r = analyzeScript(`export const meta = ${META};\nexport default async function main() { return import.meta.url; }`);
    expect(r.ok).toBe(false);
  });

  for (const name of ['process', 'fetch', 'require', 'setTimeout', 'queueMicrotask', 'Worker', 'crypto', 'WebAssembly']) {
    it(`rejects banned identifier ${name}`, () => {
      const r = analyzeScript(`export const meta = ${META};\nexport default async function main() { return ${name}; }`);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain(name);
    });
  }

  it('allows banned words inside strings and comments', () => {
    const r = analyzeScript(
      `export const meta = ${META};\n// process setTimeout fetch\nexport default async function main() { return 'process.env setTimeout()'; }`,
    );
    expect(r.ok).toBe(true);
  });

  it('allows Date/Math/eval/Function/globalThis identifiers (runtime handles them)', () => {
    const r = analyzeScript(
      `export const meta = ${META};\nexport default async function main() { return [Date, Math, eval, Function, globalThis].length; }`,
    );
    expect(r.ok).toBe(true);
  });

  it('rejects non-literal meta (identifier ref)', () => {
    const r = analyzeScript(`const n = 'x';\nexport const meta = { name: n, description: 'd' };\nexport default async function main() {}`);
    expect(r.ok).toBe(false);
  });

  it('rejects meta with computed key', () => {
    const r = analyzeScript(`export const meta = { ['na' + 'me']: 'x', description: 'd' };\nexport default async function main() {}`);
    expect(r.ok).toBe(false);
  });

  it('rejects meta with spread', () => {
    const r = analyzeScript(`export const meta = { ...{ name: 'x' }, description: 'd' };\nexport default async function main() {}`);
    expect(r.ok).toBe(false);
  });

  it('rejects meta with template string', () => {
    const r = analyzeScript(`export const meta = { name: \`x\`, description: 'd' };\nexport default async function main() {}`);
    expect(r.ok).toBe(false);
  });

  it('rejects meta missing name', () => {
    const r = analyzeScript(`export const meta = { description: 'd' };\nexport default async function main() {}`);
    expect(r.ok).toBe(false);
  });

  it('rejects meta with empty phases entry', () => {
    const r = analyzeScript(`export const meta = { name: 't', description: 'd', phases: [''] };\nexport default async function main() {}`);
    expect(r.ok).toBe(false);
  });

  it('rejects serialized meta > 4 KiB', () => {
    const r = analyzeScript(
      `export const meta = { name: 't', description: '${'d'.repeat(5000)}' };\nexport default async function main() {}`,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects non-async default export', () => {
    const r = analyzeScript(`export const meta = ${META};\nexport default function main() {}`);
    expect(r.ok).toBe(false);
  });

  it('rejects default export not named main', () => {
    const r = analyzeScript(`export const meta = ${META};\nexport default async function other() {}`);
    expect(r.ok).toBe(false);
  });

  it('rejects second export before main', () => {
    const r = analyzeScript(`export const meta = ${META};\nexport const x = 1;\nexport default async function main() {}`);
    expect(r.ok).toBe(false);
  });

  it('rejects non-object meta literal', () => {
    const r = analyzeScript(`export const meta = 'x';\nexport default async function main() {}`);
    expect(r.ok).toBe(false);
  });

  it('rejects syntax error', () => {
    const r = analyzeScript('export const meta = {;');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('script_rejected');
      expect(r.line).toBeGreaterThan(0);
    }
  });

  // —— W8 lane 波次位置规则 ——
  const laneMain = (body: string) => `export const meta = ${META};\nexport default async function main() { ${body} }`;

  it('W8: lane inside a single parallel() argument is allowed', () => {
    const r = analyzeScript(
      laneMain(`await parallel([() => agent('a', { isolation: 'lane' }), () => agent('b', { isolation: 'lane' })]);`),
    );
    expect(r.ok).toBe(true);
  });

  it('W8: lane inside nested parallel (depth >=2) is rejected', () => {
    const r = analyzeScript(laneMain(`await parallel([() => parallel([() => agent('a', { isolation: 'lane' })])]);`));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('lane_not_serializable');
  });

  it('W8: lane inside pipeline() is rejected even under parallel()', () => {
    expect(analyzeScript(laneMain(`await pipeline([1], () => agent('a', { isolation: 'lane' }));`)).ok).toBe(false);
    expect(analyzeScript(laneMain(`await parallel([() => pipeline([1], () => agent('a', { isolation: 'lane' }))]);`)).ok).toBe(false);
  });

  it('W8: lane at top level stays allowed', () => {
    expect(analyzeScript(laneMain(`return agent('a', { isolation: 'lane' });`)).ok).toBe(true);
  });

  // —— W9 meta.ultra 布尔门禁（fail-closed）——

  it('W9: meta.ultra boolean literals accepted and surfaced', () => {
    for (const ultra of ['true', 'false']) {
      const r = analyzeScript(
        `export const meta = { name: 't', description: 'd', ultra: ${ultra} };\nexport default async function main() {}`,
      );
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.meta.ultra).toBe(ultra === 'true');
    }
  });

  it('W9: meta.ultra absent defaults to undefined (non-ultra)', () => {
    const r = analyzeScript(`export const meta = ${META};\nexport default async function main() {}`);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.meta.ultra).toBeUndefined();
  });

  for (const bad of ["'true'", '1', '0', 'null', '"ultra"', 'FLAG', '{ }']) {
    it(`W9: meta.ultra non-boolean literal ${bad} is rejected`, () => {
      const r = analyzeScript(
        `export const meta = { name: 't', description: 'd', ultra: ${bad} };\nexport default async function main() {}`,
      );
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('script_rejected');
    });
  }
});
