import { SetupSnapshotSchema, SetupSettingsSchema, SetupLoginSchema } from './setup';
import { EnvironmentListSchema } from './environments';
import { WorkbenchObservationInputSchema, WorkspaceObservationResultSchema } from './observation';
import { WorkbenchCommandSchema, WorkbenchEventSchema, WorkbenchResultSchema, WorkbenchSnapshotSchema } from './workspace';
import { z } from 'zod';
import { RunPatchQuerySchema, RunPatchResultSchema } from './source-change';
import { AppInfoSchema, ShellCommandEventSchema, NativeBrowserFocusSchema } from './app';
import { ChatConversationSchema, ChatStatusSchema, ChatTargetSchema, PermissionReplySchema } from './chat';
import { ExecutionStatusSchema } from './execution';
import { ShowMenuRequestSchema, ShowMenuResultSchema } from './native-menu';
import { HarnessProfileIdSchema, HarnessProfilesSnapshotSchema, HarnessSelectionSchema } from './harness';
import { DebugStatusSnapshotSchema, StatusTransitionSchema, type DebugStatusSnapshot, type StatusTransition } from './status';
import {
  WorkflowAcceptedSchema,
  WorkflowCommandCardSchema,
  WorkflowCommandSaveSchema,
  WorkflowPatchResultSchema,
  WorkflowRunRowSchema,
  WorkflowStatusProjectionSchema,
  WorkflowUpdateEventSchema,
} from './workflow';

import {
  CatalogActionSchema,
  CatalogQuerySchema,
  RunReferenceQuerySchema,
  ResourceRevisionSchema,
  CatalogReferenceSnapshotSchema,
  PersonalChatSendSchema,
} from './resource-catalog';
const NoArgs = z.undefined();

/**
 * renderer → main 的请求通道。每个通道声明参数与返回值 schema；
 * main 在边界用 request schema 校验参数，校验失败直接抛错。
 */
export const invokeChannels = {
  'setup:status': { request: NoArgs, response: SetupSnapshotSchema },
  'setup:check': { request: NoArgs, response: SetupSnapshotSchema },
  'setup:prepare': { request: NoArgs, response: SetupSnapshotSchema },
  'setup:retry': { request: NoArgs, response: SetupSnapshotSchema },
  'setup:cancel': { request: NoArgs, response: SetupSnapshotSchema },
  'setup:login': { request: SetupLoginSchema, response: SetupSnapshotSchema },
  'setup:save': { request: SetupSettingsSchema, response: SetupSnapshotSchema },
  'setup:choose-root': { request: NoArgs, response: z.string().nullable() },
  'workbench:environments': { request: NoArgs, response: EnvironmentListSchema },
  'workbench:observe': { request: WorkbenchObservationInputSchema, response: WorkspaceObservationResultSchema },
  'workbench:reload': { request: NoArgs, response: WorkbenchSnapshotSchema },
  'workbench:get-snapshot': { request: NoArgs, response: WorkbenchSnapshotSchema },
  'workbench:catalog-command': { request: CatalogActionSchema, response: WorkbenchResultSchema },
  'workbench:resource-revision': { request: CatalogQuerySchema, response: ResourceRevisionSchema },
  'workbench:run-references': { request: RunReferenceQuerySchema, response: CatalogReferenceSnapshotSchema.nullable() },
  'workbench:run-patch': { request: RunPatchQuerySchema, response: RunPatchResultSchema },
  'workbench:command': { request: WorkbenchCommandSchema, response: WorkbenchResultSchema },
  'app:get-info': { request: NoArgs, response: AppInfoSchema },
  'chat:get-status': { request: NoArgs, response: ChatStatusSchema },
  'chat:permission-reply': { request: PermissionReplySchema, response: ChatConversationSchema },
  'chat:profiles-get': { request: NoArgs, response: HarnessProfilesSnapshotSchema },
  'chat:profiles-create': {
    request: z.object({ label: z.string().trim().min(1).max(60) }).strict(),
    response: HarnessProfilesSnapshotSchema,
  },
  'chat:profiles-check': { request: z.object({ profileId: HarnessProfileIdSchema }).strict(), response: HarnessProfilesSnapshotSchema },
  'chat:profiles-remove': { request: z.object({ profileId: HarnessProfileIdSchema }).strict(), response: HarnessProfilesSnapshotSchema },
  'chat:profiles-default': { request: HarnessSelectionSchema, response: HarnessProfilesSnapshotSchema },
  'chat:get': { request: ChatTargetSchema, response: ChatConversationSchema },
  'chat:send': { request: PersonalChatSendSchema, response: ChatConversationSchema },
  'chat:cancel': { request: ChatTargetSchema, response: ChatConversationSchema },
  'chat:reset': { request: ChatTargetSchema, response: ChatConversationSchema },
  'execution:get-status': { request: NoArgs, response: ExecutionStatusSchema },
  /** 原生菜单（OPS-1 S5）：Main 按快照构建并弹出菜单，返回选择项与冻结目标，取消为 null。 */
  'shell:show-menu': { request: ShowMenuRequestSchema, response: ShowMenuResultSchema },
  /**
   * 采集完成并展开接收会话后（OPS-1 R9）：Main 把键盘焦点从原生网页交回工作台页面（`webContents.focus()`）。
   * 没有参数；窗口不在前台或已销毁时不抢焦点，返回 false。
   */
  'shell:focus-workbench': { request: NoArgs, response: z.boolean() },
  'shell:native-focus': { request: NoArgs, response: NativeBrowserFocusSchema.nullable() },
  'shell:restore-browser-focus': { request: NativeBrowserFocusSchema, response: z.boolean() },
  /** 诊断通道：仅开发服务器或 WSL_DEBUG_STATUS=1 时注册（status-interface.md §8.1）；未启用时 Main 不注册、ipc-guard 拒绝。 */
  'debug:status': { request: NoArgs, response: DebugStatusSnapshotSchema },
  /**
   * W5 workflow 命令入口：命令卡展示脚本/args/输入与 hash；builtin 代码即批准，
   * saved 命令内容改动必须重新显式批准（contentHash 与 approvedHash 绑定）才允许运行。
   * commandId 必须命中 Main 的命令仓储；hash 校验在应用层完成，卡片仅供展示。
   */
  'workflow:commands': { request: NoArgs, response: z.array(WorkflowCommandCardSchema) },
  'workflow:run': {
    request: z.object({ requestId: z.uuid(), commandId: z.string().min(1).max(200) }).strict(),
    response: WorkflowAcceptedSchema,
  },
  'workflow:resume': {
    request: z.object({ requestId: z.uuid(), parentRunId: z.string().min(1).max(200), commandId: z.string().min(1).max(200) }).strict(),
    response: WorkflowAcceptedSchema,
  },
  /** saved 命令的新建/编辑：内容改动丢弃既有批准；save 以 commandId 命中内置命令时另存新 id。 */
  'workflow:command-save': { request: WorkflowCommandSaveSchema, response: WorkflowCommandCardSchema },
  /** 把当前内容的 contentHash 记为 approvedHash；builtin 为恒批准的 no-op。 */
  'workflow:command-approve': {
    request: z.object({ commandId: z.string().min(1).max(200) }).strict(),
    response: WorkflowCommandCardSchema,
  },
  /** 删除已保存命令（仅 saved；内置命令不可删）。 */
  'workflow:command-delete': { request: z.object({ commandId: z.string().min(1).max(200) }).strict(), response: z.null() },
  'workflow:stop': { request: z.object({ runId: z.string().min(1).max(200) }).strict(), response: WorkflowRunRowSchema },
  'workflow:reconcile': { request: z.object({ runId: z.string().min(1).max(200) }).strict(), response: WorkflowRunRowSchema },
  'workflow:status': {
    request: z.object({ runId: z.string().min(1).max(200) }).strict(),
    response: WorkflowStatusProjectionSchema.nullable(),
  },
  'workflow:runs': { request: NoArgs, response: z.array(WorkflowRunRowSchema) },
  /** W6b：返回候选最新发布的统一 diff（patchSha256 供与投影核对）；无候选时应用层抛 not_found。 */
  'workflow:patch': { request: z.object({ runId: z.string().min(1).max(200) }).strict(), response: WorkflowPatchResultSchema },
  /**
   * W6b：显式授权把已发布候选应用到受管 App——终态 run、有候选、绑定 App、
   * 工程写租约空闲、源基线与候选基线一致才执行；冲突/忙/不可用均以明确错误拒绝。
   */
  'workflow:apply': { request: z.object({ runId: z.string().min(1).max(200) }).strict(), response: WorkflowRunRowSchema },
} as const;

export type InvokeChannel = keyof typeof invokeChannels;
export type InvokeRequest<C extends InvokeChannel> = z.input<(typeof invokeChannels)[C]['request']>;
export type InvokeResponse<C extends InvokeChannel> = z.output<(typeof invokeChannels)[C]['response']>;

/** main → renderer 的事件通道。 */
export const eventChannels = {
  'setup:status': SetupSnapshotSchema,
  'workbench:event': WorkbenchEventSchema,
  'chat:status': ChatStatusSchema,
  'chat:profiles': HarnessProfilesSnapshotSchema,
  'chat:conversation': ChatConversationSchema,
  'shell:command': ShellCommandEventSchema,
  /** 诊断事件：每条转换（已脱敏）；仅诊断通道启用时发送。 */
  'debug:status': StatusTransitionSchema,
  'debug:facts-changed': z.literal('changed'),
  /** 菜单「诊断面板」：通知 renderer 打开或关闭诊断面板；仅诊断通道启用时发送。 */
  'debug:panel': z.literal('toggle'),
  /** W4 workflow：某 run 的 journal 有新事件；seq 仅为单调 tick，内容经 status/runs 重取。 */
  'workflow:update': WorkflowUpdateEventSchema,
} as const;

export type EventChannel = keyof typeof eventChannels;
export type EventPayload<C extends EventChannel> = z.output<(typeof eventChannels)[C]>;

export const INVOKE_CHANNEL_NAMES = Object.keys(invokeChannels) as InvokeChannel[];
export const EVENT_CHANNEL_NAMES = Object.keys(eventChannels) as EventChannel[];

/** Main 通过 webPreferences.additionalArguments 传给 preload 的开关：只告知是否暴露 `debug`，不携带任何数据。 */
export const DEBUG_PRELOAD_ARGUMENT = '--wsl-debug-status';

/**
 * preload 在诊断通道启用时额外暴露的 `window.studio.debug`；未启用时该键不存在。
 * 与 StudioApi（bridge.ts）分开声明，启用判定只在 Main，见 status-interface.md §8.1 / §8.6。
 */
export interface StudioDebugApi {
  status(): Promise<DebugStatusSnapshot>;
  onTransition(listener: (transition: StatusTransition) => void): () => void;
  onFactsChanged(listener: () => void): () => void;
  onTogglePanel(listener: () => void): () => void;
}
