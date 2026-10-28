import { describe, expect, it } from 'vitest';
import {
  ExecutionStatusSchema,
  HarnessDescriptorSchema,
  HarnessRefSchema,
  LEGACY_CODEX_HARNESS_REF,
  RunRecordSchema,
  WorkbenchRunSchema,
  harnessDisplayName,
  harnessRefOf,
} from './index';

const legacyRun = {
  runId: 'r',
  workspaceId: 'w',
  sessionId: 's',
  taskVersionId: 'v',
  targetRef: null,
  state: 'completed',
  startedAt: '2026-10-20T00:00:00.000Z',
  endedAt: null,
  error: null,
  candidateId: 'c',
  validation: { state: 'not_run', applicability: 'unknown', reason: null },
  review: null,
};

describe('Harness 协议（W2）', () => {
  it('W2 之前的执行记录不带 harness，读取时按 Codex CLI native 解释且不改写数据', () => {
    const run = WorkbenchRunSchema.parse(legacyRun);
    expect(run.harness).toBeUndefined();
    expect(harnessDisplayName(run)).toBe('Codex CLI');
    expect(LEGACY_CODEX_HARNESS_REF).toEqual({ harnessId: 'codex', displayName: 'Codex CLI', adapter: 'native', version: null });
  });
  it('新记录保存冻结的 HarnessRef，显示名来自记录', () => {
    const ref = { harnessId: 'claude-code', displayName: 'Claude Code', adapter: 'acp', version: '2.1.0' } as const;
    const run = WorkbenchRunSchema.parse({ ...legacyRun, harness: ref });
    expect(run.harness).toEqual(ref);
    expect(harnessDisplayName(run)).toBe('Claude Code');
    expect(() => HarnessRefSchema.parse({ ...ref, extra: 1 })).toThrow();
    expect(() => HarnessRefSchema.parse({ ...ref, harnessId: 'Bad Id' })).toThrow();
  });
  it('描述符转出处只保留身份与版本', () => {
    const descriptor = HarnessDescriptorSchema.parse({
      harnessId: 'codex',
      displayName: 'Codex CLI',
      adapter: 'native',
      version: '0.160.0',
      capabilities: {
        structuredEvents: true,
        mcp: true,
        resume: true,
        permissionRequests: false,
        clientFs: false,
        clientTerminal: false,
        readOnlyMode: true,
        images: false,
      },
      capabilitySource: 'declared',
    });
    expect(harnessRefOf(descriptor)).toEqual({ harnessId: 'codex', displayName: 'Codex CLI', adapter: 'native', version: '0.160.0' });
  });
  it('旧版 HarnessStatus / RunRecord 的 harness 不带 harnessId 仍可解析，名称不再限定为 Codex', () => {
    expect(
      ExecutionStatusSchema.parse({
        available: false,
        reason: null,
        harness: { name: 'Codex CLI', state: 'integrated', version: null, model: null },
      }).harness.harnessId,
    ).toBeUndefined();
    expect(
      ExecutionStatusSchema.parse({
        available: false,
        reason: null,
        harness: { harnessId: 'claude-code', name: 'Claude Code', state: 'integrated', version: null, model: null },
      }).harness.name,
    ).toBe('Claude Code');
    expect(RunRecordSchema.shape.harness.parse({ name: 'Codex CLI', version: null, model: null })).toEqual({
      name: 'Codex CLI',
      version: null,
      model: null,
    });
  });
});
