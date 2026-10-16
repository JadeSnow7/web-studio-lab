import type { TargetRef, WorkbenchRun, WorkbenchSession, WorkspaceSnapshot } from '@wsl/protocol';

type ResearchWorkspace = Pick<WorkspaceSnapshot, 'workspaceId' | 'managedApp' | 'resources'>;
type WorkbenchTaskVersion = WorkbenchSession['taskVersions'][number];

/** UI eligibility only; Main owns authorization and rechecks the frozen App binding. */
export function researchDraftEligible(workspace: ResearchWorkspace, target: TargetRef | null): boolean {
  const app = workspace.managedApp;
  return !!(
    app?.profile?.projectKind === 'standard-app' &&
    app.workspaceId === workspace.workspaceId &&
    app.state === 'running' &&
    app.appInstanceId &&
    target?.kind === 'web' &&
    workspace.resources.some(
      (resource) =>
        resource.resourceId === target.resourceId &&
        resource.kind === 'web' &&
        resource.appProjectId === app.projectId &&
        resource.environmentId === app.environmentId &&
        resource.instanceId,
    )
  );
}

export function researchVersionEligible(workspace: ResearchWorkspace, version: WorkbenchTaskVersion | undefined): boolean {
  return !!(
    version &&
    !version.eduTask &&
    !version.motaTask &&
    version.workspaceId === workspace.workspaceId &&
    version.appTarget?.workspaceId === workspace.workspaceId &&
    version.appTarget.projectId === workspace.managedApp?.projectId &&
    researchDraftEligible(workspace, version.targetRef)
  );
}

export type ResearchSubmission = { enabled: boolean; context: string; revision: number };

/** A consumed opt-in cannot survive navigation, cancellation, or a changed App target. */
export function researchSubmissionEnabled(
  submission: ResearchSubmission,
  current: Pick<ResearchSubmission, 'context' | 'revision'>,
  eligible: boolean,
  currentNavigation: boolean,
): boolean {
  return (
    submission.enabled &&
    eligible &&
    currentNavigation &&
    submission.context === current.context &&
    submission.revision === current.revision
  );
}

type ResearchRun = Pick<
  WorkbenchRun,
  'workspaceId' | 'sessionId' | 'taskVersionId' | 'runId' | 'researchSummary' | 'conversation' | 'executionBinding'
>;

const searchLabels = {
  in_progress: '搜索中',
  completed: '搜索已完成',
  failed: '搜索失败',
  unknown: '搜索状态未确认',
} as const;

/** Native search candidates, frozen captures and committed inclusions are separate facts. */
export function researchSummaryPresentation(run: ResearchRun) {
  const summary = run.researchSummary;
  const matches =
    !summary ||
    (summary.grant.workspaceId === run.workspaceId &&
      summary.grant.sessionId === run.sessionId &&
      summary.grant.taskVersionId === run.taskVersionId &&
      summary.grant.runId === run.runId);
  const captures = matches ? (summary?.captures ?? []) : [];
  const inclusions = matches ? (summary?.inclusions ?? []) : [];
  const searches = run.conversation?.nativeSearches ?? [];
  const ownSearches = searches.filter(
    (search) =>
      !!run.executionBinding?.turnId &&
      run.executionBinding.generation === run.conversation?.generation &&
      search.turnId === run.executionBinding.turnId,
  );
  const sources = captures.map((capture) => ({
    ...capture,
    included: inclusions.some((item) => item.captureId === capture.captureId && item.contentSha256 === capture.contentSha256),
  }));
  const unmatchedInclusion = inclusions.some(
    (item) => !captures.some((capture) => capture.captureId === item.captureId && capture.contentSha256 === item.contentSha256),
  );
  const incomplete =
    !matches ||
    unmatchedInclusion ||
    searches.length !== ownSearches.length ||
    !!run.conversation?.nativeSearchesTruncated ||
    ownSearches.some((search) => search.schemaUnsupported || search.truncated || search.status === 'unknown');
  if (!summary && !searches.length && !incomplete) return null;
  return {
    sources,
    includedCount: sources.filter((source) => source.included).length,
    searches: ownSearches.map((search) => ({ ...search, label: searchLabels[search.status] })),
    incomplete,
  };
}
