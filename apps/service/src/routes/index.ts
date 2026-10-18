import type { ChatServiceRequest } from '@wsl/protocol';
import { environmentRoutes } from './environment';
import { observationRoutes } from './observation';
import { replyRoutes } from './replies';
import { terminalRoutes } from './terminal';
import type { RequestAdmission, RouteContext, RouteHandlers, RoutedMethod, RoutedRequest, RouteRequest } from './types';

// Reject duplicate keys before spread composition could silently replace a handler.
type DuplicateMethods =
  | Extract<keyof typeof observationRoutes, keyof typeof environmentRoutes | keyof typeof terminalRoutes | keyof typeof replyRoutes>
  | Extract<keyof typeof environmentRoutes, keyof typeof terminalRoutes | keyof typeof replyRoutes>
  | Extract<keyof typeof terminalRoutes, keyof typeof replyRoutes>;
const routes = {
  ...observationRoutes,
  ...environmentRoutes,
  ...terminalRoutes,
  ...replyRoutes,
} satisfies RouteHandlers & Record<DuplicateMethods, never>;
const handlers: RouteHandlers = routes;

export function isRoutedRequest(request: ChatServiceRequest): request is RoutedRequest {
  return Object.hasOwn(handlers, request.method);
}
export function dispatchRoute<Method extends RoutedMethod>(
  method: Method,
  request: RouteRequest<Method>,
  context: RouteContext,
  admission: RequestAdmission,
): unknown {
  return handlers[method](request, context, admission);
}
export type { RouteContext } from './types';
