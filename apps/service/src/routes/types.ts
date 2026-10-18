import type { AppControlResult, ChatServiceRequest, ResearchCall, ResearchReply, WorkspaceObservationResult } from '@wsl/protocol';
import type { EnvironmentResources } from '../environment-resources';
import type { validateResearchReply } from '../research-runtime';

export type RoutedMethod =
  | 'observation.read'
  | 'observation.cancel'
  | 'observation.reply'
  | 'environments.list'
  | 'resource.register'
  | 'resource.release'
  | 'terminal.get'
  | 'terminal.open'
  | 'terminal.write'
  | 'terminal.resize'
  | 'terminal.close'
  | 'app.reply'
  | 'research.reply';

type Requests = { [M in RoutedMethod]: Extract<ChatServiceRequest, { method: M }> };
export type RoutedRequest = Requests[RoutedMethod];
interface PendingReply<Result> {
  resolve: (result: Result) => void;
  abort: () => void;
  signal: AbortSignal;
}
export interface RouteContext {
  environments: EnvironmentResources;
  terminalFor: (resourceId: string) => ReturnType<EnvironmentResources['terminal']>;
  requireReady: () => Promise<void>;
  validateResearchReply: typeof validateResearchReply;
  observations: Map<string, AbortController>;
  observationCalls: Map<string, PendingReply<WorkspaceObservationResult>>;
  appCalls: Map<string, PendingReply<AppControlResult>>;
  researchCalls: Map<string, PendingReply<ResearchReply> & { call: ResearchCall }>;
}
export interface RequestAdmission {
  checkAdmission: () => void;
}
export type RouteHandlers<Methods extends RoutedMethod = RoutedMethod> = {
  [M in Methods]: (request: Requests[M], context: RouteContext, admission: RequestAdmission) => unknown;
};
export type RouteRequest<Method extends RoutedMethod> = Requests[Method];
