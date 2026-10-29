import type { WorkspaceObservationResult } from '@wsl/protocol';
import type { EnvironmentResources } from '../environment-resources';
import type { CancellableCalls, MainRelay } from './calls';
import type { RouteTable, ServiceMethod } from './types';

export type EnvironmentMethod = Extract<
  ServiceMethod,
  'environments.list' | `resource.${string}` | `observation.${string}` | `terminal.${string}`
>;

export type EnvironmentRouteOwners = {
  environments: EnvironmentResources;
  ready: Promise<unknown>;
  /** 执行观察转给 Main 读取；service 只等待回复。 */
  observationReader: MainRelay<WorkspaceObservationResult>;
  observations: CancellableCalls;
};

export function createEnvironmentRoutes({
  environments,
  ready,
  observationReader,
  observations,
}: EnvironmentRouteOwners): RouteTable<EnvironmentMethod> {
  const terminalFor = (resourceId: string) => environments.terminal(environments.identity(resourceId));
  return {
    'observation.reply': ({ payload }) => {
      observationReader.reply(payload.callId, payload.result);
      return null;
    },
    'environments.list': () => environments.list(),
    'resource.register': async ({ payload }) => {
      await environments.register(payload);
      return null;
    },
    'resource.release': async ({ payload }) => {
      await environments.release(payload);
      return null;
    },
    'observation.read': ({ payload }) => observations.run(payload.requestId, (signal) => environments.observe(payload, signal)),
    'observation.cancel': ({ payload }) => {
      observations.cancel(payload.requestId);
      return null;
    },
    'terminal.get': ({ resourceId }) => environments.terminalSnapshot(environments.identity(resourceId)),
    'terminal.open': async ({ payload }) => {
      const identity = environments.identity(payload.resourceId);
      if (identity.environmentId === 'sandbox') await ready;
      return environments.openTerminal(identity, payload.cols, payload.rows);
    },
    'terminal.write': ({ payload }) => {
      terminalFor(payload.resourceId).write(payload.sessionId, payload.data);
      return null;
    },
    'terminal.resize': ({ payload }) => {
      terminalFor(payload.resourceId).resize(payload.sessionId, payload.cols, payload.rows);
      return null;
    },
    'terminal.close': ({ payload }) => terminalFor(payload.resourceId).close(payload.sessionId),
  };
}
