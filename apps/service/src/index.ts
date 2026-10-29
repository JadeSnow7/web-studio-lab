import { shutdownServiceOwners } from './shutdown';
import path from 'node:path';
import { AppService } from './app-service';
import {
  ObservationRequestSchema,
  ServiceRuntimeConfigSchema,
  type WorkspaceObservationResult,
  type AppControlResult,
  AppToolNameSchema,
  ChatServiceMessageSchema,
  ChatServiceRequestSchema,
  type ChatServiceMessage,
  type ChatServiceRequest,
} from '@wsl/protocol';
import { SbxConnection } from './sbx';
import { CodexChat } from './codex-chat';
import { REGISTERED_HARNESSES } from './harness/registry';
import { EnvironmentResources } from './environment-resources';
import { createAppRoutes, sourceSnapshotFailure } from './routes/app';
import { CancellableCalls, MainRelay } from './routes/calls';
import { ChatSendQueue, createChatRoutes } from './routes/chat';
import { createEnvironmentRoutes } from './routes/environment';
import type { RouteTable, ServiceMethod, ServiceResult } from './routes/types';

// utilityProcess 的消息接口由宿主提供，核心模块不依赖 Electron。
const parent = (
  process as NodeJS.Process & {
    parentPort?: { on(event: 'message', listener: (event: { data: unknown }) => void): void; postMessage(message: unknown): void };
  }
).parentPort;
if (!parent) throw new Error('缺少执行服务父消息通道');
const root = process.argv[2];
if (!root) throw new Error('缺少对话运行目录');
const send = (message: ChatServiceMessage) => parent.postMessage(ChatServiceMessageSchema.parse(message));
const runtime = process.argv[3] ? ServiceRuntimeConfigSchema.parse(JSON.parse(process.argv[3])) : undefined;
const chat = new CodexChat(root, (conversation) => send({ type: 'event', conversation }), new SbxConnection(runtime), REGISTERED_HARNESSES);
const apps = new AppService(chat.connection, {
  registryPath: path.join(root, 'app-registry.json'),
  dependencyArchivePath: runtime ? runtime.templateDependencies?.archivePath : process.env['WSL_APP_DEPENDENCY_ARCHIVE'],
  dependencyManifest: runtime?.templateDependencies,
  onSnapshot: (snapshot) => send({ type: 'app-event', snapshot }),
});
const environments = new EnvironmentResources(
  chat.connection,
  (terminal, binding) => send({ type: 'terminal-event', terminal, resourceId: binding.resourceId, binding }),
  (hint) => send({ type: 'file-hint', hint }),
  process.env,
  runtime,
);
const observationReader = new MainRelay<WorkspaceObservationResult>();
chat.setObservationReader(async (scope, tool, args, signal) => {
  const validatedTool = ObservationRequestSchema.shape.tool.parse(tool);
  return observationReader.request(
    signal,
    { error: 'cancelled', message: '执行观察已取消' },
    (id) => send({ type: 'observation-call', id, scope, tool: validatedTool, args }),
    (id) => send({ type: 'observation-abort', id }),
  );
});
// 控制面调用沿与观察相同的具名消息转给 Main dispatcher；service 不持有 run 或授权状态。
const controlPlane = new MainRelay<AppControlResult>();
chat.setAppControlReader(async (scope, tool, args, signal) => {
  const validatedTool = AppToolNameSchema.parse(tool);
  return controlPlane.request(
    signal,
    { ok: false, tool: validatedTool, error: { code: 'cancelled', message: '控制面调用已取消' } },
    (id) => send({ type: 'app-call', id, scope, tool: validatedTool, args }),
    (id) => send({ type: 'app-abort', id }),
  );
});
const ready = chat.initialize().then((status) => {
  send({ type: 'initialized', status, cleanupPending: chat.connection.getCleanupPending() });
  return status;
});
const agentCalls = new CancellableCalls('Duplicate app agent call');
const sourceCalls = new CancellableCalls('Duplicate source snapshot call');
const observations = new CancellableCalls('Duplicate observation request');
const sends = new ChatSendQueue();
const routes: RouteTable<ServiceMethod> = {
  ...createAppRoutes({ apps, ready, controlPlane, sourceCalls, agentCalls }),
  ...createEnvironmentRoutes({ environments, ready, observationReader, observations }),
  ...createChatRoutes({ chat, apps, ready, sends }),
  shutdown: async () => {
    observations.abortAll();
    agentCalls.abortAll();
    await shutdownServiceOwners(
      () => apps.shutdown(),
      () => chat.shutdown(),
      () => environments.shutdown(),
    );
    return null;
  },
};
parent.on('message', ({ data }) => {
  const request = ChatServiceRequestSchema.parse(data);
  if (request.method === 'shutdown') {
    chat.beginShutdown();
    sourceCalls.abortAll();
  }
  if (request.method === 'cancel' || request.method === 'reset') sends.revoke(request.payload.conversationId);
  const execute = async () => {
    try {
      // 各 method 的表项类型由 RouteTable 保证；这里只按判别字段取出对应处理器。
      const pending = (routes[request.method] as (request: ChatServiceRequest) => ServiceResult | Promise<ServiceResult>)(request);
      const result = pending instanceof Promise ? await pending : pending;
      send({ type: 'response', id: request.id, result });
      // ACK须由宿主收到后再结束utility，立即exit会丢失仍在传输的消息。
    } catch (error) {
      if (request.method === 'app.source.snapshot') send({ type: 'response', id: request.id, result: sourceSnapshotFailure(request) });
      else send({ type: 'error', id: request.id, error: (error as Error).message });
    }
  };
  if (request.method === 'send') sends.enqueue(request, execute);
  else void execute();
});

process.on('SIGTERM', () => {
  chat.beginShutdown();
  sourceCalls.abortAll();
  observations.abortAll();
  void shutdownServiceOwners(
    () => apps.shutdown(),
    () => chat.shutdown(),
    () => environments.shutdown(),
  )
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('guest 清理失败', error);
      process.exitCode = 1;
    });
});
