import { createHash } from 'node:crypto';
import { WORKFLOW_DSL_VERSION, WORKFLOW_EXECUTION_VERSION, type WorkflowIsolation } from '@wsl/protocol';

/**
 * P0a 冻结合同的转写层（contract-p0a.md 的唯一代码来源）。
 * 只含类型、常量与规范化函数；实现细节分布在内核、worker 与适配器中，不得在本文件外改写合同语义。
 */

/** DSL 版本在 @wsl/protocol 统一定义（跨进程身份字段），此处保留原名再导出。 */
export const DSL_VERSION = WORKFLOW_DSL_VERSION;

export const LIMITS = {
  SCRIPT_BYTES: 64 * 1024,
  META_BYTES: 4 * 1024,
  ARGS_BYTES: 256 * 1024,
  PROMPT_BYTES: 32 * 1024,
  SCHEMA_BYTES: 32 * 1024,
  TOOLS_MAX: 32,
  TOOL_CHARS: 64,
  LABEL_CHARS: 128,
  PROFILE_CHARS: 64,
  MODEL_CHARS: 64,
  RESULT_BYTES: 1024 * 1024,
  VM_HEAP_BYTES: 64 * 1024 * 1024,
  VM_SEGMENT_MS: 2_000,
  VM_TOTAL_MS: 30_000,
  VM_JOBS: 100_000,
  BRIDGE_BUFFER_BYTES: 16 * 1024 * 1024,
  CALL_BUDGET: 1_000,
  FANOUT_MAX: 4_096,
  LOG_MESSAGE_CHARS: 4 * 1024,
  LOG_TOTAL_CHARS: 256 * 1024,
  LOG_MAX_ENTRIES: 2_000,
  RUN_DEADLINE_MS: 600_000,
  CALL_TIMEOUT_DEFAULT_MS: 60_000,
  CALL_TIMEOUT_MIN_MS: 1_000,
  CALL_TIMEOUT_MAX_MS: 300_000,
  RETRIES_MAX: 5,
  /** W5 只读并发上界：同一 run 同时在途的调用派发数；交付仍严格按 callSeq。 */
  MAX_CONCURRENT_CALLS: 4,
} as const;

export type CallId = string; // `${runId}:c${callSeq}`

export type AgentResult<T = unknown> =
  | { status: 'ok'; value: T; callId: CallId }
  | { status: 'failed'; code: CallFailureCode; message: string; callId: CallId | null }
  | { status: 'conflict'; files: string[]; candidateRef: string; callId: CallId };

export type CallFailureCode =
  | 'invalid_args'
  | 'unsupported_option'
  | 'schema_invalid'
  | 'schema_mismatch'
  | 'timeout'
  | 'crash'
  | 'rate_limit'
  | 'permission_denied'
  | 'empty_output'
  | 'stopped'
  | 'result_too_large'
  | 'call_budget_exceeded'
  | 'unplanned_call'
  | 'internal'
  /** W6b：lane 调用要求受理期绑定的受管 App；run 未绑定 AppTarget 时调用得 unavailable。 */
  | 'unavailable';

// §6 的 RunFailureCode 闭集。注：§3/§6 预算表同时规定“最终返回 >1 MiB → run failed{result_too_large}”，
// 闭集列举未含该码；按更具体的行为规则将其并入实现侧集合。
export type RunFailureCode =
  | 'script_error'
  | 'contract_violation'
  | 'result_too_large'
  | 'vm_out_of_memory'
  | 'vm_cpu_segment'
  | 'vm_budget_exceeded'
  | 'jobs_budget_exceeded'
  | 'bridge_buffer_exceeded'
  | 'run_deadline_exceeded'
  | 'internal_error';

export type RunStatus = 'running' | 'stopping' | 'stopped' | 'completed' | 'failed';

export interface AgentOpts {
  harness?: string;
  profile?: string;
  model?: string;
  tier?: 'small' | 'medium' | 'big';
  schema?: Record<string, unknown>;
  isolation?: string;
  label?: string;
  phase?: string;
  timeoutMs?: number;
  retries?: number;
  tools?: string[];
}

/**
 * JournalEvent 的形状已上移到 @wsl/protocol（workflow.ts 的 zod 定义，跨进程 DTO 唯一来源）；
 * 本处保留原名再导出，字段与判别联合和合同 §7 逐成员一致，下游引用无需改动。
 */
export type { WorkflowJournalEvent as JournalEvent } from '@wsl/protocol';

/** 合同规则的抛出类型：加载拒绝、VM prelude 违约与续跑不匹配共用 name 判别。 */
export class WorkflowContractError extends Error {
  readonly code: string;
  readonly line?: number;
  readonly column?: number;

  constructor(code: string, message?: string, position?: { line: number; column: number }) {
    super(message ?? code);
    this.name = 'WorkflowContractError';
    this.code = code;
    if (position) {
      this.line = position.line;
      this.column = position.column;
    }
  }
}

/** canonical：递归排序键的 JSON.stringify；undefined 键丢弃，数组保序。 */
export function canonical(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = normalize(item);
    }
    return out;
  }
  return value;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

/** contentKey = sha256(canonical({prompt, effective, schema, isolation, label, tools, dslVersion, executionVersion}))；W6a 起隔离级别进入身份。 */
export function contentKey(input: {
  prompt: string;
  effective: Record<string, unknown>;
  schema: unknown;
  label: string | null;
  tools: string[];
  isolation?: WorkflowIsolation;
}): string {
  return sha256Hex(
    canonical({
      prompt: input.prompt,
      effective: input.effective,
      schema: input.schema,
      isolation: input.isolation ?? 'readonly',
      label: input.label,
      tools: input.tools,
      dslVersion: DSL_VERSION,
      executionVersion: WORKFLOW_EXECUTION_VERSION,
    }),
  );
}
