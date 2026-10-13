import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import {
  AppBridgeResponseSchema,
  type AgentControlState,
  type AppBridgeRequest,
  type AppBridgeResponse,
  type AppTargetSelector,
  type AppUiAction,
  type AppUiSnapshot,
  type CdpState,
  type PageIdentity,
} from '@wsl/protocol';
import { AppControlFailure } from '../workbench/app-control-failure';

/**
 * L1/L2 控制面的 CDP 适配器：与 BrowserObservation、页面点选使用同一 webContents 的调试会话。
 * 所有页面内函数都是本文件中的固定源码，Agent 输入只作为 JSON 参数值传入；不接受坐标、选择器或脚本。
 */
type Listener = () => void;
type ConsoleListener = (event: { level: string; message: string }) => void;
type DetachListener = (event: unknown, reason: string) => void;
type MessageListener = (event: unknown, method: string, params: Record<string, unknown>) => void;
type DebuggerTarget = Pick<WebContents, 'id' | 'isDestroyed' | 'getURL' | 'getTitle' | 'isLoading' | 'capturePage'> & {
  on(event: 'did-start-navigation', listener: Listener): unknown;
  on(event: 'did-navigate', listener: Listener): unknown;
  on(event: 'did-navigate-in-page', listener: Listener): unknown;
  on(event: 'destroyed', listener: Listener): unknown;
  on(event: 'console-message', listener: ConsoleListener): unknown;
  removeListener(event: 'did-start-navigation', listener: Listener): unknown;
  removeListener(event: 'did-navigate', listener: Listener): unknown;
  removeListener(event: 'did-navigate-in-page', listener: Listener): unknown;
  removeListener(event: 'destroyed', listener: Listener): unknown;
  removeListener(event: 'console-message', listener: ConsoleListener): unknown;
  debugger: Pick<WebContents['debugger'], 'attach' | 'isAttached' | 'sendCommand'> & {
    on(event: 'detach', listener: DetachListener): unknown;
    on(event: 'message', listener: MessageListener): unknown;
    removeListener(event: 'detach', listener: DetachListener): unknown;
    removeListener(event: 'message', listener: MessageListener): unknown;
  };
};
/** PreviewController 提供的操控闸门：派发窗口外的人为输入锁存 paused_by_user。 */
export interface AgentControlGate {
  begin(runId: string, label: string): void;
  dispatch<T>(runId: string, work: () => Promise<T>): Promise<T>;
  assertNotPaused(runId?: string): void;
}
/** 视为“用户接管”的输入；滚轮和指针移动只是浏览，不暂停 AI。 */
const USER_INPUT = new Set([
  'mouseDown',
  'rawKeyDown',
  'keyDown',
  'char',
  'touchStart',
  'gestureTap',
  'gestureTapDown',
  'contextMenu',
  'pointerDown',
]);
const DISPATCH_GRACE_MS = 150;

/**
 * “AI 正在操控”锁存器，由 PreviewController 持有并投影到 PreviewState.agentControl。
 * 某 run 首次在该页面写入后进入 active；派发窗口外的人为输入锁存 paused_by_user，
 * 直到用户在 Browser 区点“允许 AI 继续”或该 run 结束。派发窗口内的人为输入会被归为 AI（已知限制）。
 */
export class AgentControlLatch implements AgentControlGate {
  private current: AgentControlState = { state: 'idle', runId: null, since: null, lastAction: null };
  private dispatching = 0;
  private graceUntil = 0;
  constructor(
    private readonly changed: () => void,
    private readonly now: () => number = Date.now,
  ) {}
  state(): AgentControlState {
    return { ...this.current };
  }
  assertNotPaused(runId?: string) {
    if (this.current.state === 'paused_by_user' && (runId === undefined || this.current.runId === runId))
      throw new AppControlFailure('paused_by_user', '用户正在 Browser 区操作；AI 操控已暂停，等待用户点“允许 AI 继续”');
  }
  begin(runId: string, label: string) {
    this.assertNotPaused(runId);
    const since = this.current.runId === runId && this.current.since ? this.current.since : new Date(this.now()).toISOString();
    this.current = { state: 'active', runId, since, lastAction: label.slice(0, 200) };
    this.changed();
  }
  async dispatch<T>(runId: string, work: () => Promise<T>): Promise<T> {
    this.assertNotPaused(runId);
    this.dispatching++;
    try {
      return await work();
    } finally {
      this.dispatching--;
      this.graceUntil = this.now() + DISPATCH_GRACE_MS;
    }
  }
  observeInput(type: string) {
    if (!USER_INPUT.has(type) || this.current.state !== 'active') return;
    if (this.dispatching > 0 || this.now() < this.graceUntil) return;
    this.current = { ...this.current, state: 'paused_by_user', since: new Date(this.now()).toISOString() };
    this.changed();
  }
  /** 只有用户界面可调用；Agent 不能自行恢复。 */
  resume() {
    if (this.current.state !== 'paused_by_user') return;
    this.current = { ...this.current, state: 'active', since: new Date(this.now()).toISOString() };
    this.changed();
  }
  release(runId: string) {
    if (this.current.runId !== runId) return;
    this.current = { state: 'idle', runId: null, since: null, lastAction: null };
    this.changed();
  }
}

export interface AppUiPage {
  identity(): PageIdentity;
  cdp(): CdpState;
  picking(): boolean;
}
export interface ElementQuery {
  count: number;
  visible: boolean;
  enabled: boolean;
  text: string | null;
}

const OBJECT_GROUP = 'wsl-app-control';
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'switch',
  'tab',
  'slider',
  'spinbutton',
  'treeitem',
]);
const KEYS: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
/** 固定页面函数（以 this 为目标元素）；任何 Agent 文本都只作为参数值。 */
const FN = {
  describe: `function () {
    const rect = this.getBoundingClientRect();
    const style = getComputedStyle(this);
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
    const disabled = !!(this.disabled || this.getAttribute('aria-disabled') === 'true' || (this.closest && this.closest('fieldset:disabled')));
    const password = this.tagName === 'INPUT' && this.type === 'password';
    const value = 'value' in this && typeof this.value === 'string' ? (password ? '[redacted]' : this.value.slice(0, 1000)) : null;
    return { visible, disabled, text: String(this.innerText ?? this.textContent ?? '').trim().slice(0, 2000), value };
  }`,
  contains: `function (other) { return this === other || this.contains(other); }`,
  selectContents: `function () {
    if (typeof this.select === 'function') { this.select(); return true; }
    const range = document.createRange(); range.selectNodeContents(this);
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); return true;
  }`,
  selectOption: `function (value) {
    if (this.tagName !== 'SELECT') return 'not_select';
    const option = Array.from(this.options).find((item) => item.value === value);
    if (!option) return 'no_option';
    this.value = value;
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  }`,
  bridge: `function (request) {
    const bridge = this.__WSL_AGENT__;
    if (!bridge || typeof bridge.call !== 'function') return JSON.stringify({ ok: false, error: { code: 'invalid_request', message: 'bridge_unavailable' } });
    return bridge.call(request);
  }`,
};

export class AppUiDriver {
  private epoch = 0;
  private currentSnapshot: { snapshotId: string; refs: Map<string, { backend: number; generation: number; epoch: number }> } | null = null;
  private consoleSequence = 0;
  private consoleErrors: { sequence: number; message: string }[] = [];
  private readonly release: (() => void)[] = [];
  private disposed = false;
  constructor(
    private readonly wc: DebuggerTarget,
    private readonly page: AppUiPage,
    private readonly gate: AgentControlGate,
  ) {
    const invalidate = () => {
      this.epoch++;
      this.currentSnapshot = null;
    };
    const onConsole = (event: { level: string; message: string }) => {
      if (event.level === 'error') this.recordError(event.message);
    };
    const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
      if (method === 'Page.frameNavigated' || method === 'Page.frameDetached') invalidate();
      if (method === 'Runtime.exceptionThrown') {
        const details = params.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
        this.recordError(details?.exception?.description ?? details?.text ?? 'exception');
      }
    };
    // 与 BrowserObservation 相同：任一导航、frame 变化、CDP 断开或销毁都使全部引用失效。
    wc.on('did-start-navigation', invalidate);
    wc.on('did-navigate', invalidate);
    wc.on('did-navigate-in-page', invalidate);
    wc.on('destroyed', invalidate);
    wc.on('console-message', onConsole);
    const onDetach: DetachListener = () => invalidate();
    wc.debugger.on('detach', onDetach);
    wc.debugger.on('message', onMessage);
    this.release.push(
      () => wc.removeListener('did-start-navigation', invalidate),
      () => wc.removeListener('did-navigate', invalidate),
      () => wc.removeListener('did-navigate-in-page', invalidate),
      () => wc.removeListener('destroyed', invalidate),
      () => wc.removeListener('console-message', onConsole),
      () => wc.debugger.removeListener('detach', onDetach),
      () => wc.debugger.removeListener('message', onMessage),
    );
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.currentSnapshot = null;
    for (const release of this.release.splice(0)) release();
  }
  private recordError(message: string) {
    this.consoleErrors.push({ sequence: ++this.consoleSequence, message: message.slice(0, 2000) });
    if (this.consoleErrors.length > 200) this.consoleErrors.shift();
  }
  /** 场景开始时取标记，之后读取该标记以来的 console 错误与未捕获异常。 */
  consoleMark(): number {
    return this.consoleSequence;
  }
  consoleErrorsSince(mark: number): string[] {
    return this.consoleErrors.filter((entry) => entry.sequence > mark).map((entry) => entry.message);
  }
  private send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.disposed || this.wc.isDestroyed()) return Promise.reject(new AppControlFailure('browser_unavailable', '网页实例已关闭'));
    return this.wc.debugger.sendCommand(method, params) as Promise<T>;
  }
  private async attach(signal?: AbortSignal) {
    check(signal);
    if (this.page.cdp().state === 'detached' && !this.wc.debugger.isAttached())
      throw new AppControlFailure('cdp_detached', '页面控制已断开（例如打开了 DevTools）；请在 Browser 区重新附着后再试');
    if (!this.wc.debugger.isAttached()) this.wc.debugger.attach('1.3');
    for (const method of ['Page.enable', 'DOM.enable', 'Runtime.enable', 'Accessibility.enable']) {
      check(signal);
      await this.send(method);
    }
  }
  private async call<T>(backend: number, declaration: string, args: unknown[] = [], beforeCall?: () => void): Promise<T> {
    const { object } = await this.send<{ object: { objectId?: string } }>('DOM.resolveNode', {
      backendNodeId: backend,
      objectGroup: OBJECT_GROUP,
    });
    if (!object.objectId) throw new AppControlFailure('element_not_found', '元素已不在文档中');
    beforeCall?.();
    const result = await this.send<{ result: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: declaration,
      arguments: args.map((value) => (value && typeof value === 'object' && 'objectId' in value ? value : { value })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw new AppControlFailure('unavailable', '页面函数执行失败');
    return result.result.value as T;
  }
  private releaseObjects() {
    return this.send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => undefined);
  }

  async snapshot(appInstanceId: string, options: { limit: number; includeHidden: boolean }, signal?: AbortSignal): Promise<AppUiSnapshot> {
    await this.attach(signal);
    const epoch = this.epoch;
    const generation = this.page.identity().documentGeneration;
    const refs = new Map<string, { backend: number; generation: number; epoch: number }>();
    let snapshot: AppUiSnapshot;
    try {
      const { frameTree } = await this.send<{ frameTree: { frame: { id: string }; childFrames?: unknown[] } }>('Page.getFrameTree');
      const { nodes } = await this.send<{
        nodes: {
          ignored?: boolean;
          backendDOMNodeId?: number;
          role?: { value?: string };
          name?: { value?: string };
          properties?: { name: string; value: { value?: unknown } }[];
        }[];
      }>('Accessibility.getFullAXTree', { frameId: frameTree.frame.id });
      check(signal);
      type DomNode = { backendNodeId: number; nodeType: number; nodeName: string; attributes?: string[]; children?: DomNode[] };
      const { root } = await this.send<{ root: DomNode }>('DOM.getDocument', { depth: -1, pierce: false });
      const testids = new Map<number, { testid: string; tag: string }>();
      let domCount = 0;
      const walk = (node: DomNode) => {
        domCount++;
        const attributes = node.attributes ?? [];
        for (let index = 0; index < attributes.length; index += 2)
          if (attributes[index] === 'data-testid')
            testids.set(node.backendNodeId, { testid: attributes[index + 1]!.slice(0, 200), tag: node.nodeName.toLowerCase() });
        for (const child of node.children ?? []) walk(child);
      };
      walk(root);
      const ax = new Map<number, (typeof nodes)[number]>();
      for (const node of nodes)
        if (node.backendDOMNodeId !== undefined && !ax.has(node.backendDOMNodeId)) ax.set(node.backendDOMNodeId, node);
      const candidates = new Set<number>(testids.keys());
      for (const node of nodes)
        if (!node.ignored && node.backendDOMNodeId !== undefined && INTERACTIVE_ROLES.has(String(node.role?.value ?? '')))
          candidates.add(node.backendDOMNodeId);
      const ordered = [...candidates].sort((a, b) => a - b);
      const elements: AppUiSnapshot['elements'] = [];
      let truncated = false;
      for (const backend of ordered) {
        check(signal);
        const semantic = ax.get(backend);
        const property = (name: string) => semantic?.properties?.find((item) => item.name === name)?.value.value;
        const described = await this.call<{ visible: boolean; disabled: boolean; text: string; value: string | null }>(
          backend,
          FN.describe,
        );
        const visible = !!described?.visible && !semantic?.ignored;
        if (!visible && !options.includeHidden) continue;
        if (elements.length >= options.limit) {
          truncated = true;
          break;
        }
        const ref = `e${elements.length + 1}`;
        const testid = testids.get(backend)?.testid ?? null;
        const checked = property('checked');
        elements.push({
          ref,
          role: String(semantic?.role?.value ?? testids.get(backend)?.tag ?? 'generic').slice(0, 80),
          name: String(semantic?.name?.value ?? '').slice(0, 1000),
          testid,
          text: testid ? (described?.text ?? null) : null,
          value: described?.value ?? null,
          visible,
          disabled: !!described?.disabled || property('disabled') === true,
          focused: property('focused') === true,
          checked:
            checked === 'mixed'
              ? 'mixed'
              : typeof checked === 'boolean'
                ? checked
                : checked === 'true'
                  ? true
                  : checked === 'false'
                    ? false
                    : null,
        });
        refs.set(ref, { backend, generation, epoch });
      }
      if (epoch !== this.epoch || generation !== this.page.identity().documentGeneration)
        throw new AppControlFailure('stale_document', '采集期间页面已导航，请重新快照');
      check(signal);
      const snapshotId = randomUUID();
      snapshot = {
        appInstanceId,
        documentGeneration: generation,
        snapshotId,
        url: this.wc.getURL().slice(0, 4096),
        title: this.wc.getTitle().slice(0, 1000),
        elements,
        truncated,
        coverage: [
          '仅根文档；iframe 与关闭的 shadow root 不在快照内',
          ...(frameTree.childFrames?.length ? ['存在子 frame 未读取'] : []),
          ...(domCount > 20000 ? ['DOM 节点很多，快照可能偏慢'] : []),
        ],
      };
    } finally {
      await this.releaseObjects();
    }
    check(signal);
    if (this.disposed || epoch !== this.epoch || generation !== this.page.identity().documentGeneration)
      throw new AppControlFailure('stale_document', '采集期间页面已变化，请重新快照');
    this.currentSnapshot = { snapshotId: snapshot.snapshotId, refs };
    return snapshot;
  }

  private async resolve(target: AppTargetSelector, generation: number): Promise<number> {
    if ('ref' in target) {
      const entry = this.currentSnapshot?.snapshotId === target.snapshotId ? this.currentSnapshot.refs.get(target.ref) : undefined;
      if (!entry || entry.epoch !== this.epoch || entry.generation !== generation)
        throw new AppControlFailure('stale_ref', `引用 ${target.ref} 已失效，请重新调用 app.ui.snapshot`);
      return entry.backend;
    }
    const matches = await this.findTestid(target.testid);
    if (!matches.length) throw new AppControlFailure('element_not_found', `找不到 data-testid="${target.testid}"`);
    if (matches.length > 1) throw new AppControlFailure('ambiguous_target', `data-testid="${target.testid}" 匹配 ${matches.length} 个元素`);
    return matches[0]!;
  }
  private async findTestid(testid: string): Promise<number[]> {
    // testid 已由协议限定为 [A-Za-z0-9_.:-]，不含引号或反斜杠，可安全置于属性选择器的引号内。
    const { root } = await this.send<{ root: { nodeId: number } }>('DOM.getDocument', { depth: 0 });
    const { nodeIds } = await this.send<{ nodeIds: number[] }>('DOM.querySelectorAll', {
      nodeId: root.nodeId,
      selector: `[data-testid="${testid}"]`,
    });
    const backends: number[] = [];
    for (const nodeId of nodeIds.slice(0, 20)) {
      const { node } = await this.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { nodeId });
      backends.push(node.backendNodeId);
    }
    return backends;
  }

  /** 断言与 waitFor 使用的只读查询；testid 不存在返回 count 0。 */
  async query(target: AppTargetSelector, signal?: AbortSignal): Promise<ElementQuery> {
    await this.attach(signal);
    const generation = this.page.identity().documentGeneration;
    const epoch = this.epoch;
    const guard = () => {
      check(signal);
      if (this.page.cdp().state === 'detached') throw new AppControlFailure('cdp_detached', '页面控制已断开');
      if (epoch !== this.epoch || generation !== this.page.identity().documentGeneration)
        throw new AppControlFailure('stale_document', '查询期间页面文档已变化');
    };
    let result: ElementQuery;
    try {
      const backends = 'testid' in target ? await this.findTestid(target.testid) : [await this.resolve(target, generation)];
      guard();
      if (backends.length !== 1) result = { count: backends.length, visible: false, enabled: false, text: null };
      else {
        const described = await this.call<{ visible: boolean; disabled: boolean; text: string }>(backends[0]!, FN.describe);
        result = { count: 1, visible: described.visible, enabled: !described.disabled, text: described.text };
      }
    } finally {
      await this.releaseObjects();
    }
    guard();
    return result;
  }

  async act(
    action: AppUiAction,
    binding: { runId: string; documentGeneration: number },
    signal?: AbortSignal,
  ): Promise<{ documentGeneration: number; navigated: boolean; url: string }> {
    await this.attach(signal);
    if (this.page.picking()) throw new AppControlFailure('paused_by_user', '用户正在页面上点选元素');
    this.gate.assertNotPaused(binding.runId);
    const before = this.page.identity().documentGeneration;
    if (before !== binding.documentGeneration)
      throw new AppControlFailure('stale_document', `页面文档代次已从 ${binding.documentGeneration} 变为 ${before}，请重新快照`);
    this.gate.begin(binding.runId, action.type);
    const epoch = this.epoch;
    const guard = () => {
      check(signal);
      if ('target' in action && action.target && 'ref' in action.target && action.target.snapshotId !== this.currentSnapshot?.snapshotId)
        throw new AppControlFailure('stale_ref', `引用 ${action.target.ref} 已失效，请重新调用 app.ui.snapshot`);
      this.gate.assertNotPaused(binding.runId);
      if (this.page.picking()) throw new AppControlFailure('paused_by_user', '用户正在页面上点选元素');
      if (this.page.cdp().state === 'detached') throw new AppControlFailure('cdp_detached', '页面控制已断开');
      if (epoch !== this.epoch || before !== this.page.identity().documentGeneration)
        throw new AppControlFailure('stale_document', '动作期间页面文档已变化，请重新快照');
    };
    guard();
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const dispatch = <T>(work: () => Promise<T>) => {
      guard();
      return this.gate.dispatch(binding.runId, work);
    };
    try {
      switch (action.type) {
        case 'click': {
          const backend = await this.resolve(action.target, before);
          const point = await this.pointFor(backend, guard);
          await dispatch(async () => {
            await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
            guard();
            try {
              await this.send('Input.dispatchMouseEvent', {
                type: 'mousePressed',
                x: point.x,
                y: point.y,
                button: 'left',
                buttons: 1,
                clickCount: 1,
              });
            } finally {
              // 已发送按下事件后必须配对释放，取消不会留下按住的鼠标。
              await this.send('Input.dispatchMouseEvent', {
                type: 'mouseReleased',
                x: point.x,
                y: point.y,
                button: 'left',
                buttons: 0,
                clickCount: 1,
              });
            }
            check(signal);
          });
          break;
        }
        case 'type': {
          const backend = await this.resolve(action.target, before);
          await this.enabled(backend);
          guard();
          await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: backend });
          guard();
          await this.send('DOM.focus', { backendNodeId: backend });
          guard();
          if (action.clear) await this.call(backend, FN.selectContents, [], guard);
          await dispatch(async () => {
            if (action.text) await this.send('Input.insertText', { text: action.text });
            else if (action.clear) await this.key(KEYS.Backspace!);
          });
          break;
        }
        case 'press': {
          if (action.target) {
            const backend = await this.resolve(action.target, before);
            guard();
            await this.send('DOM.focus', { backendNodeId: backend });
          }
          await dispatch(() => this.key(KEYS[action.key]!));
          break;
        }
        case 'select': {
          const backend = await this.resolve(action.target, before);
          await this.enabled(backend);
          const outcome = await dispatch(() => this.call<string>(backend, FN.selectOption, [action.value], guard));
          if (outcome !== 'ok')
            throw new AppControlFailure(
              'element_not_found',
              outcome === 'not_select' ? '目标不是 <select>' : `没有值为 ${action.value} 的选项`,
            );
          break;
        }
        case 'scroll': {
          if (action.target) {
            const backend = await this.resolve(action.target, before);
            await dispatch(() => this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: backend }));
          } else {
            const { cssLayoutViewport } = await this.send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>(
              'Page.getLayoutMetrics',
            );
            const amount = (action.amount ?? 400) * (action.direction === 'up' ? -1 : 1);
            await dispatch(() =>
              this.send('Input.dispatchMouseEvent', {
                type: 'mouseWheel',
                x: Math.floor(cssLayoutViewport.clientWidth / 2),
                y: Math.floor(cssLayoutViewport.clientHeight / 2),
                deltaX: 0,
                deltaY: amount,
              }),
            );
          }
          break;
        }
        case 'navigate': {
          const current = new URL(this.wc.getURL());
          const next = new URL(action.path, current.origin);
          if (next.origin !== current.origin) throw new AppControlFailure('invalid_request', 'navigate 只允许同源路径');
          await dispatch(() => this.send('Page.navigate', { url: next.href }));
          await this.settle(signal, 10000);
          break;
        }
        case 'waitFor': {
          await this.waitFor(action.target, action.state, action.timeoutMs, signal, binding.runId);
          break;
        }
      }
      if (action.type !== 'navigate' && action.type !== 'waitFor') await this.settle(signal, 2000);
      const after = this.page.identity().documentGeneration;
      return { documentGeneration: after, navigated: after !== before, url: this.wc.getURL() };
    } finally {
      await this.releaseObjects();
    }
  }
  async waitFor(target: AppTargetSelector, state: string, timeoutMs: number, signal?: AbortSignal, runId?: string) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      check(signal);
      // 等待也属于 AI 操控中；用户接管后立即停止。
      if (runId) this.gate.assertNotPaused(runId);
      let found: ElementQuery;
      try {
        found = await this.query(target, signal);
      } catch (error) {
        if (!(error instanceof AppControlFailure) || error.code !== 'element_not_found') throw error;
        found = { count: 0, visible: false, enabled: false, text: null };
      }
      check(signal);
      if (runId) this.gate.assertNotPaused(runId);
      const satisfied =
        state === 'attached'
          ? found.count === 1
          : state === 'detached'
            ? found.count === 0
            : state === 'visible'
              ? found.count === 1 && found.visible
              : state === 'hidden'
                ? found.count === 0 || !found.visible
                : state === 'enabled'
                  ? found.count === 1 && found.enabled
                  : found.count === 1 && !found.enabled;
      if (satisfied) return found;
      if (Date.now() >= deadline) throw new AppControlFailure('wait_timeout', `等待 ${JSON.stringify(target)} 达到 ${state} 超时`);
      await sleep(100, signal);
    }
  }
  private async enabled(backend: number) {
    const described = await this.call<{ visible: boolean; disabled: boolean }>(backend, FN.describe);
    if (described.disabled) throw new AppControlFailure('element_disabled', '目标元素处于禁用状态');
    return described;
  }
  /** 点击坐标由 Main 从盒模型计算，并核对命中节点属于目标，避免点到遮挡层。 */
  private async pointFor(backend: number, guard: () => void) {
    const described = await this.enabled(backend);
    guard();
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: backend });
    if (!described.visible) throw new AppControlFailure('element_obscured', '目标元素不可见');
    const { quads } = await this.send<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId: backend });
    const quad = quads[0];
    if (!quad || quad.length < 8) throw new AppControlFailure('element_obscured', '目标元素没有可点击区域');
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
    const hit = await this.send<{ backendNodeId: number }>('DOM.getNodeForLocation', {
      x: Math.round(x),
      y: Math.round(y),
      includeUserAgentShadowDOM: false,
    });
    if (hit.backendNodeId !== backend) {
      const { object } = await this.send<{ object: { objectId?: string } }>('DOM.resolveNode', {
        backendNodeId: hit.backendNodeId,
        objectGroup: OBJECT_GROUP,
      });
      const inside = object.objectId ? await this.call<boolean>(backend, FN.contains, [{ objectId: object.objectId }]) : false;
      if (!inside) throw new AppControlFailure('element_obscured', '目标元素被其他元素遮挡');
    }
    return { x, y };
  }
  private async key(definition: { key: string; code: string; keyCode: number; text?: string }) {
    const base = {
      key: definition.key,
      code: definition.code,
      windowsVirtualKeyCode: definition.keyCode,
      nativeVirtualKeyCode: definition.keyCode,
    };
    try {
      await this.send('Input.dispatchKeyEvent', {
        type: definition.text ? 'keyDown' : 'rawKeyDown',
        ...base,
        ...(definition.text ? { text: definition.text } : {}),
      });
    } finally {
      // 与鼠标相同，按键释放属于在途动作清理。
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    }
  }
  /** 动作后的短暂收敛：等待由动作触发的加载结束，不把加载中的页面当作稳定。 */
  private async settle(signal: AbortSignal | undefined, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    await sleep(120, signal);
    while (this.wc.isLoading() && Date.now() < deadline) await sleep(50, signal);
  }

  async bridge(request: AppBridgeRequest, signal?: AbortSignal): Promise<AppBridgeResponse> {
    const generation = this.page.identity().documentGeneration;
    const epoch = this.epoch;
    const guard = () => {
      check(signal);
      if (request.op === 'invoke') this.gate.assertNotPaused();
      if (this.page.cdp().state === 'detached') throw new AppControlFailure('cdp_detached', '页面控制已断开');
      if (epoch !== this.epoch || generation !== this.page.identity().documentGeneration)
        throw new AppControlFailure('stale_document', '桥接期间页面文档已变化');
    };
    await this.attach(signal);
    guard();
    let response: AppBridgeResponse;
    try {
      const { result } = await this.send<{ result: { objectId?: string } }>('Runtime.evaluate', {
        expression: 'globalThis',
        objectGroup: OBJECT_GROUP,
        returnByValue: false,
      });
      if (!result.objectId) throw new AppControlFailure('bridge_unavailable', '页面全局对象不可用');
      guard();
      const called = await this.send<{ result: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.callFunctionOn', {
        objectId: result.objectId,
        functionDeclaration: FN.bridge,
        arguments: [{ value: JSON.stringify(request) }],
        returnByValue: true,
        awaitPromise: true,
      });
      guard();
      if (called.exceptionDetails || typeof called.result.value !== 'string' || called.result.value.length > 70000)
        throw new AppControlFailure('bridge_unavailable', '页面桥接未返回有效结果');
      let parsed: unknown;
      try {
        parsed = JSON.parse(called.result.value);
      } catch {
        throw new AppControlFailure('bridge_unavailable', '页面桥接结果不是 JSON');
      }
      const validated = AppBridgeResponseSchema.safeParse(parsed);
      if (!validated.success) throw new AppControlFailure('bridge_unavailable', '页面桥接结果不符合协议');
      if (!validated.data.ok && validated.data.error.message === 'bridge_unavailable')
        throw new AppControlFailure('bridge_unavailable', '页面未挂载 window.__WSL_AGENT__（生产构建或旧模板）');
      response = validated.data;
    } finally {
      await this.releaseObjects();
    }
    guard();
    return response;
  }

  async screenshot(): Promise<Buffer> {
    const image = await this.wc.capturePage();
    const png = image.toPNG();
    if (png.length > 4_000_000) throw new AppControlFailure('budget_exceeded', '截图超过 4 MB');
    return png;
  }
}

function check(signal?: AbortSignal) {
  if (signal?.aborted) throw new AppControlFailure('cancelled', '控制面调用已取消');
}
function sleep(ms: number, signal?: AbortSignal) {
  check(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new AppControlFailure('cancelled', '控制面调用已取消'));
      },
      { once: true },
    );
  });
}
