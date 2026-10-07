import { describe, expect, it } from 'vitest';
import type { TerminalSnapshot } from '@wsl/protocol';
import { projectTerminal, type TerminalState } from './terminal';

const initial: TerminalState = { snapshot: null, pending: false, error: null };
const snapshot: TerminalSnapshot = {
  seq: 10,
  sessionId: 'current',
  sandbox: 'fixture-sandbox',
  cwd: '/home/agent/workspace',
  state: 'running',
  output: 'current prompt',
  cleanupPending: true,
  error: null,
};
describe('终端会话投影', () => {
  it('重开后旧会话与迟到初始查询不能覆盖输出', () => {
    const state = projectTerminal(initial, snapshot);
    expect(projectTerminal(state, { ...snapshot, seq: 9, sessionId: 'old', output: 'late' })).toBe(state);
    expect(projectTerminal(state, snapshot)).toBe(state);
  });
  it('关闭失败保留已确认会话输出与错误', () => {
    const state = projectTerminal(initial, snapshot);
    expect(projectTerminal(state, { ...snapshot, seq: 11, state: 'failed', error: '未确认远端退出' }).snapshot).toMatchObject({
      output: 'current prompt',
      cleanupPending: true,
      error: '未确认远端退出',
      state: 'failed',
    });
  });
});
