import type { AppUiPort } from './app-control';
import type {
  ResearchGrant,
  MotaTaskBinding,
  MotaControlRequest,
  MotaControlResponse,
  AppSourceSnapshotResult,
  AppAgentOperation,
  AppAgentResult,
  AppLogs,
  EduTaskBinding,
  EduTaskOperationResult,
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
  EduAppImportPreview,
  MotaAppImportPreview,
  MotaAppImportRequest,
  AppImportOutcome,
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
export type ImportProgress = { files: number; bytes: number };
export type EduImportSource = Pick<EduImport, 'source' | 'files'> & { profile?: never };
export type MotaImportSource = Pick<MotaAppImportRequest, 'profile' | 'source' | 'files'>;
export type AppImportSource = EduImportSource | MotaImportSource;
export type AppImportSelection =
  | (EduImportSource & { preview: EduAppImportPreview; revalidate(signal: AbortSignal): Promise<EduImportSource> })
  | (MotaImportSource & { preview: MotaAppImportPreview; revalidate(signal: AbortSignal): Promise<MotaImportSource> });
export interface WorkbenchRuntime {
  motaControl?(request: MotaControlRequest): Promise<MotaControlResponse>;
  appSourceSnapshot?(target: AppTarget, signal: AbortSignal): Promise<AppSourceSnapshotResult>;
  appSelectImportSource?(signal: AbortSignal, progress: (value: ImportProgress) => void): Promise<AppImportSelection | null>;
  appImportSource?(target: AppTarget, source: AppImportSource, importOperationId: string): Promise<AppImportOutcome>;
  appCancelImport?(target: AppTarget, importOperationId: string): Promise<AppImportOutcome>;
  eduTaskSource?(target: AppTarget): Promise<AppSource>;
  eduTaskPrepare?(binding: EduTaskBinding): Promise<EduTaskOperationResult>;
  eduTaskApply?(binding: EduTaskBinding): Promise<EduTaskOperationResult>;
  eduTaskCancel?(binding: EduTaskBinding): Promise<EduTaskOperationResult>;
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
  openResearchDocument?(resourceId: string, url: string, signal: AbortSignal): Promise<PageResourceSnapshot>;
  validateBrowserUrl(url: string): void;
  ensureBrowser(workspaceId: string, resource: WorkbenchResource, options?: { deferInitialLoad: boolean }): void;
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
    motaTask?: MotaTaskBinding,
    researchGrant?: ResearchGrant,
  ): Promise<ChatConversation>;
  cancel(sessionId: string): Promise<ChatConversation>;
}
export type CaptureListener = (resourceId: string, capture: PageCapture) => void;
