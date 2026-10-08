import { describe, expect, it } from 'vitest';
import { invokeChannels, PreviewLayoutSchema, ReviewSchema, TaskVersionSchema, isTerminalStatus } from './index';

const page = { webContentsId: 2, documentGeneration: 1, url: 'wsl-demo://taskflow/index.html', title: 't', partition: 'preview-demo' };
const version = {
  taskId: 'task-1',
  version: 1,
  confirmedAt: '2026-10-06T05:00:00.000Z',
  caseId: 'c1',
  goal: '新增 priority',
  allowedScopes: ['ui'],
  acceptance: ['保存后冷启动仍在'],
  budget: { maxAttempts: 3, timeLimitMinutes: 15 },
  capture: { captureId: 'c', capturedAt: '2026-10-06T05:00:00.000Z', page, elementSelector: 'td', elementText: '未设置' },
};

describe('TaskVersionSchema', () => {
  it('接受完整的任务版本', () => {
    expect(TaskVersionSchema.parse(version).version).toBe(1);
  });
  it('预算不能超过计划默认值（3 次 attempt、15 分钟）', () => {
    expect(() => TaskVersionSchema.parse({ ...version, budget: { maxAttempts: 4, timeLimitMinutes: 15 } })).toThrow();
    expect(() => TaskVersionSchema.parse({ ...version, budget: { maxAttempts: 3, timeLimitMinutes: 16 } })).toThrow();
  });
  it('没有验收条件或允许范围时拒绝', () => {
    expect(() => TaskVersionSchema.parse({ ...version, acceptance: [] })).toThrow();
    expect(() => TaskVersionSchema.parse({ ...version, allowedScopes: [] })).toThrow();
  });
});

describe('ReviewSchema', () => {
  it('接受结果必须绑定任务版本与源码快照', () => {
    expect(() => ReviewSchema.parse({ state: 'accepted', decidedAt: 'x', taskVersion: 1 })).toThrow();
    expect(
      ReviewSchema.parse({ state: 'accepted', decidedAt: 'x', taskVersion: 1, sourceState: { baseCommit: 'a', diffHash: 'b' } }).state,
    ).toBe('accepted');
  });
  it('要求修改必须写明原因', () => {
    expect(() => ReviewSchema.parse({ state: 'changes_requested', decidedAt: 'x', taskVersion: 1, note: '  ' })).toThrow();
  });
});

describe('IPC 通道 schema', () => {
  it('布局参数必须是非负整数', () => {
    expect(() => PreviewLayoutSchema.parse({ bounds: { x: -1, y: 0, width: 10, height: 10 }, visible: true })).toThrow();
    expect(() => PreviewLayoutSchema.parse({ bounds: { x: 1.5, y: 0, width: 10, height: 10 }, visible: true })).toThrow();
  });
  it('无参数通道拒绝多余参数', () => {
    expect(() => invokeChannels['preview:reload'].request.parse({ any: 1 })).toThrow();
    expect(invokeChannels['preview:reload'].request.parse(undefined)).toBeUndefined();
  });
  it('导航地址长度受限', () => {
    expect(() => invokeChannels['preview:navigate'].request.parse({ url: 'x'.repeat(3000) })).toThrow();
  });
});

describe('isTerminalStatus', () => {
  it('取消中不是终态，无法判断是终态', () => {
    expect(isTerminalStatus('cancelling')).toBe(false);
    expect(isTerminalStatus('inconclusive')).toBe(true);
  });
});
