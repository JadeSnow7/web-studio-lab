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
export interface WorkbenchRuntime {
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
  ): Promise<ChatConversation>;
  cancel(sessionId: string): Promise<ChatConversation>;
}
export type CaptureListener = (resourceId: string, capture: PageCapture) => void;
