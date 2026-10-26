import { z } from 'zod';
import { HarnessIdSchema, HarnessProfileIdSchema, ProfileDirSchema } from './harness';
import { AppTargetSchema } from './managed-app';
import { SOURCE_DIFF_MAX_FILES, SOURCE_PATCH_MAX_BYTES, SourceChangeFileSchema } from './source-change';

/**
 * Workflow 运行时的跨进程 DTO（contract-p0a.md §7 的 journal 记录形状 + 引擎端口进出参）。
 * 本文件只做数据形状定义；状态机与持久化由 service 内核和 Main 应用用例各自实现。
 */

/** DSL 版本：变更使既有缓存与运行身份失效（合同 §1/§7）。 */
export const WORKFLOW_DSL_VERSION = 'lab-workflow/1';

/**
 * W9 Ultra 指挥提示的 canonical 文案：供未来的指挥侧（director）实现与文档引用，
 * 固定文本保证各组/各次实验条件可比。当前版本不注入任何会话——导出仅供引用，
 * meta.ultra 只是 run 的受理标记，不改变审批、预算或路由。
 * 语义要点：先判断任务是否值得编排（不值得就退化为单 Agent 直跑），
 * 值得才生成确定性 workflow 计划，且规划/重试/停止/恢复全部计入同一总预算。
 */
export const ULTRA_DIRECTOR_HINT =
  '先判断这个任务是否值得编排：不值得就直接以单个 Agent 调用完成，不制造多余编排。' +
  '值得时，生成一个确定性的 workflow 计划：声明 phases，把可并行的只读调用放进固定波次，' +
  '写操作走 lane 隔离并按调用序号合并候选。规划、失败重试、被停止调用与恢复全部计入同一总预算，' +
  '不得为通过验收而超支或绕过审批。';

/** W6a：调用隔离词汇——readonly 只读；lane 从固定输入物化独立 attempt 候选目录并发布候选快照。 */
export const WorkflowIsolationSchema = z.enum(['readonly', 'lane']);
export type WorkflowIsolation = z.infer<typeof WorkflowIsolationSchema>;

const tree = z
  .string()
  .length(40)
  .regex(/^[a-f0-9]{40}$/);
const sha256 = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);

const utf8Bytes = (value: string): number => {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
};

/**
 * W6a lane 候选发布事实：capture() 对 run 基线的完整快照 diff（baseTree 恒定，逐次 afterTree 推进）。
 * call_end 携带它时，Main journal 在同一事务插入 publications 行并 CAS 推进 runs.candidate_tree。
 */
export const WorkflowPublicationSchema = z
  .object({
    baseTree: tree,
    afterTree: tree,
    patchSha256: sha256,
    /** 本快照相对基线的文件变更清单（截断时与 capture 口径一致 ≤200）。 */
    files: z.array(SourceChangeFileSchema).max(SOURCE_DIFF_MAX_FILES),
  })
  .strict();
export type WorkflowPublication = z.infer<typeof WorkflowPublicationSchema>;

/** run 事件中的状态闭集（合同 §7：paused 不在 P0a）。 */
export const WorkflowRunStatusSchema = z.enum(['running', 'stopping', 'stopped', 'completed', 'failed']);
export type WorkflowRunStatus = z.infer<typeof WorkflowRunStatusSchema>;

/** 合同 §6 的 RunFailureCode 闭集（result_too_large 并入见合同转写层备注）。 */
export const WorkflowRunFailureCodeSchema = z.enum([
  'script_error',
  'contract_violation',
  'result_too_large',
  'vm_out_of_memory',
  'vm_cpu_segment',
  'vm_budget_exceeded',
  'jobs_budget_exceeded',
  'bridge_buffer_exceeded',
  'run_deadline_exceeded',
  'internal_error',
]);
export type WorkflowRunFailureCode = z.infer<typeof WorkflowRunFailureCodeSchema>;

const WorkflowRunEventSchema = z.object({
  t: z.literal('run'),
  runId: z.string(),
  parentRunId: z.union([z.null(), z.string()]),
  scriptHash: z.string(),
  argsHash: z.string(),
  dslVersion: z.string(),
  status: WorkflowRunStatusSchema,
  failureCode: WorkflowRunFailureCodeSchema.optional(),
  result: z.unknown().optional(),
  /** W6a：受理时建立的候选基线树（无输入时为 Git 空树），随 run 事件回显进 journal。 */
  baseTree: tree.optional(),
  /** W6a：候选发布面向的应用目标；缺省为合成身份。 */
  appTarget: AppTargetSchema.optional(),
  /**
   * W9：脚本 meta.ultra === true 时回显。Ultra 只是 run 的受理/展示标记：
   * 不跳过审批、不改变预算、不改变路由（零特权语义见 record-w9）。
   */
  ultra: z.boolean().optional(),
});

const WorkflowPhaseEventSchema = z.object({
  t: z.literal('phase'),
  runId: z.string(),
  seq: z.number(),
  title: z.string(),
});

const WorkflowLogEventSchema = z.object({
  t: z.literal('log'),
  runId: z.string(),
  seq: z.number(),
  message: z.string(),
});

const WorkflowCallStartEventSchema = z.object({
  t: z.literal('call_start'),
  runId: z.string(),
  callSeq: z.number(),
  callId: z.string(),
  phase: z.union([z.string(), z.null()]),
  label: z.union([z.string(), z.null()]),
  contentKey: z.string(),
  effective: z.record(z.string(), z.unknown()),
  promptHash: z.string(),
  /** W6a：注册时的实际隔离级别；校验失败的调用按 'readonly' 缺省记录。 */
  isolation: WorkflowIsolationSchema,
});

const WorkflowAttemptStartEventSchema = z.object({
  t: z.literal('attempt_start'),
  runId: z.string(),
  callSeq: z.number(),
  attempt: z.number(),
  /** W6a：该 attempt 实际派发的隔离级别。 */
  isolation: WorkflowIsolationSchema,
  /** W7：该 attempt 实际派发的路由成员（解析后冻结，重试不变）；无路由能力的 run 缺省。 */
  route: z.object({ harnessId: HarnessIdSchema, profileId: HarnessProfileIdSchema }).strict().optional(),
  /** W8：lane attempt 的实际基线树（登记 call_start 时的候选指针）；非 lane attempt 缺省。 */
  laneBase: tree.optional(),
});

/** 一次 attempt 的模型用量（W4）：未提供时为 unknown（null），不能记 0。 */
export const WorkflowUsageSchema = z
  .object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() })
  .strict();
export type WorkflowUsage = z.infer<typeof WorkflowUsageSchema>;

const WorkflowAttemptEndEventSchema = z.object({
  t: z.literal('attempt_end'),
  runId: z.string(),
  callSeq: z.number(),
  attempt: z.number(),
  status: z.enum(['ok', 'failed', 'stopped']),
  code: z.string().optional(),
  /** 该 attempt 实际报告的用量；缺省即 unknown。 */
  usage: WorkflowUsageSchema.optional(),
});

const WorkflowCallEndEventSchema = z.object({
  t: z.literal('call_end'),
  runId: z.string(),
  callSeq: z.number(),
  /** W8：conflict 为 lane 候选与已发布指针冲突的终态（候选保留为孤立对象，不自动合并）。 */
  status: z.enum(['ok', 'failed', 'stopped', 'cached', 'conflict']),
  code: z.string().optional(),
  result: z.unknown().optional(),
  cachedFromRunId: z.string().optional(),
  attempts: z.number().optional(),
  /** W6a：lane 成功调用的已提交发布事实；cached 续跑命中时原样回放祖先 publication。 */
  publication: WorkflowPublicationSchema.optional(),
  /** W8：conflict 终态的冲突文件路径清单（文件级三向合并判定的重叠且不同结果路径）。 */
  conflictFiles: z.array(z.string()).max(256).optional(),
  /** W8：conflict 终态保留的候选树身份（objects.git 中可诊断的孤立候选）。 */
  candidateRef: tree.optional(),
});

/** W6a：候选快照经单独授权应用到应用目标的事实记录（应用用例在后续工作包产生）。 */
const WorkflowApplyEventSchema = z.object({
  t: z.literal('apply'),
  runId: z.string(),
  target: AppTargetSchema,
  afterTree: tree,
  at: z.number().int(),
});

const WorkflowDeliverEventSchema = z.object({
  t: z.literal('deliver'),
  runId: z.string(),
  callSeq: z.number(),
});

const WorkflowWarnEventSchema = z.object({
  t: z.literal('warn'),
  runId: z.string(),
  seq: z.number(),
  code: z.string(),
  message: z.string(),
});

/** 合同 §7 的 JournalEvent 判别联合（discriminator: t）；W6a 增加 apply。 */
export const WorkflowJournalEventSchema = z.discriminatedUnion('t', [
  WorkflowRunEventSchema,
  WorkflowPhaseEventSchema,
  WorkflowLogEventSchema,
  WorkflowCallStartEventSchema,
  WorkflowAttemptStartEventSchema,
  WorkflowAttemptEndEventSchema,
  WorkflowCallEndEventSchema,
  WorkflowDeliverEventSchema,
  WorkflowWarnEventSchema,
  WorkflowApplyEventSchema,
]);
export type WorkflowJournalEvent = z.infer<typeof WorkflowJournalEventSchema>;

/** 引擎端口的一次运行终态。 */
export const WorkflowRunOutcomeSchema = z.object({
  status: z.enum(['completed', 'failed', 'stopped']),
  failureCode: WorkflowRunFailureCodeSchema.optional(),
  result: z.unknown().optional(),
});
export type WorkflowRunOutcome = z.infer<typeof WorkflowRunOutcomeSchema>;

/** 续跑注入的已提交结果缓存项：contentKey → 原成功结果与其出处 runId；lane 命中附带祖先发布事实供回放。 */
export const WorkflowCacheEntrySchema = z.object({
  contentKey: z.string(),
  result: z.unknown(),
  fromRunId: z.string(),
  /** W6a：命中 lane 调用时回放祖先已提交 publication（baseTree 必须与续跑 run 基线一致）。 */
  publication: WorkflowPublicationSchema.optional(),
});
export type WorkflowCacheEntry = z.infer<typeof WorkflowCacheEntrySchema>;

/** run 级冻结输入的单个文件（W3）：guest helper 按 path/base64 物化到独立目录。 */
export const WorkflowInputFileSchema = z.object({ path: z.string().min(1), base64: z.string() }).strict();
export type WorkflowInputFile = z.infer<typeof WorkflowInputFileSchema>;

/** run 级冻结输入（W3）：每次 attempt 全新物化；文件数上限与 guest workspace 载荷一致（256）。 */
export const WorkflowRunInputSchema = z.object({ files: z.array(WorkflowInputFileSchema).max(256) }).strict();
export type WorkflowRunInput = z.infer<typeof WorkflowRunInputSchema>;

/**
 * W7：路由范围成员——一次 run 授权可派发到的 Harness × Profile 组合。
 * profileDir 由 Main 按 profileDirOf 解析（builtin → null，沿用 guest 预设配置目录）；
 * 成员是运行授权的一部分（设计 §129），service 侧再逐一核对 Harness/argv 能力。
 */
export const RouteScopeMemberSchema = z
  .object({
    harnessId: HarnessIdSchema,
    profileId: HarnessProfileIdSchema,
    profileDir: ProfileDirSchema.nullable(),
  })
  .strict();
export type RouteScopeMember = z.infer<typeof RouteScopeMemberSchema>;

/**
 * W7：Main→service 的路由范围（workflow-run spec 字段）。
 * 成员上限与 Profile 快照一致（≤32）；defaultHarness 是未显式声明 harness 的调用的解析起点。
 * 缺省不下发该字段 → service 维持单适配器语义（opts.profile 只记录、不路由）。
 */
export const WorkflowRouteScopeSchema = z
  .object({
    defaultHarness: HarnessIdSchema.default('codex'),
    members: z.array(RouteScopeMemberSchema).max(32),
  })
  .strict();
export type WorkflowRouteScope = z.infer<typeof WorkflowRouteScopeSchema>;

/**
 * W6a：lane 候选文件集（attempt workspace 采集）。文件数与字节预算与 guest
 * workspace/AppSourceFile 一致（≤256 个、解码合计 ≤512 KiB）；校验失败即整个载荷无效。
 */
const WorkflowCandidateFilesSchema = z
  .array(WorkflowInputFileSchema)
  .max(256)
  .superRefine((files, context) => {
    if (files.length > 256) return;
    let remaining = 524288;
    for (const [index, file] of files.entries()) {
      const encoded = file.base64;
      const reject = () => context.addIssue({ code: 'custom', path: [index, 'base64'], message: '候选文件超出预算或编码无效' });
      if (encoded.length > Math.ceil(remaining / 3) * 4 || encoded.length % 4 !== 0) return reject();
      const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
      const decodedBytes = (encoded.length / 4) * 3 - padding;
      if (decodedBytes > remaining) return reject();
      for (let offset = 0; offset < encoded.length - padding; offset++) {
        const char = encoded.charCodeAt(offset);
        if (!((char >= 65 && char <= 90) || (char >= 97 && char <= 122) || (char >= 48 && char <= 57) || char === 43 || char === 47)) {
          return reject();
        }
      }
      remaining -= decodedBytes;
    }
  });

/** W6a：service → Main 的 lane 候选载荷（attempt workspace 采集的文件集）。 */
export const WorkflowCandidatePayloadSchema = z
  .object({
    runId: z.string().min(1).max(200),
    callSeq: z.number().int().positive(),
    files: WorkflowCandidateFilesSchema,
  })
  .strict();
export type WorkflowCandidatePayload = z.infer<typeof WorkflowCandidatePayloadSchema>;

const WorkflowId = z.string().min(1).max(200);

/**
 * W5 命令卡（产品面入口）：内置命令与已保存命令共用同一展示形状——脚本源码、meta、args、
 * 输入清单与受理身份 hash 全部展示给用户。builtin 命令经代码冻结即视为已批准；
 * saved 命令必须把 contentHash 与显式批准的 approvedHash 绑定后才允许运行。
 */
export const WorkflowCommandCardSchema = z
  .object({
    commandId: WorkflowId,
    name: z.string().min(1).max(200),
    description: z.string().min(1).max(4000),
    phases: z.array(z.string()).max(64),
    script: z.string(),
    args: z.unknown(),
    /** 冻结输入的相对路径清单（内容在 script 同卡片展示出处）；空输入为空数组。 */
    inputFilePaths: z.array(z.string().min(1)).max(256),
    scriptHash: z.string(),
    argsHash: z.string(),
    deadlineMs: z.number().int().positive(),
    /** builtin 内置命令（代码即批准）或 saved 用户保存命令。 */
    source: z.enum(['builtin', 'saved']),
    /** 当前内容的 contentHash 是否已被批准；false → 运行前必须显式批准。 */
    approved: z.boolean(),
    /** W6b：脚本声明 lane 调用 → 执行时必须绑定受管 App（受理时解析，无 App 则 lane 调用得 unavailable）。 */
    requiresApp: z.boolean(),
    /** W6b：脚本声明非 readonly 调用（当前即 lane）→ 该命令会产出候选写入。 */
    writes: z.boolean(),
  })
  .strict();
export type WorkflowCommandCard = z.infer<typeof WorkflowCommandCardSchema>;

/** 保存命令的编辑载荷（workflow:command-save）：commandId 缺省新建；saved 命令不携带 input。 */
export const WorkflowCommandSaveSchema = z
  .object({
    commandId: WorkflowId.optional(),
    name: z.string().min(1).max(200),
    script: z
      .string()
      .min(1)
      .max(64 * 1024),
    args: z.unknown().optional(),
    deadlineMs: z.number().int().positive().max(600_000),
  })
  .strict();
export type WorkflowCommandSave = z.infer<typeof WorkflowCommandSaveSchema>;

/** W6a：run 的候选快照投影——基线、当前指针、最新发布的摘要与（已发生时的）应用时间。 */
export const WorkflowCandidateProjectionSchema = z
  .object({
    baseTree: tree,
    currentTree: tree,
    patchSha256: sha256,
    files: z.array(SourceChangeFileSchema).max(SOURCE_DIFF_MAX_FILES),
    appliedAt: z.number().int().nullable(),
  })
  .strict();
export type WorkflowCandidateProjection = z.infer<typeof WorkflowCandidateProjectionSchema>;

/** runs 行的对外投影：不含 result_json / engine / created_seq 等内部列。 */
export const WorkflowRunRowSchema = z
  .object({
    runId: WorkflowId,
    requestId: z.string().nullable(),
    status: z.string(),
    scriptHash: z.string(),
    argsHash: z.string(),
    parentRunId: z.string().nullable(),
    createdMs: z.number().int(),
    failureCode: z.string().nullable(),
    /** W6a：该 run 已产生至少一次候选发布时提供；无候选或候选链不可读时缺省。 */
    candidate: WorkflowCandidateProjectionSchema.optional(),
    /** W6b：命令卡元数据副本——脚本声明 lane 调用（执行需绑定受管 App）。 */
    requiresApp: z.boolean(),
    /** W6b：脚本声明非 readonly 调用（会产出候选写入）。 */
    writes: z.boolean(),
    /** W6b：本次执行实际绑定的受管 App；命令含 lane 但当时无受管 App 时为 null（lane 调用得 unavailable）。 */
    appTarget: AppTargetSchema.nullable(),
    /** W9：脚本 meta.ultra === true 的 Ultra 标记（零特权，仅展示/实验分组）。 */
    ultra: z.boolean(),
  })
  .strict();
export type WorkflowRunRow = z.infer<typeof WorkflowRunRowSchema>;

/** run/resume 的受理回执：runId 与受理时计算的 hash 绑定。 */
export const WorkflowAcceptedSchema = z.object({ workflowRunId: WorkflowId, scriptHash: z.string(), argsHash: z.string() }).strict();
export type WorkflowAccepted = z.infer<typeof WorkflowAcceptedSchema>;

/** Main→renderer 的 journal 推进 tick：只提示“该 run 有新事件”，内容由 status/runs 重取。 */
export const WorkflowUpdateEventSchema = z.object({ workflowRunId: WorkflowId, seq: z.number().int().nonnegative() }).strict();
export type WorkflowUpdateEvent = z.infer<typeof WorkflowUpdateEventSchema>;

/** 状态投影中的单个调用：cached 结果带原始成功出处；usage 未报告为 null（unknown，不记 0）。 */
export const WorkflowCallProjectionSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    label: z.string().nullable(),
    phase: z.string().nullable(),
    status: z.string(),
    code: z.string().nullable(),
    attempts: z.number().int().nonnegative(),
    cachedFromRunId: z.string().nullable(),
    usage: WorkflowUsageSchema.nullable(),
    /** W8：conflict 终态的冲突文件清单与保留候选树；非 conflict 缺省。 */
    conflictFiles: z.array(z.string()).max(256).optional(),
    candidateRef: tree.optional(),
  })
  .strict();
export type WorkflowCallProjection = z.infer<typeof WorkflowCallProjectionSchema>;

/** 详情视图附带的 journal 尾部（phase/log/warn），用于最小界面的日志区。 */
export const WorkflowLogEntrySchema = z
  .object({ seq: z.number().int().nonnegative(), kind: z.enum(['phase', 'log', 'warn']), text: z.string() })
  .strict();
export type WorkflowLogEntry = z.infer<typeof WorkflowLogEntrySchema>;

/** run 行 + calls 投影 + 日志尾部的对外状态详情（workflow:status 响应）。 */
export const WorkflowStatusProjectionSchema = z
  .object({
    runId: WorkflowId,
    status: z.string(),
    failureCode: z.string().nullable(),
    result: z.unknown().optional(),
    calls: z.array(WorkflowCallProjectionSchema),
    logTail: z.array(WorkflowLogEntrySchema).max(200),
    /** W6a：该 run 已产生至少一次候选发布时提供候选指针与最新摘要。 */
    candidate: WorkflowCandidateProjectionSchema.optional(),
    /** W6b：同 WorkflowRunRow——命令卡元数据副本与本次执行绑定的受管 App。 */
    requiresApp: z.boolean(),
    writes: z.boolean(),
    appTarget: AppTargetSchema.nullable(),
  })
  .strict();
export type WorkflowStatusProjection = z.infer<typeof WorkflowStatusProjectionSchema>;

/** W6b workflow:patch 响应：候选最新发布的统一 diff 与其 sha256（供预览核对）。 */
export const WorkflowPatchResultSchema = z
  .object({
    runId: WorkflowId,
    patchSha256: sha256,
    patch: z
      .string()
      .min(1)
      .max(SOURCE_PATCH_MAX_BYTES)
      .refine((text) => utf8Bytes(text) <= SOURCE_PATCH_MAX_BYTES, 'diff 超出字节预算'),
  })
  .strict();
export type WorkflowPatchResult = z.infer<typeof WorkflowPatchResultSchema>;
