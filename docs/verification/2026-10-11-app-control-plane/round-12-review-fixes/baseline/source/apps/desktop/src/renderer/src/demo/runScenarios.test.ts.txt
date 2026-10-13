import { describe, expect, it } from 'vitest';
import { RunRecordSchema, type RunRecord } from '@wsl/protocol';
import { DEMO_RUNS, DEMO_SCENARIOS } from './runScenarios';

const byId = (id: string) => DEMO_RUNS.find((r) => r.runId === id) as RunRecord;

describe('演示运行记录', () => {
  it('全部符合协议，且都标记为 demo', () => {
    for (const record of DEMO_RUNS) {
      expect(() => RunRecordSchema.parse(record)).not.toThrow();
      expect(record.origin).toBe('demo');
    }
  });
  it('每个演示入口都有对应记录', () => {
    for (const s of DEMO_SCENARIOS) expect(byId(s.runId)).toBeDefined();
  });
  it('工具故障记为无法判断，不出现业务失败的检查结果', () => {
    const run = byId('demo-run-inconclusive');
    expect(run.status).toBe('inconclusive');
    const checks = run.attempts.flatMap((a) => a.checks.map((c) => c.result));
    expect(checks).toContain('error');
    expect(checks).not.toContain('fail');
  });
  it('取消中的记录仍有未退出进程；已取消的记录全部退出', () => {
    expect(byId('demo-run-cancelling').processes.some((p) => p.state !== 'exited')).toBe(true);
    expect(byId('demo-run-cancelled').processes.every((p) => p.state === 'exited')).toBe(true);
  });
  it('无模型复验不记录模型，也不需要审阅', () => {
    const run = byId('demo-run-revalidate');
    expect(run.mode).toBe('revalidate');
    expect(run.harness.model).toBeNull();
    expect(run.review.state).toBe('not_ready');
  });
});
