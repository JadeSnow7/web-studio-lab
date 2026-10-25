import type { CallFailureCode } from './contract';
import type { CallEvent, WorkflowCall, WorkflowCallAdapter } from './call-adapter';

/**
 * MockHarness（fixtures/workflow/README.md）：按 label 匹配预定响应序列，缺省按 prompt 全等，
 * 再缺省用 "fallback" 键；per-attempt 消费 attempts 数组，耗尽后重复末项；无匹配 → unplanned_call。
 */
export type MockResponse =
  | { text: string; delayMs?: number }
  | { textBytes: number; delayMs?: number }
  | { json: unknown; delayMs?: number }
  | { fail: 'timeout' | 'crash' | 'rate_limit' | 'empty_output' | 'schema_bad' | 'permission_denied'; delayMs?: number };

export type MockPlan = Record<string, MockResponse[]>;

export interface MockHarnessOptions {
  /** 每个响应派发前的等待，供 stop-mid-attempt 类测试留出窗口。 */
  delayMs?: number;
  onDispatch?: (call: WorkflowCall) => void;
  /** W7：路由池成员需要各自的 harnessId；缺省 'mock' 不改变既有用法。 */
  harnessId?: string;
}

export class MockHarness implements WorkflowCallAdapter {
  readonly harnessId: string;
  dispatchCount = 0;
  readonly dispatchedLabels: (string | null)[] = [];
  private cursors = new Map<string, number>();

  constructor(
    private plan: MockPlan,
    private options: MockHarnessOptions = {},
  ) {
    this.harnessId = options.harnessId ?? 'mock';
  }

  async *run(call: WorkflowCall, signal: AbortSignal): AsyncIterable<CallEvent> {
    this.dispatchCount += 1;
    this.dispatchedLabels.push(call.label);
    this.options.onDispatch?.(call);

    const key = this.matchKey(call);
    if (key === null) {
      yield { type: 'failed', code: 'unplanned_call', message: `no planned response for label=${call.label ?? 'null'}` };
      return;
    }
    const sequence = this.plan[key]!;
    const cursor = Math.min(this.cursors.get(key) ?? 0, sequence.length - 1);
    this.cursors.set(key, cursor + 1);
    const response = sequence[cursor]!;

    const delayMs = response.delayMs ?? this.options.delayMs ?? 0;
    if (delayMs > 0) {
      const deadline = Date.now() + delayMs;
      while (Date.now() < deadline) {
        if (signal.aborted) return;
        await new Promise((resolve) => setTimeout(resolve, Math.min(10, deadline - Date.now())));
      }
    }
    if (signal.aborted) return;

    if ('fail' in response) {
      yield { type: 'failed', code: this.mapFailCode(response.fail), message: `mock fail: ${response.fail}` };
    } else if ('json' in response) {
      yield { type: 'result', json: response.json };
    } else if ('textBytes' in response) {
      yield { type: 'result', text: 'x'.repeat(response.textBytes) };
    } else {
      yield { type: 'result', text: response.text };
    }
  }

  private matchKey(call: WorkflowCall): string | null {
    if (call.label !== null && call.label in this.plan) return call.label;
    if (call.prompt in this.plan) return call.prompt;
    if ('fallback' in this.plan) return 'fallback';
    return null;
  }

  private mapFailCode(code: string): CallFailureCode {
    switch (code) {
      case 'timeout':
        return 'timeout';
      case 'crash':
        return 'crash';
      case 'rate_limit':
        return 'rate_limit';
      case 'empty_output':
        return 'empty_output';
      case 'permission_denied':
        return 'permission_denied';
      // 计划中的 schema_bad 表示“本次输出不满足 schema”，等价于内核校验出的 schema_mismatch（可重试）。
      case 'schema_bad':
        return 'schema_mismatch';
      default:
        return 'crash';
    }
  }
}
