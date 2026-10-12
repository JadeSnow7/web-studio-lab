import { SetupSnapshotSchema, SetupSettingsSchema, SetupLoginSchema } from './setup';
import { EnvironmentListSchema } from './environments';
import { WorkbenchObservationInputSchema, WorkspaceObservationResultSchema } from './observation';
import { WorkbenchCommandSchema, WorkbenchEventSchema, WorkbenchResultSchema, WorkbenchSnapshotSchema } from './workspace';
import { z } from 'zod';
import { AppInfoSchema, ShellCommandSchema } from './app';
import { ChatConversationSchema, ChatStatusSchema, ChatTargetSchema } from './chat';
import { ExecutionStatusSchema } from './execution';
import { DebugStatusSnapshotSchema, StatusTransitionSchema, type DebugStatusSnapshot, type StatusTransition } from './status';

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
  'workbench:command': { request: WorkbenchCommandSchema, response: WorkbenchResultSchema },
  'app:get-info': { request: NoArgs, response: AppInfoSchema },
  'chat:get-status': { request: NoArgs, response: ChatStatusSchema },
  'chat:get': { request: ChatTargetSchema, response: ChatConversationSchema },
  'chat:send': { request: PersonalChatSendSchema, response: ChatConversationSchema },
  'chat:cancel': { request: ChatTargetSchema, response: ChatConversationSchema },
  'chat:reset': { request: ChatTargetSchema, response: ChatConversationSchema },
  'execution:get-status': { request: NoArgs, response: ExecutionStatusSchema },
  /** 诊断通道：仅开发服务器或 WSL_DEBUG_STATUS=1 时注册（status-interface.md §8.1）；未启用时 Main 不注册、ipc-guard 拒绝。 */
  'debug:status': { request: NoArgs, response: DebugStatusSnapshotSchema },
} as const;

export type InvokeChannel = keyof typeof invokeChannels;
export type InvokeRequest<C extends InvokeChannel> = z.input<(typeof invokeChannels)[C]['request']>;
export type InvokeResponse<C extends InvokeChannel> = z.output<(typeof invokeChannels)[C]['response']>;

/** main → renderer 的事件通道。 */
export const eventChannels = {
  'setup:status': SetupSnapshotSchema,
  'workbench:event': WorkbenchEventSchema,
  'chat:status': ChatStatusSchema,
  'chat:conversation': ChatConversationSchema,
  'shell:command': ShellCommandSchema,
  /** 诊断事件：每条转换（已脱敏）；仅诊断通道启用时发送。 */
  'debug:status': StatusTransitionSchema,
  /** 菜单「诊断面板」：通知 renderer 打开或关闭诊断面板；仅诊断通道启用时发送。 */
  'debug:panel': z.literal('toggle'),
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
  onTogglePanel(listener: () => void): () => void;
}
