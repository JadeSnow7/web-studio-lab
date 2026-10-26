import { ChatServiceMessageSchema, ChatServiceRequestSchema } from './chat';
import { describe, expect, it } from 'vitest';
import {
  WorkflowAcceptedSchema,
  WorkflowCommandCardSchema,
  WorkflowCommandSaveSchema,
  WorkflowJournalEventSchema,
  WorkflowRunRowSchema,
  WorkflowStatusProjectionSchema,
  WorkflowUpdateEventSchema,
} from './workflow';

/** W4/W5 新增 schema 的正反例：命令卡、保存载荷、运行行、受理回执、更新 tick、状态投影、attempt_end usage。 */
describe('workflow W5 schemas', () => {
  const card = {
    commandId: 'diagnose-input',
    name: '固定输入诊断',
    description: '读取冻结输入快照。',
    phases: ['collect', 'summarize'],
    script: 'export const meta = {};\nexport default async function main() {}',
    args: {},
    inputFilePaths: ['input/app.ts'],
    scriptHash: 'a'.repeat(64),
    argsHash: 'b'.repeat(64),
    deadlineMs: 60_000,
    source: 'builtin',
    approved: true,
    // W6b：命令卡声明 App 绑定与写意图（元数据级，权威校验在 service analyze + kernel）。
    requiresApp: false,
    writes: false,
  };

  it('parses a command card and rejects extra fields', () => {
    expect(WorkflowCommandCardSchema.parse(card).commandId).toBe('diagnose-input');
    expect(WorkflowCommandCardSchema.safeParse({ ...card, injected: true }).success).toBe(false);
    expect(WorkflowCommandCardSchema.safeParse({ ...card, deadlineMs: -1 }).success).toBe(false);
    expect(WorkflowCommandCardSchema.safeParse({ ...card, source: 'remote' }).success).toBe(false);
  });

  it('parses command-save payload; strict shape rejects injected input', () => {
    const save = {
      name: 'n',
      script: 'export const meta = {};\nexport default async function main() {}',
      args: { a: 1 },
      deadlineMs: 60_000,
    };
    expect(WorkflowCommandSaveSchema.parse(save).name).toBe('n');
    // saved 命令不支持冻结输入：注入 input 字段即 schema 拒绝。
    expect(WorkflowCommandSaveSchema.safeParse({ ...save, input: { files: [] } }).success).toBe(false);
    expect(WorkflowCommandSaveSchema.safeParse({ ...save, deadlineMs: 700_000 }).success).toBe(false);
  });

  it('parses run row / accepted / update payloads', () => {
    expect(
      WorkflowRunRowSchema.parse({
        runId: 'r1',
        requestId: 'req-1',
        status: 'running',
        scriptHash: 's',
        argsHash: 'a',
        parentRunId: null,
        createdMs: 1,
        failureCode: null,
        requiresApp: false,
        writes: false,
        appTarget: null,
        ultra: false,
      }).status,
    ).toBe('running');
    expect(WorkflowAcceptedSchema.parse({ workflowRunId: 'r1', scriptHash: 's', argsHash: 'a' }).workflowRunId).toBe('r1');
    expect(WorkflowUpdateEventSchema.parse({ workflowRunId: 'r1', seq: 0 }).seq).toBe(0);
    // 内部列不外泄：多余字段被拒绝。
    expect(
      WorkflowRunRowSchema.safeParse({
        runId: 'r',
        requestId: null,
        status: 's',
        scriptHash: '',
        argsHash: '',
        parentRunId: null,
        createdMs: 0,
        failureCode: null,
        resultJson: '{}',
      }).success,
    ).toBe(false);
  });

  it('attempt_end carries optional usage; projection marks unknown usage as null', () => {
    expect(
      WorkflowJournalEventSchema.parse({
        t: 'attempt_end',
        runId: 'r',
        callSeq: 1,
        attempt: 1,
        status: 'ok',
        usage: { inputTokens: 1000, outputTokens: 20 },
      }),
    ).toMatchObject({ usage: { inputTokens: 1000 } });
    expect(
      WorkflowJournalEventSchema.safeParse({
        t: 'attempt_end',
        runId: 'r',
        callSeq: 1,
        attempt: 1,
        status: 'ok',
        usage: { inputTokens: -1, outputTokens: 0 },
      }).success,
    ).toBe(false);

    const projection = WorkflowStatusProjectionSchema.parse({
      runId: 'r',
      status: 'completed',
      failureCode: null,
      requiresApp: false,
      writes: false,
      appTarget: null,
      calls: [
        { seq: 1, label: 'l1', phase: null, status: 'ok', code: null, attempts: 1, cachedFromRunId: null, usage: null },
        { seq: 2, label: 'l2', phase: 'summarize', status: 'cached', code: null, attempts: 0, cachedFromRunId: 'ancestor', usage: null },
      ],
      logTail: [{ seq: 1, kind: 'log', text: 'hi' }],
    });
    expect(projection.calls[1]?.cachedFromRunId).toBe('ancestor');
  });
});

it('workflow cleanup receipts and shutdown use narrow IPC shapes without a serialized signal', () => {
  expect(ChatServiceRequestSchema.parse({ id: 'close', method: 'workflow-shutdown' })).toEqual({
    id: 'close',
    method: 'workflow-shutdown',
  });
  expect(ChatServiceRequestSchema.safeParse({ id: 'close', method: 'workflow-shutdown', signal: { aborted: true } }).success).toBe(false);
  expect(
    ChatServiceMessageSchema.parse({ type: 'workflow-cleanup-unconfirmed', runId: 'r', error: 'negative guest cleanup receipt' }),
  ).toEqual({ type: 'workflow-cleanup-unconfirmed', runId: 'r', error: 'negative guest cleanup receipt' });
  expect(
    ChatServiceMessageSchema.safeParse({ type: 'workflow-cleanup-unconfirmed', runId: 'r', error: 'cleanup', confirmed: true }).success,
  ).toBe(false);
});
