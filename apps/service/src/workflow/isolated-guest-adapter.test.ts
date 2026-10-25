import { describe, expect, it, vi } from 'vitest';
import type { HarnessDescriptor, ProfileDir, WorkflowRunInput } from '@wsl/protocol';
import type { GuestFrame, GuestOutcome, GuestStart } from '../sbx';
import type { HarnessEvent, NativeHarnessAdapter } from '../harness/types';
import { codexAdapter } from '../harness/codex/adapter';
import { WorkflowCleanupUnconfirmedError, type CallEvent, type WorkflowCall } from './call-adapter';
import { IsolatedGuestAdapter, type GuestProcessLike, type IsolatedGuestAdapterDeps } from './isolated-guest-adapter';

// W3 只读 guest 适配器：伪 GuestProcessLike 记录启动规格、按测试推送帧、
// close 复用同一 done 回执，验证终态映射、能力门控与 abort 清理路径。

const RUN_ID = '11111111-1111-4111-8111-111111111111';
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

class FakeGuest implements GuestProcessLike {
  readonly done: Promise<GuestOutcome>;
  closeCalls = 0;
  writes: unknown[] = [];
  private resolveDone!: (outcome: GuestOutcome) => void;

  constructor(private readonly emit: (frame: GuestFrame) => void) {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  frame(frame: GuestFrame) {
    this.emit(frame);
  }

  settle(outcome: GuestOutcome) {
    this.resolveDone(outcome);
  }

  write(frame: never) {
    this.writes.push(frame);
  }

  close() {
    this.closeCalls += 1;
    return this.done;
  }
}

function stubHarness(overrides: Partial<NativeHarnessAdapter> = {}): NativeHarnessAdapter {
  return {
    label: 'Stub',
    mcpInjection: 'codex-config',
    requiresSessionRef: false,
    maxLineChars: 1024,
    harnessId: 'stub',
    configDirEnv: null,
    selfCheck: {
      versionArgv: ['stub', '--version'],
      statusArgv: ['stub', 'status'],
      parseStatus: () => 'undetermined',
    },
    descriptor: () => ({}) as HarnessDescriptor,
    argv: () => ['stub', 'exec', '--write'],
    argvForIsolation: (isolation) =>
      isolation === 'readonly' ? ['stub', 'exec', '--read-only'] : isolation === 'lane' ? ['stub', 'exec', '--workspace-write'] : null,
    parseLine: () => null,
    ...overrides,
  };
}

function rig(deps: Partial<IsolatedGuestAdapterDeps> = {}) {
  const spawned: { spec: GuestStart; proc: FakeGuest }[] = [];
  const adapter = new IsolatedGuestAdapter({
    start: (spec, onFrame) => {
      const proc = new FakeGuest(onFrame);
      spawned.push({ spec, proc });
      return proc;
    },
    harness: stubHarness(),
    runId: RUN_ID,
    ...deps,
  });
  return { adapter, spawned };
}

const call = (overrides: Partial<WorkflowCall> = {}): WorkflowCall => ({
  callId: `${RUN_ID}:c1`,
  prompt: '只读检查',
  label: null,
  phase: null,
  effective: { harness: 'stub' },
  schema: null,
  isolation: 'readonly',
  tools: [],
  timeoutMs: 60_000,
  ...overrides,
});

const clean: GuestOutcome = { error: null, exitCode: 0, confirmed: true };
const NEVER = new AbortController().signal;

describe('IsolatedGuestAdapter', () => {
  it('以只读 argv、prompt 与冻结输入启动，不携带 MCP/资源包/stdin', async () => {
    const input: WorkflowRunInput = { files: [{ path: 'a.txt', base64: 'QQ==' }] };
    const profileDir: ProfileDir = { env: 'CODEX_HOME', path: '/profiles/codex/default' };
    const { adapter, spawned } = rig({ input, profileDir });

    const iterator = adapter.run(call({ prompt: '检查输入' }), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.spec).toEqual({
      type: 'start',
      mode: 'codex',
      argv: ['stub', 'exec', '--read-only'],
      prompt: '检查输入',
      workspace: { runId: RUN_ID, files: input.files },
      profileDir,
    });
    expect('mcp' in spawned[0]!.spec).toBe(false);
    expect('resourceBundle' in spawned[0]!.spec).toBe(false);
    expect('stdin' in spawned[0]!.spec).toBe(false);
    expect('observation' in spawned[0]!.spec).toBe(false);

    spawned[0]!.proc.settle(clean);
    // 无 turn_completed：进程结束但未产生终态事件 → crash。
    expect((await first).value).toMatchObject({ type: 'failed', code: 'crash' });
  });

  it('无 input 时仍物化空目录作 cwd，无 profileDir 时 start 不携带该字段', async () => {
    const { adapter, spawned } = rig();
    const iterator = adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    expect(spawned[0]!.spec).toEqual({
      type: 'start',
      mode: 'codex',
      argv: ['stub', 'exec', '--read-only'],
      prompt: '只读检查',
      workspace: { runId: RUN_ID, files: [] },
    });
    expect('profileDir' in spawned[0]!.spec).toBe(false);
    spawned[0]!.proc.settle(clean);
    await first;
  });

  it('Codex 事件行映射为 result{text}，忽略 stderr 与 workspace 帧', async () => {
    const { adapter, spawned } = rig({ harness: codexAdapter });
    const iterator = adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    const proc = spawned[0]!.proc;

    expect(spawned[0]!.spec).toMatchObject({
      argv: ['codex', 'exec', '--sandbox', 'read-only', '--json', '--skip-git-repo-check', '-'],
    });
    proc.frame({ type: 'ready', pid: 1 });
    proc.frame({ type: 'output', stream: 'stderr', data: '一些诊断\n' });
    proc.frame({ type: 'output', stream: 'stdout', data: line({ type: 'thread.started', thread_id: 't1' }) });
    proc.frame({
      type: 'output',
      stream: 'stdout',
      data: line({
        type: 'item.completed',
        item: { id: 'w', type: 'command_execution', command: 'ls', aggregated_output: 'x', exit_code: 0 },
      }),
    });
    proc.frame({
      type: 'output',
      stream: 'stdout',
      data: line({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: '答案' } }),
    });
    proc.frame({ type: 'output', stream: 'stdout', data: line({ type: 'turn.completed' }) });
    proc.frame({ type: 'workspace', runId: RUN_ID, files: [] });
    proc.frame({ type: 'exit', exitCode: 0 });
    proc.frame({ type: 'cleanup', ok: true });
    proc.settle(clean);

    expect((await first).value).toEqual({ type: 'result', text: '答案' });
    expect((await iterator.next()).done).toBe(true);
  });

  it('Stub parseLine 的 message/turn_completed 同样映射为 result', async () => {
    const harness = stubHarness({
      parseLine: (l): HarnessEvent[] | null =>
        l === 'DONE' ? [{ type: 'turn_completed' }] : l.startsWith('MSG:') ? [{ type: 'message', id: 'x', text: l.slice(4) }] : null,
    });
    const { adapter, spawned } = rig({ harness });
    const iterator = adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    spawned[0]!.proc.frame({ type: 'output', stream: 'stdout', data: 'MSG:你好\nDONE\n' });
    spawned[0]!.proc.settle(clean);
    expect((await first).value).toEqual({ type: 'result', text: '你好' });
  });

  it('turn_failed 行 → failed{crash}', async () => {
    const { adapter, spawned } = rig({ harness: codexAdapter });
    const iterator = adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    spawned[0]!.proc.frame({ type: 'output', stream: 'stdout', data: line({ type: 'turn.failed', error: { message: '模型出错' } }) });
    spawned[0]!.proc.settle({ error: null, exitCode: 1, confirmed: true });
    expect((await first).value).toMatchObject({ type: 'failed', code: 'crash', message: expect.stringContaining('模型出错') });
    expect(spawned[0]!.proc.closeCalls).toBe(1);
  });

  it('exit 非零 → failed{crash}', async () => {
    const { adapter, spawned } = rig();
    const iterator = adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    spawned[0]!.proc.frame({ type: 'exit', exitCode: 3 });
    spawned[0]!.proc.settle({ error: null, exitCode: 3, confirmed: true });
    expect((await first).value).toMatchObject({ type: 'failed', code: 'crash', message: expect.stringContaining('3') });
  });

  it('error 帧且清理未确认 → owner rejection', async () => {
    const { adapter, spawned } = rig();
    const iterator = adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    spawned[0]!.proc.frame({ type: 'error', error: 'guest 传输炸了' });
    spawned[0]!.proc.settle({ error: 'guest 传输炸了', exitCode: null, confirmed: false });
    await expect(first).rejects.toThrow(/cleanup unconfirmed.*传输炸了/);
  });

  it('cleanup{ok:false} → owner rejection，即使 turn 已完成', async () => {
    const { adapter, spawned } = rig({ harness: codexAdapter });
    const iterator = adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    const proc = spawned[0]!.proc;
    proc.frame({
      type: 'output',
      stream: 'stdout',
      data: line({ type: 'item.completed', item: { id: 'm', type: 'agent_message', text: 'x' } }),
    });
    proc.frame({ type: 'output', stream: 'stdout', data: line({ type: 'turn.completed' }) });
    proc.frame({ type: 'cleanup', ok: false, error: 'helper 清理失败' });
    proc.settle({ error: 'helper 清理失败', exitCode: 0, confirmed: false });
    await expect(first).rejects.toThrow(/cleanup unconfirmed/);
  });

  it('confirmed done error remains crash; unconfirmed done rejects ownership', async () => {
    const { adapter, spawned } = rig();
    const iterator = adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    spawned[0]!.proc.settle({ error: 'sbx 退出失败（1）', exitCode: 1, confirmed: true });
    expect((await first).value).toMatchObject({ type: 'failed', code: 'crash', message: expect.stringContaining('sbx 退出失败') });

    const second = adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    const pending = second.next();
    spawned[1]!.proc.settle({ error: null, exitCode: 0, confirmed: false });
    await expect(pending).rejects.toThrow(/cleanup unconfirmed/);
  });

  it('turn_completed 无助手文本 → failed{empty_output}', async () => {
    const { adapter, spawned } = rig({ harness: codexAdapter });
    const iterator = adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    spawned[0]!.proc.frame({ type: 'output', stream: 'stdout', data: line({ type: 'turn.completed' }) });
    spawned[0]!.proc.settle(clean);
    expect((await first).value).toMatchObject({ type: 'failed', code: 'empty_output' });
  });

  it('parseLine 抛出 → failed{crash} 并发起清理', async () => {
    const harness = stubHarness({
      parseLine: () => {
        throw new Error('坏行');
      },
    });
    const { adapter, spawned } = rig({ harness });
    const iterator = adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    spawned[0]!.proc.frame({ type: 'output', stream: 'stdout', data: 'xxx\n' });
    spawned[0]!.proc.settle(clean);
    expect((await first).value).toMatchObject({ type: 'failed', code: 'crash', message: expect.stringContaining('坏行') });
    expect(spawned[0]!.proc.closeCalls).toBe(1);
  });

  it('超过 maxLineChars 的协议行 → failed{crash}', async () => {
    const { adapter, spawned } = rig({ harness: stubHarness({ maxLineChars: 8 }) });
    const iterator = adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    spawned[0]!.proc.frame({ type: 'output', stream: 'stdout', data: 'this line is far too long\n' });
    spawned[0]!.proc.settle(clean);
    expect((await first).value).toMatchObject({ type: 'failed', code: 'crash', message: expect.stringContaining('协议行超过限制') });
  });

  it('isolation 非 readonly → failed{unsupported_option}，不启动 guest', async () => {
    const { adapter, spawned } = rig();
    const iterator = adapter.run(call({ isolation: 'shared' as 'readonly' }), NEVER)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'failed', code: 'unsupported_option' });
    expect(spawned).toHaveLength(0);
  });

  it('harness 未实现 argvForIsolation 或返回 null → failed{unsupported_option}', async () => {
    const missing = stubHarness();
    delete missing.argvForIsolation;
    const first = rig({ harness: missing });
    const it1 = first.adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    expect((await it1.next()).value).toMatchObject({ type: 'failed', code: 'unsupported_option' });
    expect(first.spawned).toHaveLength(0);

    const second = rig({ harness: stubHarness({ argvForIsolation: () => null }) });
    const it2 = second.adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    expect((await it2.next()).value).toMatchObject({ type: 'failed', code: 'unsupported_option' });
    expect(second.spawned).toHaveLength(0);
  });

  it('start 抛出 → failed{crash}', async () => {
    const adapter = new IsolatedGuestAdapter({
      start: () => {
        throw new Error('sbx 不可用');
      },
      harness: stubHarness(),
      runId: RUN_ID,
    });
    const iterator = adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'failed', code: 'crash', message: expect.stringContaining('sbx 不可用') });
  });

  it('signal abort → 复用 proc.close() 清理，生成器返回且不产出终态', async () => {
    const { adapter, spawned } = rig();
    const controller = new AbortController();
    const iterator = adapter.run(call(), controller.signal)[Symbol.asyncIterator]();
    const first = iterator.next();

    controller.abort();
    spawned[0]!.proc.settle({ error: null, exitCode: null, confirmed: true });

    const result = await first;
    expect(result.done).toBe(true);
    expect(spawned[0]!.proc.closeCalls).toBe(1);
    expect((await iterator.next()).done).toBe(true);
  });

  it('iterator.return()（内核 timeout/stop 路径）→ 同一清理路径', async () => {
    const { adapter, spawned } = rig();
    const iterator = adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    void first;
    const returned = iterator.return!();
    spawned[0]!.proc.settle(clean);
    expect((await returned).done).toBe(true);
    expect(spawned[0]!.proc.closeCalls).toBe(1);
    expect((await first).done).toBe(true);
  });

  it('W6a lane：start 声明 collect，argv 来自 argvForIsolation(lane)', async () => {
    const { adapter, spawned } = rig();
    const iterator = adapter.run(call({ isolation: 'lane' }), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    expect(spawned[0]!.spec).toMatchObject({
      argv: ['stub', 'exec', '--workspace-write'],
      collect: true,
      workspace: { runId: RUN_ID, files: [] },
    });
    spawned[0]!.proc.settle(clean);
    await first;
  });

  it('W6a lane：exit0 后写 collect 帧，collect 帧文件集随 result 带出', async () => {
    const harness = stubHarness({
      parseLine: (l): HarnessEvent[] | null =>
        l === 'DONE' ? [{ type: 'turn_completed' }] : l.startsWith('MSG:') ? [{ type: 'message', id: 'x', text: l.slice(4) }] : null,
    });
    const { adapter, spawned } = rig({ harness });
    const iterator = adapter.run(call({ isolation: 'lane' }), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    const proc = spawned[0]!.proc;
    proc.frame({ type: 'output', stream: 'stdout', data: 'MSG:写入完成\nDONE\n' });
    proc.frame({ type: 'exit', exitCode: 0 });
    await Promise.resolve();
    await Promise.resolve();
    expect(proc.writes).toEqual([{ type: 'collect' }]);
    proc.frame({ type: 'collect', runId: RUN_ID, files: [{ path: 'out.txt', base64: 'WA==' }] });
    proc.frame({ type: 'cleanup', ok: true });
    proc.settle(clean);
    expect((await first).value).toEqual({
      type: 'result',
      text: '写入完成',
      candidate: { files: [{ path: 'out.txt', base64: 'WA==' }] },
    });
  });

  it('W6a lane：collect 帧 runId 不匹配 → failed{crash}', async () => {
    const { adapter, spawned } = rig();
    const iterator = adapter.run(call({ isolation: 'lane' }), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    const proc = spawned[0]!.proc;
    proc.frame({ type: 'exit', exitCode: 0 });
    proc.frame({ type: 'collect', runId: '22222222-2222-4222-8222-222222222222', files: [] });
    proc.settle(clean);
    expect((await first).value).toMatchObject({ type: 'failed', code: 'crash', message: expect.stringContaining('身份不匹配') });
  });

  it('W6a lane：无 collect 帧即 settle → failed{crash} 候选未确认', async () => {
    const harness = stubHarness({
      parseLine: (l): HarnessEvent[] | null =>
        l === 'DONE' ? [{ type: 'turn_completed' }] : l.startsWith('MSG:') ? [{ type: 'message', id: 'x', text: l.slice(4) }] : null,
    });
    const { adapter, spawned } = rig({ harness });
    const iterator = adapter.run(call({ isolation: 'lane' }), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    spawned[0]!.proc.frame({ type: 'output', stream: 'stdout', data: 'MSG:x\nDONE\n' });
    spawned[0]!.proc.frame({ type: 'exit', exitCode: 0 });
    spawned[0]!.proc.frame({ type: 'cleanup', ok: true });
    spawned[0]!.proc.settle(clean);
    expect((await first).value).toMatchObject({ type: 'failed', code: 'crash', message: expect.stringContaining('候选采集未确认') });
  });

  it('W6a lane：collect 超时 → failed{crash} 并发起清理', async () => {
    const { adapter, spawned } = rig({ collectTimeoutMs: 5 });
    const iterator = adapter.run(call({ isolation: 'lane' }), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    const proc = spawned[0]!.proc;
    proc.frame({ type: 'exit', exitCode: 0 });
    // 等超时器先触发（setFailure → requestClose），再让 done 收尾。
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(proc.writes).toEqual([{ type: 'collect' }]);
    proc.settle(clean);
    expect((await first).value).toMatchObject({ type: 'failed', code: 'crash', message: expect.stringContaining('候选采集未确认') });
    expect(proc.closeCalls).toBe(1);
  });

  it('W6a lane：turn_failed 不请求 collect，走同一 close 清理', async () => {
    const { adapter, spawned } = rig({ harness: codexAdapter });
    const iterator = adapter.run(call({ isolation: 'lane' }), NEVER)[Symbol.asyncIterator]();
    const first = iterator.next();
    const proc = spawned[0]!.proc;
    proc.frame({ type: 'output', stream: 'stdout', data: line({ type: 'turn.failed', error: { message: '写失败' } }) });
    proc.settle({ error: null, exitCode: 1, confirmed: true });
    expect((await first).value).toMatchObject({ type: 'failed', code: 'crash' });
    expect(proc.writes).toEqual([]);
    expect(proc.closeCalls).toBe(1);
  });
});

it('abort rejects an unconfirmed guest cleanup receipt', async () => {
  const { adapter, spawned } = rig();
  const abort = new AbortController();
  const it = adapter.run(call(), abort.signal)[Symbol.asyncIterator]();
  const pending = it.next();
  abort.abort();
  spawned[0]!.proc.settle({ error: 'cleanup unconfirmed', exitCode: null, confirmed: false });
  await expect(pending).rejects.toThrow(/cleanup unconfirmed/);
});

it('abort preserves a synchronous close failure as cleanup unconfirmed', async () => {
  const { adapter, spawned } = rig();
  const abort = new AbortController();
  const iterator = adapter.run(call(), abort.signal)[Symbol.asyncIterator]();
  const pending = iterator.next();
  spawned[0]!.proc.close = () => {
    throw new Error('close transport lost');
  };
  abort.abort();
  await expect(pending).rejects.toThrow(/cleanup unconfirmed.*close transport lost/);
});
it('a rejected guest done receipt cannot become an ordinary failed attempt', async () => {
  const { adapter } = rig({
    start: () => ({
      done: Promise.reject(new Error('guest receipt lost')),
      close: () => Promise.reject(new Error('close receipt lost')),
      write: () => {},
    }),
  });
  await expect(adapter.run(call(), NEVER)[Symbol.asyncIterator]().next()).rejects.toThrow(/cleanup unconfirmed.*guest receipt lost/);
});

it('return cannot erase cleanup rejection from the pending next', async () => {
  const { adapter, spawned } = rig();
  const abort = new AbortController();
  const iterator = adapter.run(call(), abort.signal)[Symbol.asyncIterator]();
  const pending = iterator.next();
  const nextFailure = expect(pending).rejects.toThrow(/cleanup unconfirmed/);
  abort.abort();
  const returning = iterator.return!();
  const returnFailure = expect(returning).rejects.toThrow(/cleanup unconfirmed/);
  spawned[0]!.proc.settle({ confirmed: false, exitCode: null, error: 'cleanup unconfirmed' });
  await nextFailure;
  await returnFailure;
});

it('return gives a typed cleanup rejection priority over a simultaneous ordinary next rejection', async () => {
  const { adapter } = rig();
  const cleanup = new WorkflowCleanupUnconfirmedError('cleanup unconfirmed: close receipt lost');
  const inner = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: (): Promise<IteratorResult<CallEvent>> => Promise.reject(new Error('ordinary next failure')),
    return: () => Promise.reject(cleanup),
    throw: () => Promise.reject(new Error('unused')),
  };
  const execution = vi.spyOn(adapter as unknown as { execute: () => typeof inner }, 'execute').mockReturnValue(inner);
  try {
    const iterator = adapter.run(call(), NEVER)[Symbol.asyncIterator]();
    const pending = iterator.next();
    const first = expect(pending).rejects.toThrow('ordinary next failure');
    const closing = iterator.return!();
    await expect(closing).rejects.toBe(cleanup);
    await first;
  } finally {
    execution.mockRestore();
  }
});
