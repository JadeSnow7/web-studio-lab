import {
  ResourceCollectionSchema,
  ResourceListRequestSchema,
  ResourceCaptureRequestSchema,
  ResourceRemoveRequestSchema,
} from './resources';
import { z } from 'zod';
import { TerminalOpenSchema, TerminalWriteSchema, TerminalResizeSchema, TerminalTargetSchema, TerminalSnapshotSchema } from './terminal';
import { AppInfoSchema, ShellCommandSchema } from './app';
import { ChatConversationSchema, ChatSendSchema, ChatStatusSchema, ChatTargetSchema } from './chat';
import { ExecutionStatusSchema } from './execution';
import {
  PageCaptureSchema,
  PreviewFreezeResultSchema,
  PreviewLayoutSchema,
  PreviewNavigateRequestSchema,
  PreviewStateSchema,
} from './preview';

const NoArgs = z.undefined();
const NoResult = z.void();

/**
 * renderer → main 的请求通道。每个通道声明参数与返回值 schema；
 * main 在边界用 request schema 校验参数，校验失败直接抛错。
 */
export const invokeChannels = {
  'resources:list': { request: ResourceListRequestSchema, response: ResourceCollectionSchema },
  'resources:capture': { request: ResourceCaptureRequestSchema, response: ResourceCollectionSchema },
  'resources:remove': { request: ResourceRemoveRequestSchema, response: ResourceCollectionSchema },
  'preview:get-state': { request: NoArgs, response: PreviewStateSchema },
  'preview:set-layout': { request: PreviewLayoutSchema, response: NoResult },
  'preview:freeze': { request: NoArgs, response: PreviewFreezeResultSchema },
  'preview:navigate': { request: PreviewNavigateRequestSchema, response: NoResult },
  'preview:reload': { request: NoArgs, response: NoResult },
  'preview:go-back': { request: NoArgs, response: NoResult },
  'preview:go-forward': { request: NoArgs, response: NoResult },
  'preview:focus': { request: NoArgs, response: NoResult },
  'preview:start-pick': { request: NoArgs, response: NoResult },
  'preview:cancel-pick': { request: NoArgs, response: NoResult },
  'preview:reattach-cdp': { request: NoArgs, response: NoResult },
  'app:get-info': { request: NoArgs, response: AppInfoSchema },
  'chat:get-status': { request: NoArgs, response: ChatStatusSchema },
  'chat:get': { request: ChatTargetSchema, response: ChatConversationSchema },
  'chat:send': { request: ChatSendSchema, response: ChatConversationSchema },
  'chat:cancel': { request: ChatTargetSchema, response: ChatConversationSchema },
  'chat:reset': { request: ChatTargetSchema, response: ChatConversationSchema },
  'terminal:get': { request: NoArgs, response: TerminalSnapshotSchema },
  'terminal:open': { request: TerminalOpenSchema, response: TerminalSnapshotSchema },
  'terminal:write': { request: TerminalWriteSchema, response: NoResult },
  'terminal:resize': { request: TerminalResizeSchema, response: NoResult },
  'terminal:close': { request: TerminalTargetSchema, response: TerminalSnapshotSchema },
  'execution:get-status': { request: NoArgs, response: ExecutionStatusSchema },
} as const;

export type InvokeChannel = keyof typeof invokeChannels;
export type InvokeRequest<C extends InvokeChannel> = z.input<(typeof invokeChannels)[C]['request']>;
export type InvokeResponse<C extends InvokeChannel> = z.output<(typeof invokeChannels)[C]['response']>;

/** main → renderer 的事件通道。 */
export const eventChannels = {
  'terminal:state': TerminalSnapshotSchema,
  'chat:status': ChatStatusSchema,
  'chat:conversation': ChatConversationSchema,
  'preview:state': PreviewStateSchema,
  'preview:captured': PageCaptureSchema,
  'shell:command': ShellCommandSchema,
} as const;

export type EventChannel = keyof typeof eventChannels;
export type EventPayload<C extends EventChannel> = z.output<(typeof eventChannels)[C]>;

export const INVOKE_CHANNEL_NAMES = Object.keys(invokeChannels) as InvokeChannel[];
export const EVENT_CHANNEL_NAMES = Object.keys(eventChannels) as EventChannel[];
