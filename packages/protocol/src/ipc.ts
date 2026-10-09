import { SetupSnapshotSchema, SetupSettingsSchema, SetupLoginSchema } from './setup';
import { EnvironmentListSchema } from './environments';
import { WorkbenchObservationInputSchema, WorkspaceObservationResultSchema } from './observation';
import { WorkbenchCommandSchema, WorkbenchEventSchema, WorkbenchResultSchema, WorkbenchSnapshotSchema } from './workspace';
import { z } from 'zod';
import { AppInfoSchema, ShellCommandSchema } from './app';
import { ChatConversationSchema, ChatSendSchema, ChatStatusSchema, ChatTargetSchema } from './chat';
import { ExecutionStatusSchema } from './execution';

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
  'workbench:command': { request: WorkbenchCommandSchema, response: WorkbenchResultSchema },
  'app:get-info': { request: NoArgs, response: AppInfoSchema },
  'chat:get-status': { request: NoArgs, response: ChatStatusSchema },
  'chat:get': { request: ChatTargetSchema, response: ChatConversationSchema },
  'chat:send': { request: ChatSendSchema, response: ChatConversationSchema },
  'chat:cancel': { request: ChatTargetSchema, response: ChatConversationSchema },
  'chat:reset': { request: ChatTargetSchema, response: ChatConversationSchema },
  'execution:get-status': { request: NoArgs, response: ExecutionStatusSchema },
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
} as const;

export type EventChannel = keyof typeof eventChannels;
export type EventPayload<C extends EventChannel> = z.output<(typeof eventChannels)[C]>;

export const INVOKE_CHANNEL_NAMES = Object.keys(invokeChannels) as InvokeChannel[];
export const EVENT_CHANNEL_NAMES = Object.keys(eventChannels) as EventChannel[];
