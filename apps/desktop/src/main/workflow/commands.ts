import { randomUUID } from 'node:crypto';
import type { WorkflowCommandCard, WorkflowCommandSave, WorkflowRunInput } from '@wsl/protocol';
import { sha256Hex, workflowArgsHash, workflowInputHash, workflowScriptHash } from './journal-sqlite';
import type { WorkflowCommandsStore } from './commands-store';
import { type SavedWorkflowCommand } from './commands-store';

/**
 * W5 命令仓储：内置命令（builtin，代码冻结即批准）+ 用户保存命令（saved，文件仓储）。
 * 批准绑定：contentHash = sha256(scriptHash + argsHash + inputHash + deadlineMs)，
 * saved 命令的 approvedHash 与当前内容一致才允许 run；任何内容保存都丢弃 approvedHash。
 * run/resume 只按 commandId 解析——卡片内容本身是展示数据，不作为授权依据。
 * saved 命令不支持冻结输入（input 字段不存在；strict schema 在入口拒绝注入）。
 */

export type WorkflowCommandErrorCode =
  'unknown_command' | 'command_not_approved' | 'command_is_builtin' | 'invalid_args' | 'command_invalid';

export class WorkflowCommandError extends Error {
  readonly code: WorkflowCommandErrorCode;

  constructor(code: WorkflowCommandErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'WorkflowCommandError';
    this.code = code;
  }
}

interface WorkflowBuiltinCommandDef {
  commandId: string;
  name: string;
  description: string;
  phases: string[];
  script: string;
  args: unknown;
  input?: WorkflowRunInput;
  deadlineMs: number;
}

/** run/resume 解析出的执行负载；input 仅 builtin 可携带。 */
export interface WorkflowCommandResolution {
  commandId: string;
  script: string;
  args: unknown;
  input?: WorkflowRunInput;
  deadlineMs: number;
  source: 'builtin' | 'saved';
}

const INPUT_SNAPSHOT: WorkflowRunInput = {
  files: [
    {
      path: 'input/app.ts',
      base64: Buffer.from(
        [
          "import { defineConfig } from 'vite';",
          '',
          'export default defineConfig({',
          '  server: { port: 5173 },',
          "  build: { target: 'es2022' },",
          '});',
          '',
        ].join('\n'),
        'utf8',
      ).toString('base64'),
    },
    {
      path: 'input/README.md',
      base64: Buffer.from('# 输入快照\n\n固定任务的冻结输入，用于只读诊断演示。\n', 'utf8').toString('base64'),
    },
  ],
};

const DIAGNOSE_SCRIPT = `export const meta = {
  name: '固定输入诊断',
  description: '读取冻结输入快照，先逐文件摘要再汇总成一段诊断报告。',
  phases: ['collect', 'summarize'],
};

export default async function main() {
  phase('collect');
  const collected = await agent('读取输入目录 input/ 下的 app.ts 与 README.md，逐文件给出一句中文摘要。', {
    label: '收集摘要',
  });
  if (collected.status !== 'ok') return { ok: false, stage: 'collect', error: collected.message };
  log('收集完成：' + String(collected.value).slice(0, 200));
  phase('summarize');
  const report = await agent('把下面的文件摘要汇总成一段中文诊断报告：' + String(collected.value), {
    label: '汇总报告',
  });
  if (report.status !== 'ok') return { ok: false, stage: 'summarize', error: report.message };
  return { ok: true, report: report.value };
}
`;

const DIAGNOSE_SLOW_SCRIPT = `export const meta = {
  name: '固定输入慢速诊断',
  description: '与固定输入诊断相同，但汇总阶段驻留等待，用于停止与续跑验证。',
  phases: ['collect', 'summarize'],
};

export default async function main() {
  phase('collect');
  const collected = await agent('读取输入目录 input/ 下的 app.ts 与 README.md，逐文件给出一句中文摘要。', {
    label: '收集摘要',
  });
  if (collected.status !== 'ok') return { ok: false, stage: 'collect', error: collected.message };
  log('收集完成：' + String(collected.value).slice(0, 200));
  phase('summarize');
  const report = await agent('[slow] 把下面的文件摘要汇总成一段中文诊断报告：' + String(collected.value), {
    label: '慢速汇总',
  });
  if (report.status !== 'ok') return { ok: false, stage: 'summarize', error: report.message };
  return { ok: true, report: report.value };
}
`;

const DIAGNOSE_PARALLEL_SCRIPT = `export const meta = {
  name: '固定输入并行诊断',
  description: 'W5 只读并发：并行派发快速摘要与驻留慢速摘要，用于并发交付与停止验证。',
  phases: ['parallel'],
};

export default async function main() {
  phase('parallel');
  const [fast, slow] = await parallel([
    () => agent('读取输入目录 input/ 下的 app.ts，给出一句中文摘要。', { label: '并行摘要' }),
    () => agent('[slow] 读取输入目录 input/ 下的 README.md，给出一句中文摘要。', { label: '慢速摘要' }),
  ]);
  const text = (r) => (r.status === 'ok' ? r.value : r.message);
  return { ok: fast.status === 'ok' && slow.status === 'ok', fast: text(fast), slow: text(slow) };
}
`;

const PATCH_APP_WAVE_SCRIPT = `export const meta = {
  name: '波次修改应用（候选）',
  description: 'W8 固定波次：两个 lane 并行修改受管 App 源码，候选按调用序号合并发布；冲突的候选保留并返回 conflict 槽位，不自动合并。',
  phases: ['wave'],
};

export default async function main() {
  phase('wave');
  const [a, b] = await parallel([
    () => agent('读取工程源码；在工程中新增 wave-a 相关文件后返回变更摘要。', { label: '波次 A', isolation: 'lane' }),
    () => agent('读取工程源码；在工程中新增 wave-b 相关文件后返回变更摘要。', { label: '波次 B', isolation: 'lane' }),
  ]);
  return { ok: a.status === 'ok' && b.status === 'ok', a: a.status, b: b.status };
}
`;

const PATCH_APP_SCRIPT = `export const meta = {
  name: '修改应用（候选）',
  description: 'lane 写候选：Agent 在受管 App 的隔离副本里修改源码并发布候选快照；候选不会自动进入应用——审阅 diff 后由你显式应用。',
  phases: ['edit'],
};

export default async function main() {
  phase('edit');
  const change = await agent('读取工程源码；实现 README 顶部注释描述的目标后返回变更摘要。', {
    label: '修改工程',
    isolation: 'lane',
  });
  if (change.status !== 'ok') return { ok: false, stage: 'edit', error: change.message };
  return { ok: true, summary: change.value };
}
`;

const BUILTINS: readonly WorkflowBuiltinCommandDef[] = [
  {
    commandId: 'diagnose-input',
    name: '固定输入诊断',
    description: '读取冻结输入快照，先逐文件摘要再汇总成一段诊断报告。',
    phases: ['collect', 'summarize'],
    script: DIAGNOSE_SCRIPT,
    args: {},
    input: INPUT_SNAPSHOT,
    deadlineMs: 60_000,
  },
  {
    commandId: 'diagnose-slow',
    name: '固定输入慢速诊断',
    description: '与固定输入诊断相同，但汇总阶段驻留等待，用于停止与续跑验证。',
    phases: ['collect', 'summarize'],
    script: DIAGNOSE_SLOW_SCRIPT,
    args: {},
    input: INPUT_SNAPSHOT,
    deadlineMs: 90_000,
  },
  {
    commandId: 'diagnose-parallel',
    name: '固定输入并行诊断',
    description: 'W5 只读并发：并行派发快速摘要与驻留慢速摘要，用于并发交付与停止验证。',
    phases: ['parallel'],
    script: DIAGNOSE_PARALLEL_SCRIPT,
    args: {},
    input: INPUT_SNAPSHOT,
    deadlineMs: 90_000,
  },
  {
    commandId: 'patch-app-wave',
    name: '波次修改应用（候选）',
    description: 'W8 固定波次：两个 lane 并行修改受管 App 源码，候选按调用序号合并发布；应用前须审阅授权。',
    phases: ['wave'],
    script: PATCH_APP_WAVE_SCRIPT,
    args: {},
    deadlineMs: 300_000,
  },
  {
    commandId: 'patch-app',
    name: '修改应用（候选）',
    description: 'lane 写候选：Agent 修改受管 App 源码并发布候选；应用前须审阅并显式授权。',
    phases: ['edit'],
    script: PATCH_APP_SCRIPT,
    args: {},
    // 无 input：lane 的冻结输入在受理期取受管 App 的实时源码快照（App 绑定）。
    deadlineMs: 300_000,
  },
];

function builtinDef(commandId: string): WorkflowBuiltinCommandDef | null {
  return BUILTINS.find((def) => def.commandId === commandId) ?? null;
}

/** contentHash = sha256(scriptHash + argsHash + inputHash + deadlineMs)：批准绑定的唯一口径。 */
function commandContentHash(parts: { script: string; args: unknown; input?: WorkflowRunInput; deadlineMs: number }): string {
  return sha256Hex(
    workflowScriptHash(parts.script) + workflowArgsHash(parts.args) + workflowInputHash(parts.input) + String(parts.deadlineMs),
  );
}

/** saved 命令的 meta 只做展示：尽力提取 name/description/phases，失败回退占位（脚本身份靠 hash 不靠 meta）。 */
function metaString(script: string, key: string): string | null {
  const match = script.match(new RegExp(`${key}\\s*:\\s*'([^'\\\\]*)'`)) ?? script.match(new RegExp(`${key}\\s*:\\s*"([^"\\\\]*)"`));
  return match?.[1] ?? null;
}

function metaPhases(script: string): string[] {
  const match = script.match(/phases\s*:\s*\[([^\]]*)\]/);
  if (!match) return [];
  const out: string[] = [];
  const item = /'([^'\\]*)'|"([^"\\]*)"/g;
  let group: RegExpExecArray | null;
  while ((group = item.exec(match[1]!)) !== null) out.push(group[1] ?? group[2] ?? '');
  return out.filter((phase) => phase.length > 0);
}

/**
 * W6b：脚本声明 lane 调用（元数据级检测——批准/卡片/绑定决策的展示依据；
 * 运行时权威校验在 service analyze + kernel）。requiresApp 与 writes 目前同口径：
 * lane 是唯一的写隔离级别，而 lane 需要受理期绑定的受管 App。
 * 先剥离注释与字符串字面量再匹配——字符串/注释里的 `isolation: 'lane'` 不应触发
 * App 绑定与冻结输入替换。剥离后残余的误报方向是「不绑定」：lane 调用在内核以
 * unavailable 诚实失败，不会静默写入；模板字符串整体按字面量处理（${} 内的 lane
 * 语法按未声明处理，同样收敛到不绑定）。
 */
export function scriptDeclaresLane(script: string): boolean {
  // 剥离注释并把字符串字面量折叠为 ''——内容恰为 lane 的引号字面量例外地保留
  // 'lane' 形态，使代码中的 isolation:'lane' 仍可命中；注释与模板字符串整体剔除。
  // 残余误报（如 isolation:'lane'+'x'）与漏报（如 isolation:`lane`）都收敛到
  // 「不绑定/不派发」一侧：analyze/kernel 的字面量校验是运行时权威，这里只提前决定
  // 是否绑定受管 App 与替换冻结输入，宁缺毋滥。
  let stripped = '';
  let quote: "'" | '"' | '`' | null = null;
  let literal = '';
  let state: 'code' | 'line' | 'block' | 'escape' = 'code';
  for (let i = 0; i < script.length; i++) {
    const ch = script[i]!;
    const next = script[i + 1];
    if (state === 'escape') {
      literal += ch;
      state = 'code';
    } else if (quote !== null) {
      if (ch === '\\') {
        literal += ch;
        state = 'escape';
      } else if (ch === quote) {
        if (quote !== '`') stripped += literal === 'lane' ? "'lane'" : "''";
        quote = null;
        literal = '';
      } else {
        literal += ch;
      }
    } else if (state === 'line') {
      if (ch === '\n') {
        state = 'code';
        stripped += ch;
      }
    } else if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code';
        i += 1;
      }
    } else if (ch === '/' && next === '/') {
      state = 'line';
      i += 1;
    } else if (ch === '/' && next === '*') {
      state = 'block';
      i += 1;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      literal = '';
    } else {
      stripped += ch;
    }
  }
  return /isolation\s*:\s*['"]lane['"]/.test(stripped);
}

export class WorkflowCommands {
  /** 仓储加载（损坏文件 fail-closed：saved 为空且 error 可读，builtin 不受影响）。 */
  readonly ready: Promise<void>;

  constructor(private readonly store: WorkflowCommandsStore) {
    this.ready = store.load();
  }

  /** 文件仓储的加载错误；null 表示仓储健康。 */
  get storeError(): string | null {
    return this.store.error;
  }

  /** 全部命令卡：内置在前，saved 按创建序；approved 即时按 contentHash 重算。 */
  async cards(): Promise<WorkflowCommandCard[]> {
    await this.ready;
    const builtin = BUILTINS.map((def) => this.builtinCard(def));
    const saved = this.store.list().map((command) => this.savedCard(command));
    return [...builtin, ...saved];
  }

  /** builtin 或任意 saved 命令的展示卡；未知 id 抛 unknown_command。 */
  async card(commandId: string): Promise<WorkflowCommandCard> {
    await this.ready;
    const def = builtinDef(commandId);
    if (def) return this.builtinCard(def);
    const saved = this.store.get(commandId);
    if (!saved) throw new WorkflowCommandError('unknown_command', `未知命令 ${commandId}`);
    return this.savedCard(saved);
  }

  /**
   * run 的受理解析：builtin 恒批准；saved 要求 approvedHash === 当前 contentHash，
   * 不一致 → command_not_approved。resume 不检查批准状态（身份校验绑定的是父 run 的 hash）。
   */
  async resolve(commandId: string, options: { requireApproved: boolean }): Promise<WorkflowCommandResolution> {
    await this.ready;
    const def = builtinDef(commandId);
    if (def) {
      return {
        commandId,
        script: def.script,
        args: def.args,
        deadlineMs: def.deadlineMs,
        source: 'builtin',
        ...(def.input ? { input: def.input } : {}),
      };
    }
    const saved = this.store.get(commandId);
    if (!saved) throw new WorkflowCommandError('unknown_command', `未知命令 ${commandId}`);
    if (options.requireApproved && saved.approvedHash !== this.savedContentHash(saved)) {
      throw new WorkflowCommandError('command_not_approved', `命令 ${commandId} 的内容未批准或已变更`);
    }
    return { commandId, script: saved.script, args: saved.args, deadlineMs: saved.deadlineMs, source: 'saved' };
  }

  /**
   * 新建/编辑 saved 命令：写入即丢弃 approvedHash（内容改动使原允许失效）。
   * commandId 命中 builtin → 另存新 id；命中既有 saved → 覆盖更新；缺省/未知 → 新建。
   */
  async save(input: WorkflowCommandSave): Promise<WorkflowCommandCard> {
    await this.ready;
    const name = input.name.trim();
    if (name.length === 0 || name.length > 200) throw new WorkflowCommandError('invalid_args', '命令名称必须是非空且不超过 200 字符');
    if (input.script.length === 0 || Buffer.byteLength(input.script, 'utf8') > 64 * 1024) {
      throw new WorkflowCommandError('command_invalid', '脚本必须非空且不超过 64 KiB');
    }
    if (!Number.isInteger(input.deadlineMs) || input.deadlineMs <= 0 || input.deadlineMs > 600_000) {
      throw new WorkflowCommandError('invalid_args', 'deadlineMs 必须是 (0, 600000] 的整数');
    }
    // args 必须 JSON 可序列化（canonical 规范化会拒绝循环引用/BigInt 等）。
    try {
      workflowArgsHash(input.args);
    } catch {
      throw new WorkflowCommandError('invalid_args', 'args 必须是 JSON 可序列化值');
    }
    const existing = input.commandId !== undefined ? this.store.get(input.commandId) : null;
    const now = Date.now();
    const record: SavedWorkflowCommand = {
      commandId: existing?.commandId ?? (input.commandId !== undefined && !builtinDef(input.commandId) ? input.commandId : randomUUID()),
      name,
      script: input.script,
      ...(input.args !== undefined ? { args: input.args } : {}),
      deadlineMs: input.deadlineMs,
      createdMs: existing?.createdMs ?? now,
      updatedMs: now,
    };
    await this.store.put(record);
    return this.savedCard(record);
  }

  /** 显式批准：saved 记 approvedHash=当前 contentHash；builtin 恒批准（no-op 返回卡片）。 */
  async approve(commandId: string): Promise<WorkflowCommandCard> {
    await this.ready;
    if (builtinDef(commandId)) return this.builtinCard(builtinDef(commandId)!);
    const saved = this.store.get(commandId);
    if (!saved) throw new WorkflowCommandError('unknown_command', `未知命令 ${commandId}`);
    await this.store.setApprovedHash(commandId, this.savedContentHash(saved));
    return this.savedCard({ ...saved, approvedHash: this.savedContentHash(saved) });
  }

  /** 仅 saved 可删；builtin → command_is_builtin；未知 → unknown_command。 */
  async delete(commandId: string): Promise<void> {
    await this.ready;
    if (builtinDef(commandId)) throw new WorkflowCommandError('command_is_builtin', `内置命令 ${commandId} 不可删除`);
    if (!(await this.store.delete(commandId))) throw new WorkflowCommandError('unknown_command', `未知命令 ${commandId}`);
  }

  private savedContentHash(command: SavedWorkflowCommand): string {
    return commandContentHash({ script: command.script, args: command.args, deadlineMs: command.deadlineMs });
  }

  private builtinCard(def: WorkflowBuiltinCommandDef): WorkflowCommandCard {
    return {
      commandId: def.commandId,
      name: def.name,
      description: def.description,
      phases: def.phases,
      script: def.script,
      args: def.args,
      inputFilePaths: (def.input?.files ?? []).map((file) => file.path),
      scriptHash: workflowScriptHash(def.script),
      argsHash: workflowArgsHash(def.args),
      deadlineMs: def.deadlineMs,
      source: 'builtin',
      approved: true,
      requiresApp: scriptDeclaresLane(def.script),
      writes: scriptDeclaresLane(def.script),
    };
  }

  private savedCard(command: SavedWorkflowCommand): WorkflowCommandCard {
    return {
      commandId: command.commandId,
      name: command.name,
      description: metaString(command.script, 'description') ?? '已保存命令',
      phases: metaPhases(command.script),
      script: command.script,
      args: command.args ?? null,
      inputFilePaths: [],
      scriptHash: workflowScriptHash(command.script),
      argsHash: workflowArgsHash(command.args),
      deadlineMs: command.deadlineMs,
      source: 'saved',
      approved: command.approvedHash === this.savedContentHash(command),
      requiresApp: scriptDeclaresLane(command.script),
      writes: scriptDeclaresLane(command.script),
    };
  }
}
