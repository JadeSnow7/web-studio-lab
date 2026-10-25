import type { EnvironmentDescription, WorkbenchTab } from '@wsl/protocol';
type Kind = WorkbenchTab['targetRef']['kind'];
export function supportsEnvironment(environment: EnvironmentDescription, kind: Kind) {
  return (
    environment.state === 'configured' &&
    (kind === 'file' ? environment.capabilities.files : environment.capabilities.terminal) &&
    (kind !== 'ssh' || environment.environmentId === 'ssh')
  );
}
const key = (workspaceId: string, kind: Kind) => `wsl.default-environment:${encodeURIComponent(workspaceId)}:${kind}`;
export function readEnvironmentPreference(storage: Pick<Storage, 'getItem'>, workspaceId: string, kind: Kind) {
  const value = storage.getItem(key(workspaceId, kind));
  return value;
}
export function rememberEnvironment(storage: Pick<Storage, 'setItem'>, workspaceId: string, kind: Kind, environmentId: string) {
  storage.setItem(key(workspaceId, kind), environmentId);
}
export function defaultEnvironment(environments: EnvironmentDescription[], kind: Kind, preference: string | null) {
  const available = environments.filter((environment) => supportsEnvironment(environment, kind));
  // An invalid prior choice must be repaired explicitly, even when another environment is now the only candidate.
  if (preference !== null && !available.some((environment) => environment.environmentId === preference)) return undefined;
  return available.length === 1 ? available[0] : available.find((environment) => environment.environmentId === preference);
}
