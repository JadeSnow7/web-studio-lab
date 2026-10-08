import type { WorkbenchSession, WorkspaceSnapshot, Observation } from '@wsl/protocol';
export function reorderTabIds(ids: string[], source: string, target: string) {
  if (source === target) return ids;
  const next = ids.filter((id) => id !== source);
  next.splice(next.indexOf(target), 0, source);
  return next;
}
export function sessionSelection(session: WorkbenchSession, runs: WorkspaceSnapshot['runs'], versionId: string, runId: string) {
  const own = runs.filter((r) => r.sessionId === session.sessionId);
  const run = runId ? own.find((r) => r.runId === runId) : versionId ? own.filter((r) => r.taskVersionId === versionId).at(-1) : own.at(-1);
  const selectedVersion = runId ? run?.taskVersionId : versionId;
  const version = selectedVersion ? session.taskVersions.find((v) => v.taskVersionId === selectedVersion) : session.taskVersions.at(-1);
  return { run, version, conversation: runId || versionId ? run?.conversation : session.conversation };
}
export type RenderedTerminal = { instanceId: string | null; sessionId: string | null; output: string; offset: number };
export function terminalDelta(previous: RenderedTerminal, next: RenderedTerminal) {
  const changed = previous.instanceId !== next.instanceId || previous.sessionId !== next.sessionId;
  const previousEnd = previous.offset + previous.output.length;
  const nextEnd = next.offset + next.output.length;
  const gap = !changed && next.offset > previousEnd;
  const reset = changed || next.offset < previous.offset || nextEnd < previousEnd || gap;
  return { reset, text: reset ? next.output : next.output.slice(Math.max(0, previousEnd - next.offset)), gap };
}

/** Only raster images are rendered; provider payloads are never treated as HTML or SVG. */
export function observationImage(observation: Observation) {
  const { dataUrl, base64, mediaType } = observation.data;
  if (typeof dataUrl === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) return dataUrl;
  if (
    typeof base64 === 'string' &&
    ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(String(mediaType)) &&
    /^[A-Za-z0-9+/=]+$/.test(base64)
  )
    return `data:${mediaType};base64,${base64}`;
  return null;
}
