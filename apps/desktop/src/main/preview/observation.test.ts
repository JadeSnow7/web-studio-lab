import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import type { Observation, ObservationResult } from '@wsl/protocol';
import { BrowserObservation } from './observation';

function successful(result: ObservationResult): Observation {
  if ('error' in result) throw new Error(result.error);
  return result;
}
function target(id = 17) {
  const send = vi.fn(async (method: string, _params?: Record<string, unknown>): Promise<Record<string, unknown>> => {
    switch (method) {
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'root-frame', url: 'https://site.test/' }, childFrames: [{ frame: { id: 'child-frame' } }] } };
      case 'Accessibility.getFullAXTree':
        return {
          nodes: [
            { nodeId: 'document', frameId: 'root-frame', backendDOMNodeId: 1, role: { value: 'RootWebArea' } },
            { nodeId: 'input', backendDOMNodeId: 2, role: { value: 'textbox' }, name: { value: 'Draft' }, value: { value: 'unsaved' } },
            { nodeId: 'child', frameId: 'child-frame', backendDOMNodeId: 3, role: { value: 'RootWebArea' } },
          ],
        };
      case 'Accessibility.getPartialAXTree':
        return { nodes: [{ backendDOMNodeId: 2, role: { value: 'textbox' }, value: { value: 'unsaved' } }] };
      case 'DOM.describeNode':
        return { node: { attributes: ['type', 'text', 'onclick', 'forbidden'] } };
      case 'DOM.getBoxModel':
        return { model: { width: 40, height: 20 } };
      case 'DOM.pushNodesByBackendIdsToFrontend':
        return { nodeIds: [22] };
      case 'CSS.getComputedStyleForNode':
        return {
          computedStyle: [
            { name: 'display', value: 'inline-block' },
            { name: 'visibility', value: 'visible' },
            { name: 'color', value: 'rgb(1, 2, 3)' },
            { name: 'background-color', value: 'rgb(255, 255, 255)' },
            { name: 'font-size', value: '16px' },
            { name: 'font-weight', value: '400' },
            { name: 'background-image', value: 'url(secret)' },
          ],
        };
      default:
        return {};
    }
  });
  const debuggerApi = Object.assign(new EventEmitter(), { attach: vi.fn(), isAttached: () => true, sendCommand: send });
  const wc = Object.assign(new EventEmitter(), {
    id,
    debugger: debuggerApi,
    isDestroyed: () => false,
    getURL: () => 'https://site.test/',
    getTitle: () => 'Test',
    isLoading: () => false,
    capturePage: vi.fn<WebContents['capturePage']>(),
  });
  return {
    wc,
    send,
    observer: new BrowserObservation(wc, {
      workspaceId: 'workspace',
      environmentId: 'local',
      resourceId: 'web-' + id,
      kind: 'browser',
      instanceId: 'instance-' + id,
      instanceGeneration: 1,
    }),
  };
}
function firstTextbox(snapshot: Observation) {
  const elements = snapshot.data.elements;
  if (!Array.isArray(elements)) throw new Error('Missing elements');
  const node: unknown = elements.find((element) => element.role === 'textbox');
  if (!node || typeof node !== 'object' || !('ref' in node) || typeof node.ref !== 'string') throw new Error('Missing textbox ref');
  return node.ref;
}
describe('browser frame mapping and fixed CDP style reads', () => {
  it('scopes accessibility to the protocol root frame, exposes child coverage gaps and never guesses foreign refs', async () => {
    const { observer, send } = target();
    const snapshot = successful(await observer.observe('browser.snapshot', {}, 'workspace'));
    expect(send).toHaveBeenCalledWith('Accessibility.getFullAXTree', { frameId: 'root-frame' });
    expect(snapshot.data.frameCoverage).toMatchObject({ coveredFrameIds: ['root-frame'], missingFrameIds: ['child-frame'] });
    expect(snapshot.coverage.range).toEqual(snapshot.data.frameCoverage);
    expect(snapshot.data.elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'textbox', frameId: 'root-frame', frameMappingSource: 'getFullAXTree.frameId' }),
        expect.objectContaining({ frameId: 'child-frame', ref: undefined }),
      ]),
    );
  });
  it('reads only fixed computed styles and the same referenced backend node without executing JavaScript', async () => {
    const { observer, send } = target();
    const snapshot = successful(await observer.observe('browser.snapshot', {}, 'workspace'));
    const ref = firstTextbox(snapshot);
    const query = successful(await observer.observe('browser.query', { ref }, 'workspace'));
    expect(query.data).toMatchObject({
      frameId: 'root-frame',
      value: 'unsaved',
      attributes: { type: 'text' },
      computedStyles: { display: 'inline-block', 'font-size': '16px' },
    });
    expect(query.data.computedStyles).not.toHaveProperty('background-image');
    expect(send).toHaveBeenCalledWith('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [2] });
    expect(send).toHaveBeenCalledWith('CSS.getComputedStyleForNode', { nodeId: 22 });
    expect(send.mock.calls.some(([method]) => method === 'Runtime.evaluate' || method === 'Runtime.callFunctionOn')).toBe(false);
    expect(await observer.observe('browser.query', { ref, javascript: 'alert(1)' }, 'workspace')).toMatchObject({
      error: 'invalid_request',
    });
  });
  it('rejects cross-target and navigation-stale frame refs before querying DOM', async () => {
    const first = target();
    const second = target(18);
    const ref = firstTextbox(successful(await first.observer.observe('browser.snapshot', {}, 'workspace')));
    expect(await second.observer.observe('browser.query', { ref }, 'workspace')).toMatchObject({ error: 'stale_ref' });
    first.wc.emit('did-start-navigation', { url: 'https://site.test/next', isMainFrame: true });
    expect(await first.observer.observe('browser.query', { ref }, 'workspace')).toMatchObject({ error: 'stale_ref' });
    expect(first.send.mock.calls.some(([method]) => method === 'CSS.getComputedStyleForNode')).toBe(false);
  });
  it('reports style access failure as a specific coverage gap while preserving semantic output', async () => {
    const { observer, send } = target();
    const ref = firstTextbox(successful(await observer.observe('browser.snapshot', {}, 'workspace')));
    const original = send.getMockImplementation();
    send.mockImplementation(async (method, params) => {
      if (method === 'CSS.getComputedStyleForNode') throw new Error('node gone');
      return original ? original(method, params) : {};
    });
    const query = successful(await observer.observe('browser.query', { ref }, 'workspace'));
    expect(query.data).toMatchObject({ value: 'unsaved', computedStyles: null });
    expect(query.coverage.reasons).toContain('computed_styles_unavailable_for_node');
  });
});

const browserResource = {
  workspaceId: 'w-a',
  environmentId: 'local',
  resourceId: 'web-stable',
  kind: 'browser' as const,
  instanceId: 'web-instance',
  instanceGeneration: 2,
};
it('returns Main resource identity and releases owned listeners on dispose', async () => {
  const { wc } = target();
  const before = wc.listenerCount('did-start-navigation');
  const observer = new BrowserObservation(wc, browserResource);
  const result = successful(await observer.observe('browser.snapshot', {}, 'w-a'));
  expect(result.resource).toEqual(browserResource);
  observer.dispose();
  expect(wc.listenerCount('did-start-navigation')).toBe(before);
  expect(await observer.observe('browser.snapshot', {}, 'w-a')).toMatchObject({ error: 'unavailable' });
});
it('refuses late browser results after dispose and does not retain late refs', async () => {
  const { wc, send } = target();
  const observer = new BrowserObservation(wc, browserResource);
  let release: (() => void) | undefined;
  const original = send.getMockImplementation();
  send.mockImplementation(async (method, args) => {
    if (method === 'Accessibility.getFullAXTree')
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return original ? original(method, args) : {};
  });
  const pending = observer.observe('browser.snapshot', {}, 'w-a');
  await expect.poll(() => typeof release).toBe('function');
  observer.dispose();
  release?.();
  expect(await pending).toMatchObject({ error: 'unavailable' });
});
it('rejects a different workspace and cancelled browser request', async () => {
  const { wc } = target();
  const observer = new BrowserObservation(wc, browserResource);
  expect(await observer.observe('browser.snapshot', {}, 'w-b')).toMatchObject({ error: 'unauthorized' });
  const cancellation = new AbortController();
  cancellation.abort();
  expect(await observer.observe('browser.snapshot', {}, 'w-a', cancellation.signal)).toMatchObject({ error: 'cancelled' });
  observer.dispose();
});

it('cancellation suppresses an in-flight browser result and stops subsequent CDP reads', async () => {
  const { wc, send } = target();
  const observer = new BrowserObservation(wc, browserResource);
  let release: (() => void) | undefined;
  const original = send.getMockImplementation();
  send.mockImplementation(async (method, args) => {
    if (method === 'Page.getFrameTree')
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return original ? original(method, args) : {};
  });
  const cancellation = new AbortController();
  const pending = observer.observe('browser.snapshot', {}, 'w-a', cancellation.signal);
  await expect.poll(() => typeof release).toBe('function');
  cancellation.abort();
  expect(await pending).toMatchObject({ error: 'cancelled' });
  release?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(send.mock.calls.some(([method]) => method === 'Accessibility.getFullAXTree')).toBe(false);
  observer.dispose();
});
