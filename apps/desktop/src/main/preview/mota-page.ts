import { MotaActionSchema, MotaStateSchema, type MotaAction, type MotaState } from '@wsl/protocol';
import { AppControlFailure } from '../workbench/app-control-failure';

/** Fixed, read-only projection. No core methods, saved game data, scripts or model-supplied paths. */
export const MOTA_STATE_EXPRESSION = `(() => {
  const c = globalThis.core;
  if (!c || !c.status || globalThis.main?.mode !== 'play') return null;
  const s = c.status, h = s.hero, e = s.event || {}, d = e.data || {};
  const text = typeof d.current === 'string' ? d.current : typeof d.current?.text === 'string' ? d.current.text : '';
  const number = v => typeof v === 'number' && Number.isFinite(v) ? v : 0;
  const short = v => typeof v === 'string' ? v.slice(0, 80) : null;
  const canvas = document.getElementById('data');
  const r = canvas?.getBoundingClientRect();
  const css = canvas ? getComputedStyle(canvas) : null;
  const visible = r && r.width > 0 && r.height > 0 && css?.display !== 'none' && css?.visibility !== 'hidden' && Number(css?.opacity) > 0;
  const blocks = Array.isArray(s.thisMap?.blocks) ? s.thisMap.blocks : [];
  return {
    played: s.played === true, floorId: short(s.floorId),
    hero: s.played && h?.loc && !(s.floorId == null && h.loc.x === -1 && h.loc.y === -1) ? { x: h.loc.x, y: h.loc.y, hp: number(h.hp), atk: number(h.atk), def: number(h.def),
      money: number(h.money), coin: number(h.items?.constants?.coin),
      keys: { yellow: number(h.items?.tools?.yellowKey), blue: number(h.items?.tools?.blueKey), red: number(h.items?.tools?.redKey) } } : null,
    moving: number(s.heroMoving) > 0 || s.heroStop === false || s.automaticRoute?.autoHeroMove === true,
    locked: s.lockControl === true, event: { id: short(e.id), type: short(d.type) },
    dialogue: e.id === 'action' && d.type === 'text' ? { text: text.slice(0, 2000), canContinue: !e.animateUI && e.interval == null } : null,
    map: s.played && s.thisMap ? { width: c.bigmap.width, height: c.bigmap.height,
      blocks: blocks.slice(0, 1024).map(b => ({ x: b.x, y: b.y, id: b.id, eventId: short(b.event?.id), disabled: b.disable === true })),
      truncated: blocks.length > 1024 } : null,
    canvas: visible ? { rect: { x:r.x, y:r.y, width:r.width, height:r.height },
      viewport: { width: innerWidth, height: innerHeight }, logicalWidth:c._PX_, logicalHeight:c._PY_,
      offsetX:number(c.bigmap?.offsetX), offsetY:number(c.bigmap?.offsetY), scale:c.domStyle?.scale } : null
  };
})()`;

type Point = { x: number; y: number };
export interface MotaPagePort {
  attach(signal?: AbortSignal): Promise<void>;
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T>;
  current(): { generation: number; epoch: number; navigations: number; detached: boolean; picking: boolean; loading: boolean; url: string };
  gate: {
    begin(runId: string, label: string): void;
    assertNotPaused(runId?: string): void;
    dispatch<T>(runId: string, work: () => Promise<T>): Promise<T>;
  };
}
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', value: 13, text: '\r' },
  Space: { key: ' ', code: 'Space', value: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', value: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', value: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', value: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', value: 39 },
};
/** The model selects a map cell; only Main derives viewport coordinates. */
export function motaTilePoint(state: MotaState, action: Extract<MotaAction, { type: 'tile' }>): Point {
  if (!state.played || state.floorId !== action.floorId) throw new AppControlFailure('stale_document', '当前魔塔楼层已变化');
  if (state.moving || state.locked) throw new AppControlFailure('app_busy', '勇士移动或剧情尚未结束');
  const { map, canvas } = state;
  if (!map || !canvas || action.x >= map.width || action.y >= map.height)
    throw new AppControlFailure('invalid_request', '目标格子不在当前地图内');
  const { rect, viewport, logicalWidth, logicalHeight, offsetX, offsetY, scale } = canvas;
  if (Math.abs(rect.width / logicalWidth - scale) > 0.02 || Math.abs(rect.height / logicalHeight - scale) > 0.02)
    throw new AppControlFailure('element_obscured', '画布缩放与游戏布局不一致');
  const lx = (action.x + 0.5) * 32 - offsetX,
    ly = (action.y + 0.5) * 32 - offsetY;
  const x = rect.x + (lx / logicalWidth) * rect.width,
    y = rect.y + (ly / logicalHeight) * rect.height;
  if (lx < 0 || ly < 0 || lx >= logicalWidth || ly >= logicalHeight || x < 0 || y < 0 || x >= viewport.width || y >= viewport.height)
    throw new AppControlFailure('element_obscured', '目标格子不在可见画布视口内');
  return { x, y };
}
function check(signal?: AbortSignal) {
  if (signal?.aborted) throw new AppControlFailure('cancelled', '魔塔操作已取消');
}
function delay(ms: number, signal?: AbortSignal) {
  check(signal);
  return new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer);
      reject(new AppControlFailure('cancelled', '魔塔操作已取消'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }, ms);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

export class MotaPageDriver {
  constructor(private readonly port: MotaPagePort) {}
  private async read(appInstanceId: string, guard: () => void): Promise<MotaState> {
    guard();
    const response = await this.port.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', {
      expression: MOTA_STATE_EXPRESSION,
      returnByValue: true,
      awaitPromise: false,
    });
    guard();
    if (response.exceptionDetails || !response.result?.value || typeof response.result.value !== 'object')
      throw new AppControlFailure('unsupported', '当前页面未提供受限魔塔游戏状态');
    const result = MotaStateSchema.safeParse({
      ...response.result.value,
      appInstanceId,
      documentGeneration: this.port.current().generation,
    });
    if (!result.success) throw new AppControlFailure('unavailable', '魔塔状态超出受支持的固定边界');
    return result.data;
  }
  async state(appInstanceId: string, signal?: AbortSignal) {
    const before = this.port.current();
    const guard = () => {
      check(signal);
      const now = this.port.current();
      if (now.detached) throw new AppControlFailure('cdp_detached', '页面控制已断开');
      if (now.generation !== before.generation || now.epoch !== before.epoch)
        throw new AppControlFailure('stale_document', '读取期间页面已变化');
    };
    guard();
    await this.port.attach(signal);
    return this.read(appInstanceId, guard);
  }
  private async ready(appInstanceId: string, guard: () => void, signal?: AbortSignal) {
    const deadline = Date.now() + 10000;
    for (;;) {
      guard();
      try {
        return await this.read(appInstanceId, guard);
      } catch (error) {
        if (!(error instanceof AppControlFailure) || error.code !== 'unsupported') throw error;
        if (Date.now() >= deadline) throw new AppControlFailure('wait_timeout', '魔塔页面未在时限内初始化');
      }
      await delay(100, signal);
    }
  }
  private async target(selector: '#data' | '#playGame', guard: () => void) {
    guard();
    const { root } = await this.port.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 });
    guard();
    const { nodeIds } = await this.port.send<{ nodeIds: number[] }>('DOM.querySelectorAll', { nodeId: root.nodeId, selector });
    guard();
    if (nodeIds.length !== 1) throw new AppControlFailure('element_not_found', '当前页面缺少唯一魔塔控件');
    const { node } = await this.port.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { nodeId: nodeIds[0] });
    guard();
    return node.backendNodeId;
  }
  private async hit(backend: number, point: Point, guard: () => void) {
    guard();
    const { backendNodeId } = await this.port.send<{ backendNodeId: number }>('DOM.getNodeForLocation', {
      x: Math.round(point.x),
      y: Math.round(point.y),
      includeUserAgentShadowDOM: false,
    });
    guard();
    if (backendNodeId !== backend) throw new AppControlFailure('element_obscured', '魔塔控件被其他元素遮挡');
  }
  private async playButton(guard: () => void, signal?: AbortSignal) {
    const deadline = Date.now() + 10000;
    for (;;) {
      guard();
      try {
        const backend = await this.target('#playGame', guard);
        const { quads } = await this.port.send<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId: backend });
        guard();
        const q = quads[0];
        if (!q || q.length !== 8 || !q.every(Number.isFinite) || Math.abs(q[2]! - q[0]!) < 1 || Math.abs(q[5]! - q[1]!) < 1)
          throw new AppControlFailure('element_obscured', '开始按钮不可见');
        const point = { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 };
        await this.hit(backend, point, guard);
        return { backend, point };
      } catch (error) {
        if (!(error instanceof AppControlFailure) || !['element_not_found', 'element_obscured'].includes(error.code)) throw error;
        if (Date.now() >= deadline) throw new AppControlFailure('wait_timeout', '开始按钮未在时限内可见');
      }
      await delay(100, signal);
    }
  }
  private async canvasGeometry(backend: number, state: MotaState, guard: () => void) {
    if (!state.canvas) throw new AppControlFailure('element_obscured', '魔塔画布不可见');
    const { quads } = await this.port.send<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId: backend });
    guard();
    const { x, y, width, height } = state.canvas.rect;
    const expected = [x, y, x + width, y, x + width, y + height, x, y + height];
    if (
      quads.length !== 1 ||
      quads[0]?.length !== 8 ||
      quads[0].some((value, index) => !Number.isFinite(value) || Math.abs(value - expected[index]!) > 1)
    )
      throw new AppControlFailure('element_obscured', '画布存在旋转、裁剪或布局变化');
  }
  private async click(backend: number, point: Point, runId: string, guard: () => void, validate?: () => Promise<void>) {
    await this.hit(backend, point, guard);
    await validate?.();
    await this.port.gate.dispatch(runId, async () => {
      guard();
      await this.port.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      guard();
      try {
        await this.port.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
      } finally {
        await this.port.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
      }
      guard();
    });
  }
  private async press(key: keyof typeof KEYS, runId: string, guard: () => void) {
    const definition = KEYS[key];
    const base = {
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.value,
      nativeVirtualKeyCode: definition.value,
    };
    await this.port.gate.dispatch(runId, async () => {
      guard();
      try {
        await this.port.send('Input.dispatchKeyEvent', {
          ...base,
          type: 'text' in definition ? 'keyDown' : 'rawKeyDown',
          ...('text' in definition ? { text: definition.text } : {}),
        });
      } finally {
        await this.port.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
      }
      guard();
    });
  }
  private async stable(appInstanceId: string, guard: () => void, signal?: AbortSignal, requireGame = false) {
    const deadline = Date.now() + 8000;
    let prior = '';
    for (;;) {
      await delay(150, signal);
      guard();
      const state = await this.read(appInstanceId, guard);
      const signature = JSON.stringify(state);
      // The start panel stays unchanged during its fade; it is not a completed new game.
      const gameReady = !requireGame || (state.played && state.floorId !== null && state.hero !== null && state.map !== null);
      if (gameReady && !state.moving && (!state.locked || state.dialogue?.canContinue) && signature === prior) return state;
      prior = signature;
      if (Date.now() >= deadline) throw new AppControlFailure('wait_timeout', '魔塔动作后未在时限内稳定或进入可确认剧情');
    }
  }
  async act(input: MotaAction, binding: { appInstanceId: string; runId: string; documentGeneration: number }, signal?: AbortSignal) {
    const parsed = MotaActionSchema.safeParse(input);
    if (!parsed.success) throw new AppControlFailure('invalid_request', '魔塔动作不符合固定协议');
    const action = parsed.data;
    let expected = this.port.current();
    if (binding.documentGeneration !== expected.generation) throw new AppControlFailure('stale_document', '请读取当前页面代次后再操作');
    const guard = () => {
      check(signal);
      this.port.gate.assertNotPaused(binding.runId);
      const now = this.port.current();
      if (now.picking) throw new AppControlFailure('paused_by_user', '用户正在点选页面');
      if (now.detached) throw new AppControlFailure('cdp_detached', '页面控制已断开');
      if (now.generation !== expected.generation || now.epoch !== expected.epoch || now.url !== expected.url)
        throw new AppControlFailure('stale_document', '魔塔动作期间页面已变化');
    };
    guard();
    await this.port.attach(signal);
    guard();
    this.port.gate.begin(binding.runId, `mota.${action.type}`);
    await this.port.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    let state =
      action.type === 'newGame' ? await this.ready(binding.appInstanceId, guard, signal) : await this.read(binding.appInstanceId, guard);
    if (action.type === 'newGame') {
      // Floors are loaded before the start screen; always reload to discard a pre-edit map cache.
      await this.port.gate.dispatch(binding.runId, async () => {
        guard();
        await this.port.send('Page.reload', { ignoreCache: true });
      });
      const deadline = Date.now() + 10000;
      for (;;) {
        check(signal);
        this.port.gate.assertNotPaused(binding.runId);
        const now = this.port.current();
        if (
          now.url !== expected.url ||
          now.detached ||
          now.picking ||
          now.navigations > expected.navigations + 1 ||
          now.generation > expected.generation + 1
        )
          throw new AppControlFailure('stale_document', '重开期间出现非预期导航');
        if (!now.loading && now.generation === expected.generation + 1 && now.navigations === expected.navigations + 1) {
          expected = now;
          state = await this.ready(binding.appInstanceId, guard, signal);
          break;
        }
        if (Date.now() >= deadline) throw new AppControlFailure('wait_timeout', '重新加载魔塔页面超时');
        await delay(100, signal);
      }
      if (state.played) throw new AppControlFailure('app_busy', '页面未回到开始界面');
      const { backend, point } = await this.playButton(guard, signal);
      await this.click(backend, point, binding.runId, guard);
    } else if (action.type === 'tile') {
      const backend = await this.target('#data', guard);
      state = await this.read(binding.appInstanceId, guard);
      const point = motaTilePoint(state, action);
      await this.canvasGeometry(backend, state, guard);
      await this.click(backend, point, binding.runId, guard, async () => {
        const fresh = await this.read(binding.appInstanceId, guard);
        const next = motaTilePoint(fresh, action);
        if (Math.abs(next.x - point.x) > 0.5 || Math.abs(next.y - point.y) > 0.5)
          throw new AppControlFailure('element_obscured', '派发前画布布局已变化');
      });
    } else {
      const key = action.type === 'continue' ? 'Enter' : action.key;
      if (key === 'Enter' || key === 'Space') {
        if (!state.dialogue?.canContinue) throw new AppControlFailure('app_busy', '当前没有可确认的剧情文本');
      } else if (!state.played || state.locked || state.moving) throw new AppControlFailure('app_busy', '当前不能移动勇士');
      const backend = await this.target('#data', guard);
      const canvas = state.canvas;
      if (!canvas) throw new AppControlFailure('element_obscured', '魔塔画布不可见');
      await this.hit(backend, { x: canvas.rect.x + canvas.rect.width / 2, y: canvas.rect.y + canvas.rect.height / 2 }, guard);
      await this.press(key, binding.runId, guard);
    }
    return this.stable(binding.appInstanceId, guard, signal, action.type === 'newGame');
  }
}
