import type { AppUiPort } from './app-control';
import type {
  AppAgentOperation,
  AppAgentResult,
  AppLogs,
  EduTaskBinding,
  AppSource,
  PageResourceSnapshot,
  CatalogReferenceSnapshot,
  ManagedApp,
  AppTarget,
  EduVerificationBegin,
  EduVerificationTarget,
  EduVerificationStatus,
  EduAdmissionRecoveryStatus,
  EduImport,
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
export interface WorkbenchRuntime {
  eduTaskSource?(target: AppTarget): Promise<AppSource>;
  eduTaskPrepare?(binding: EduTaskBinding): Promise<void>;
  eduTaskApply?(binding: EduTaskBinding): Promise<ManagedApp>;
  appGet?(target: AppTarget): Promise<ManagedApp>;
  appCreate?(target: AppTarget): Promise<ManagedApp>;
  appSelectEduSource?(signal: AbortSignal): Promise<Pick<EduImport, 'source' | 'files'> | null>;
  appImportEdu?(target: AppTarget, source: Pick<EduImport, 'source' | 'files'>): Promise<ManagedApp>;
  appStart?(target: AppTarget): Promise<ManagedApp>;
  appStop?(target: AppTarget): Promise<ManagedApp>;
  verificationBegin?(input: EduVerificationBegin): Promise<EduVerificationStatus>;
  verificationEnd?(target: EduVerificationTarget): Promise<EduVerificationStatus>;
  verificationStatus?(target: EduVerificationTarget): Promise<EduVerificationStatus>;
  verificationReconcile?(target: EduVerificationTarget): Promise<EduVerificationStatus>;
  verificationRecoverAdmission?(original: EduVerificationBegin): Promise<EduAdmissionRecoveryStatus>;
  appExport?(target: AppTarget): Promise<{ path: string; manifestPath?: string; sha256: string }>;
  releaseAppBrowser?(resourceId: string): void | Promise<void>;
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
  deactivateAudio?(): Promise<void>;
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
    eduTask?: EduTaskBinding,
  ): Promise<ChatConversation>;
  cancel(sessionId: string): Promise<ChatConversation>;
}
export type CaptureListener = (resourceId: string, capture: PageCapture) => void;
