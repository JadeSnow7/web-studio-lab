import type { ChatServiceMessage, ChatServiceRequest } from '@wsl/protocol';

export type ServiceMethod = ChatServiceRequest['method'];
export type ServiceRequestOf<M extends ServiceMethod> = Extract<ChatServiceRequest, { method: M }>;
export type ServiceResult = Extract<ChatServiceMessage, { type: 'response' }>['result'];

/** 每个 method 恰好由一个所属模块处理；同步结果在收到请求的同一轮内回复。 */
export type RouteTable<M extends ServiceMethod> = {
  readonly [K in M]: (request: ServiceRequestOf<K>) => ServiceResult | Promise<ServiceResult>;
};
