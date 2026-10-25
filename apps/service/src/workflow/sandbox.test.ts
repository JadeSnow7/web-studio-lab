import { describe, expect, it } from 'vitest';
import { createRun } from './kernel';
import { MockHarness } from './mock-harness';
import { freshJournalDir, readRunJournal } from './test-helpers';

// E2 子集：intrinsics 收缩、预算中断、日志截断与 __proto__ 注入防护，全部走真实 QuickJS WASM 路径。

const wrap = (body: string, phases = ['p']) =>
  `export const meta = { name: 'sandbox', description: 'sandbox probe', phases: ${JSON.stringify(phases)} };\n` +
  `export default async function main() {\n${body}\n}`;

async function runScript(script: string, args: unknown = null) {
  const journalDir = freshJournalDir();
  const run = await createRun({ script, args, journalDir, adapter: new MockHarness({}) });
  const outcome = await run.done;
  const events = await readRunJournal(journalDir, run.runId);
  return { outcome, events };
}

describe('sandbox (E2 subset)', () => {
  it('real WASM VM executes script code', async () => {
    const { outcome } = await runScript(wrap('return { v: [1, 2, 3].reduce((a, b) => a + b, 0) };'));
    expect(outcome.status).toBe('completed');
    expect(outcome.result).toEqual({ v: 6 });
  }, 30_000);

  it('Date.now() throws → run failed{script_error}', async () => {
    const { outcome } = await runScript(wrap('return { t: Date.now() };'));
    expect(outcome.status).toBe('failed');
    expect(outcome.failureCode).toBe('script_error');
  }, 30_000);

  it('new Date() throws → run failed{script_error}', async () => {
    const { outcome } = await runScript(wrap('return { t: new Date().getTime() };'));
    expect(outcome.status).toBe('failed');
    expect(outcome.failureCode).toBe('script_error');
  }, 30_000);

  it('Math.random() throws → run failed{script_error}', async () => {
    const { outcome } = await runScript(wrap('return { r: Math.random() };'));
    expect(outcome.status).toBe('failed');
    expect(outcome.failureCode).toBe('script_error');
  }, 30_000);

  it('eval is unbound → run failed{script_error}', async () => {
    const { outcome } = await runScript(wrap("return { v: eval('1+1') };"));
    expect(outcome.status).toBe('failed');
    expect(outcome.failureCode).toBe('script_error');
  }, 30_000);

  it('Function is unbound → run failed{script_error}', async () => {
    const { outcome } = await runScript(wrap("return { v: Function('return 1')() };"));
    expect(outcome.status).toBe('failed');
    expect(outcome.failureCode).toBe('script_error');
  }, 30_000);

  it('dynamic import() rejected at static check → script_rejected, no run', async () => {
    await expect(
      createRun({
        script: wrap("const m = await import('x'); return {};"),
        args: null,
        journalDir: freshJournalDir(),
        adapter: new MockHarness({}),
      }),
    ).rejects.toMatchObject({ name: 'WorkflowContractError', code: 'script_rejected' });
  });

  it('while(true){} → vm_cpu_segment', async () => {
    const { outcome } = await runScript(wrap('while (true) {}'));
    expect(outcome.status).toBe('failed');
    expect(outcome.failureCode).toBe('vm_cpu_segment');
  }, 30_000);

  it('microtask bomb → jobs_budget_exceeded 或 vm_budget_exceeded', async () => {
    const { outcome } = await runScript(wrap('function f() { Promise.resolve().then(f); } f(); await null; return {};'));
    expect(outcome.status).toBe('failed');
    expect(['jobs_budget_exceeded', 'vm_budget_exceeded']).toContain(outcome.failureCode);
  }, 60_000);

  it('huge allocation → vm_out_of_memory', async () => {
    const { outcome } = await runScript(wrap("const a = []; while (true) { a.push('x'.repeat(1 << 20)); }"));
    expect(outcome.status).toBe('failed');
    expect(outcome.failureCode).toBe('vm_out_of_memory');
  }, 30_000);

  it('giant log() payload truncated to 4 KiB', async () => {
    const { outcome, events } = await runScript(wrap("log('y'.repeat(10000)); return { ok: 1 };"));
    expect(outcome.status).toBe('completed');
    const logs = events.filter((e) => e.t === 'log');
    expect(logs.length).toBe(1);
    expect((logs[0] as { message: string }).message.length).toBe(4096);
  }, 30_000);

  it('log budget overflow → warn log_budget_exceeded', async () => {
    const { outcome, events } = await runScript(wrap('for (let i = 0; i < 2005; i++) log("entry-" + i); return { ok: 1 };'));
    expect(outcome.status).toBe('completed');
    const warns = events.filter((e) => e.t === 'warn');
    expect(warns.length).toBe(1);
    expect((warns[0] as { code: string }).code).toBe('log_budget_exceeded');
    expect(events.filter((e) => e.t === 'log').length).toBe(2000);
  }, 30_000);

  it('args containing __proto__ keys do not pollute host objects', async () => {
    const args = JSON.parse('{"__proto__": {"polluted": true}, "topic": "t"}');
    const script = wrap('return { a: args.topic, p: Object.getPrototypeOf(args).polluted ?? null };');
    const { outcome } = await runScript(script, args);
    expect(outcome.status).toBe('completed');
    expect(outcome.result).toEqual({ a: 't', p: null });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
  }, 30_000);

  it('worker disposes cleanly and a subsequent run works', async () => {
    const first = await runScript(wrap('return { n: 1 };'));
    expect(first.outcome.status).toBe('completed'); // finalizeRun 等待 worker 退出后才 resolve done
    const second = await runScript(wrap('return { n: 2 };'));
    expect(second.outcome.status).toBe('completed');
    expect(second.outcome.result).toEqual({ n: 2 });
  }, 60_000);

  it('dangling agent() call without await → run failed{script_error}', async () => {
    const { outcome } = await runScript(wrap("agent('fire and forget', { label: 'x', isolation: 'readonly' }); return { done: true };"));
    expect(outcome.status).toBe('failed');
    expect(outcome.failureCode).toBe('script_error');
  }, 30_000);
});
