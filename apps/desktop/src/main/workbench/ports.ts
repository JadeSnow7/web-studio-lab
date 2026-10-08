import type {
  ResourceCollection,
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
  environmentsList(): Promise<EnvironmentDescription[]>;
  registerResource(identity: ResourceInstanceIdentity): Promise<void>;
  observe(request: ObservationRequest, signal: AbortSignal): Promise<ObservationResult>;
  registerSession(sessionId: string, workspaceId: string): Promise<void>;
  publicResourcesList(): Promise<ResourceCollection>;
  publicResourcesCapture(resourceId: string, savedResourceId?: string): Promise<ResourceCollection>;
  publicResourcesRemove(savedResourceId: string): Promise<ResourceCollection>;
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
  send(sessionId: string, text: string, scope?: ObservationTurnScope): Promise<ChatConversation>;
  cancel(sessionId: string): Promise<ChatConversation>;
}
export type CaptureListener = (resourceId: string, capture: PageCapture) => void;
