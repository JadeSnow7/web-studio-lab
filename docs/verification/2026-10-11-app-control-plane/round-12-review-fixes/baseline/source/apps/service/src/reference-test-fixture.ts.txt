import type { CatalogReferenceSnapshot } from '@wsl/protocol';
export function emptyReferences(
  sessionId: string,
  workspaceId: string | null = sessionId === 'conv-personal-default' ? null : 'taskflow-demo',
): CatalogReferenceSnapshot {
  return { accountId: 'test-account', sessionId, workspaceId, catalogRevision: 0, resources: [] };
}
