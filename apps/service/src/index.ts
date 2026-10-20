import { RecoveryJournal } from './edu-recovery-journal';
import { MaintenanceGate } from './maintenance-gate';
import { EduVerificationService } from './edu-verification';
import { shutdownServiceOwners } from './shutdown';
import { randomUUID } from 'node:crypto';
import { validateResearchReply } from './research-runtime';
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
  type EduTaskBinding,
  type ResearchCall,
  type ResearchReply,
} from '@wsl/protocol';
import { SbxConnection } from './sbx';
import { CodexChat } from './codex-chat';
import { EnvironmentResources } from './environment-resources';
import { dispatchRoute, isRoutedRequest, type RouteContext } from './routes';

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
const researchCalls = new Map<
  string,
  {
    call: ResearchCall;
    resolve: (reply: ResearchReply) => void;
    abort: () => void;
    signal: AbortSignal;
  }
>();
chat.setResearchReader(
  (call, signal) =>
    new Promise((resolve) => {
      if (researchCalls.has(call.callId)) throw new Error('Duplicate research call');
      const abort = () => {
        signal.removeEventListener('abort', abort);
        researchCalls.delete(call.callId);
        send({ type: 'research-abort', callId: call.callId });
        resolve({
          callId: call.callId,
          context: call.context,
          result: { ok: false, tool: call.tool, error: { code: 'cancelled', message: 'Research cancelled' } },
        });
      };
      researchCalls.set(call.callId, { call, resolve, abort, signal });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      send({ type: 'research-call', ...call });
    }),
);
const sourceCalls = new Map<string, AbortController>();
const agentCalls = new Map<string, AbortController>();
const observations = new Map<string, AbortController>();
const terminalFor = (resourceId: string) => environments.terminal(environments.identity(resourceId));
const routeContext: RouteContext = {
  environments,
  terminalFor,
  requireReady,
  validateResearchReply,
  observations,
  observationCalls,
  appCalls,
  researchCalls,
};
const connectionReady = chat.initialize();
// Capture and resource writes share ordering. Cancellation must bypass a held
// capture so it can revoke CodexChat.preparing before any guest is launched.
let sendOperations: Promise<unknown> = Promise.resolve();
interface SendAdmission {
  cancelled: boolean;
  binding?: EduTaskBinding;
}
const pendingSends = new Map<string, Set<SendAdmission>>();
async function cancelPendingEdu(admissions: SendAdmission[]): Promise<void> {
  for (const admission of admissions) admission.cancelled = true;
  const outcomes = await Promise.all(admissions.flatMap((admission) => (admission.binding ? [apps.cancelEduTask(admission.binding)] : [])));
  if (outcomes.some((outcome) => !outcome.cleanupConfirmed)) throw new Error('edu_task_helper_cleanup_unknown');
}
const maintenance = new MaintenanceGate();
const recoveryJournal = new RecoveryJournal(path.join(root, 'edu-verification-recovery.json'), maintenance);
let initializationError: Error | null = null;
const verification = new EduVerificationService(
  apps,
  maintenance,
  async () => {
    const cancellingEdu = cancelPendingEdu([...pendingSends.values()].flatMap((pending) => [...pending]));
    for (const controller of agentCalls.values()) controller.abort();
    for (const controller of sourceCalls.values()) controller.abort();
    await cancellingEdu;
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
async function shutdownApps(): Promise<void> {
  const errors: unknown[] = [];
  try {
    await verification.shutdown();
  } catch (error) {
    errors.push(error);
  }
  // Verification failure must not skip independent helper and import cleanup.
  try {
    await apps.shutdown();
  } catch (error) {
    errors.push(error);
  }
  if (errors.length) throw new AggregateError(errors, '应用所属进程清理未确认');
}
parent.on('message', ({ data }) => {
  const request = ChatServiceRequestSchema.parse(data);
  if (request.method === 'shutdown') chat.beginShutdown();
  const cancellingAdmissions =
    request.method === 'cancel' || request.method === 'reset' ? [...(pendingSends.get(request.payload.conversationId) ?? [])] : [];
  for (const pending of cancellingAdmissions) pending.cancelled = true;
  const admission: SendAdmission | null = request.method === 'send' ? { cancelled: false, binding: request.payload.eduTask } : null;
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
      'app.importSource',
      'app.start',
      'app.prepareEduTask',
      'app.applyEduTask',
    ].includes(request.method) ||
    (request.method === 'app.agent' && ['seed', 'reset'].includes(request.payload.operation.op)) ||
    (request.method === 'app.motaControl' && ['acquire', 'map.set'].includes(request.payload.method)) ||
    (request.method === 'app.motaEditor' && !['editor.revoke', 'editor.status'].includes(request.payload.method));
  let checkAdmission: () => void = () => undefined;
  let admissionError: unknown;
  if (mutating) {
    try {
      checkAdmission = maintenance.admission();
    } catch (error) {
      admissionError = error;
    }
  }
  // Register finite ownership before send ordering can defer its first helper.
  // A cancel racing that queued send can then leave a precise tombstone.
  const eduBinding =
    request.method === 'send' ? request.payload.eduTask : request.method === 'app.prepareEduTask' ? request.payload : undefined;
  if (eduBinding) {
    try {
      apps.registerEduTask(eduBinding);
    } catch (error) {
      admissionError ??= error;
    }
  }
  if (request.method === 'send' && request.payload.motaTask) {
    try {
      apps.registerMotaTask(request.payload.motaTask);
    } catch (error) {
      admissionError ??= error;
    }
  }
  const execute = async () => {
    // This local call boundary proves only model dispatch, never finite helper
    // cleanup. Once chat.send is invoked, a thrown transport remains unknown.
    let chatSendInvoked = false;
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
          'app.cancelImport',
          'app.cancelEduTask',
          'app.motaControl',
          'app.motaEditor',
          'app.source.cancel',
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
      if (isRoutedRequest(request)) {
        const dispatched = dispatchRoute(request.method, request, routeContext, { checkAdmission });
        result = dispatched instanceof Promise ? await dispatched : dispatched;
      } else
        switch (request.method) {
          case 'app.motaEditor':
            result = await apps.motaEditor(request.payload);
            break;
          case 'app.motaControl':
            result = await apps.motaControl(request.payload);
            break;
          case 'app.source.snapshot': {
            if (sourceCalls.has(request.payload.callId)) throw new Error('Duplicate source snapshot call');
            const controller = new AbortController();
            sourceCalls.set(request.payload.callId, controller);
            try {
              await requireReady();
              result = await apps.sourceSnapshot(request.payload.target, controller.signal);
            } finally {
              sourceCalls.delete(request.payload.callId);
            }
            break;
          }
          case 'app.source.cancel':
            sourceCalls.get(request.payload.callId)?.abort();
            result = null;
            break;
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
            result = await apps.prepareTask(request.payload, eduCandidates.get(request.payload));
            break;
          case 'app.applyEduTask':
            await requireReady();
            checkAdmission();
            result = await apps.applyTask(request.payload, eduCandidates.get(request.payload));
            break;
          case 'app.cancelEduTask':
            result = await apps.cancelEduTask(request.payload);
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
          case 'app.importSource':
            await requireReady();
            checkAdmission();
            result = await apps.importSource(request.payload);
            break;
          case 'app.cancelImport':
            result = await apps.cancelImport(request.payload);
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
          case 'app.agent': {
            await requireReady();
            if (agentCalls.has(request.payload.callId)) throw new Error('Duplicate app agent call');
            const controller = new AbortController();
            agentCalls.set(request.payload.callId, controller);
            try {
              checkAdmission();
              result = await apps.agent(
                request.payload.target,
                request.payload.appInstanceId,
                request.payload.operation,
                controller.signal,
              );
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
          case 'register':
            chat.register(request.payload.conversationId, request.payload.workspaceId);
            result = null;
            break;
          case 'status':
            result = initializationError
              ? { ...chat.getStatus(), available: false, reason: initializationError.message }
              : chat.getStatus();
            break;
          case 'get':
            result = chat.get(request.payload.conversationId);
            break;
          case 'send': {
            const binding = request.payload.eduTask;
            const motaTask = request.payload.motaTask;
            await apps.assertTaskAdmission(request.payload.references.workspaceId, binding, motaTask);
            if (motaTask && !admission?.cancelled) {
              chat.assertMotaCapability();
              const acquired = await apps.motaControl({
                type: 'mota-control',
                requestId: randomUUID(),
                binding: motaTask,
                method: 'acquire',
                input: {},
              });
              if (!acquired.ok) throw new Error(acquired.error.message);
            }
            const workspace = binding && !admission?.cancelled ? await apps.taskSource(binding) : undefined;
            checkAdmission();
            if (binding && !admission?.cancelled) apps.assertEduTaskActive(binding);
            if (motaTask && !admission?.cancelled) apps.assertMotaTaskActive(motaTask);
            if (admission?.cancelled) result = chat.get(request.payload.conversationId);
            else {
              chatSendInvoked = true;
              result = await chat.send(
                request.payload.conversationId,
                request.payload.text,
                request.payload.observationScope,
                request.payload.references,
                binding && workspace ? { binding, workspace, retain: (candidate) => eduCandidates.retain(binding, candidate) } : undefined,
                motaTask,
                request.payload.researchGrant,
              );
            }
            break;
          }
          case 'cancel':
            if (cancellingAdmissions.some((admission) => admission.binding)) await cancelPendingEdu(cancellingAdmissions);
            result = await chat.cancel(request.payload.conversationId, cancellingAdmissions.length > 0);
            break;
          case 'reset':
            if (cancellingAdmissions.some((admission) => admission.binding)) await cancelPendingEdu(cancellingAdmissions);
            result = await chat.reset(request.payload.conversationId);
            break;
          case 'shutdown': {
            for (const controller of observations.values()) controller.abort();
            for (const controller of agentCalls.values()) controller.abort();
            for (const controller of sourceCalls.values()) controller.abort();
            await shutdownServiceOwners(
              shutdownApps,
              () => chat.shutdown(),
              () => environments.shutdown(),
            );

            result = null;
            break;
          }
          default: {
            const unreachable: never = request;
            throw new Error(`Unhandled service request: ${unreachable}`);
          }
        }
      send({ type: 'response', id: request.id, result });
      // ACK须由宿主收到后再结束utility，立即exit会丢失仍在传输的消息。
    } catch (error) {
      if (request.method === 'app.source.snapshot')
        send({
          type: 'response',
          id: request.id,
          result: {
            ok: false,
            target: request.payload.target,
            cleanupConfirmed: false,
            error: '源码 helper 启动或回执异常；清理未确认',
          },
        });
      else if (request.method === 'app.prepareEduTask' || request.method === 'app.applyEduTask' || request.method === 'app.cancelEduTask')
        send({
          type: 'response',
          id: request.id,
          result: apps.eduTaskFailure(
            request.payload,
            request.method === 'app.prepareEduTask' ? 'prepare' : request.method === 'app.applyEduTask' ? 'apply' : 'cancel',
            error,
          ),
        });
      else if (request.method === 'send' && request.payload.eduTask && !chatSendInvoked)
        send({
          type: 'response',
          id: request.id,
          result: {
            kind: 'edu-task-dispatch-rejected',
            conversationId: request.payload.conversationId,
            binding: request.payload.eduTask,
            executorStarted: false,
            error: error instanceof Error && error.message ? error.message.slice(0, 1000) : 'edu_task_dispatch_rejected',
          },
        });
      else if (request.method === 'send' && request.payload.motaTask && !chatSendInvoked)
        send({
          type: 'response',
          id: request.id,
          result: {
            kind: 'mota-task-dispatch-rejected',
            conversationId: request.payload.conversationId,
            binding: request.payload.motaTask,
            executorStarted: false,
            error: error instanceof Error && error.message ? error.message.slice(0, 1000) : 'mota_task_dispatch_rejected',
          },
        });
      else send({ type: 'error', id: request.id, error: (error as Error).message });
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
  for (const controller of agentCalls.values()) controller.abort();
  for (const controller of sourceCalls.values()) controller.abort();
  void shutdownServiceOwners(
    shutdownApps,
    () => chat.shutdown(),
    () => environments.shutdown(),
  )
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error('guest 清理失败', error);
      process.exitCode = 1;
    });
});
