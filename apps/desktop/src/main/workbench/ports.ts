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
export interface BrowserPort {
  validateBrowserUrl(url: string): void;
  ensureBrowser(workspaceId: string, resource: WorkbenchResource, options?: { deferInitialLoad: boolean }): void;
  browserState(resourceId: string): PreviewState;
  browserLayout(resourceId: string, layout: PreviewLayout): void;
  browserAction(resourceId: string, action: string, url?: string, requestId?: string): Promise<void> | void;
  hideBrowsers(): void;
  openResearchDocument?(resourceId: string, url: string, signal: AbortSignal): Promise<PageResourceSnapshot>;
}

export interface TerminalPort {
  terminalOpen(resourceId: string, cols: number, rows: number): Promise<TerminalSnapshot>;
  terminalWrite(resourceId: string, instanceId: string, data: string): Promise<void>;
  terminalResize(resourceId: string, instanceId: string, cols: number, rows: number): Promise<void>;
  terminalStop(resourceId: string, instanceId: string): Promise<TerminalSnapshot>;
}

export interface ResourcePort {
  environmentsList(): Promise<EnvironmentDescription[]>;
  registerResource(identity: ResourceInstanceIdentity): Promise<void>;
  releaseResource(identity: ResourceInstanceIdentity): Promise<void>;
  observe(request: ObservationRequest, signal: AbortSignal): Promise<ObservationResult>;
  captureResource(resourceId: string): Promise<PageResourceSnapshot>;
}

export interface AgentPort {
  registerSession(sessionId: string, workspaceId: string): Promise<void>;
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

export interface AppPort {
  appGet?(target: AppTarget): Promise<ManagedApp>;
  appCreate?(target: AppTarget): Promise<ManagedApp>;
  appStart?(target: AppTarget): Promise<ManagedApp>;
  appStop?(target: AppTarget): Promise<ManagedApp>;
  appExport?(target: AppTarget): Promise<{ path: string; manifestPath?: string; sha256: string }>;
  appSourceSnapshot?(target: AppTarget, signal: AbortSignal): Promise<AppSourceSnapshotResult>;
  releaseAppBrowser?(resourceId: string): void | Promise<void>;
  /** 控制面执行器：仅受管 App 的 Browser 资源可取得 UI 端口。 */
  appUi?(resourceId: string): AppUiPort;
  appAgent?(target: AppTarget, appInstanceId: string | null, operation: AppAgentOperation, signal: AbortSignal): Promise<AppAgentResult>;
  appLogs?(target: AppTarget, maxBytes: number): Promise<AppLogs>;
  appLeaseValid?(projectId: string, appInstanceId: string): boolean;
}

export interface AppImportPort {
  appSelectImportSource?(signal: AbortSignal, progress: (value: ImportProgress) => void): Promise<AppImportSelection | null>;
  appImportSource?(target: AppTarget, source: AppImportSource, importOperationId: string): Promise<AppImportOutcome>;
  appCancelImport?(target: AppTarget, importOperationId: string): Promise<AppImportOutcome>;
}

/** 试验场专属，待解耦。 */
export interface TrialAppPort {
  motaControl?(request: MotaControlRequest): Promise<MotaControlResponse>;
  eduTaskSource?(target: AppTarget): Promise<AppSource>;
  eduTaskPrepare?(binding: EduTaskBinding): Promise<EduTaskOperationResult>;
  eduTaskApply?(binding: EduTaskBinding): Promise<EduTaskOperationResult>;
  eduTaskCancel?(binding: EduTaskBinding): Promise<EduTaskOperationResult>;
  appSelectEduSource?(signal: AbortSignal): Promise<Pick<EduImport, 'source' | 'files'> | null>;
  appImportEdu?(target: AppTarget, source: Pick<EduImport, 'source' | 'files'>): Promise<ManagedApp>;
  verificationBegin?(input: EduVerificationBegin): Promise<EduVerificationStatus>;
  verificationEnd?(target: EduVerificationTarget): Promise<EduVerificationStatus>;
  verificationStatus?(target: EduVerificationTarget): Promise<EduVerificationStatus>;
  verificationReconcile?(target: EduVerificationTarget): Promise<EduVerificationStatus>;
  verificationRecoverAdmission?(original: EduVerificationBegin): Promise<EduAdmissionRecoveryStatus>;
  deactivateAudio?(): Promise<void>;
}
export type WorkbenchRuntime = BrowserPort & TerminalPort & ResourcePort & AgentPort & AppPort & AppImportPort & TrialAppPort;

// Frozen from the pre-split WorkbenchRuntime at 1c856f5; independent of the grouped interfaces.
type OriginalRuntimeRequiredKeys =
  | 'environmentsList'
  | 'releaseResource'
  | 'registerResource'
  | 'observe'
  | 'registerSession'
  | 'captureResource'
  | 'validateBrowserUrl'
  | 'ensureBrowser'
  | 'browserState'
  | 'browserLayout'
  | 'browserAction'
  | 'hideBrowsers'
  | 'terminalOpen'
  | 'terminalWrite'
  | 'terminalResize'
  | 'terminalStop'
  | 'send'
  | 'cancel';
type OriginalRuntimeOptionalKeys =
  | 'motaControl'
  | 'appSourceSnapshot'
  | 'appSelectImportSource'
  | 'appImportSource'
  | 'appCancelImport'
  | 'eduTaskSource'
  | 'eduTaskPrepare'
  | 'eduTaskApply'
  | 'eduTaskCancel'
  | 'appGet'
  | 'appCreate'
  | 'appSelectEduSource'
  | 'appImportEdu'
  | 'appStart'
  | 'appStop'
  | 'verificationBegin'
  | 'verificationEnd'
  | 'verificationStatus'
  | 'verificationReconcile'
  | 'verificationRecoverAdmission'
  | 'appExport'
  | 'releaseAppBrowser'
  | 'appUi'
  | 'appAgent'
  | 'appLogs'
  | 'appLeaseValid'
  | 'openResearchDocument'
  | 'deactivateAudio';
type OriginalRuntimeKeys = OriginalRuntimeRequiredKeys | OriginalRuntimeOptionalKeys;
type OptionalKeys<T> = { [K in keyof T]-?: Record<never, never> extends Pick<T, K> ? K : never }[keyof T];
type Assert<T extends true> = T;
/** Compile-time checks only: preserve both the member set and every member's optionality. */
export type WorkbenchRuntimeContract = [
  Assert<Exclude<OriginalRuntimeKeys, keyof WorkbenchRuntime> extends never ? true : false>,
  Assert<Exclude<keyof WorkbenchRuntime, OriginalRuntimeKeys> extends never ? true : false>,
  Assert<Exclude<OriginalRuntimeOptionalKeys, OptionalKeys<WorkbenchRuntime>> extends never ? true : false>,
  Assert<Exclude<OptionalKeys<WorkbenchRuntime>, OriginalRuntimeOptionalKeys> extends never ? true : false>,
];

export interface WorkbenchHostEvents {
  performActiveBrowserAction(action: 'reload' | 'openDevTools'): Promise<void>;
  onVerification(status: EduVerificationStatus): Promise<void>;
  onAdmissionRecovery(status: EduAdmissionRecoveryStatus): Promise<void>;
  maintenanceLocked(): boolean;
  onApp(app: ManagedApp): Promise<void>;
  verificationAllowsAudio(projectId: string, appInstanceId: string): boolean;
  isActiveWorkspace(workspaceId: string): boolean;
  onPreview(resourceId: string, state: PreviewState, instanceId: string | null, generation: number): void;
  onCapture(resourceId: string, capture: PageCapture, instanceId: string | null, generation: number, requestId: string): void;
  onCaptureError(
    resourceId: string,
    requestId: string,
    instanceId: string | null,
    generation: number,
    kind: 'failed' | 'cancelled',
    error: string,
  ): void;
  onBrowserFocus(workspaceId: string, resourceId: string, instanceId: string | null, generation: number): void;
}
export type CaptureListener = (resourceId: string, capture: PageCapture) => void;
