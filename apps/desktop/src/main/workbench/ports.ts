import type { EduImport, EduAppImportPreview, AppImportOutcome } from '@wsl/protocol';
import type { AppUiPort } from './app-control';
import type {
  AppSourceSnapshotResult,
  AppAgentOperation,
  AppAgentResult,
  AppLogs,
  PageResourceSnapshot,
  CatalogReferenceSnapshot,
  ManagedApp,
  AppTarget,
  EnvironmentDescription,
  ObservationRequest,
  ObservationResult,
  ResourceInstanceIdentity,
  ObservationTurnScope,
  ChatConversation,
  PageCapture,
  PreviewLayout,
  PreviewState,
  TerminalSnapshot,
  WorkbenchResource,
  HarnessRef,
  HarnessSelection,
  TurnHarness,
} from '@wsl/protocol';
export class RunDispatchFailure extends Error {
  constructor(
    message: string,
    readonly cleanupPending: boolean,
    readonly knownNotSent = false,
  ) {
    super(message);
  }
}
export type ImportProgress = { files: number; bytes: number };
export type AppImportSource = Pick<EduImport, 'source' | 'files'>;
export type AppImportSelection = AppImportSource & {
  preview: EduAppImportPreview;
  revalidate(signal: AbortSignal): Promise<AppImportSource>;
};
export interface WorkbenchRuntime {
  appSelectImportSource?(signal: AbortSignal, progress: (value: ImportProgress) => void): Promise<AppImportSelection | null>;
  appImportSource?(target: AppTarget, source: AppImportSource, importOperationId: string): Promise<AppImportOutcome>;
  appCancelImport?(target: AppTarget, importOperationId: string): Promise<AppImportOutcome>;
  appSourceSnapshot?(target: AppTarget, signal: AbortSignal): Promise<AppSourceSnapshotResult>;
  appGet?(target: AppTarget): Promise<ManagedApp>;
  appCreate?(target: AppTarget): Promise<ManagedApp>;
  appStart?(target: AppTarget): Promise<ManagedApp>;
  appStop?(target: AppTarget): Promise<ManagedApp>;
  appExport?(target: AppTarget): Promise<{ path: string; manifestPath?: string; sha256: string }>;
  releaseAppBrowser?(resourceId: string): void;
  /** 控制面执行器：仅受管 App 的 Browser 资源可取得 UI 端口。 */
  appUi?(resourceId: string): AppUiPort;
  appAgent?(target: AppTarget, appInstanceId: string | null, operation: AppAgentOperation, signal: AbortSignal): Promise<AppAgentResult>;
  appLogs?(target: AppTarget, maxBytes: number): Promise<AppLogs>;
  appLeaseValid?(projectId: string, appInstanceId: string): boolean;
  environmentsList(): Promise<EnvironmentDescription[]>;
  releaseResource(identity: ResourceInstanceIdentity): Promise<void>;
  registerResource(identity: ResourceInstanceIdentity): Promise<void>;
  observe(request: ObservationRequest, signal: AbortSignal): Promise<ObservationResult>;
  registerSession(sessionId: string, workspaceId: string): Promise<void>;
  captureResource(resourceId: string): Promise<PageResourceSnapshot>;
  validateBrowserUrl(url: string): void;
  ensureBrowser(workspaceId: string, resource: WorkbenchResource): void;
  browserState(resourceId: string): PreviewState;
  browserLayout(resourceId: string, layout: PreviewLayout): void;
  browserAction(resourceId: string, action: string, url?: string, requestId?: string): Promise<void> | void;
  hideBrowsers(): void;
  terminalOpen(resourceId: string, cols: number, rows: number): Promise<TerminalSnapshot>;
  terminalWrite(resourceId: string, instanceId: string, data: string): Promise<void>;
  terminalResize(resourceId: string, instanceId: string, cols: number, rows: number): Promise<void>;
  terminalStop(resourceId: string, instanceId: string): Promise<TerminalSnapshot>;
  send(
    sessionId: string,
    text: string,
    scope: ObservationTurnScope | undefined,
    references: CatalogReferenceSnapshot,
    harness: TurnHarness,
  ): Promise<ChatConversation>;
  cancel(sessionId: string): Promise<ChatConversation>;
  /** 把用户对权限请求的回复转给执行服务（W4b）；请求已结束或选项不符时抛出。 */
  answerPermission(sessionId: string, requestId: string, optionId: string | null): Promise<ChatConversation>;
  /** 当前持有 sandbox guest 工作区写入许可的会话；无人持有时为 null。未实现时视为不检查。 */
  writeHolder?(): string | null;
  /**
   * 解析会话的 Harness 选择（null 为全局默认）：返回冻结进执行记录的出处与本轮参数。
   * 在元数据队列内同步调用，只读已知结果；Harness 不可用或 Profile 已知未登录时抛出（W4a）。
   */
  resolveHarness(selection: HarnessSelection | null): { ref: HarnessRef; turn: TurnHarness };
  /** 启动路径上补做尚未完成的 Profile 自检；不是已登录时抛出，执行按“从未启动”记为失败。 */
  prepareHarness(turn: TurnHarness): Promise<void>;
}
export type CaptureListener = (resourceId: string, capture: PageCapture) => void;
