import { RecoveryJournal } from './edu-recovery-journal';
import { MaintenanceGate } from './maintenance-gate';
import { EduVerificationService } from './edu-verification';
import { shutdownServiceOwners } from './shutdown';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AppService } from './app-service';
import { EduTaskCandidates } from './edu-task';
import {
  ObservationRequestSchema,
  ServiceRuntimeConfigSchema,
  type WorkspaceObservationResult,
  type AppControlResult,
  AppToolNameSchema,
  ChatServiceMessageSchema,
  ChatServiceRequestSchema,
  type ChatServiceMessage,
} from '@wsl/protocol';
import { SbxConnection } from './sbx';
import { CodexChat } from './codex-chat';
import { EnvironmentResources } from './environment-resources';

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
const eduCandidates = new EduTaskCandidates(root);
const chat = new CodexChat(root, (conversation) => send({ type: 'event', conversation }), new SbxConnection(runtime));
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
// 控制面调用沿与观察相同的具名消息转给 Main dispatcher；service 不持有 run 或授权状态。
const appCalls = new Map<string, { resolve: (result: AppControlResult) => void; abort: () => void; signal: AbortSignal }>();
chat.setAppControlReader(
  (scope, tool, args, signal) =>
    new Promise((resolve) => {
      const validatedTool = AppToolNameSchema.parse(tool);
      const id = randomUUID();
      const abort = () => {
        signal.removeEventListener('abort', abort);
        send({ type: 'app-abort', id });
        appCalls.delete(id);
        resolve({ ok: false, tool: validatedTool, error: { code: 'cancelled', message: '控制面调用已取消' } });
      };
      appCalls.set(id, { resolve, abort, signal });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      send({ type: 'app-call', id, scope, tool: validatedTool, args });
    }),
);
const agentCalls = new Map<string, AbortController>();
const observations = new Map<string, AbortController>();
const terminalFor = (resourceId: string) => environments.terminal(environments.identity(resourceId));
const connectionReady = chat.initialize();
// Capture and resource writes share ordering. Cancellation must bypass a held
// capture so it can revoke CodexChat.preparing before any guest is launched.
let sendOperations: Promise<unknown> = Promise.resolve();
const pendingSends = new Map<string, Set<{ cancelled: boolean }>>();
const maintenance = new MaintenanceGate();
const recoveryJournal = new RecoveryJournal(path.join(root, 'edu-verification-recovery.json'), maintenance);
let initializationError: Error | null = null;
const verification = new EduVerificationService(
  apps,
  maintenance,
  async () => {
    for (const pending of pendingSends.values()) for (const admission of pending) admission.cancelled = true;
    for (const controller of agentCalls.values()) controller.abort();
    await chat.drainForVerification();
    await maintenance.drain();
    await chat.drainForVerification();
    await environments.drainTerminals();
  },
  {
    ensureReady: requireReady,
    journal: recoveryJournal,
    onStatus: (status) => send({ type: 'edu-verification-event', status }),
    onAdmissionStatus: (status) => send({ type: 'edu-admission-recovery-event', status }),
  },
);
const ready = connectionReady.then(async (status) => {
  try {
    await verification.initialize();
  } catch (error) {
    initializationError = new Error('verification_journal_invalid', { cause: error });
  }
  const effective = initializationError ? { ...status, available: false, reason: initializationError.message } : status;
  send({ type: 'initialized', status: effective, cleanupPending: maintenance.isLocked() || chat.connection.getCleanupPending() });
  return effective;
});
async function requireReady(): Promise<void> {
  await ready;
  if (initializationError) throw initializationError;
}
parent.on('message', ({ data }) => {
  const request = ChatServiceRequestSchema.parse(data);
  if (request.method === 'shutdown') chat.beginShutdown();
  if (request.method === 'cancel' || request.method === 'reset') {
    for (const pending of pendingSends.get(request.payload.conversationId) ?? []) pending.cancelled = true;
  }
  const admission = request.method === 'send' ? { cancelled: false } : null;
  if (request.method === 'send' && admission) {
    const pending = pendingSends.get(request.payload.conversationId) ?? new Set();
    pending.add(admission);
    pendingSends.set(request.payload.conversationId, pending);
  }
  const mutating =
    [
      'send',
      'terminal.open',
      'terminal.write',
      'app.create',
      'app.importEdu',
      'app.start',
      'app.prepareEduTask',
      'app.applyEduTask',
    ].includes(request.method) ||
    (request.method === 'app.agent' && ['seed', 'reset'].includes(request.payload.operation.op));
  let checkAdmission: () => void = () => undefined;
  let admissionError: unknown;
  if (mutating) {
    try {
      checkAdmission = maintenance.admission();
    } catch (error) {
      admissionError = error;
    }
  }
  const execute = async () => {
    try {
      if (
        initializationError &&
        ![
          'status',
          'get',
          'register',
          'resource.register',
          'terminal.get',
          'environments.list',
          'shutdown',
          'cancel',
          'reset',
          'app.agent.cancel',
          'observation.cancel',
          'terminal.close',
        ].includes(request.method)
      )
        throw initializationError;
      if (admissionError) throw admissionError;
      checkAdmission();
      if (request.method === 'send') await requireReady();
      checkAdmission();
      let result;
      switch (request.method) {
        case 'app.verification.recoverAdmission':
          result = await verification.recoverAdmission(request.payload);
          break;
        case 'app.verification.begin':
          result = await verification.begin(request.payload);
          break;
        case 'app.verification.reconcile':
          await requireReady();
          result = await verification.reconcile(request.payload);
          break;
        case 'app.verification.end':
          result = await verification.end(request.payload);
          break;
        case 'app.verification.status':
          result = verification.status(request.payload);
          break;
        case 'app.taskSource':
          await requireReady();
          result = await apps.export(request.payload, true);
          break;
        case 'app.prepareEduTask':
          await requireReady();
          checkAdmission();
          await apps.prepareTask(request.payload, eduCandidates.get(request.payload));
          result = null;
          break;
        case 'app.applyEduTask':
          await requireReady();
          checkAdmission();
          result = await apps.applyTask(request.payload, eduCandidates.get(request.payload));
          break;
        case 'app.get':
          await requireReady();
          result = await apps.restore(request.payload);
          break;
        case 'app.create':
          await requireReady();
          checkAdmission();
          result = await apps.create(request.payload);
          break;
        case 'app.importEdu':
          await requireReady();
          checkAdmission();
          result = await apps.importEdu(request.payload);
          break;
        case 'app.start':
          await requireReady();
          checkAdmission();
          result = await apps.start(request.payload);
          break;
        case 'app.stop':
          await requireReady();
          if (await verification.stopCurrent(request.payload)) result = await apps.restore(request.payload);
          else result = await apps.stop(request.payload);
          break;
        case 'app.export':
          await requireReady();
          result = await apps.export(request.payload);
          break;
        case 'app.reply': {
          const call = appCalls.get(request.payload.callId);
          if (call) {
            appCalls.delete(request.payload.callId);
            call.signal.removeEventListener('abort', call.abort);
            call.resolve(request.payload.result);
          }
          result = null;
          break;
        }
        case 'app.agent': {
          await requireReady();
          if (agentCalls.has(request.payload.callId)) throw new Error('Duplicate app agent call');
          const controller = new AbortController();
          agentCalls.set(request.payload.callId, controller);
          try {
            checkAdmission();
            result = await apps.agent(request.payload.target, request.payload.appInstanceId, request.payload.operation, controller.signal);
          } finally {
            agentCalls.delete(request.payload.callId);
          }
          break;
        }
        case 'app.agent.cancel':
          agentCalls.get(request.payload.callId)?.abort();
          result = null;
          break;
        case 'app.logs':
          await requireReady();
          result = await apps.logs(request.payload.target, request.payload.maxBytes);
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
        case 'resource.release':
          await environments.release(request.payload);
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
        case 'register':
          chat.register(request.payload.conversationId, request.payload.workspaceId);
          result = null;
          break;
        case 'status':
          result = initializationError ? { ...chat.getStatus(), available: false, reason: initializationError.message } : chat.getStatus();
          break;
        case 'get':
          result = chat.get(request.payload.conversationId);
          break;
        case 'send': {
          const binding = request.payload.eduTask;
          await apps.assertTaskAdmission(request.payload.references.workspaceId, binding);
          const workspace = binding && !admission?.cancelled ? await apps.taskSource(binding) : undefined;
          checkAdmission();
          result = admission?.cancelled
            ? chat.get(request.payload.conversationId)
            : await chat.send(
                request.payload.conversationId,
                request.payload.text,
                request.payload.observationScope,
                request.payload.references,
                binding && workspace ? { binding, workspace, retain: (candidate) => eduCandidates.retain(binding, candidate) } : undefined,
              );
          break;
        }
        case 'cancel':
          result = await chat.cancel(request.payload.conversationId, pendingSends.has(request.payload.conversationId));
          break;
        case 'reset':
          result = await chat.reset(request.payload.conversationId);
          break;
        case 'terminal.get':
          result = environments.terminalSnapshot(environments.identity(request.resourceId));
          break;
        case 'terminal.open': {
          const identity = environments.identity(request.payload.resourceId);
          if (identity.environmentId === 'sandbox') await requireReady();
          checkAdmission();
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
          for (const controller of agentCalls.values()) controller.abort();
          await verification.shutdown();
          await shutdownServiceOwners(
            () => apps.shutdown(),
            () => chat.shutdown(),
            () => environments.shutdown(),
          );

          result = null;
          break;
        }
      }
      send({ type: 'response', id: request.id, result });
      // ACK须由宿主收到后再结束utility，立即exit会丢失仍在传输的消息。
    } catch (error) {
      send({ type: 'error', id: request.id, error: (error as Error).message });
    } finally {
      if (request.method === 'send' && admission) {
        const pending = pendingSends.get(request.payload.conversationId);
        pending?.delete(admission);
        if (!pending?.size) pendingSends.delete(request.payload.conversationId);
      }
    }
  };
  if (request.method === 'send') {
    sendOperations = sendOperations.then(() => maintenance.track(execute()));
  } else if (mutating) void maintenance.track(execute());
  else void execute();
});

process.on('SIGTERM', () => {
  chat.beginShutdown();
  for (const controller of observations.values()) controller.abort();
  void verification
    .shutdown()
    .then(() =>
      shutdownServiceOwners(
        () => apps.shutdown(),
        () => chat.shutdown(),
        () => environments.shutdown(),
      ),
    )
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('guest 清理失败', error);
      process.exitCode = 1;
    });
});
