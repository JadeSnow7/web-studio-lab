import { observationSchema, type Task } from './contracts.js';

// This expression runs in the observed page, independently of the product adapter.
export function observationExpression(task: Task): string {
  return `JSON.stringify({url: location.href, runId: new URL(location.href).searchParams.get('runId'), readyState: document.readyState, matches: Array.from(document.querySelectorAll(${JSON.stringify(task.selector)})).map(el => { const rect = el.getBoundingClientRect(); const style = getComputedStyle(el); return {text: el.textContent, visible: rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && Number(style.opacity) > 0 && el.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})}; })})`;
}
export function assertObservation(raw: unknown, task: Task, previewUrl: string): void {
  const observation = observationSchema.parse(raw);
  if (observation.url !== previewUrl || observation.runId !== task.runId || observation.readyState !== 'complete') {
    throw new Error('DOM URL, runId or ready state does not match this run');
  }
  if (observation.matches.length !== 1) throw new Error('Greeting selector must match exactly one element');
}
export function postcondition(raw: unknown, task: Task, previewUrl: string, exceptions: unknown[]): void {
  assertObservation(raw, task, previewUrl);
  const observation = observationSchema.parse(raw);
  if (!observation.matches[0].visible || observation.matches[0].text !== task.expectedText) {
    throw new Error('Greeting must be visible and exactly Hello Web Studio');
  }
  if (exceptions.length !== 0) throw new Error('Runtime exceptions were captured during observation');
}
