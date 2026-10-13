// 真实 Electron 集成夹具：在独立 BrowserWindow 中挂载产品的 PreviewController、AppUiDriver 与 AppControl，
// 连接本机构建并启动的 standard-app（非 sandbox、无模型）。只服务 e2e/app-control-harness.spec.ts。
import { app, BrowserWindow } from 'electron';
import { PreviewController } from '../../apps/desktop/src/main/preview/controller';
import { AppUiDriver } from '../../apps/desktop/src/main/preview/app-ui';
import { AppControl, FileAppControlStore, type AppControlContext, type AppUiPort } from '../../apps/desktop/src/main/workbench/app-control';
import { AppControlFailure } from '../../apps/desktop/src/main/workbench/app-control-failure';
import {
  AgentCliEnvelopeSchema,
  AppOperationReceiptSchema,
  type AppAgentOperation,
  type AppAgentResult,
  type ObservationTurnScope,
  type PreviewState,
} from '../../packages/protocol/src/index';

type Config = { url: string; token: string; appInstanceId: string; evidence: string };
const config = JSON.parse(process.env['WSL_HARNESS_CONFIG'] ?? 'null') as Config;
const origin = new URL(config.url).origin;
const flags = {
  runActive: true,
  runId: 'harness-run-1',
  leaseValid: true,
  allowsReset: false,
  appState: 'running' as 'running' | 'stopped',
  appInstanceId: config.appInstanceId,
};
const restarts: string[] = [];
let latest: PreviewState | null = null;

async function agent(operation: AppAgentOperation, signal: AbortSignal): Promise<AppAgentResult> {
  // 与 AppService 的运行实例分支一致：回环 HTTP + 实例令牌。
  if (operation.op === 'reconcile-cli') throw new Error('Harness has no backend CLI');
  const tracked = operation.op === 'seed' || operation.op === 'reset' || operation.op === 'reconcile';
  const id = tracked ? operation.operationId : null;
  const headers = {
    'x-wsl-agent-token': config.token,
    'content-type': 'application/json',
    ...(id ? { 'x-wsl-agent-operation-id': id } : {}),
  };
  if (operation.op === 'reconcile') {
    await fetch(new URL(`/api/__agent/operations/${id}/cancel`, config.url), {
      method: 'POST',
      headers,
      body: JSON.stringify({ operation: operation.operation }),
      signal,
    });
    const envelope = AgentCliEnvelopeSchema.parse(
      await (await fetch(new URL(`/api/__agent/operations/${id}`, config.url), { headers, signal })).json(),
    );
    if (!envelope.ok) return { mode: 'http', cleanupConfirmed: false, envelope };
    const receipt = AppOperationReceiptSchema.parse(envelope.data);
    return {
      mode: 'http',
      cleanupConfirmed: receipt.state !== 'running',
      operation: receipt,
      envelope: receipt.envelope ?? { ok: false, error: { code: 'app_busy', message: 'Data operation still running' } },
    };
  }
  const [method, pathname, body] =
    operation.op === 'describe'
      ? ['GET', '/api/__agent/describe', undefined]
      : operation.op === 'query'
        ? ['POST', '/api/__agent/db/query', { sql: operation.sql, limit: operation.limit }]
        : operation.op === 'snapshot'
          ? ['GET', '/api/__agent/db/snapshot', undefined]
          : ['POST', `/api/__agent/db/${operation.op}`, {}];
  const response = await fetch(new URL(pathname, config.url), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const envelope = AgentCliEnvelopeSchema.parse(await response.json());
  if (!tracked) return { mode: 'http', cleanupConfirmed: true, envelope };
  const receiptEnvelope = AgentCliEnvelopeSchema.parse(
    await (await fetch(new URL(`/api/__agent/operations/${id}`, config.url), { headers, signal })).json(),
  );
  if (!receiptEnvelope.ok) return { mode: 'http', cleanupConfirmed: false, envelope };
  const receipt = AppOperationReceiptSchema.parse(receiptEnvelope.data);
  return { mode: 'http', cleanupConfirmed: receipt.state !== 'running', envelope, operation: receipt };
}

app.on('window-all-closed', () => app.quit());
void app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 1100, height: 820, show: true, webPreferences: { sandbox: true, contextIsolation: true } });
  void window.loadURL('data:text/html,<title>harness workbench</title><input aria-label="workbench">');
  const preview = new PreviewController(window, {
    partition: 'harness-preview',
    homeUrl: config.url,
    allowedOrigins: [origin],
    managedAppOrigin: () => origin,
    onState: (state) => {
      latest = state;
    },
    onCaptured: () => undefined,
  });
  preview.load();
  preview.setLayout({ bounds: { x: 0, y: 60, width: 1000, height: 740 }, visible: true });
  const driver = new AppUiDriver(
    preview.observationTarget,
    { identity: () => preview.pageIdentity(), cdp: () => preview.getCdpState(), picking: () => preview.isPicking() },
    preview.agentControl,
  );
  const ui: AppUiPort = {
    identity: () => ({
      documentGeneration: preview.pageIdentity().documentGeneration,
      url: preview.pageIdentity().url,
      cdp: preview.getCdpState(),
      agentControl: preview.agentControl.state(),
    }),
    snapshot: (appInstanceId, options, signal) => driver.snapshot(appInstanceId, options, signal),
    act: (action, binding, signal) => driver.act(action, binding, signal),
    query: (target, signal) => driver.query(target, signal),
    bridge: (request, signal) => driver.bridge(request, signal),
    screenshot: () => driver.screenshot(),
    consoleMark: () => driver.consoleMark(),
    consoleErrorsSince: (mark) => driver.consoleErrorsSince(mark),
    beginControl: (runId, label) => preview.agentControl.begin(runId, label),
    releaseRun: (runId) => preview.agentControl.release(runId),
  };
  const control = new AppControl({
    context: async (): Promise<AppControlContext> => {
      if (!flags.runActive) throw new AppControlFailure('no_active_run', '执行已结束');
      return {
        workspaceId: 'harness-space',
        sessionId: 'harness-session',
        runId: flags.runId,
        allowsReset: flags.allowsReset,
        app: {
          projectId: '00000000-0000-4000-8000-0000000000aa',
          appInstanceId: flags.appInstanceId,
          state: flags.appState,
          url: config.url,
          cleanupConfirmed: false,
          error: null,
        },
        browser: { resourceId: 'harness-browser', instanceId: 'harness-instance', generation: 1 },
      };
    },
    ui: () => ui,
    agent: (_target, _appInstanceId, operation, signal) => agent(operation, signal),
    logs: async () => ({ text: '', truncated: false, totalBytes: 0 }),
    leaseValid: () => flags.leaseValid,
    restart: (_workspaceId, appInstanceId) => restarts.push(appInstanceId),
    store: new FileAppControlStore(config.evidence),
  });
  const scope: ObservationTurnScope = { workspaceId: 'harness-space', sessionId: 'harness-session', runId: flags.runId, sources: [] };
  const pending = new Map<string, AbortController>();
  Object.assign(globalThis, {
    __harness: {
      ready: () => !preview.observationTarget.isLoading() && preview.pageIdentity().url.startsWith(origin),
      call: (tool: string, args: Record<string, unknown> = {}, callId?: string) => {
        const controller = new AbortController();
        if (callId) pending.set(callId, controller);
        return control.call({ ...scope, runId: flags.runId }, tool, args, controller.signal).finally(() => {
          if (callId) pending.delete(callId);
        });
      },
      abort: (callId: string) => pending.get(callId)?.abort(),
      releaseRun: () => control.releaseRun(flags.runId),
      set: (next: Partial<typeof flags>) => Object.assign(flags, next),
      restarts: () => [...restarts],
      previewState: () => latest,
      agentControl: () => preview.agentControl.state(),
      resume: () => preview.agentControl.resume(),
      /** 经 Chromium 正常输入管线模拟“用户”在 Browser 区的点击（不经 CDP）。 */
      userClick: (x: number, y: number) => {
        const wc = preview.observationTarget;
        wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
        wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      },
      reload: () => preview.reload(),
      focusWorkbench: () => window.webContents.focus(),
      focus: () => ({ workbench: window.webContents.isFocused(), preview: preview.observationTarget.isFocused() }),
      evaluateInPage: (expression: string) => preview.observationTarget.executeJavaScript(expression),
    },
  });
});
