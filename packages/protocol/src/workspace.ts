import { ObservationRecordSchema, FileInvalidationHintSchema } from './observation';
import { EnvironmentListSchema } from './environments';
import { ResourceCollectionSchema } from './resources';
import { z } from 'zod';
import { ManagedAppSchema } from './managed-app';
import { ChatConversationSchema } from './chat';
import { PageCaptureSchema, PreviewLayoutSchema, PreviewStateSchema } from './preview';
import { TerminalWriteSchema, TerminalSnapshotSchema } from './terminal';

const Id = z.string().min(1).max(200);
export const TargetRefSchema = z.object({ kind: z.enum(['web', 'terminal', 'session', 'ssh', 'file']), resourceId: Id }).strict();
export type TargetRef = z.infer<typeof TargetRefSchema>;
export const WorkbenchTabSchema = z
  .object({
    tabId: Id,
    title: z.string().min(1).max(200),
    pinned: z.boolean(),
    group: z.string().max(100).nullable(),
    targetRef: TargetRefSchema,
  })
  .strict();
export type WorkbenchTab = z.infer<typeof WorkbenchTabSchema>;
export type PaneLayout =
  | { kind: 'pane'; paneId: string; tabId: string | null }
  | { kind: 'split'; direction: 'horizontal' | 'vertical'; ratio: number; first: PaneLayout; second: PaneLayout };
export const PaneLayoutSchema: z.ZodType<PaneLayout> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('pane'), paneId: Id, tabId: Id.nullable() }).strict(),
    z
      .object({
        kind: z.literal('split'),
        direction: z.enum(['horizontal', 'vertical']),
        ratio: z.number().min(0.1).max(0.9),
        first: PaneLayoutSchema,
        second: PaneLayoutSchema,
      })
      .strict(),
  ]),
);
export const WorkbenchTaskVersionSchema = z.object({
  taskVersionId: Id,
  version: z.number().int().positive(),
  workspaceId: Id,
  sessionId: Id,
  goal: z.string().min(1).max(32000),
  targetRef: TargetRefSchema.nullable(),
  capture: PageCaptureSchema.nullable(),
  captureBinding: z
    .object({ appInstanceId: Id, instanceId: Id, generation: z.number().int().nonnegative() })
    .strict()
    .nullable()
    .default(null),
  confirmedAt: z.string(),
  acceptance: z.array(z.string()).default([]),
  allowedScopes: z.array(z.string()).default([]),
});
export const WorkbenchRunSchema = z.object({
  runId: Id,
  workspaceId: Id,
  sessionId: Id,
  taskVersionId: Id,
  targetRef: TargetRefSchema.nullable(),
  state: z.enum(['starting', 'running', 'cancelling', 'completed', 'cancelled', 'failed', 'interrupted']),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  error: z.string().nullable(),
  candidateId: Id,
  validation: z.object({
    state: z.enum(['not_run', 'running', 'passed', 'failed', 'blocked']),
    applicability: z.enum(['current', 'stale', 'unknown']),
    reason: z.string().nullable(),
  }),
  conversation: ChatConversationSchema.nullable().default(null),
  executionBinding: z.object({ generation: z.string(), turnId: z.string().nullable() }).nullable().default(null),
  review: z.object({ decision: z.enum(['accepted', 'changes_requested']), reviewedAt: z.string(), candidateId: Id }).nullable(),
});
export type WorkbenchRun = z.infer<typeof WorkbenchRunSchema>;
export const WorkbenchSessionSchema = z.object({
  sessionId: Id,
  resourceId: Id,
  title: z.string(),
  draft: z.string().max(32000),
  conversation: ChatConversationSchema.nullable(),
  historyRestored: z.boolean().default(false),
  observations: z.array(ObservationRecordSchema).max(200).default([]),
  context: PageCaptureSchema.nullable(),
  captureRequest: z
    .object({
      requestId: Id,
      resourceId: Id,
      state: z.enum(['pending', 'completed', 'failed', 'cancelled']),
      error: z.string().nullable(),
    })
    .nullable()
    .default(null),
  contextTarget: TargetRefSchema.nullable(),
  taskTargetRef: TargetRefSchema.nullable(),
  taskAcceptance: z.array(z.string().trim().min(1).max(2000)).max(50).default([]),
  taskAllowedScopes: z.array(z.string().trim().min(1).max(200)).max(20).default([]),
  contextApplicability: z.enum(['current', 'stale', 'unknown']),
  taskVersions: z.array(WorkbenchTaskVersionSchema),
});
export type WorkbenchSession = z.infer<typeof WorkbenchSessionSchema>;
export const WorkbenchResourceSchema = z.object({
  resourceId: Id,
  environmentId: z.enum(['local', 'sandbox', 'ssh']).nullable(),
  appProjectId: z.uuid().optional(),
  kind: TargetRefSchema.shape.kind,
  title: z.string(),
  url: z.string().nullable(),
  instanceId: Id.nullable(),
  generation: z.number().int().nonnegative(),
  preview: PreviewStateSchema.nullable(),
  terminal: TerminalSnapshotSchema.nullable(),
  unavailableReason: z.string().nullable(),
});
export type WorkbenchResource = z.infer<typeof WorkbenchResourceSchema>;
export const WorkspaceSnapshotSchema = z.object({
  managedApp: ManagedAppSchema.nullable().optional(),
  appExport: z.object({ path: z.string(), manifestPath: z.string().optional(), sha256: z.string() }).nullable().optional(),
  workspaceId: Id,
  name: z.string().min(1).max(200),
  revision: z.number().int().nonnegative(),
  tabs: z.array(WorkbenchTabSchema),
  resources: z.array(WorkbenchResourceSchema),
  layout: PaneLayoutSchema,
  activePaneId: Id,
  sessions: z.array(WorkbenchSessionSchema),
  runs: z.array(WorkbenchRunSchema),
  publicResources: ResourceCollectionSchema.nullable(),
  publicResourcesError: z.string().nullable().default(null),
  fileHints: z.array(FileInvalidationHintSchema).max(100).default([]),
  observations: z.array(ObservationRecordSchema).max(200).default([]),
  theme: z.enum(['light', 'dark', 'warm', 'system']),
});
export type WorkspaceSnapshot = z.infer<typeof WorkspaceSnapshotSchema>;
export const WorkbenchNotificationSchema = z.object({
  notificationId: Id,
  workspaceId: Id,
  sessionId: Id,
  taskVersionId: Id,
  runId: Id,
  kind: z.enum(['completed', 'failed', 'cancelled', 'interrupted']),
  occurredAt: z.string(),
  readAt: z.string().nullable(),
});
export type WorkbenchNotification = z.infer<typeof WorkbenchNotificationSchema>;
export const WorkbenchSnapshotSchema = z.object({
  appInstanceId: Id,
  storageError: z.string().nullable(),
  activeWorkspaceId: Id,
  seq: z.number().int().nonnegative(),
  workspaces: z.array(WorkspaceSnapshotSchema),
  environments: EnvironmentListSchema.default([]),
  notificationReadReceipts: z.array(z.object({ notificationId: Id, readAt: z.string() })).default([]),
  notifications: z.array(WorkbenchNotificationSchema).default([]),
});
export type WorkbenchSnapshot = z.infer<typeof WorkbenchSnapshotSchema>;
const Base = { commandId: Id, workspaceId: Id, expectedRevision: z.number().int().nonnegative().optional() };
const command = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ ...Base, type: z.literal(type), ...shape }).strict();
export const WorkbenchCommandSchema = z.discriminatedUnion('type', [
  command('createApp', {}),
  command('startApp', {}),
  command('stopApp', {}),
  command('exportApp', {}),
  command('createWorkspace', { name: z.string().trim().min(1).max(200) }),
  command('renameWorkspace', { name: z.string().trim().min(1).max(200) }),
  command('switchWorkspace', {}),
  command('createTab', {
    kind: TargetRefSchema.shape.kind,
    environmentId: z.enum(['local', 'sandbox', 'ssh']).optional(),
    title: z.string().trim().min(1).max(200),
    url: z.string().max(2048).optional(),
  }),
  command('openTab', { resourceId: Id }),
  command('locateSession', { sessionId: Id, taskVersionId: Id.optional(), runId: Id.optional() }),
  command('markNotificationRead', { notificationId: Id }),
  command('activateTab', { tabId: Id }),
  command('closeTab', { tabId: Id }),
  command('updateTab', {
    tabId: Id,
    title: z.string().min(1).max(200).optional(),
    pinned: z.boolean().optional(),
    group: z.string().max(100).nullable().optional(),
  }),
  command('reorderTabs', { tabIds: z.array(Id) }),
  command('splitPane', { paneId: Id, direction: z.enum(['horizontal', 'vertical']), tabId: Id.optional() }),
  command('closePane', { paneId: Id }),
  command('focusPane', { paneId: Id }),
  command('setRatio', { paneId: Id, ratio: z.number().min(0.1).max(0.9) }),
  command('setPreferences', {
    theme: WorkspaceSnapshotSchema.shape.theme.optional(),
  }),
  command('saveDraft', { sessionId: Id, draft: z.string().max(32000) }),
  command('saveTaskCriteria', {
    sessionId: Id,
    acceptance: WorkbenchSessionSchema.shape.taskAcceptance.removeDefault(),
    allowedScopes: WorkbenchSessionSchema.shape.taskAllowedScopes.removeDefault(),
  }),
  command('saveTaskTarget', { sessionId: Id, targetRef: TargetRefSchema.nullable() }),
  command('capturePublicResource', { resourceId: Id, savedResourceId: Id.optional() }),
  command('removePublicResource', { savedResourceId: Id }),
  command('captureContext', { sessionId: Id, resourceId: Id, requestId: Id }),
  command('cancelCapture', { resourceId: Id, requestId: Id }),
  command('hideBrowsers', {}),
  command('confirmTask', {
    acceptance: z.array(z.string()).optional(),
    allowedScopes: z.array(z.string()).optional(),
    sessionId: Id,
    goal: z.string().trim().min(1).max(32000),
    targetRef: TargetRefSchema.nullable(),
  }),
  command('startRun', { sessionId: Id, taskVersionId: Id }),
  command('cancelRun', { runId: Id }),
  command('cancelObservation', { sessionId: Id.nullable(), requestId: Id }),
  command('runValidation', { runId: Id }),
  command('recordReview', { runId: Id, candidateId: Id, decision: z.enum(['accepted', 'changes_requested']) }),
  command('browserLayout', { resourceId: Id, layout: PreviewLayoutSchema }),
  command('browserAction', {
    resourceId: Id,
    action: z.enum(['navigate', 'reload', 'back', 'forward', 'focus', 'pick', 'cancelPick', 'reattach']),
    url: z.string().max(2048).optional(),
  }),
  command('terminalOpen', { resourceId: Id, cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(200) }),
  command('terminalWrite', { resourceId: Id, instanceId: Id, data: TerminalWriteSchema.shape.data }),
  command('terminalResize', {
    resourceId: Id,
    instanceId: Id,
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(1).max(200),
  }),
  command('stopInstance', { resourceId: Id, instanceId: Id }),
]);
export type WorkbenchCommand = z.infer<typeof WorkbenchCommandSchema>;
export const WorkbenchErrorSchema = z.object({
  code: z.enum(['unsupported', 'disconnected', 'conflict', 'not_found', 'denied', 'execution_failed', 'invalid_input', 'pane_limit']),
  message: z.string(),
});
export const WorkbenchResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), snapshot: WorkbenchSnapshotSchema }),
  z.object({ ok: z.literal(false), error: WorkbenchErrorSchema, snapshot: WorkbenchSnapshotSchema }),
]);
export type WorkbenchResult = z.infer<typeof WorkbenchResultSchema>;
export const WorkbenchEventSchema = z.object({
  eventId: Id,
  workspaceId: Id,
  entityId: Id,
  occurredAt: z.string(),
  seq: z.number().int().nonnegative(),
  instanceId: Id.nullable(),
  generation: z.number().int().nonnegative(),
  type: z.literal('snapshot'),
  snapshot: WorkbenchSnapshotSchema,
});
export type WorkbenchEvent = z.infer<typeof WorkbenchEventSchema>;
