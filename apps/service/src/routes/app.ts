import type { AppControlResult } from '@wsl/protocol';
import type { AppService } from '../app-service';
import type { CancellableCalls, MainRelay } from './calls';
import type { RouteTable, ServiceMethod, ServiceRequestOf } from './types';

export type AppMethod = Extract<ServiceMethod, `app.${string}`>;

export type AppRouteOwners = {
  apps: AppService;
  ready: Promise<unknown>;
  /** 控制面调用转给 Main dispatcher；service 不持有 run 或授权状态。 */
  controlPlane: MainRelay<AppControlResult>;
  sourceCalls: CancellableCalls;
  agentCalls: CancellableCalls;
};

export function createAppRoutes({ apps, ready, controlPlane, sourceCalls, agentCalls }: AppRouteOwners): RouteTable<AppMethod> {
  return {
    'app.source.snapshot': ({ payload }) =>
      sourceCalls.run(payload.callId, async (signal) => {
        await ready;
        return apps.sourceSnapshot(payload.target, signal);
      }),
    'app.source.cancel': ({ payload }) => {
      sourceCalls.cancel(payload.callId);
      return null;
    },
    'app.get': async ({ payload }) => {
      await ready;
      return apps.restore(payload);
    },
    'app.create': async ({ payload }) => {
      await ready;
      return apps.create(payload);
    },
    'app.importSource': async ({ payload }) => {
      await ready;
      return apps.importSource(payload);
    },
    'app.cancelImport': async ({ payload }) => {
      await ready;
      return apps.cancelImport(payload);
    },
    'app.start': async ({ payload }) => {
      await ready;
      return apps.start(payload);
    },
    'app.stop': ({ payload }) => apps.stop(payload),
    'app.export': async ({ payload }) => {
      await ready;
      return apps.export(payload);
    },
    'app.reply': ({ payload }) => {
      controlPlane.reply(payload.callId, payload.result);
      return null;
    },
    'app.agent': async ({ payload }) => {
      await ready;
      return agentCalls.run(payload.callId, (signal) => apps.agent(payload.target, payload.appInstanceId, payload.operation, signal));
    },
    'app.agent.cancel': ({ payload }) => {
      agentCalls.cancel(payload.callId);
      return null;
    },
    'app.logs': async ({ payload }) => {
      await ready;
      return apps.logs(payload.target, payload.maxBytes);
    },
  };
}

/** 源码采集失败时仍回复类型化回执，Main 据此保持清理未确认。 */
export function sourceSnapshotFailure({ payload }: ServiceRequestOf<'app.source.snapshot'>) {
  return { ok: false, target: payload.target, cleanupConfirmed: false, error: '源码 helper 启动或回执异常；清理未确认' } as const;
}
