import type { WorkbenchTab, WorkspaceSnapshot } from '@wsl/protocol';
/** Page titles are transient projection data; persisted tab names are never changed by navigation. */
export function tabTitle(workspace: WorkspaceSnapshot, tab: WorkbenchTab) {
  return (
    (tab.autoTitle && tab.targetRef.kind === 'web'
      ? workspace.resources.find((resource) => resource.resourceId === tab.targetRef.resourceId)?.preview?.page.title.trim()
      : null) || tab.title
  );
}
