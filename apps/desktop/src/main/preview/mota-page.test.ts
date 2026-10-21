import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppToolInputSchemas, MotaControlRequestSchema, MotaStateSchema, type MotaState } from '@wsl/protocol';
import { AppControlFailure } from '../workbench/app-control-failure';
import { MOTA_STATE_EXPRESSION, MotaPageDriver, motaTilePoint, type MotaPagePort } from './mota-page';

function snapshot(): MotaState {
  return {
    appInstanceId: 'app',
    documentGeneration: 2,
    played: true,
    floorId: 'MT1',
    hero: { x: 6, y: 11, hp: 1000, atk: 20, def: 10, money: 4, coin: 1, keys: { yellow: 2, blue: 3, red: 4 } },
    moving: false,
    locked: false,
    event: { id: null, type: null },
    dialogue: null,
    map: { width: 13, height: 13, blocks: [{ x: 2, y: 3, id: 53, eventId: 'coin', disabled: false }], truncated: false },
    canvas: {
      rect: { x: 100, y: 20, width: 208, height: 208 },
      viewport: { width: 800, height: 600 },
      logicalWidth: 416,
      logicalHeight: 416,
      offsetX: 0,
      offsetY: 0,
      scale: 0.5,
    },
  };
}
function fixture() {
  const status = {
    generation: 2,
    epoch: 4,
    navigations: 1,
    detached: false,
    picking: false,
    loading: false,
    url: 'http://127.0.0.1:54321/',
  };
  let state = snapshot();
  let mapAtLoad = state.map;
  let persistedMap = state.map;
  let clickCompletesGame = true;
  let canvasQuad = [100, 20, 308, 20, 308, 228, 100, 228];
  let paused = false,
    hit = 20,
    unavailable = 0;
  const calls: { method: string; params?: Record<string, unknown> }[] = [];
  let onSend: (method: string, params?: Record<string, unknown>) => void = () => {};
  const port: MotaPagePort = {
    attach: vi.fn(async () => {}),
    current: () => ({ ...status }),
    gate: {
      begin: vi.fn(),
      assertNotPaused: () => {
        if (paused) throw new AppControlFailure('paused_by_user', 'paused');
      },
      dispatch: async (_runId, work) => work(),
    },
    async send<T>(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params });
      onSend(method, params);
      let response: unknown = {};
      if (method === 'Runtime.evaluate') {
        expect(params?.expression).toBe(MOTA_STATE_EXPRESSION);
        const { appInstanceId: _app, documentGeneration: _generation, ...projection } = state;
        response = { result: { value: unavailable-- > 0 ? null : projection } };
      }
      if (method === 'DOM.getDocument') response = { root: { nodeId: 1 } };
      if (method === 'DOM.querySelectorAll') response = { nodeIds: [params?.selector === '#data' ? 2 : 3] };
      if (method === 'DOM.describeNode') response = { node: { backendNodeId: params?.nodeId === 2 ? 20 : 30 } };
      if (method === 'DOM.getNodeForLocation') response = { backendNodeId: hit };
      if (method === 'DOM.getContentQuads')
        response = { quads: params?.backendNodeId === 20 ? [canvasQuad] : [[110, 30, 150, 30, 150, 50, 110, 50]] };
      if (method === 'Page.reload') {
        status.generation++;
        status.epoch++;
        status.navigations++;
        state = { ...state, played: false, hero: null, map: null };
        mapAtLoad = persistedMap;
        hit = 30;
      }
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased' && clickCompletesGame)
        state = { ...snapshot(), map: mapAtLoad };
      if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyUp')
        state = { ...state, locked: false, dialogue: null, event: { id: null, type: null } };
      return response as T;
    },
  };
  return {
    driver: new MotaPageDriver(port),
    port,
    status,
    calls,
    setState: (next: MotaState) => {
      state = next;
    },
    setPersistedMap: (next: MotaState['map']) => {
      persistedMap = next;
    },
    setClickCompletesGame: (next: boolean) => {
      clickCompletesGame = next;
    },
    setHit: (next: number) => {
      hit = next;
    },
    setQuad: (next: number[]) => {
      canvasQuad = next;
    },
    pause: () => {
      paused = true;
    },
    unavailable: (count: number) => {
      unavailable = count;
    },
    onSend: (hook: typeof onSend) => {
      onSend = hook;
    },
  };
}
const binding = { appInstanceId: 'app', runId: 'run', documentGeneration: 2 };
const tile = { type: 'tile' as const, floorId: 'MT1', x: 2, y: 3 };
const outcome = (promise: Promise<unknown>) =>
  promise.then(
    (data) => ({ ok: true, data }),
    (error: unknown) => ({ ok: false, error }),
  );
afterEach(() => vi.useRealTimers());

describe('fixed Mota read projection and protocol', () => {
  it('reads the actual tools/constants layout without executing or changing game state', () => {
    const s = snapshot();
    const forbidden = vi.fn(() => {
      throw new Error('game method must never run');
    });
    const core = {
      status: {
        played: true,
        floorId: 'MT1',
        hero: {
          loc: { x: 6, y: 11 },
          hp: 1000,
          atk: 20,
          def: 10,
          money: 4,
          items: { constants: { coin: 1 }, tools: { yellowKey: 2, blueKey: 3, redKey: 4 }, equips: {} },
          secretSave: 'not projected',
        },
        thisMap: { blocks: [{ x: 2, y: 3, id: 53, event: { id: 'coin', secret: 'not projected' } }] },
        heroStop: true,
        heroMoving: 0,
        lockControl: false,
        event: {},
        automaticRoute: { autoHeroMove: false },
      },
      bigmap: { width: 13, height: 13, offsetX: 0, offsetY: 0 },
      domStyle: { scale: 0.5 },
      _PX_: 416,
      _PY_: 416,
      startGame: forbidden,
      moveHero: forbidden,
      setBlock: forbidden,
    };
    const before = JSON.stringify(core);
    const projection: unknown = runInNewContext(MOTA_STATE_EXPRESSION, {
      core,
      main: { mode: 'play' },
      document: { getElementById: () => ({ getBoundingClientRect: () => s.canvas?.rect }) },
      getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
      innerWidth: 800,
      innerHeight: 600,
    });
    expect(MotaStateSchema.parse({ ...Object(projection), appInstanceId: 'app', documentGeneration: 2 })).toEqual(s);
    expect(JSON.stringify(projection)).not.toContain('not projected');
    expect(JSON.stringify(core)).toBe(before);
    expect(forbidden).not.toHaveBeenCalled();
  });
  it('limits state to 1024 map blocks and 2000 dialogue characters', () => {
    const projection = runInNewContext(MOTA_STATE_EXPRESSION, {
      core: {
        status: {
          played: true,
          hero: {},
          thisMap: { blocks: Array.from({ length: 1025 }, () => ({ x: 0, y: 0, id: 0 })) },
          event: { id: 'action', data: { type: 'text', current: { text: 'x'.repeat(2100) } } },
        },
        bigmap: { width: 13, height: 13 },
      },
      main: { mode: 'play' },
      document: { getElementById: () => null },
    });
    expect(projection.map.blocks).toHaveLength(1024);
    expect(projection.map.truncated).toBe(true);
    expect(projection.dialogue.text).toHaveLength(2000);
  });
  it('projects the known pre-floor hero sentinel as not ready without inventing a position', () => {
    const projection: unknown = runInNewContext(MOTA_STATE_EXPRESSION, {
      core: {
        status: { played: true, floorId: null, hero: { loc: { x: -1, y: -1 }, hp: 1000 }, event: {}, thisMap: null },
      },
      main: { mode: 'play' },
      document: { getElementById: () => null },
    });
    if (!projection || typeof projection !== 'object') throw new Error('expected fixed state projection');
    expect(MotaStateSchema.parse({ ...projection, appInstanceId: 'app', documentGeneration: 3 })).toMatchObject({
      played: true,
      floorId: null,
      hero: null,
      map: null,
    });
  });
  it.each([null, 34])('reports text confirmation readiness only after its typing interval clears (%s)', (interval) => {
    const projection: unknown = runInNewContext(MOTA_STATE_EXPRESSION, {
      core: {
        status: {
          played: false,
          event: {
            id: 'action',
            interval,
            data: { type: 'text', current: '测试剧情' },
          },
        },
      },
      main: { mode: 'play' },
      document: { getElementById: () => null },
    });
    if (!projection || typeof projection !== 'object') throw new Error('expected fixed state projection');
    expect(MotaStateSchema.parse({ ...projection, appInstanceId: 'app', documentGeneration: 2 }).dialogue).toEqual({
      text: '测试剧情',
      canContinue: interval === null,
    });
  });
  it.each([
    { type: 'tile', floorId: 'MT1', x: -1, y: 0 },
    { type: 'tile', floorId: 'MT1', x: 64, y: 0 },
    { type: 'tile', floorId: 'MT1', x: 1, y: 0, script: 'x' },
    { type: 'key', key: 'Escape' },
    { type: 'continue', code: 'x' },
  ])('rejects unsupported action %j at the tool boundary', (action) => {
    expect(AppToolInputSchemas['app.mota.act'].safeParse({ appInstanceId: 'app', documentGeneration: 2, action }).success).toBe(false);
  });
  it('keeps generic coordinates forbidden and map mutation fixed to its CAS fields', () => {
    expect(
      AppToolInputSchemas['app.ui.act'].safeParse({ appInstanceId: 'app', documentGeneration: 2, action: { type: 'click', x: 2, y: 3 } })
        .success,
    ).toBe(false);
    expect(
      AppToolInputSchemas['app.mota.map.set'].safeParse({ appInstanceId: 'app', expectedSha256: 'a'.repeat(64), x: 2, y: 3 }).success,
    ).toBe(true);
    for (const extra of [{ value: 1 }, { floorId: 'MT2' }, { path: '/tmp/file' }, { js: 'anything' }])
      expect(
        AppToolInputSchemas['app.mota.map.set'].safeParse({ appInstanceId: 'app', expectedSha256: 'a'.repeat(64), x: 2, y: 3, ...extra })
          .success,
      ).toBe(false);
    expect(MotaControlRequestSchema.safeParse({ method: 'map.set', input: {} }).success).toBe(false);
  });
});

describe('Mota CDP actions', () => {
  it('derives a scaled cell center and uses paired native mouse events', async () => {
    vi.useFakeTimers();
    const f = fixture();
    expect(motaTilePoint(snapshot(), tile)).toEqual({ x: 140, y: 76 });
    const result = outcome(f.driver.act(tile, binding));
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ ok: true, data: { played: true, documentGeneration: 2 } });
    expect(f.calls.filter((call) => call.method === 'Input.dispatchMouseEvent').map((call) => call.params)).toEqual([
      { type: 'mouseMoved', x: 140, y: 76 },
      { type: 'mousePressed', x: 140, y: 76, button: 'left', buttons: 1, clickCount: 1 },
      { type: 'mouseReleased', x: 140, y: 76, button: 'left', buttons: 0, clickCount: 1 },
    ]);
  });
  it.each(['floor', 'moving', 'locked', 'outside-map', 'outside-viewport', 'bad-scale', 'obscured'] as const)(
    'rejects %s before any input',
    async (kind) => {
      const f = fixture(),
        s = snapshot();
      if (kind === 'floor') s.floorId = 'MT2';
      if (kind === 'moving') s.moving = true;
      if (kind === 'locked') s.locked = true;
      if (kind === 'outside-map' && s.map) s.map.width = 2;
      if (kind === 'outside-viewport' && s.canvas) s.canvas.offsetX = 200;
      if (kind === 'bad-scale' && s.canvas) s.canvas.scale = 1;
      if (kind === 'obscured') f.setHit(99);
      f.setState(s);
      expect(await outcome(f.driver.act(tile, binding))).toMatchObject({ ok: false });
      expect(f.calls.some((call) => call.method.startsWith('Input.'))).toBe(false);
    },
  );
  it.each(['cancel', 'pause', 'navigate', 'pick', 'detach'] as const)('rechecks %s after the hit-test and prevents input', async (kind) => {
    const f = fixture(),
      abort = new AbortController();
    f.onSend((method) => {
      if (method !== 'DOM.getNodeForLocation') return;
      if (kind === 'cancel') abort.abort();
      if (kind === 'pause') f.pause();
      if (kind === 'navigate') f.status.generation++;
      if (kind === 'pick') f.status.picking = true;
      if (kind === 'detach') f.status.detached = true;
    });
    expect(await outcome(f.driver.act(tile, binding, abort.signal))).toMatchObject({ ok: false });
    expect(f.calls.some((call) => call.method.startsWith('Input.'))).toBe(false);
  });
  it('always releases an in-flight mouse press on cancellation', async () => {
    const f = fixture(),
      abort = new AbortController();
    f.onSend((method, params) => {
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed') abort.abort();
    });
    expect(await outcome(f.driver.act(tile, binding, abort.signal))).toMatchObject({ ok: false, error: { code: 'cancelled' } });
    expect(f.calls.filter((call) => call.method === 'Input.dispatchMouseEvent').map((call) => call.params?.type)).toEqual([
      'mouseMoved',
      'mousePressed',
      'mouseReleased',
    ]);
  });
  it('rechecks the floor after the canvas hit-test before dispatching', async () => {
    const f = fixture();
    f.onSend((method) => {
      if (method === 'DOM.getNodeForLocation') f.setState({ ...snapshot(), floorId: 'MT2' });
    });
    expect(await outcome(f.driver.act(tile, binding))).toMatchObject({ ok: false, error: { code: 'stale_document' } });
    expect(f.calls.some((call) => call.method.startsWith('Input.'))).toBe(false);
  });
  it('rejects a rotated square canvas whose bounding rectangle alone looks valid', async () => {
    const f = fixture();
    f.setQuad([308, 20, 308, 228, 100, 228, 100, 20]);
    expect(await outcome(f.driver.act(tile, binding))).toMatchObject({ ok: false, error: { code: 'element_obscured' } });
    expect(f.calls.some((call) => call.method.startsWith('Input.'))).toBe(false);
  });
  it('confirms only a text dialogue with paired real key events', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setState({ ...snapshot(), locked: true, event: { id: 'action', type: 'text' }, dialogue: { text: '继续剧情', canContinue: true } });
    const result = outcome(f.driver.act({ type: 'continue' }, binding));
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ ok: true, data: { dialogue: null } });
    expect(f.calls.filter((call) => call.method === 'Input.dispatchKeyEvent').map((call) => call.params?.type)).toEqual([
      'keyDown',
      'keyUp',
    ]);
    expect(f.calls.filter((call) => call.method === 'Input.dispatchKeyEvent').every((call) => call.params?.key === 'Enter')).toBe(true);
  });
  it('does not use Enter to pick an arbitrary menu or skip an unsupported event', async () => {
    const f = fixture();
    f.setState({ ...snapshot(), locked: true, event: { id: 'action', type: 'choices' } });
    expect(await outcome(f.driver.act({ type: 'continue' }, binding))).toMatchObject({ ok: false, error: { code: 'app_busy' } });
    expect(f.calls.some((call) => call.method.startsWith('Input.'))).toBe(false);
  });
  it('waits for dialogue typing to finish and then advances it with exactly one Enter', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setClickCompletesGame(false);
    const dialogue = {
      ...snapshot(),
      locked: true,
      event: { id: 'action', type: 'text' },
      dialogue: { text: '完整剧情', canContinue: false },
    };
    f.onSend((method, params) => {
      if (method !== 'Input.dispatchMouseEvent' || params?.type !== 'mouseReleased') return;
      f.setState(dialogue);
      setTimeout(() => f.setState({ ...dialogue, dialogue: { text: '完整剧情', canContinue: true } }), 600);
    });
    let settled = false;
    const move = outcome(f.driver.act(tile, binding)).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(settled).toBe(false);
    expect(await outcome(f.driver.act({ type: 'continue' }, binding))).toMatchObject({ ok: false, error: { code: 'app_busy' } });
    expect(f.calls.some((call) => call.method === 'Input.dispatchKeyEvent')).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(await move).toMatchObject({ ok: true, data: { dialogue: { canContinue: true } } });
    const advance = outcome(f.driver.act({ type: 'continue' }, binding));
    await vi.advanceTimersByTimeAsync(500);
    expect(await advance).toMatchObject({ ok: true, data: { dialogue: null } });
    expect(f.calls.filter((call) => call.method === 'Input.dispatchKeyEvent' && call.params?.type === 'keyDown')).toHaveLength(1);
  });
  it('reloads a played game, waits for core readiness, and clicks the real start button', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.onSend((method) => {
      if (method === 'Page.reload') f.unavailable(3);
    });
    const result = outcome(f.driver.act({ type: 'newGame' }, binding));
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ ok: true, data: { played: true, documentGeneration: 3 } });
    expect(f.calls.filter((call) => call.method === 'Page.reload')).toHaveLength(1);
    expect(f.calls.filter((call) => call.method === 'DOM.querySelectorAll').map((call) => call.params?.selector)).toEqual(['#playGame']);
    expect(
      f.calls.filter((call) => call.method === 'Runtime.evaluate').every((call) => call.params?.expression === MOTA_STATE_EXPRESSION),
    ).toBe(true);
  });
  it('reloads even the initial start screen so a persisted map edit replaces its cached floor before play', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setState({ ...snapshot(), played: false, floorId: null, hero: null, map: null });
    f.setHit(30);
    const changedMap = { width: 13, height: 13, blocks: [{ x: 3, y: 4, id: 53, eventId: 'coin', disabled: false }], truncated: false };
    // The controlled page reloads persisted map bytes only on Page.reload, not on the start click.
    f.setPersistedMap(changedMap);
    const result = outcome(f.driver.act({ type: 'newGame' }, binding));
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ ok: true, data: { played: true, documentGeneration: 3, map: changedMap } });
    expect(f.calls.filter((call) => call.method === 'Page.reload')).toHaveLength(1);
    const reload = f.calls.findIndex((call) => call.method === 'Page.reload');
    const click = f.calls.findIndex((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mousePressed');
    expect(reload).toBeLessThan(click);
  });
  it('waits through the unchanged start animation and the pre-floor state before newGame succeeds', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setClickCompletesGame(false);
    f.onSend((method, params) => {
      if (method !== 'Input.dispatchMouseEvent' || params?.type !== 'mouseReleased') return;
      setTimeout(() => f.setState({ ...snapshot(), played: true, floorId: null, hero: null, map: null }), 700);
      setTimeout(() => f.setState(snapshot()), 1100);
    });
    let settled = false;
    const result = outcome(f.driver.act({ type: 'newGame' }, binding)).then((value) => {
      settled = true;
      return value;
    });
    await vi.advanceTimersByTimeAsync(400);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toMatchObject({ ok: true, data: { played: true, floorId: 'MT1', hero: { x: 6, y: 11 }, documentGeneration: 3 } });
    expect(f.calls.filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mousePressed')).toHaveLength(1);
  });
  it('keeps the original eight-second bound when the start click never enters a game', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.setClickCompletesGame(false);
    const result = outcome(f.driver.act({ type: 'newGame' }, binding));
    await vi.advanceTimersByTimeAsync(8500);
    expect(await result).toMatchObject({ ok: false, error: { code: 'wait_timeout' } });
    expect(f.calls.filter((call) => call.method === 'Input.dispatchMouseEvent' && call.params?.type === 'mousePressed')).toHaveLength(1);
  });
  it('rejects a second navigation during a requested new game', async () => {
    const f = fixture();
    f.onSend((method) => {
      if (method === 'Page.reload') {
        f.status.generation++;
        f.status.navigations++;
      }
    });
    expect(await outcome(f.driver.act({ type: 'newGame' }, binding))).toMatchObject({ ok: false, error: { code: 'stale_document' } });
    expect(f.calls.some((call) => call.method.startsWith('Input.'))).toBe(false);
  });
  it('rejects a stale document before attaching or dispatching', async () => {
    const f = fixture();
    expect(await outcome(f.driver.act(tile, { ...binding, documentGeneration: 1 }))).toMatchObject({
      ok: false,
      error: { code: 'stale_document' },
    });
    expect(f.port.attach).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });
  it('bounds a game that never settles and removes abort listeners after completed delays', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      abort = new AbortController();
    const added = vi.spyOn(abort.signal, 'addEventListener'),
      removed = vi.spyOn(abort.signal, 'removeEventListener');
    f.onSend((method, params) => {
      if (method === 'Runtime.evaluate' && f.calls.some((call) => call.method.startsWith('Input.')))
        f.setState({ ...snapshot(), moving: true });
      if (method === 'Input.dispatchKeyEvent' && params?.type === 'keyUp') f.setState({ ...snapshot(), moving: true });
    });
    const result = outcome(f.driver.act(tile, binding, abort.signal));
    await vi.advanceTimersByTimeAsync(8500);
    expect(await result).toMatchObject({ ok: false, error: { code: 'wait_timeout' } });
    expect(removed).toHaveBeenCalledTimes(added.mock.calls.length);
  });
  it('rejects a navigation during read instead of assigning the new generation to old state', async () => {
    const f = fixture();
    f.onSend((method) => {
      if (method === 'Runtime.evaluate') f.status.generation++;
    });
    expect(await outcome(f.driver.state('app'))).toMatchObject({ ok: false, error: { code: 'stale_document' } });
  });
});
