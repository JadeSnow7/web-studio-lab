import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { CdpState, PageIdentity } from '@wsl/protocol';
import { AgentControlLatch, AppUiDriver } from './app-ui';
import { AppControlFailure } from '../workbench/app-control-failure';

const code = async (work: Promise<unknown>) => {
  try {
    await work;
    return 'ok';
  } catch (error) {
    return error instanceof AppControlFailure ? error.code : String(error);
  }
};

describe('AgentControlLatch', () => {
  it('pauses on user input outside AI dispatch, ignores input inside the dispatch window, resumes only explicitly', async () => {
    let now = 1000;
    const changed = vi.fn();
    const latch = new AgentControlLatch(changed, () => now);
    latch.observeInput('mouseDown');
    expect(latch.state().state).toBe('idle');
    latch.begin('run-1', 'click');
    expect(latch.state()).toMatchObject({ state: 'active', runId: 'run-1', lastAction: 'click' });
    await latch.dispatch('run-1', async () => latch.observeInput('mouseDown'));
    latch.observeInput('keyDown');
    expect(latch.state().state).toBe('active');
    latch.observeInput('mouseWheel');
    latch.observeInput('mouseMove');
    now += 1000;
    expect(latch.state().state).toBe('active');
    latch.observeInput('mouseDown');
    expect(latch.state().state).toBe('paused_by_user');
    expect(() => latch.begin('run-1', 'type')).toThrow(AppControlFailure);
    await expect(latch.dispatch('run-1', async () => 'x')).rejects.toMatchObject({ code: 'paused_by_user' });
    // 新 run 不继承旧 run 的暂停。
    expect(() => latch.assertNotPaused('run-2')).not.toThrow();
    latch.resume();
    expect(latch.state().state).toBe('active');
    latch.release('run-other');
    expect(latch.state().state).toBe('active');
    latch.release('run-1');
    expect(latch.state()).toEqual({ state: 'idle', runId: null, since: null, lastAction: null });
    expect(changed).toHaveBeenCalled();
  });
});

function fakePage() {
  let generation = 1;
  let cdp: CdpState = { state: 'attached' };
  let picking = false;
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  let hit = 11;
  let offset = { pageX: 0, pageY: 0 };
  let descendantHit = false;
  let coordinateHit = false;
  let width = 800;
  let quad = [10, 10, 30, 10, 30, 20, 10, 20];
  let reordered = false;
  let bridgeValue: unknown = JSON.stringify({ ok: true, data: { version: 1, commands: [], states: [] } });
  let testidMatches = [11];
  let replyGate: { method: string; type?: string; remaining: number; wait: Promise<void> } | null = null;
  const send = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push({ method, params });
    // Freeze the observed hit before delaying its delivery, so a later scroll cannot manufacture an overlay failure.
    const observedHit = coordinateHit && (params?.x !== 20 + offset.pageX || params?.y !== 15 + offset.pageY) ? 99 : hit;
    if (replyGate?.method === method && (replyGate.type === undefined || replyGate.type === params?.type))
      if (--replyGate.remaining <= 0) await replyGate.wait;
    switch (method) {
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'root' } } };
      case 'Accessibility.getFullAXTree':
        return {
          nodes: [
            { backendDOMNodeId: 10, role: { value: 'RootWebArea' } },
            { backendDOMNodeId: 11, role: { value: 'button' }, name: { value: reordered ? '删除欢迎语' : '保存欢迎语' } },
            { backendDOMNodeId: 12, role: { value: 'textbox' }, name: { value: '欢迎语' } },
          ],
        };
      case 'DOM.getDocument':
        return params?.depth === 0
          ? { root: { nodeId: 1 } }
          : {
              root: {
                backendNodeId: 10,
                nodeType: 9,
                nodeName: '#document',
                children: [
                  {
                    backendNodeId: 11,
                    nodeType: 1,
                    nodeName: 'BUTTON',
                    attributes: ['data-testid', reordered ? 'welcome-delete' : 'welcome-save'],
                  },
                  {
                    backendNodeId: 12,
                    nodeType: 1,
                    nodeName: 'INPUT',
                    attributes: ['data-testid', reordered ? 'welcome-save' : 'welcome-input'],
                  },
                ],
              },
            };
      case 'DOM.querySelectorAll':
        return { nodeIds: testidMatches.map((id) => id + 100) };
      case 'DOM.describeNode':
        return { node: { backendNodeId: Number(params?.nodeId) - 100 } };
      case 'DOM.resolveNode':
        return { object: { objectId: `obj-${String(params?.backendNodeId)}` } };
      case 'Runtime.callFunctionOn': {
        const declaration = String(params?.functionDeclaration);
        if (declaration.includes('__WSL_AGENT__')) return { result: { value: bridgeValue } };
        if (declaration.includes('getBoundingClientRect'))
          return {
            result: { value: { visible: true, disabled: false, text: params?.objectId === 'obj-11' ? '保存欢迎语' : '', value: null } },
          };
        if (declaration.includes('contains')) return { result: { value: descendantHit } };
        return { result: { value: true } };
      }
      case 'Runtime.evaluate':
        return { result: { objectId: 'global' } };
      case 'DOM.getContentQuads':
        return { quads: [quad] };
      case 'Page.getLayoutMetrics':
        return { cssLayoutViewport: { ...offset, clientWidth: width, clientHeight: 600 } };
      case 'DOM.getNodeForLocation':
        return { backendNodeId: observedHit };
      default:
        return {};
    }
  });
  const debuggerApi = Object.assign(new EventEmitter(), { attach: vi.fn(), isAttached: () => cdp.state === 'attached', sendCommand: send });
  const wc = Object.assign(new EventEmitter(), {
    id: 7,
    debugger: debuggerApi,
    isDestroyed: () => false,
    getURL: () => 'http://127.0.0.1:49152/',
    getTitle: () => 'App',
    isLoading: () => false,
    capturePage: vi.fn(),
  });
  const latch = new AgentControlLatch(() => undefined);
  const page = {
    identity: (): PageIdentity => ({
      webContentsId: 7,
      documentGeneration: generation,
      url: 'http://127.0.0.1:49152/',
      title: 'App',
      partition: 'p',
    }),
    cdp: () => cdp,
    picking: () => picking,
  };
  const driver = new AppUiDriver(wc as never, page, latch);
  return {
    driver,
    reorder: () => {
      reordered = true;
    },
    failNextSnapshot: () => {
      send.mockRejectedValueOnce(new Error('CDP snapshot failed'));
    },
    gateReply: (method: string, type?: string, remaining = 1) => {
      let open!: () => void;
      replyGate = { method, type, remaining, wait: new Promise<void>((resolve) => (open = resolve)) };
      return () => {
        replyGate = null;
        open();
      };
    },
    wc,
    latch,
    calls,
    navigate: () => {
      generation++;
      wc.emit('did-navigate');
    },
    detach: () => {
      cdp = { state: 'detached', reason: 'devtools' };
      debuggerApi.emit('detach', {}, 'devtools');
    },
    setHit: (value: number) => (hit = value),
    setWidth: (value: number) => (width = value),
    shiftQuad: () => {
      quad = quad.map((value) => value + 1);
    },
    setOffset: (pageX: number, pageY: number) => {
      offset = { pageX, pageY };
      coordinateHit = true;
    },
    setDescendantHit: () => {
      hit = 13;
      descendantHit = true;
    },
    setPicking: (value: boolean) => (picking = value),
    setBridge: (value: unknown) => (bridgeValue = value),
    setTestidMatches: (value: number[]) => (testidMatches = value),
  };
}

describe('AppUiDriver screenshot', () => {
  const validPng = () =>
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=', 'base64');
  function fixture({ empty = false, width = 1, height = 1, png = validPng() } = {}) {
    const page = fakePage();
    const image = {
      isEmpty: vi.fn(() => empty),
      getSize: vi.fn(() => ({ width, height })),
      toPNG: vi.fn(() => png),
    };
    page.wc.capturePage.mockResolvedValue(image);
    return { ...page, image, png };
  }

  it('rejects an empty NativeImage without encoding it or retrying capture', async () => {
    const { driver, wc, image } = fixture({ empty: true });
    await expect(driver.screenshot()).rejects.toMatchObject({ code: 'unavailable' });
    expect(image.toPNG).not.toHaveBeenCalled();
    expect(wc.capturePage).toHaveBeenCalledOnce();
  });

  it.each([
    { width: 0, height: 1 },
    { width: 1, height: 0 },
    { width: 0, height: 0 },
    { width: -1, height: 1 },
    { width: 1, height: -1 },
  ])('rejects invalid dimensions $width × $height before encoding', async (size) => {
    const { driver, image } = fixture(size);
    await expect(driver.screenshot()).rejects.toMatchObject({ code: 'unavailable' });
    expect(image.toPNG).not.toHaveBeenCalled();
  });

  it('rejects a nonempty image whose PNG encoding is empty', async () => {
    const { driver, wc, image } = fixture({ png: Buffer.alloc(0) });
    await expect(driver.screenshot()).rejects.toMatchObject({ code: 'unavailable' });
    expect(image.toPNG).toHaveBeenCalledOnce();
    expect(wc.capturePage).toHaveBeenCalledOnce();
  });

  it('returns the original PNG bytes from a valid image', async () => {
    const { driver, wc, image, png } = fixture();
    await expect(driver.screenshot()).resolves.toBe(png);
    expect(image.toPNG).toHaveBeenCalledOnce();
    expect(wc.capturePage).toHaveBeenCalledOnce();
  });

  it('preserves the inclusive 4,000,000-byte budget boundary', async () => {
    const { driver, png } = fixture({ png: Buffer.alloc(4_000_000) });
    await expect(driver.screenshot()).resolves.toBe(png);
  });

  it('preserves budget_exceeded for PNG output above 4,000,000 bytes', async () => {
    const { driver } = fixture({ png: Buffer.alloc(4_000_001) });
    await expect(driver.screenshot()).rejects.toMatchObject({ code: 'budget_exceeded' });
  });
});

describe('AppUiDriver', () => {
  it('new snapshot invalidates Save ref before dispatch when the same document reuses e1 for Delete', async () => {
    const page = fakePage();
    const first = await page.driver.snapshot('app-1', { limit: 200, includeHidden: false });
    page.reorder();
    const second = await page.driver.snapshot('app-1', { limit: 200, includeHidden: false });
    expect(second.documentGeneration).toBe(first.documentGeneration);
    expect(second.elements[0]!.testid).toBe('welcome-delete');
    const before = page.calls.length;
    expect(
      await code(
        page.driver.act({ type: 'click', target: { ref: 'e1', snapshotId: first.snapshotId } }, { runId: 'r', documentGeneration: 1 }),
      ),
    ).toBe('stale_ref');
    expect(page.calls.slice(before).some((call) => call.method.startsWith('Input.'))).toBe(false);
    expect(
      await code(
        page.driver.act({ type: 'click', target: { ref: 'e1', snapshotId: second.snapshotId } }, { runId: 'r', documentGeneration: 1 }),
      ),
    ).toBe('ok');
  });
  it('cancellation while releasing snapshot objects preserves the previous successful table', async () => {
    const page = fakePage();
    const first = await page.driver.snapshot('app-1', { limit: 200, includeHidden: false });
    const open = page.gateReply('Runtime.releaseObjectGroup');
    const controller = new AbortController();
    const pending = page.driver.snapshot('app-1', { limit: 200, includeHidden: false }, controller.signal);
    await vi.waitFor(() => expect(page.calls.filter((call) => call.method === 'Runtime.releaseObjectGroup')).toHaveLength(2));
    controller.abort();
    open();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    expect(
      await code(
        page.driver.act({ type: 'click', target: { ref: 'e1', snapshotId: first.snapshotId } }, { runId: 'r', documentGeneration: 1 }),
      ),
    ).toBe('ok');
  });
  it.each(['failure', 'cancel'])('a %s snapshot preserves the last successful ref table', async (change) => {
    const page = fakePage();
    const snapshot = await page.driver.snapshot('app-1', { limit: 200, includeHidden: false });
    const controller = new AbortController();
    if (change === 'failure') {
      page.failNextSnapshot();
      await expect(page.driver.snapshot('app-1', { limit: 200, includeHidden: false })).rejects.toThrow('CDP snapshot failed');
    } else {
      const open = page.gateReply('Runtime.callFunctionOn', undefined, 2);
      const pending = page.driver.snapshot('app-1', { limit: 200, includeHidden: false }, controller.signal);
      await vi.waitFor(() => expect(page.calls.filter((call) => call.method === 'Runtime.callFunctionOn').length).toBeGreaterThan(3));
      controller.abort();
      open();
      await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    }
    expect(
      await code(
        page.driver.act({ type: 'click', target: { ref: 'e1', snapshotId: snapshot.snapshotId } }, { runId: 'r', documentGeneration: 1 }),
      ),
    ).toBe('ok');
  });

  it('snapshot returns short refs with testids; navigation invalidates them', async () => {
    const page = fakePage();
    const snapshot = await page.driver.snapshot('app-1', { limit: 200, includeHidden: false });
    expect(snapshot.documentGeneration).toBe(1);
    expect(snapshot.elements.map((element) => [element.ref, element.role, element.testid])).toEqual([
      ['e1', 'button', 'welcome-save'],
      ['e2', 'textbox', 'welcome-input'],
    ]);
    expect(snapshot.elements[0]!.text).toBe('保存欢迎语');
    expect(
      await code(
        page.driver.act({ type: 'click', target: { ref: 'e1', snapshotId: snapshot.snapshotId } }, { runId: 'r', documentGeneration: 1 }),
      ),
    ).toBe('ok');
    page.navigate();
    expect(
      await code(
        page.driver.act({ type: 'click', target: { ref: 'e1', snapshotId: snapshot.snapshotId } }, { runId: 'r', documentGeneration: 1 }),
      ),
    ).toBe('stale_document');
    expect(
      await code(
        page.driver.act({ type: 'click', target: { ref: 'e1', snapshotId: snapshot.snapshotId } }, { runId: 'r', documentGeneration: 2 }),
      ),
    ).toBe('stale_ref');
  });
  it('click coordinates come from the box model and an obscuring hit is refused', async () => {
    const page = fakePage();
    expect(await code(page.driver.act({ type: 'click', target: { testid: 'welcome-save' } }, { runId: 'r', documentGeneration: 1 }))).toBe(
      'ok',
    );
    const presses = page.calls.filter((call) => call.method === 'Input.dispatchMouseEvent');
    expect(presses.map((call) => [call.params?.type, call.params?.x, call.params?.y])).toEqual([
      ['mouseMoved', 20, 15],
      ['mousePressed', 20, 15],
      ['mouseReleased', 20, 15],
    ]);
    page.setHit(99);
    const before = page.calls.length;
    expect(await code(page.driver.act({ type: 'click', target: { testid: 'welcome-save' } }, { runId: 'r', documentGeneration: 1 }))).toBe(
      'element_obscured',
    );
    expect(page.calls.slice(before).some((call) => call.method === 'Input.dispatchMouseEvent')).toBe(false);
  });
  it.each([
    [0, 320],
    [180, 0],
    [-80, 320],
  ])('hit-tests document coordinates after scrolling %s/%s but clicks viewport coordinates', async (x, y) => {
    const page = fakePage();
    page.setOffset(x, y);
    expect(await code(page.driver.act({ type: 'click', target: { testid: 'welcome-save' } }, { runId: 'r', documentGeneration: 1 }))).toBe(
      'ok',
    );
    expect(page.calls.find((call) => call.method === 'DOM.getNodeForLocation')?.params).toMatchObject({ x: 20 + x, y: 15 + y });
    expect(page.calls.filter((call) => call.method === 'Input.dispatchMouseEvent').map((call) => [call.params?.x, call.params?.y])).toEqual(
      [
        [20, 15],
        [20, 15],
        [20, 15],
      ],
    );
  });
  it('accepts a descendant at the document point but rejects a scrolled overlay without input', async () => {
    const page = fakePage();
    page.setOffset(100, 320);
    page.setDescendantHit();
    expect(await code(page.driver.act({ type: 'click', target: { testid: 'welcome-save' } }, { runId: 'r', documentGeneration: 1 }))).toBe(
      'ok',
    );
    const overlay = fakePage();
    overlay.setOffset(100, 320);
    overlay.setHit(99);
    expect(
      await code(overlay.driver.act({ type: 'click', target: { testid: 'welcome-save' } }, { runId: 'r', documentGeneration: 1 })),
    ).toBe('element_obscured');
    expect(overlay.calls.some((call) => call.method.startsWith('Input.'))).toBe(false);
  });
  it.each(['cancel', 'navigate', 'detach', 'pause'])('click stops after delayed layout metrics and %s', async (change) => {
    const page = fakePage();
    const open = page.gateReply('Page.getLayoutMetrics');
    const controller = new AbortController();
    const pending = code(
      page.driver.act({ type: 'click', target: { testid: 'welcome-save' } }, { runId: 'r', documentGeneration: 1 }, controller.signal),
    );
    await vi.waitFor(() => expect(page.calls.some((call) => call.method === 'Page.getLayoutMetrics')).toBe(true));
    if (change === 'cancel') controller.abort();
    if (change === 'navigate') page.navigate();
    if (change === 'detach') page.detach();
    if (change === 'pause') page.latch.observeInput('mouseDown');
    open();
    expect(await pending).toBe(
      change === 'cancel'
        ? 'cancelled'
        : change === 'navigate'
          ? 'stale_document'
          : change === 'detach'
            ? 'cdp_detached'
            : 'paused_by_user',
    );
    expect(page.calls.some((call) => call.method.startsWith('Input.'))).toBe(false);
    expect(page.calls.some((call) => call.method === 'DOM.getNodeForLocation')).toBe(false);
  });
  it.each(['scroll', 'resize', 'move'])('refuses %s between geometry and hit verification without dispatching input', async (change) => {
    const page = fakePage();
    page.setOffset(0, 320);
    const open = page.gateReply('DOM.getNodeForLocation');
    const pending = code(page.driver.act({ type: 'click', target: { testid: 'welcome-save' } }, { runId: 'r', documentGeneration: 1 }));
    await vi.waitFor(() => expect(page.calls.some((call) => call.method === 'DOM.getNodeForLocation')).toBe(true));
    if (change === 'scroll') page.setOffset(0, 420);
    if (change === 'resize') page.setWidth(600);
    if (change === 'move') page.shiftQuad();
    open();
    expect(await pending).toBe('element_obscured');
    expect(page.calls.some((call) => call.method.startsWith('Input.'))).toBe(false);
  });
  it('ambiguous or missing testids, picking, pauses and CDP detach are refused before input dispatch', async () => {
    const page = fakePage();
    page.setTestidMatches([11, 12]);
    expect(await code(page.driver.act({ type: 'click', target: { testid: 'welcome-save' } }, { runId: 'r', documentGeneration: 1 }))).toBe(
      'ambiguous_target',
    );
    page.setTestidMatches([]);
    expect(await code(page.driver.act({ type: 'click', target: { testid: 'welcome-save' } }, { runId: 'r', documentGeneration: 1 }))).toBe(
      'element_not_found',
    );
    page.setTestidMatches([11]);
    page.setPicking(true);
    expect(await code(page.driver.act({ type: 'press', key: 'Enter' }, { runId: 'r', documentGeneration: 1 }))).toBe('paused_by_user');
    page.setPicking(false);
    page.latch.begin('r', 'x');
    page.latch.observeInput('mouseDown');
    expect(await code(page.driver.act({ type: 'press', key: 'Enter' }, { runId: 'r', documentGeneration: 1 }))).toBe('paused_by_user');
    page.detach();
    expect(await code(page.driver.act({ type: 'press', key: 'Enter' }, { runId: 'r2', documentGeneration: 1 }))).toBe('cdp_detached');
    expect(page.calls.some((call) => call.method.startsWith('Input.'))).toBe(false);
  });
  it('type focuses, clears and inserts text through CDP input without focusing the window', async () => {
    const page = fakePage();
    await page.driver.act(
      { type: 'type', target: { testid: 'welcome-input' }, text: '固定验收 2026', clear: true },
      { runId: 'r', documentGeneration: 1 },
    );
    const methods = page.calls.map((call) => call.method);
    expect(methods).toContain('Emulation.setFocusEmulationEnabled');
    expect(methods.indexOf('DOM.focus')).toBeLessThan(methods.indexOf('Input.insertText'));
    expect(page.calls.find((call) => call.method === 'Input.insertText')?.params).toEqual({ text: '固定验收 2026' });
  });
  it('bridge calls a fixed function with the request only as a JSON argument and validates the response', async () => {
    const page = fakePage();
    expect(await page.driver.bridge({ op: 'describe' })).toEqual({ ok: true, data: { version: 1, commands: [], states: [] } });
    const call = page.calls.find(
      (entry) => entry.method === 'Runtime.callFunctionOn' && String(entry.params?.functionDeclaration).includes('__WSL_AGENT__'),
    )!;
    expect(call.params?.arguments).toEqual([{ value: JSON.stringify({ op: 'describe' }) }]);
    expect(page.calls.find((entry) => entry.method === 'Runtime.evaluate')?.params?.expression).toBe('globalThis');
    page.setBridge(JSON.stringify({ ok: false, error: { code: 'invalid_request', message: 'bridge_unavailable' } }));
    expect(await code(page.driver.bridge({ op: 'describe' }))).toBe('bridge_unavailable');
    page.setBridge('{"ok":"yes"}');
    expect(await code(page.driver.bridge({ op: 'describe' }))).toBe('bridge_unavailable');
    page.setBridge(42);
    expect(await code(page.driver.bridge({ op: 'describe' }))).toBe('bridge_unavailable');
  });
  it.each(['cancel', 'navigate', 'detach'])('click stops before mousePressed after delayed mouseMoved and %s', async (change) => {
    const page = fakePage();
    const open = page.gateReply('Input.dispatchMouseEvent', 'mouseMoved');
    const controller = new AbortController();
    const pending = code(
      page.driver.act({ type: 'click', target: { testid: 'welcome-save' } }, { runId: 'r', documentGeneration: 1 }, controller.signal),
    );
    await vi.waitFor(() => expect(page.calls.some((call) => call.params?.type === 'mouseMoved')).toBe(true));
    if (change === 'cancel') controller.abort();
    if (change === 'navigate') page.navigate();
    if (change === 'detach') page.detach();
    open();
    const result = await pending;
    expect(page.calls.filter((call) => call.method === 'Input.dispatchMouseEvent').map((call) => call.params?.type)).toEqual([
      'mouseMoved',
    ]);
    expect(result).toBe(change === 'cancel' ? 'cancelled' : change === 'navigate' ? 'stale_document' : 'cdp_detached');
  });
  it('cancellation after mousePressed still releases the button before reporting cancelled', async () => {
    const page = fakePage();
    const open = page.gateReply('Input.dispatchMouseEvent', 'mousePressed');
    const controller = new AbortController();
    const pending = code(
      page.driver.act({ type: 'click', target: { testid: 'welcome-save' } }, { runId: 'r', documentGeneration: 1 }, controller.signal),
    );
    await vi.waitFor(() => expect(page.calls.some((call) => call.params?.type === 'mousePressed')).toBe(true));
    controller.abort();
    open();
    expect(await pending).toBe('cancelled');
    expect(page.calls.filter((call) => call.method === 'Input.dispatchMouseEvent').map((call) => call.params?.type)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
    ]);
  });
  it.each(['cancel', 'pause'])('type stops after delayed focus and %s without selecting or inserting text', async (change) => {
    const page = fakePage();
    const open = page.gateReply('DOM.focus');
    const controller = new AbortController();
    const pending = code(
      page.driver.act(
        { type: 'type', target: { testid: 'welcome-input' }, text: 'new', clear: true },
        { runId: 'r', documentGeneration: 1 },
        controller.signal,
      ),
    );
    await vi.waitFor(() => expect(page.calls.some((call) => call.method === 'DOM.focus')).toBe(true));
    if (change === 'cancel') controller.abort();
    else page.latch.observeInput('mouseDown');
    open();
    const result = await pending;
    expect(
      page.calls.some(
        (call) => String(call.params?.functionDeclaration).includes('selectNodeContents') || call.method === 'Input.insertText',
      ),
    ).toBe(false);
    expect(result).toBe(change === 'cancel' ? 'cancelled' : 'paused_by_user');
  });
  it.each(['query', 'bridge'])('rejects %s when navigation occurs during object cleanup', async (operation) => {
    const page = fakePage();
    const open = page.gateReply('Runtime.releaseObjectGroup');
    const pending = code(operation === 'query' ? page.driver.query({ testid: 'welcome-save' }) : page.driver.bridge({ op: 'state' }));
    await vi.waitFor(() => expect(page.calls.some((call) => call.method === 'Runtime.releaseObjectGroup')).toBe(true));
    page.navigate();
    open();
    expect(await pending).toBe('stale_document');
  });
  it.each(['navigate', 'cancel', 'detach'])('rejects a late element query after %s', async (change) => {
    const page = fakePage();
    const open = page.gateReply('Runtime.callFunctionOn');
    const controller = new AbortController();
    const pending = code(page.driver.query({ testid: 'welcome-save' }, controller.signal));
    await vi.waitFor(() => expect(page.calls.some((call) => call.method === 'Runtime.callFunctionOn')).toBe(true));
    if (change === 'navigate') page.navigate();
    if (change === 'cancel') controller.abort();
    if (change === 'detach') page.detach();
    open();
    expect(await pending).toBe(change === 'navigate' ? 'stale_document' : change === 'cancel' ? 'cancelled' : 'cdp_detached');
  });
  it.each(['navigate', 'cancel', 'detach'])('rejects a late bridge response after %s', async (change) => {
    const page = fakePage();
    const open = page.gateReply('Runtime.callFunctionOn');
    const controller = new AbortController();
    const pending = code(page.driver.bridge({ op: 'state' }, controller.signal));
    await vi.waitFor(() => expect(page.calls.some((call) => call.method === 'Runtime.callFunctionOn')).toBe(true));
    if (change === 'navigate') page.navigate();
    if (change === 'cancel') controller.abort();
    if (change === 'detach') page.detach();
    open();
    expect(await pending).toBe(change === 'navigate' ? 'stale_document' : change === 'cancel' ? 'cancelled' : 'cdp_detached');
  });
  it('cancelled bridge never invokes the command after a delayed global-object read', async () => {
    const page = fakePage();
    const open = page.gateReply('Runtime.evaluate');
    const controller = new AbortController();
    const pending = code(page.driver.bridge({ op: 'invoke', name: 'health.refresh', input: {} }, controller.signal));
    await vi.waitFor(() => expect(page.calls.some((call) => call.method === 'Runtime.evaluate')).toBe(true));
    controller.abort();
    open();
    expect(await pending).toBe('cancelled');
    expect(page.calls.some((call) => call.method === 'Runtime.callFunctionOn')).toBe(false);
  });
  it.each(['hidden', 'detached'])('waitFor %s preserves a detached CDP failure instead of accepting absence', async (state) => {
    const page = fakePage();
    page.detach();
    expect(await code(page.driver.waitFor({ testid: 'welcome-save' }, state, 20))).toBe('cdp_detached');
  });
  it('navigate only targets the current origin', async () => {
    const page = fakePage();
    await page.driver.act({ type: 'navigate', path: '/welcome?x=1' }, { runId: 'r', documentGeneration: 1 });
    expect(page.calls.find((call) => call.method === 'Page.navigate')?.params).toEqual({ url: 'http://127.0.0.1:49152/welcome?x=1' });
  });
});
