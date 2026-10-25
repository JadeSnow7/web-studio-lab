import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { ChatServiceRequestSchema, invokeChannels, type WorkflowJournalEvent, type WorkflowRunOutcome } from '@wsl/protocol';
import type { WorkflowEnginePort, WorkflowEngineRunSpec } from './engine-port';
import { WorkflowApplication, WorkflowApplicationError } from './application';
import { WorkflowCommands, WorkflowCommandError } from './commands';
import { WorkflowCommandsStore } from './commands-store';
import { SqliteWorkflowJournal } from './journal-sqlite';
// E7 语料断言具体拒绝路径：analyze/kernel/host 的实际拒绝点经 service 源码直接驱动（与既有测试同法）。
import { analyzeScript } from '../../../../service/src/workflow/analyze';
import { createRun, type CreateRunOptions } from '../../../../service/src/workflow/kernel';
import { JsonlJournal, readJournal } from '../../../../service/src/workflow/journal-jsonl';
import { MockHarness } from '../../../../service/src/workflow/mock-harness';
import { WorkflowContractError } from '../../../../service/src/workflow/contract';
import { ServiceWorkflowHost } from '../../../../service/src/workflow-host';
import type { ChatServiceRequest } from '@wsl/protocol';

/**
 * E7 授权语料（W5 离线可表示类）：表驱动，每条 {id, class, expect}。
 * expect: 'allow' 或 'reject:<code 前缀>'；每条 check 返回实际观察到的结果，
 * 断言观察 == 期望——含合法人类请求正控 allow，不伪造全拒绝。
 */

const SCRIPT = `export const meta = { name: 'e7', description: 'd' };
export default async function main() { return { ok: 1 }; }`;

class FakeEngine implements WorkflowEnginePort {
  async shutdown(): Promise<void> {}
  readonly specs = new Map<string, WorkflowEngineRunSpec>();
  private readonly controls = new Map<string, { resolve: (o: WorkflowRunOutcome) => void; stopped: boolean }>();

  run(spec: WorkflowEngineRunSpec) {
    this.specs.set(spec.runId, spec);
    let resolveDone!: (o: WorkflowRunOutcome) => void;
    const done = new Promise<WorkflowRunOutcome>((resolve) => {
      resolveDone = resolve;
    });
    const control = { resolve: resolveDone, stopped: false };
    this.controls.set(spec.runId, control);
    return {
      done,
      stop: async () => {
        control.stopped = true;
      },
    };
  }

  emit(runId: string, event: WorkflowJournalEvent): Promise<void> {
    return this.specs.get(runId)!.journal(event);
  }

  finish(runId: string, outcome: WorkflowRunOutcome): void {
    this.controls.get(runId)!.resolve(outcome);
  }

  wasStopped(runId: string): boolean {
    return this.controls.get(runId)?.stopped ?? false;
  }
}

interface Ctx {
  dir: string;
  journal: SqliteWorkflowJournal;
  engine: FakeEngine;
  app: WorkflowApplication;
  store: WorkflowCommandsStore;
  commands: WorkflowCommands;
}

let seq = 0;
function makeCtx(): Ctx {
  const dir = mkdtempSync(path.join(tmpdir(), 'wsl-e7-'));
  const journal = new SqliteWorkflowJournal(path.join(dir, 'journal.db'));
  const engine = new FakeEngine();
  const app = new WorkflowApplication({ journal, engine, now: () => 1_000 });
  const store = new WorkflowCommandsStore(path.join(dir, 'commands.json'), () => 1_000);
  const commands = new WorkflowCommands(store);
  return { dir, journal, engine, app, store, commands };
}

function rid(): string {
  return `e7-req-${++seq}`;
}

function classify(error: unknown): string {
  if (error instanceof WorkflowApplicationError || error instanceof WorkflowCommandError || error instanceof WorkflowContractError) {
    return `reject:${error.code}`;
  }
  if (error instanceof ZodError) return 'reject:schema_violation';
  const message = error instanceof Error ? error.message : String(error);
  const prefixed = message.match(/^([a-z_]+)：/);
  if (prefixed) return `reject:${prefixed[1]}`;
  return 'reject:other';
}

async function attempt(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return 'allow';
  } catch (error) {
    return classify(error);
  }
}

/** 与 ipc.ts handler 同路径：resolve(requireApproved) → app.run。 */
async function runLike(ctx: Ctx, commandId: string, requestId = rid()) {
  const command = await ctx.commands.resolve(commandId, { requireApproved: true });
  return ctx.app.run({ requestId, script: command.script, args: command.args, deadlineMs: command.deadlineMs, input: command.input });
}

async function resumeLike(ctx: Ctx, parentRunId: string, commandId: string, requestId = rid()) {
  const command = await ctx.commands.resolve(commandId, { requireApproved: false });
  return ctx.app.resume({
    requestId,
    parentWorkflowRunId: parentRunId,
    script: command.script,
    args: command.args,
    deadlineMs: command.deadlineMs,
    input: command.input,
  });
}

async function saveLike(ctx: Ctx, input: { commandId?: string; name?: string; script?: string; args?: unknown; deadlineMs?: number }) {
  return ctx.commands.save({
    ...(input.commandId !== undefined ? { commandId: input.commandId } : {}),
    name: input.name ?? '语料命令',
    script: input.script ?? SCRIPT,
    ...(input.args !== undefined ? { args: input.args } : {}),
    deadlineMs: input.deadlineMs ?? 60_000,
  });
}

async function completeRun(
  ctx: Ctx,
  accepted: { workflowRunId: string; scriptHash: string; argsHash: string },
  parentRunId: string | null = null,
) {
  await ctx.engine.emit(accepted.workflowRunId, {
    t: 'run',
    runId: accepted.workflowRunId,
    parentRunId,
    scriptHash: accepted.scriptHash,
    argsHash: accepted.argsHash,
    dslVersion: 'lab-workflow/1',
    status: 'completed',
    result: { ok: 1 },
  });
  ctx.engine.finish(accepted.workflowRunId, { status: 'completed', result: { ok: 1 } });
}

/** 直接把 commands.json 写成指定内容再重新加载（文件层篡改类用例）。 */
async function tamperStore(ctx: Ctx, mutate: (file: { version: number; commands: Record<string, unknown>[] }) => void): Promise<void> {
  const file = { version: 1, commands: ctx.store.list() as unknown as Record<string, unknown>[] };
  mutate(file);
  writeFileSync(path.join(ctx.dir, 'commands.json'), JSON.stringify(file), 'utf8');
  const reloaded = new WorkflowCommandsStore(path.join(ctx.dir, 'commands.json'), () => 1_000);
  await reloaded.load();
  ctx.store = reloaded;
  ctx.commands = new WorkflowCommands(reloaded);
}

/** 真实内核驱动一次调用级用例：返回首个 failed call_end 的 code，或 run 终态。 */
async function kernelOutcome(
  script: string,
  plan: Record<string, { text: string }[]> = { fallback: [{ text: 'ok' }] },
  extra?: Partial<CreateRunOptions>,
): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'wsl-e7-k-'));
  try {
    const run = await createRun({ script, args: null, journalDir: dir, adapter: new MockHarness(plan), ...extra });
    const outcome = await run.done;
    const events = await readJournal(JsonlJournal.filePath(dir, run.runId));
    const failedEnd = events.find((e) => e.t === 'call_end' && e.status === 'failed');
    if (failedEnd && failedEnd.t === 'call_end') return `reject:${failedEnd.code}`;
    return outcome.status === 'completed' ? 'allow' : `reject:${outcome.failureCode}`;
  } catch (error) {
    return classify(error);
  }
}

function analyzeOutcome(script: string): string {
  const result = analyzeScript(script);
  return result.ok ? 'allow' : `reject:${result.code}`;
}

function schemaOutcome(parse: () => unknown): Promise<string> {
  return attempt(Promise.resolve().then(parse));
}

const wrap = (body: string) =>
  `export const meta = { name: 'e7', description: 'd', phases: ['p'] };\nexport default async function main() { ${body} }`;

async function hostDuplicateOutcome(runIds: [string, string]): Promise<string> {
  const posted: unknown[] = [];
  const host = new ServiceWorkflowHost({
    post: (message) => {
      posted.push(message);
    },
    ready: Promise.resolve(),
    start: () => {
      throw new Error('e7 不启动 guest');
    },
    harnesses: [{ harnessId: 'mock', label: 'mock' } as never],
    engine: {
      run: async () => ({ done: new Promise<WorkflowRunOutcome>(() => {}), stop: async () => {} }),
    },
  });
  const request = (id: string, runId: string) =>
    ({ id, method: 'workflow-run', runId, script: 's', args: null }) as unknown as ChatServiceRequest;
  await host.execute(request('r1', runIds[0]));
  try {
    await host.execute(request('r2', runIds[1]));
    return 'allow';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('重复受理')) return 'reject:duplicate_accept';
    return classify(error);
  }
}

type Check = (ctx: Ctx) => Promise<string>;
interface E7Entry {
  id: string;
  cls: string;
  expect: string;
  run: Check;
}
const E = (id: string, cls: string, expect: string, run: Check): E7Entry => ({ id, cls, expect, run });

/** save→approve 后按编辑序列再跑 run；edit 为对 save 输入的覆盖。 */
const editThenRun =
  (edit: Partial<{ name: string; script: string; args: unknown; deadlineMs: number }>): Check =>
  async (ctx) => {
    const card = await saveLike(ctx, {});
    await ctx.commands.approve(card.commandId);
    await ctx.commands.save({
      commandId: card.commandId,
      name: edit.name ?? '语料命令',
      script: edit.script ?? SCRIPT,
      args: edit.args ?? {},
      deadlineMs: edit.deadlineMs ?? 60_000,
    });
    return attempt(runLike(ctx, card.commandId));
  };

const VARIANT_SCRIPT = `export const meta = { name: 'e7v', description: 'other' };\nexport default async function main() { return { ok: 2 }; }`;

const CORPUS: E7Entry[] = [
  // —— 命令改动失效（contentHash 变化使原批准失效）——
  E('E7-001', 'command_edit_invalidation', 'reject:command_not_approved', editThenRun({ script: VARIANT_SCRIPT })),
  E('E7-002', 'command_edit_invalidation', 'reject:command_not_approved', editThenRun({ script: SCRIPT + '// changed\n' })),
  E('E7-003', 'command_edit_invalidation', 'reject:command_not_approved', editThenRun({ args: { a: 2 } })),
  E('E7-004', 'command_edit_invalidation', 'reject:command_not_approved', editThenRun({ args: { b: true } })),
  E('E7-005', 'command_edit_invalidation', 'reject:command_not_approved', editThenRun({ deadlineMs: 90_000 })),
  E('E7-006', 'command_edit_invalidation', 'reject:command_not_approved', editThenRun({ deadlineMs: 30_000 })),
  E('E7-007', 'command_edit_invalidation', 'reject:command_not_approved', async (ctx) => {
    const card = await saveLike(ctx, {});
    await ctx.commands.approve(card.commandId);
    // 任何保存都丢弃 approvedHash（合同口径：保存即失效，不区分改动面）。
    await ctx.commands.save({ commandId: card.commandId, name: '改名命令', script: SCRIPT, args: {}, deadlineMs: 60_000 });
    return attempt(runLike(ctx, card.commandId));
  }),
  E('E7-008', 'command_edit_invalidation', 'reject:command_not_approved', async (ctx) => {
    const card = await saveLike(ctx, { name: '原命令' });
    await ctx.commands.approve(card.commandId);
    await ctx.commands.save({ commandId: card.commandId, name: '另一个名字', script: SCRIPT, args: {}, deadlineMs: 60_000 });
    return attempt(runLike(ctx, card.commandId));
  }),
  E('E7-009', 'command_edit_invalidation', 'allow', async (ctx) => {
    const card = await saveLike(ctx, {});
    await ctx.commands.approve(card.commandId);
    await ctx.commands.save({ commandId: card.commandId, name: '语料命令', script: VARIANT_SCRIPT, args: {}, deadlineMs: 60_000 });
    await ctx.commands.approve(card.commandId); // 重新批准后可运行
    return attempt(runLike(ctx, card.commandId));
  }),
  E('E7-010', 'command_edit_invalidation', 'allow', async (ctx) => {
    const card = await saveLike(ctx, { args: { a: 1 } });
    await ctx.commands.approve(card.commandId);
    await ctx.commands.save({ commandId: card.commandId, name: '语料命令', script: SCRIPT, args: { a: 2 }, deadlineMs: 60_000 });
    await ctx.commands.approve(card.commandId);
    return attempt(runLike(ctx, card.commandId));
  }),
  E('E7-011', 'command_edit_invalidation', 'reject:command_not_approved', async (ctx) => {
    const card = await saveLike(ctx, {});
    await ctx.commands.approve(card.commandId);
    await ctx.commands.save({ commandId: card.commandId, name: '语料命令', script: VARIANT_SCRIPT, args: {}, deadlineMs: 60_000 });
    await ctx.commands.save({ commandId: card.commandId, name: '语料命令', script: VARIANT_SCRIPT, args: { x: 1 }, deadlineMs: 60_000 });
    return attempt(runLike(ctx, card.commandId));
  }),
  E('E7-012', 'command_edit_invalidation', 'reject:command_not_approved', async (ctx) => {
    const card = await saveLike(ctx, {});
    await ctx.commands.approve(card.commandId);
    await ctx.commands.save({ commandId: card.commandId, name: '语料命令', script: VARIANT_SCRIPT, args: {}, deadlineMs: 60_000 });
    await ctx.commands.approve(card.commandId);
    await ctx.commands.save({ commandId: card.commandId, name: '语料命令', script: SCRIPT, args: {}, deadlineMs: 60_000 });
    return attempt(runLike(ctx, card.commandId));
  }),

  // —— 参数/文件层篡改 ——
  E('E7-013', 'args_tamper', 'reject:command_not_approved', async (ctx) => {
    const card = await saveLike(ctx, {});
    await ctx.commands.approve(card.commandId);
    await tamperStore(ctx, (file) => {
      file.commands = file.commands.map((c) => ({ ...c, approvedHash: '0'.repeat(64) }));
    });
    return attempt(runLike(ctx, card.commandId));
  }),
  E('E7-014', 'args_tamper', 'reject:command_not_approved', async (ctx) => {
    const card = await saveLike(ctx, { args: { a: 1 } });
    await ctx.commands.approve(card.commandId);
    await tamperStore(ctx, (file) => {
      file.commands = file.commands.map((c) => ({ ...c, args: { a: 999 } }));
    });
    return attempt(runLike(ctx, card.commandId));
  }),
  E('E7-015', 'args_tamper', 'reject:schema_violation', () =>
    schemaOutcome(() =>
      invokeChannels['workflow:run'].request.parse({ requestId: crypto.randomUUID(), commandId: 'diagnose-input', args: { evil: 1 } }),
    ),
  ),
  E('E7-016', 'args_tamper', 'reject:schema_violation', () =>
    schemaOutcome(() =>
      invokeChannels['workflow:run'].request.parse({ requestId: crypto.randomUUID(), commandId: 'diagnose-input', script: 'x' }),
    ),
  ),
  E('E7-017', 'args_tamper', 'reject:command_not_approved', async (ctx) => {
    const card = await saveLike(ctx, {});
    await ctx.commands.approve(card.commandId);
    await tamperStore(ctx, (file) => {
      file.commands = file.commands.map((c) => ({ ...c, script: VARIANT_SCRIPT }));
    });
    return attempt(runLike(ctx, card.commandId));
  }),
  E('E7-018', 'args_tamper', 'reject:command_not_approved', async (ctx) => {
    const card = await saveLike(ctx, {});
    await ctx.commands.approve(card.commandId);
    await tamperStore(ctx, (file) => {
      file.commands = file.commands.map((c) => ({ ...c, deadlineMs: 599_000 }));
    });
    return attempt(runLike(ctx, card.commandId));
  }),

  // —— 批准前运行 ——
  E('E7-019', 'run_before_approve', 'reject:command_not_approved', async (ctx) => {
    const card = await saveLike(ctx, {});
    return attempt(runLike(ctx, card.commandId));
  }),
  E('E7-020', 'run_before_approve', 'reject:command_not_approved', async (ctx) => {
    const card = await saveLike(ctx, { name: '未批准B' });
    return attempt(runLike(ctx, card.commandId));
  }),
  E('E7-021', 'run_before_approve', 'reject:command_not_approved', async (ctx) => {
    const a = await saveLike(ctx, { name: '已批准' });
    await ctx.commands.approve(a.commandId);
    const b = await saveLike(ctx, { name: '未批准' });
    return attempt(runLike(ctx, b.commandId));
  }),
  E('E7-022', 'run_before_approve', 'allow', async (ctx) => {
    const card = await saveLike(ctx, {});
    await ctx.commands.approve(card.commandId);
    return attempt(runLike(ctx, card.commandId));
  }),

  // —— 未知 commandId ——
  E('E7-023', 'unknown_command', 'reject:unknown_command', (ctx) => attempt(runLike(ctx, 'no-such-command'))),
  E('E7-024', 'unknown_command', 'reject:unknown_command', (ctx) => attempt(resumeLike(ctx, 'parent-run', 'no-such-command'))),
  E('E7-025', 'unknown_command', 'reject:unknown_command', (ctx) => attempt(ctx.commands.approve('no-such-command'))),
  E('E7-026', 'unknown_command', 'reject:unknown_command', (ctx) => attempt(ctx.commands.delete('no-such-command'))),
  E('E7-027', 'unknown_command', 'reject:unknown_command', (ctx) => attempt(ctx.commands.card('no-such-command'))),
  E('E7-028', 'unknown_command', 'reject:unknown_command', (ctx) =>
    attempt(ctx.commands.resolve('no-such-command', { requireApproved: false })),
  ),

  // —— resume 用错 commandId / 未核对 run ——
  E('E7-029', 'resume_mismatch', 'reject:resume_mismatch', async (ctx) => {
    const parent = await runLike(ctx, 'diagnose-input');
    await completeRun(ctx, parent);
    return attempt(resumeLike(ctx, parent.workflowRunId, 'diagnose-slow'));
  }),
  E('E7-030', 'resume_mismatch', 'reject:resume_mismatch', async (ctx) => {
    const card = await saveLike(ctx, {});
    await ctx.commands.approve(card.commandId);
    const parent = await runLike(ctx, card.commandId);
    await completeRun(ctx, parent);
    return attempt(resumeLike(ctx, parent.workflowRunId, 'diagnose-input'));
  }),
  E('E7-031', 'resume_mismatch', 'reject:resume_mismatch', async (ctx) => {
    const card = await saveLike(ctx, { args: { a: 1 } });
    await ctx.commands.approve(card.commandId);
    const parent = await runLike(ctx, card.commandId);
    await completeRun(ctx, parent);
    await ctx.commands.save({ commandId: card.commandId, name: '语料命令', script: SCRIPT, args: { a: 2 }, deadlineMs: 60_000 });
    return attempt(resumeLike(ctx, parent.workflowRunId, card.commandId));
  }),
  E('E7-032', 'resume_mismatch', 'reject:run_not_found', async (ctx) => {
    const parent = await runLike(ctx, 'diagnose-input');
    await completeRun(ctx, parent);
    return attempt(resumeLike(ctx, 'no-such-parent-run', 'diagnose-input'));
  }),
  E('E7-033', 'resume_mismatch', 'reject:resume_mismatch', async (ctx) => {
    const parent = await runLike(ctx, 'diagnose-slow');
    await completeRun(ctx, parent);
    return attempt(resumeLike(ctx, parent.workflowRunId, 'diagnose-parallel'));
  }),
  E('E7-034', 'resume_not_terminal', 'reject:run_not_resumable', async (ctx) => {
    const parent = await runLike(ctx, 'diagnose-input');
    return attempt(resumeLike(ctx, parent.workflowRunId, 'diagnose-input'));
  }),
  E('E7-035', 'resume_not_terminal', 'reject:process_unconfirmed', async (ctx) => {
    const parent = await runLike(ctx, 'diagnose-input');
    // 重启恢复标记：父 run 未核对 → process_unconfirmed（在 assertIdle 之前判出）。
    ctx.journal.updateRunStatus(parent.workflowRunId, { status: 'needs_reconciliation' });
    return attempt(resumeLike(ctx, parent.workflowRunId, 'diagnose-input'));
  }),
  E('E7-036', 'resume_not_terminal', 'reject:run_not_resumable', async (ctx) => {
    const parent = await runLike(ctx, 'diagnose-input');
    ctx.journal.updateRunStatus(parent.workflowRunId, { status: 'stopping' });
    return attempt(resumeLike(ctx, parent.workflowRunId, 'diagnose-input'));
  }),

  // —— run_busy 并发 ——
  E('E7-037', 'run_busy', 'reject:run_busy', async (ctx) => {
    await runLike(ctx, 'diagnose-input');
    return attempt(runLike(ctx, 'diagnose-slow'));
  }),
  E('E7-038', 'run_busy', 'reject:run_busy', async (ctx) => {
    const card = await saveLike(ctx, {});
    await ctx.commands.approve(card.commandId);
    await runLike(ctx, 'diagnose-input'); // 第一个 run 仍在 running
    return attempt(runLike(ctx, card.commandId));
  }),
  E('E7-039', 'run_busy', 'reject:run_busy', async (ctx) => {
    const open = await runLike(ctx, 'diagnose-input');
    ctx.journal.updateRunStatus(open.workflowRunId, { status: 'needs_reconciliation' });
    return attempt(runLike(ctx, 'diagnose-input'));
  }),
  E('E7-040', 'run_busy', 'reject:run_busy', async (ctx) => {
    const first = await runLike(ctx, 'diagnose-input');
    await completeRun(ctx, first);
    await runLike(ctx, 'diagnose-slow'); // 第二个仍在 running
    const card = await saveLike(ctx, {});
    await ctx.commands.approve(card.commandId);
    return attempt(resumeLike(ctx, first.workflowRunId, 'diagnose-input'));
  }),
  E('E7-041', 'run_busy', 'allow', async (ctx) => {
    const first = await runLike(ctx, 'diagnose-input');
    await completeRun(ctx, first);
    return attempt(runLike(ctx, 'diagnose-slow'));
  }),

  // —— requestId 幂等 / 冲突 ——
  E('E7-042', 'request_conflict', 'reject:request_conflict', async (ctx) => {
    const requestId = rid();
    await runLike(ctx, 'diagnose-input', requestId);
    return attempt(runLike(ctx, 'diagnose-slow', requestId));
  }),
  E('E7-043', 'request_conflict', 'reject:request_conflict', async (ctx) => {
    const card = await saveLike(ctx, { args: { a: 1 } });
    await ctx.commands.approve(card.commandId);
    const requestId = rid();
    await runLike(ctx, card.commandId, requestId);
    await ctx.commands.save({ commandId: card.commandId, name: '语料命令', script: SCRIPT, args: { a: 2 }, deadlineMs: 60_000 });
    await ctx.commands.approve(card.commandId);
    return attempt(runLike(ctx, card.commandId, requestId));
  }),
  E('E7-044', 'request_conflict', 'allow', async (ctx) => {
    const requestId = rid();
    const first = await runLike(ctx, 'diagnose-input', requestId);
    const again = await runLike(ctx, 'diagnose-input', requestId);
    expect(again.workflowRunId).toBe(first.workflowRunId);
    expect(ctx.engine.specs.size).toBe(1);
    return 'allow';
  }),
  E('E7-045', 'request_conflict', 'reject:request_conflict', async (ctx) => {
    const parent = await runLike(ctx, 'diagnose-input');
    await completeRun(ctx, parent);
    const requestId = rid();
    await resumeLike(ctx, parent.workflowRunId, 'diagnose-input', requestId);
    return attempt(resumeLike(ctx, 'other-parent', 'diagnose-input', requestId));
  }),
  E('E7-046', 'request_conflict', 'allow', async (ctx) => {
    const parent = await runLike(ctx, 'diagnose-input');
    await completeRun(ctx, parent);
    const requestId = rid();
    const first = await resumeLike(ctx, parent.workflowRunId, 'diagnose-input', requestId);
    const again = await resumeLike(ctx, parent.workflowRunId, 'diagnose-input', requestId);
    expect(again.workflowRunId).toBe(first.workflowRunId);
    return 'allow';
  }),

  // —— saved 命令注入 input ——
  E('E7-047', 'saved_input_injection', 'reject:schema_violation', () =>
    schemaOutcome(() =>
      invokeChannels['workflow:command-save'].request.parse({ name: 'n', script: 's', deadlineMs: 1, input: { files: [] } }),
    ),
  ),
  E('E7-048', 'saved_input_injection', 'reject:schema_violation', () =>
    schemaOutcome(() =>
      invokeChannels['workflow:command-save'].request.parse({
        name: 'n',
        script: 's',
        deadlineMs: 1,
        input: { files: [{ path: 'a.txt', base64: 'QQ==' }] },
      }),
    ),
  ),
  E('E7-049', 'saved_input_injection', 'reject:unknown_command', async (ctx) => {
    await saveLike(ctx, {});
    writeFileSync(
      path.join(ctx.dir, 'commands.json'),
      JSON.stringify({
        version: 1,
        commands: ctx.store.list().map((c) => ({ ...c, input: { files: [{ path: 'evil', base64: 'x' }] } })),
      }),
    );
    const reloaded = new WorkflowCommandsStore(path.join(ctx.dir, 'commands.json'));
    await reloaded.load();
    // 注入 input 的记录使整个文件按损坏处理：saved 为空且记 error（fail-closed）。
    expect(reloaded.error).not.toBeNull();
    expect(reloaded.list()).toHaveLength(0);
    const commands = new WorkflowCommands(reloaded);
    return attempt(commands.card('saved-any'));
  }),
  E('E7-050', 'saved_input_injection', 'reject:unknown_command', async (ctx) => {
    await saveLike(ctx, {});
    writeFileSync(
      path.join(ctx.dir, 'commands.json'),
      JSON.stringify({ version: 1, commands: ctx.store.list().map((c) => ({ ...c, inputFilePaths: ['evil'] })) }),
    );
    const reloaded = new WorkflowCommandsStore(path.join(ctx.dir, 'commands.json'));
    await reloaded.load();
    expect(reloaded.error).not.toBeNull();
    return attempt(new WorkflowCommands(reloaded).card('saved-any'));
  }),
  E('E7-051', 'saved_input_injection', 'reject:unknown_command', async (ctx) => {
    writeFileSync(path.join(ctx.dir, 'commands.json'), '{"version":1,"commands":[],"extra":true}');
    const reloaded = new WorkflowCommandsStore(path.join(ctx.dir, 'commands.json'));
    await reloaded.load();
    expect(reloaded.error).not.toBeNull();
    return attempt(new WorkflowCommands(reloaded).card('saved-any'));
  }),

  // —— 非法 args ——
  E('E7-052', 'invalid_args', 'reject:invalid_args', async (ctx) => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    return attempt(saveLike(ctx, { args: circular }));
  }),
  E('E7-053', 'invalid_args', 'reject:invalid_args', async (ctx) => attempt(saveLike(ctx, { args: { n: 10n } }))),
  E('E7-054', 'invalid_args', 'reject:invalid_args', async (ctx) => attempt(saveLike(ctx, { args: () => 1 }))),
  E('E7-055', 'invalid_args', 'allow', async (ctx) => attempt(saveLike(ctx, { args: undefined }))),

  // —— 超长/越界 ——
  E('E7-056', 'oversize', 'reject:invalid_args', (ctx) => attempt(saveLike(ctx, { name: 'n'.repeat(201) }))),
  E('E7-057', 'oversize', 'reject:invalid_args', (ctx) => attempt(saveLike(ctx, { name: '' }))),
  E('E7-058', 'oversize', 'reject:invalid_args', (ctx) => attempt(saveLike(ctx, { name: '   ' }))),
  E('E7-059', 'oversize', 'reject:command_invalid', (ctx) => attempt(saveLike(ctx, { script: 'x'.repeat(64 * 1024 + 1) }))),
  E('E7-060', 'oversize', 'reject:command_invalid', (ctx) => attempt(saveLike(ctx, { script: '' }))),
  E('E7-061', 'oversize', 'reject:invalid_args', (ctx) => attempt(saveLike(ctx, { deadlineMs: 0 }))),
  E('E7-062', 'oversize', 'reject:invalid_args', (ctx) => attempt(saveLike(ctx, { deadlineMs: 600_001 }))),
  E('E7-063', 'oversize', 'reject:invalid_args', (ctx) => attempt(saveLike(ctx, { deadlineMs: -5 }))),

  // —— isolation 未授权值（受理前 analyze 拒绝；W6a 起 'lane' 合法）——
  E('E7-064', 'isolation', 'allow', () => Promise.resolve(analyzeOutcome(wrap("return agent('x', { isolation: 'lane' });")))),
  E('E7-065', 'isolation', 'reject:script_rejected', () =>
    Promise.resolve(analyzeOutcome(wrap("return agent('x', { isolation: 'shared' });"))),
  ),
  E('E7-066', 'isolation', 'reject:script_rejected', () =>
    Promise.resolve(analyzeOutcome(wrap("return agent('x', { isolation: 'write' });"))),
  ),
  E('E7-067', 'isolation', 'reject:script_rejected', () =>
    Promise.resolve(analyzeOutcome(wrap("return agent('x', { isolation: 'workspace-write' });"))),
  ),
  E('E7-068', 'isolation', 'reject:script_rejected', () => Promise.resolve(analyzeOutcome(wrap("return agent('x', { isolation: 1 });")))),
  E('E7-069', 'isolation', 'reject:script_rejected', () =>
    Promise.resolve(analyzeOutcome(wrap("return agent('x', { isolation: true });"))),
  ),
  E('E7-070', 'isolation', 'allow', () => Promise.resolve(analyzeOutcome(wrap("return agent('x', { isolation: 'readonly' });")))),
  E('E7-071', 'isolation', 'reject:unsupported_option', () =>
    kernelOutcome(wrap("const iso = 'shared'; return agent('x', { label: 'i', isolation: iso });")),
  ),
  // W6a：动态 lane 值通过受理；发布通道缺位（无 Main 回执端口）时调用以 internal 失败。
  // W6b：先绑定 App 目标才轮到发布通道检查（未绑定的 lane 走 E7-115 的 unavailable）。
  E('E7-114', 'isolation', 'reject:internal', () =>
    kernelOutcome(wrap("const iso = 'lane'; return agent('x', { label: 'i', isolation: iso });"), undefined, {
      appTarget: { workspaceId: 'w-e7', projectId: 'p-e7' },
    }),
  ),
  // W6b：lane 调用要求受理期绑定的受管 App——未绑定的 run 内 lane 得 unavailable。
  E('E7-115', 'isolation', 'reject:unavailable', () =>
    kernelOutcome(wrap("const iso = 'lane'; return agent('x', { label: 'i', isolation: iso });")),
  ),

  // —— 脚本形状 ——
  E('E7-072', 'script_shape', 'reject:script_rejected', () =>
    Promise.resolve(analyzeOutcome('export default async function main() { return 1; }')),
  ),
  E('E7-073', 'script_shape', 'reject:script_rejected', () =>
    Promise.resolve(analyzeOutcome("export const meta = { name: 'm', description: 'd' };")),
  ),
  E('E7-074', 'script_shape', 'reject:script_rejected', () =>
    Promise.resolve(analyzeOutcome("export const meta = { description: 'd' };\nexport default async function main() {}")),
  ),
  E('E7-075', 'script_shape', 'reject:script_rejected', () =>
    Promise.resolve(analyzeOutcome("export const meta = { name: 'm' };\nexport default async function main() {}")),
  ),
  E('E7-076', 'script_shape', 'reject:script_rejected', () =>
    Promise.resolve(analyzeOutcome("export const meta = { name: 'm', description: 'd' };\nexport default function main() {}")),
  ),
  E('E7-077', 'script_shape', 'reject:script_rejected', () => Promise.resolve(analyzeOutcome(wrap('return process.pid;')))),
  E('E7-078', 'script_shape', 'reject:script_rejected', () =>
    Promise.resolve(
      analyzeOutcome(`export const meta = { name: 'm', description: 'd' };\nconst x = 1;\nexport default async function main() {}`),
    ),
  ),

  // —— 空 prompt / 超预算 opts（真实内核调用级拒绝）——
  E('E7-079', 'kernel_call_reject', 'reject:invalid_args', () => kernelOutcome(wrap("return agent('');"))),
  E('E7-080', 'kernel_call_reject', 'reject:invalid_args', () => kernelOutcome(wrap("return agent('x', { timeoutMs: 500 });"))),
  E('E7-081', 'kernel_call_reject', 'reject:invalid_args', () => kernelOutcome(wrap("return agent('x', { timeoutMs: 400000 });"))),
  E('E7-082', 'kernel_call_reject', 'reject:invalid_args', () => kernelOutcome(wrap("return agent('x', { retries: 6 });"))),
  E('E7-083', 'kernel_call_reject', 'reject:invalid_args', () => kernelOutcome(wrap("return agent('x', { retries: -1 });"))),
  E('E7-084', 'kernel_call_reject', 'reject:invalid_args', () =>
    kernelOutcome(wrap(`return agent('x', { tools: Array.from({length:33}, (_,i)=>'t'+i) });`)),
  ),
  E('E7-085', 'kernel_call_reject', 'reject:invalid_args', () => kernelOutcome(wrap(`return agent('x', { label: 'l'.repeat(129) });`))),
  E('E7-086', 'kernel_call_reject', 'reject:schema_invalid', () => kernelOutcome(wrap("return agent('x', { schema: { $ref: '#/x' } });"))),
  E('E7-087', 'kernel_call_reject', 'reject:invalid_args', () => kernelOutcome(wrap("return agent('x', { phase: 'not-declared' });"))),
  E('E7-088', 'kernel_call_reject', 'reject:unsupported_option', () =>
    kernelOutcome(wrap("return agent('x', { harness: 'other-harness' });")),
  ),

  // —— 迟到受理（重复 runId / 幂等语义）——
  E('E7-089', 'duplicate_accept', 'reject:duplicate_accept', () => hostDuplicateOutcome(['r-dup', 'r-dup'])),
  E('E7-090', 'duplicate_accept', 'allow', () => hostDuplicateOutcome(['r-a', 'r-b'])),
  E('E7-091', 'duplicate_accept', 'allow', async (ctx) => {
    const requestId = rid();
    const first = await runLike(ctx, 'diagnose-input', requestId);
    await completeRun(ctx, first);
    const again = await runLike(ctx, 'diagnose-input', requestId);
    expect(again.workflowRunId).toBe(first.workflowRunId);
    return 'allow';
  }),
  E('E7-092', 'duplicate_accept', 'reject:request_conflict', async (ctx) => {
    const requestId = rid();
    const first = await runLike(ctx, 'diagnose-input', requestId);
    await completeRun(ctx, first);
    return attempt(runLike(ctx, 'diagnose-slow', requestId));
  }),

  // —— 伪 origin（请求 schema 无 origin 字段，strict 注入即拒）——
  E('E7-093', 'origin_injection', 'reject:schema_violation', () =>
    schemaOutcome(() =>
      invokeChannels['workflow:run'].request.parse({ requestId: crypto.randomUUID(), commandId: 'diagnose-input', origin: 'evil' }),
    ),
  ),
  E('E7-094', 'origin_injection', 'reject:schema_violation', () =>
    schemaOutcome(() =>
      invokeChannels['workflow:resume'].request.parse({
        requestId: crypto.randomUUID(),
        parentRunId: 'p',
        commandId: 'diagnose-input',
        origin: 'evil',
      }),
    ),
  ),
  E('E7-095', 'origin_injection', 'reject:schema_violation', () =>
    schemaOutcome(() => invokeChannels['workflow:stop'].request.parse({ runId: 'r', origin: 'evil' })),
  ),
  E('E7-096', 'origin_injection', 'reject:schema_violation', () =>
    schemaOutcome(() => invokeChannels['workflow:reconcile'].request.parse({ runId: 'r', origin: 'evil' })),
  ),
  E('E7-097', 'origin_injection', 'reject:schema_violation', () =>
    schemaOutcome(() => invokeChannels['workflow:status'].request.parse({ runId: 'r', origin: 'evil' })),
  ),
  E('E7-098', 'origin_injection', 'reject:schema_violation', () =>
    schemaOutcome(() => invokeChannels['workflow:command-save'].request.parse({ name: 'n', script: 's', deadlineMs: 1, origin: 'evil' })),
  ),
  E('E7-099', 'origin_injection', 'reject:schema_violation', () =>
    schemaOutcome(() => invokeChannels['workflow:command-approve'].request.parse({ commandId: 'c', origin: 'evil' })),
  ),
  E('E7-100', 'origin_injection', 'reject:schema_violation', () =>
    schemaOutcome(() => invokeChannels['workflow:command-delete'].request.parse({ commandId: 'c', origin: 'evil' })),
  ),
  E('E7-101', 'origin_injection', 'reject:schema_violation', () =>
    schemaOutcome(() => invokeChannels['workflow:commands'].request.parse({ origin: 'evil' })),
  ),

  // —— builtin 不变量 ——
  E('E7-102', 'builtin_invariants', 'allow', (ctx) => attempt(runLike(ctx, 'diagnose-input'))),
  E('E7-103', 'builtin_invariants', 'allow', (ctx) => attempt(ctx.commands.approve('diagnose-slow'))),
  E('E7-104', 'builtin_invariants', 'reject:command_is_builtin', (ctx) => attempt(ctx.commands.delete('diagnose-input'))),
  E('E7-105', 'builtin_invariants', 'allow', async (ctx) => {
    const card = await ctx.commands.save({ commandId: 'diagnose-input', name: '同名另存', script: SCRIPT, args: {}, deadlineMs: 60_000 });
    // builtin commandId 不可被 save 覆盖：另存新 id。
    expect(card.commandId).not.toBe('diagnose-input');
    expect(card.source).toBe('saved');
    expect(card.approved).toBe(false);
    return 'allow';
  }),
  E('E7-106', 'builtin_invariants', 'allow', async (ctx) => {
    const parent = await runLike(ctx, 'diagnose-input');
    await completeRun(ctx, parent);
    return attempt(resumeLike(ctx, parent.workflowRunId, 'diagnose-input'));
  }),
  E('E7-107', 'builtin_invariants', 'allow', async (ctx) => {
    const cards = await ctx.commands.cards();
    expect(cards.filter((c) => c.source === 'builtin').map((c) => c.commandId)).toEqual([
      'diagnose-input',
      'diagnose-slow',
      'diagnose-parallel',
      'patch-app-wave',
      'patch-app',
    ]);
    return 'allow';
  }),

  // —— 正控 allow ——
  E('E7-108', 'allow_controls', 'allow', async (ctx) => {
    const card = await saveLike(ctx, {});
    await ctx.commands.approve(card.commandId);
    const run = await runLike(ctx, card.commandId);
    await completeRun(ctx, run);
    return attempt(resumeLike(ctx, run.workflowRunId, card.commandId));
  }),
  E('E7-109', 'allow_controls', 'allow', async (ctx) => {
    const card = await saveLike(ctx, {});
    await ctx.commands.delete(card.commandId);
    return attempt(ctx.commands.card('diagnose-input'));
  }),
  E('E7-110', 'allow_controls', 'allow', async (ctx) => {
    const a = await saveLike(ctx, { name: 'A' });
    const b = await saveLike(ctx, { name: 'B' });
    await ctx.commands.approve(a.commandId);
    await ctx.commands.approve(b.commandId);
    const run = await runLike(ctx, a.commandId);
    await completeRun(ctx, run);
    return attempt(runLike(ctx, b.commandId));
  }),
  E('E7-111', 'allow_controls', 'allow', async (ctx) => {
    const card = await saveLike(ctx, {});
    await ctx.commands.approve(card.commandId);
    return attempt(ctx.commands.approve(card.commandId));
  }),
  E('E7-112', 'allow_controls', 'allow', async (ctx) => {
    const run = await runLike(ctx, 'diagnose-slow');
    const stopping = ctx.app.stop(run.workflowRunId);
    // FakeEngine 的 done 由测试驱动：发终态 run 事件并结清 handle。
    await ctx.engine.emit(run.workflowRunId, {
      t: 'run',
      runId: run.workflowRunId,
      parentRunId: null,
      scriptHash: run.scriptHash,
      argsHash: run.argsHash,
      dslVersion: 'lab-workflow/1',
      status: 'stopped',
    });
    ctx.engine.finish(run.workflowRunId, { status: 'stopped' });
    await stopping;
    return ctx.engine.wasStopped(run.workflowRunId) ? 'allow' : 'reject:stop_not_confirmed';
  }),
  E('E7-113', 'allow_controls', 'allow', async (ctx) => {
    const run = await runLike(ctx, 'diagnose-input');
    await completeRun(ctx, run);
    expect(ctx.app.listRuns().map((r) => r.runId)).toContain(run.workflowRunId);
    expect(ctx.app.status(run.workflowRunId).status).toBe('completed');
    return 'allow';
  }),

  // —— W7 路由范围授权 ——
  // 路由范围外的 harness：受理的运行授权里没有该 Harness，opts.harness 越界即拒绝。
  E('E7-116', 'route_scope', 'reject:unsupported_option', () =>
    kernelOutcome(wrap("return agent('x', { label: 'r', harness: 'hz' });"), undefined, {
      routeScope: { defaultHarness: 'ha', members: [{ harnessId: 'ha', profileId: 'ha:default' }] },
    }),
  ),
  // 范围内的 harness 但显式 profile 不是成员：不静默降级，拒绝。
  E('E7-117', 'route_scope', 'reject:unsupported_option', () =>
    kernelOutcome(wrap("return agent('x', { label: 'r', profile: 'hz:default' });"), undefined, {
      routeScope: { defaultHarness: 'ha', members: [{ harnessId: 'ha', profileId: 'ha:default' }] },
    }),
  ),
  // 范围内的合法声明：正控 allow（防全拒绝制造通过）。
  E('E7-118', 'route_scope', 'allow', () =>
    kernelOutcome(wrap("return agent('x', { label: 'r', harness: 'ha', profile: 'ha:default' });"), undefined, {
      routeScope: { defaultHarness: 'ha', members: [{ harnessId: 'ha', profileId: 'ha:default' }] },
    }),
  ),
  // spec 层篡改：profileId 不符合 HarnessProfileIdSchema → 消息 schema 拒绝。
  E('E7-119', 'route_scope', 'reject:schema_violation', () =>
    schemaOutcome(() =>
      ChatServiceRequestSchema.parse({
        id: 'req-rs',
        method: 'workflow-run',
        runId: 'r',
        script: 's',
        routeScope: { defaultHarness: 'ha', members: [{ harnessId: 'ha', profileId: 'not-a-profile', profileDir: null }] },
      }),
    ),
  ),
  // spec 层篡改：注入未知字段 → strict 拒绝。
  E('E7-120', 'route_scope', 'reject:schema_violation', () =>
    schemaOutcome(() =>
      ChatServiceRequestSchema.parse({
        id: 'req-rs2',
        method: 'workflow-run',
        runId: 'r',
        script: 's',
        routeScope: {
          defaultHarness: 'ha',
          members: [{ harnessId: 'ha', profileId: 'ha:default', profileDir: null, credential: 'x' }],
        },
      }),
    ),
  ),

  // —— W8 波次 ——
  // lane 在 parallel() 直接实参内合法（固定波次）。
  E('E7-121', 'wave', 'allow', () =>
    Promise.resolve(
      analyzeOutcome(wrap("return parallel([() => agent('a', { isolation: 'lane' }), () => agent('b', { isolation: 'lane' })]);")),
    ),
  ),
  // 嵌套 parallel 内的 lane 仍拒绝（depth >=2）。
  E('E7-122', 'wave', 'reject:script_rejected', () =>
    Promise.resolve(analyzeOutcome(wrap("return parallel([() => parallel([() => agent('a', { isolation: 'lane' })])]);"))),
  ),
  // pipeline 内的 lane 仍拒绝（即使外层 parallel）。
  E('E7-123', 'wave', 'reject:script_rejected', () =>
    Promise.resolve(analyzeOutcome(wrap("return parallel([() => pipeline([1], () => agent('a', { isolation: 'lane' }))]);"))),
  ),
  // 合并冲突是终态不是失败：不可重试（conflict 交付 conflict 槽位，run 完成）。
  E('E7-124', 'wave', 'allow', () =>
    kernelOutcome(wrap("const iso = 'lane'; return agent('x', { label: 'w', isolation: iso, retries: 3 });"), undefined, {
      appTarget: { workspaceId: 'w-e7', projectId: 'p-e7' },
      adapter: {
        harnessId: 'mock',
        async *run() {
          yield { type: 'result' as const, text: 'ok', candidate: { files: [] } };
        },
      },
      laneWorkspace: async () => ({ baseTree: 'd'.repeat(40), files: [] }),
      publishCandidate: async () => ({ conflict: { files: ['s.txt'], candidateRef: 'f'.repeat(40) } }),
    }),
  ),
  // laneBase 通道缺失（无 laneWorkspace 端口）→ lane 调用 internal 失败，不派发。
  E('E7-125', 'wave', 'reject:internal', () =>
    kernelOutcome(wrap("const iso = 'lane'; return agent('x', { label: 'w', isolation: iso });"), undefined, {
      appTarget: { workspaceId: 'w-e7', projectId: 'p-e7' },
      publishCandidate: async () => {
        throw new Error('must not be called');
      },
    }),
  ),
];

describe('E7 授权语料（W5，≥100 条版本化语料）', () => {
  it(`corpus size >= 100 (got ${CORPUS.length})`, () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(100);
    expect(new Set(CORPUS.map((e) => e.id)).size).toBe(CORPUS.length);
  });

  for (const entry of CORPUS) {
    it(`${entry.id} [${entry.cls}] → ${entry.expect}`, async () => {
      const ctx = makeCtx();
      const observed = await entry.run(ctx);
      expect(observed).toBe(entry.expect);
    }, 60_000);
  }
});
