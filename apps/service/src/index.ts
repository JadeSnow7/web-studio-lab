import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppService } from './app-service';
import {
  ObservationRequestSchema,
  ServiceRuntimeConfigSchema,
  type WorkspaceObservationResult,
  ChatServiceMessageSchema,
  ChatServiceRequestSchema,
  type ChatServiceMessage,
} from '@wsl/protocol';
import { SbxConnection } from './sbx';
import { CodexChat } from './codex-chat';
import { EnvironmentResources } from './environment-resources';
import { ResourceStore } from './resource-store';

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
const resources = new ResourceStore(root);
const chat = new CodexChat(root, (conversation) => send({ type: 'event', conversation }), new SbxConnection(runtime), resources);
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
const observationCalls = new Map<
  string,
  { resolve: (result: WorkspaceObservationResult) => void; abort: () => void; signal: AbortSignal }
>();
chat.setObservationReader(
  (scope, tool, args, signal) =>
    new Promise((resolve) => {
      const validatedTool = ObservationRequestSchema.shape.tool.parse(tool);
      const id = randomUUID();
      const abort = () => {
        signal.removeEventListener('abort', abort);
        send({ type: 'observation-abort', id });
        observationCalls.delete(id);
        resolve({ error: 'cancelled', message: '执行观察已取消' });
      };
      observationCalls.set(id, { resolve, abort, signal });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      send({ type: 'observation-call', id, scope, tool: validatedTool, args });
    }),
);
const observations = new Map<string, AbortController>();
const terminalFor = (resourceId: string) => environments.terminal(environments.identity(resourceId));
const ready = chat.initialize().then((status) => {
  send({ type: 'initialized', status, cleanupPending: chat.connection.getCleanupPending() });
  return status;
});
// 对话入口与资源提交共享顺序，防止持久化中插入旧快照轮次；send 不等待模型完成。
let resourceOperations: Promise<unknown> = Promise.resolve();
parent.on('message', ({ data }) => {
  const request = ChatServiceRequestSchema.parse(data);
  const execute = async () => {
    try {
      if (['send', 'resources.save', 'resources.remove'].includes(request.method)) await ready;
      let result;
      switch (request.method) {
        case 'app.get':
          await ready;
          result = await apps.restore(request.payload);
          break;
        case 'app.create':
          await ready;
          result = await apps.create(request.payload);
          break;
        case 'app.start':
          await ready;
          result = await apps.start(request.payload);
          break;
        case 'app.stop':
          result = await apps.stop(request.payload);
          break;
        case 'app.export':
          await ready;
          result = await apps.export(request.payload);
          break;
        case 'observation.reply': {
          const call = observationCalls.get(request.payload.callId);
          if (call) {
            observationCalls.delete(request.payload.callId);
            call.signal.removeEventListener('abort', call.abort);
            call.resolve(request.payload.result);
          }
          result = null;
          break;
        }
        case 'environments.list':
          result = environments.list();
          break;
        case 'resource.register':
          await environments.register(request.payload);
          result = null;
          break;
        case 'observation.read': {
          if (observations.has(request.payload.requestId)) throw new Error('Duplicate observation request');
          const controller = new AbortController();
          observations.set(request.payload.requestId, controller);
          try {
            result = await environments.observe(request.payload, controller.signal);
          } finally {
            observations.delete(request.payload.requestId);
          }
          break;
        }
        case 'observation.cancel':
          observations.get(request.payload.requestId)?.abort();
          result = null;
          break;
        case 'resources.list':
          result = await resources.list(request.payload.spaceId);
          break;
        case 'resources.save': {
          chat.assertResourceMutationAllowed(request.payload.spaceId);
          const before = await resources.list(request.payload.spaceId);
          result = await resources.save(request.payload.spaceId, request.payload.snapshot, request.payload.resourceId);
          if (result.revision !== before.revision) chat.invalidateResources(request.payload.spaceId);
          break;
        }
        case 'resources.remove':
          chat.assertResourceMutationAllowed(request.payload.spaceId);
          result = await resources.remove(request.payload.spaceId, request.payload.resourceId);
          chat.invalidateResources(request.payload.spaceId);
          break;
        case 'register':
          chat.register(request.payload.conversationId, request.payload.workspaceId);
          result = null;
          break;
        case 'status':
          result = chat.getStatus();
          break;
        case 'get':
          result = chat.get(request.payload.conversationId);
          break;
        case 'send':
          result = await chat.send(request.payload.conversationId, request.payload.text, request.payload.observationScope);
          break;
        case 'cancel':
          result = await chat.cancel(request.payload.conversationId);
          break;
        case 'reset':
          result = await chat.reset(request.payload.conversationId);
          break;
        case 'terminal.get':
          result = environments.terminalSnapshot(environments.identity(request.resourceId));
          break;
        case 'terminal.open': {
          const identity = environments.identity(request.payload.resourceId);
          if (identity.environmentId === 'sandbox') await ready;
          result = await environments.openTerminal(identity, request.payload.cols, request.payload.rows);
          break;
        }
        case 'terminal.write':
          terminalFor(request.payload.resourceId).write(request.payload.sessionId, request.payload.data);
          result = null;
          break;
        case 'terminal.resize':
          terminalFor(request.payload.resourceId).resize(request.payload.sessionId, request.payload.cols, request.payload.rows);
          result = null;
          break;
        case 'terminal.close':
          result = await terminalFor(request.payload.resourceId).close(request.payload.sessionId);
          break;
        case 'shutdown': {
          for (const controller of observations.values()) controller.abort();
          await apps.shutdown();
          const results = await Promise.allSettled([chat.shutdown(), environments.shutdown()]);
          const failure = results.find((result) => result.status === 'rejected');
          if (failure?.status === 'rejected') throw failure.reason;

          result = null;
          break;
        }
      }
      send({ type: 'response', id: request.id, result });
      // ACK须由宿主收到后再结束utility，立即exit会丢失仍在传输的消息。
    } catch (error) {
      send({ type: 'error', id: request.id, error: (error as Error).message });
    }
  };
  if (['send', 'cancel', 'reset', 'shutdown', 'resources.save', 'resources.remove'].includes(request.method)) {
    resourceOperations = resourceOperations.then(execute);
  } else void execute();
});

process.on('SIGTERM', () => {
  for (const controller of observations.values()) controller.abort();
  void apps
    .shutdown()
    .then(() => Promise.all([chat.shutdown(), environments.shutdown()]))
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('guest 清理失败', error);
      process.exitCode = 1;
    });
});
