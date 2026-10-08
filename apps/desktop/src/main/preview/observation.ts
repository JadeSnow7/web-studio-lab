import { createHash, randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { z } from 'zod';
import type { Observation, ObservationResult, ResourceInstanceIdentity } from '@wsl/protocol';

const Query = z
  .object({
    ref: z.string().optional(),
    text: z.string().max(200).optional(),
    role: z.string().max(80).optional(),
    limit: z.number().int().min(1).max(100).default(30),
  })
  .strict();
const STYLE_PROPERTIES = ['display', 'visibility', 'color', 'background-color', 'font-size', 'font-weight'] as const;
type FrameTree = { frame: { id: string; url?: string }; childFrames?: FrameTree[] };
const FrameTreeSchema: z.ZodType<FrameTree> = z.lazy(() =>
  z
    .object({
      frame: z.object({ id: z.string().min(1), url: z.string().optional() }).passthrough(),
      childFrames: z.array(FrameTreeSchema).optional(),
    })
    .passthrough(),
);
const Limit = z.object({ limit: z.number().int().min(1).max(500).default(200) }).strict();
const Shot = z
  .object({
    x: z.number().int().nonnegative().optional(),
    y: z.number().int().nonnegative().optional(),
    width: z.number().int().min(1).max(4096).optional(),
    height: z.number().int().min(1).max(4096).optional(),
  })
  .strict();
type AXNode = {
  nodeId: string;
  ignored?: boolean;
  backendDOMNodeId?: number;
  frameId?: string;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  properties?: { name: string; value: { value?: unknown } }[];
};
type BrowserObservationTarget = Pick<WebContents, 'id' | 'isDestroyed' | 'getURL' | 'getTitle' | 'isLoading' | 'capturePage'> & {
  removeListener(event: 'did-start-navigation', listener: (event: { url: string; isMainFrame: boolean }) => void): unknown;
  removeListener(event: 'console-message', listener: (event: { level: string; message: string }) => void): unknown;
  removeListener(event: 'destroyed', listener: () => void): unknown;
  on(event: 'did-start-navigation', listener: (event: { url: string; isMainFrame: boolean }) => void): unknown;
  on(event: 'console-message', listener: (event: { level: string; message: string }) => void): unknown;
  on(event: 'destroyed', listener: () => void): unknown;
  debugger: Pick<WebContents['debugger'], 'attach' | 'isAttached' | 'sendCommand'> & {
    removeListener(event: 'detach', listener: (event: unknown, reason: string) => void): unknown;
    removeListener(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>) => void): unknown;
    on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown;
    on(event: 'message', listener: (event: unknown, method: string, params: Record<string, unknown>) => void): unknown;
  };
};
/** One provider per actual WebContents. Never reopens the URL or mutates its page. */
export class BrowserObservation {
  private generation = randomUUID();
  private epoch = 0;
  private refs = new Map<string, { backend: number; epoch: number; frame: string }>();
  private events: { sequence: number; capturedAt: string; type: string; data: unknown }[] = [];
  private sequence = 0;
  private readonly startedAt = new Date().toISOString();
  private networkStartedAt: string | null = null;
  private disposed = false;
  private readonly releaseListeners: (() => void)[] = [];
  private readonly identity: ResourceInstanceIdentity;
  constructor(
    private readonly wc: BrowserObservationTarget,
    identity: ResourceInstanceIdentity,
  ) {
    this.identity = Object.freeze({ ...identity });
    const invalidate = () => {
      this.epoch++;
      this.refs.clear();
    };
    const onNavigation = (event: { url: string; isMainFrame: boolean }) => {
      invalidate();
      this.event('navigation', { url: event.url, isMainFrame: event.isMainFrame });
    };
    wc.on('did-start-navigation', onNavigation);
    wc.on('destroyed', invalidate);
    const onDetach = (_event: unknown, reason: string) => {
      invalidate();
      this.generation = randomUUID();
      this.networkStartedAt = null;
      this.event('detach', { reason });
    };
    wc.debugger.on('detach', onDetach);
    const onConsole = (event: { level: string; message: string }) => {
      if (event.level === 'error' || event.level === 'warning')
        this.event('console', { level: event.level, message: event.message.slice(0, 4000) });
    };
    wc.on('console-message', onConsole);
    const onMessage = (_event: unknown, method: string, params: Record<string, unknown>) => {
      if (method === 'Page.frameDetached' || method === 'Page.frameNavigated') invalidate();
      if (method === 'Runtime.exceptionThrown' || method === 'Network.loadingFailed') this.event(method, params);
      if (method === 'Network.responseReceived') {
        const response = params.response as { url?: string; status?: number };
        this.event('response', { url: response.url, status: response.status });
      }
    };
    wc.debugger.on('message', onMessage);
    this.releaseListeners.push(
      () => wc.removeListener('did-start-navigation', onNavigation),
      () => wc.removeListener('destroyed', invalidate),
      () => wc.removeListener('console-message', onConsole),
      () => wc.debugger.removeListener('detach', onDetach),
      () => wc.debugger.removeListener('message', onMessage),
    );
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch++;
    this.refs.clear();
    this.events = [];
    for (const release of this.releaseListeners.splice(0)) release();
  }
  private event(type: string, data: unknown) {
    const encoded = JSON.stringify(data);
    if (encoded.length > 4000) data = { truncated: true, text: encoded.slice(0, 4000) };
    this.events.push({ sequence: ++this.sequence, capturedAt: new Date().toISOString(), type, data });
    if (this.events.length > 500) this.events.shift();
  }
  source() {
    return {
      resource: this.identity,
      generation: this.generation,
      capabilities: ['snapshot', 'query', 'screenshot', 'read_events'],
      status: this.disposed || this.wc.isDestroyed() ? 'closed' : 'available',
      target: { webContentsId: this.wc.id },
    };
  }
  private result(
    source: string,
    data: Record<string, unknown>,
    reasons: string[] = [],
    snapshotId = randomUUID(),
    range?: Record<string, unknown>,
  ): Observation {
    const body = JSON.stringify(data);
    return {
      resource: this.identity,
      generation: this.generation,
      revision: { value: createHash('sha256').update(body).digest('hex'), strength: 'content-hash' },
      snapshotId,
      capturedAt: new Date().toISOString(),
      source,
      representation: source === 'screenshot' ? 'image/png' : 'json',
      coverage: { status: reasons.length ? 'partial' : 'complete', reasons, ...(range ? { range } : {}) },
      data,
    };
  }
  private async attach() {
    if (!this.wc.debugger.isAttached()) this.wc.debugger.attach('1.3');
    if (!this.networkStartedAt) this.networkStartedAt = new Date().toISOString();
    await Promise.all(
      ['Page.enable', 'Runtime.enable', 'Network.enable', 'Accessibility.enable'].map((method) => this.wc.debugger.sendCommand(method)),
    );
  }
  private async styles(
    backendNodeId: number,
    assertActive: () => void,
  ): Promise<{ values: Record<string, string> | null; reason?: string }> {
    try {
      // CSS requires a frontend DOM node ID. These fixed read-only protocol calls
      // expose no evaluation hook, selector code, style mutation or arbitrary CDP.
      assertActive();
      await this.wc.debugger.sendCommand('DOM.enable');
      assertActive();
      await this.wc.debugger.sendCommand('DOM.getDocument', { depth: 0 });
      assertActive();
      const pushed = await this.wc.debugger.sendCommand('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendNodeId] });
      const nodeId: unknown = pushed.nodeIds?.[0];
      if (typeof nodeId !== 'number' || nodeId <= 0) return { values: null, reason: 'computed_style_node_unavailable' };
      assertActive();
      await this.wc.debugger.sendCommand('CSS.enable');
      assertActive();
      const response = await this.wc.debugger.sendCommand('CSS.getComputedStyleForNode', { nodeId });
      const properties = z.array(z.object({ name: z.string(), value: z.string() })).parse(response.computedStyle);
      const values: Record<string, string> = {};
      for (const name of STYLE_PROPERTIES) {
        const property = properties.find((item) => item.name === name);
        if (property) values[name] = property.value.slice(0, 1000);
      }
      return { values, ...(Object.keys(values).length < STYLE_PROPERTIES.length ? { reason: 'some_computed_styles_unavailable' } : {}) };
    } catch {
      return { values: null, reason: 'computed_styles_unavailable_for_node' };
    }
  }
  async observe(tool: string, args: Record<string, unknown>, workspaceId: string, signal?: AbortSignal): Promise<ObservationResult> {
    if (!['browser.snapshot', 'browser.query', 'browser.screenshot', 'browser.read_events'].includes(tool))
      return { error: 'unsupported', message: 'Unsupported browser observation' };
    if (workspaceId !== this.identity.workspaceId) return { error: 'unauthorized', message: 'Resource belongs to another workspace' };
    if (this.disposed) return { error: 'unavailable', message: 'Browser observer disposed' };
    if (signal?.aborted) return { error: 'cancelled', message: 'Browser observation cancelled' };
    let settled = false;
    const assertActive = () => {
      if (settled || this.disposed || signal?.aborted) throw new Error('Browser observation no longer active');
    };
    let abortListener: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.read(tool, args, assertActive).then((result) => {
          assertActive();
          return result;
        }),
        new Promise<ObservationResult>((resolve) => {
          abortListener = () => resolve({ error: 'cancelled', message: 'Browser observation cancelled' });
          signal?.addEventListener('abort', abortListener, { once: true });
        }),
        new Promise<ObservationResult>((resolve) => {
          timer = setTimeout(() => resolve({ error: 'timeout', message: 'Browser observation exceeded 5 seconds' }), 5000);
        }),
      ]);
    } catch (error) {
      return {
        error: signal?.aborted ? 'cancelled' : error instanceof z.ZodError ? 'invalid_request' : 'unavailable',
        message: error instanceof Error ? error.message : String(error),
      };
    } finally {
      settled = true;
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      if (timer) clearTimeout(timer);
    }
  }
  private async read(tool: string, args: Record<string, unknown>, assertActive: () => void): Promise<ObservationResult> {
    if (this.wc.isDestroyed()) return { error: 'not_found', message: 'Browser target closed' };
    assertActive();
    const epoch = this.epoch;
    await this.attach();
    assertActive();
    if (epoch !== this.epoch) return { error: 'unstable', message: 'Document changed during attachment' };
    if (tool === 'browser.read_events') {
      const { limit } = Limit.parse(args);
      return this.result(
        'runtime-events',
        {
          events: this.events.slice(-Math.min(limit, 25)),
          requestedLimit: limit,
          resultLimit: 25,
          collectionStartedAt: this.startedAt,
          networkCollectionStartedAt: this.networkStartedAt,
          networkCoverage: 'since most recent CDP attachment; detach intervals are gaps',
          oldestSequence: this.events[0]?.sequence,
        },
        ['Bounded event history; events before observation attachment are unavailable'],
      );
    }
    if (tool === 'browser.screenshot') {
      const clip = Shot.parse(args);
      const hasClip = clip.width !== undefined && clip.height !== undefined;
      if (Object.keys(clip).length && !hasClip) return { error: 'invalid_request', message: 'Region requires width and height' };
      const image = await this.wc.capturePage(
        hasClip ? { x: clip.x ?? 0, y: clip.y ?? 0, width: clip.width!, height: clip.height! } : undefined,
      );
      assertActive();
      if (epoch !== this.epoch) return { error: 'unstable', message: 'Navigation occurred during capture' };
      const size = image.getSize();
      if (size.width * size.height > 16777216 || image.toPNG().length > 700000)
        return { error: 'unavailable', message: 'Image exceeds pixel budget' };
      return this.result('screenshot', {
        target: this.wc.id,
        ...size,
        dataUrl: image.toDataURL(),
        region: hasClip ? clip : 'viewport',
      });
    }
    if (tool === 'browser.query' && typeof args.ref === 'string') {
      const query = Query.parse(args);
      const ref = this.refs.get(query.ref!);
      if (!ref || ref.epoch !== epoch) return { error: 'stale_ref', message: 'Element reference expired; take a new snapshot' };
      const [semantic, dom, box, styles] = await Promise.all([
        this.wc.debugger.sendCommand('Accessibility.getPartialAXTree', { backendNodeId: ref.backend, fetchRelatives: false }),
        this.wc.debugger.sendCommand('DOM.describeNode', { backendNodeId: ref.backend, depth: 0 }),
        this.wc.debugger.sendCommand('DOM.getBoxModel', { backendNodeId: ref.backend }).catch(() => null),
        this.styles(ref.backend, assertActive),
      ]);
      assertActive();
      if (epoch !== this.epoch) return { error: 'stale_ref', message: 'Document changed during query' };
      const node = semantic.nodes?.[0] as AXNode | undefined;
      const attrs = dom.node?.attributes as string[] | undefined;
      const attributes: Record<string, string> = {};
      for (let i = 0; i < (attrs?.length ?? 0); i += 2)
        if (['type', 'role', 'aria-label', 'name'].includes(attrs![i]!)) attributes[attrs![i]!] = attrs![i + 1]!.slice(0, 1000);
      const secret = attributes.type === 'password' || node?.properties?.some((p) => p.name === 'protected' && p.value.value === true);
      return this.result(
        'dom-element',
        {
          ref: query.ref,
          frameId: ref.frame,
          role: node?.role?.value,
          name: node?.name?.value?.slice(0, 2000),
          value: secret ? '[redacted]' : String(node?.value?.value ?? '').slice(0, 8000),
          attributes,
          box: box?.model ?? null,
          computedStyles: styles.values,
          computedStyleProperties: STYLE_PROPERTIES,
        },
        ['Native CDP DOM and accessibility values only; password values redacted', ...(styles.reason ? [styles.reason] : [])],
        undefined,
        { coveredFrameIds: [ref.frame], elementRef: query.ref, computedStyleProperties: STYLE_PROPERTIES },
      );
    }
    const query = tool === 'browser.query' ? Query.parse(args) : null;
    const limit = query?.limit ?? Limit.parse(args).limit;
    const frameResponse = await this.wc.debugger.sendCommand('Page.getFrameTree');
    assertActive();
    const frameTree = FrameTreeSchema.parse(frameResponse.frameTree);
    const rootFrameId = frameTree.frame.id;
    // getFullAXTree is explicitly scoped to this frame. AXNode.frameId is optional
    // (typically present only on the document root), so omitted IDs inherit the
    // requested frame, never an inferred URL/title or a different target.
    const { nodes } = (await this.wc.debugger.sendCommand('Accessibility.getFullAXTree', { frameId: rootFrameId })) as { nodes: AXNode[] };
    assertActive();
    const childFrameIds: string[] = [];
    const pendingFrames = [...(frameTree.childFrames ?? [])];
    while (pendingFrames.length) {
      const frame = pendingFrames.shift();
      if (!frame) break;
      childFrameIds.push(frame.frame.id);
      pendingFrames.push(...(frame.childFrames ?? []));
    }
    const frameCoverage = {
      coveredFrameIds: [rootFrameId],
      missingFrameIds: [...new Set(childFrameIds)],
      frameMappingSource: 'Page.getFrameTree + Accessibility.getFullAXTree(frameId)',
      missingFrameReason: 'Child frame accessibility trees are not queried by this adapter',
    };
    const snapshotId = randomUUID();
    const rows = nodes
      .filter((n) => !n.ignored)
      .filter((n) => (!query?.text || String(n.name?.value ?? '').includes(query.text)) && (!query?.role || n.role?.value === query.role));
    const elements = rows.slice(0, Math.min(limit, 100)).map((n) => {
      const frameId = n.frameId ?? rootFrameId;
      const ref = `${this.wc.id}:${frameId}:${epoch}:${snapshotId}:${n.nodeId}`;
      const canReference = n.backendDOMNodeId !== undefined && frameId === rootFrameId;
      if (canReference && n.backendDOMNodeId !== undefined) this.refs.set(ref, { backend: n.backendDOMNodeId, epoch, frame: frameId });
      const password = n.properties?.some((p) => p.name === 'protected' && p.value.value === true);
      return {
        ref: canReference ? ref : undefined,
        frameId,
        frameMappingSource: n.frameId ? 'AXNode.frameId' : 'getFullAXTree.frameId',
        role: n.role?.value,
        name: n.name?.value?.slice(0, 1000),
        value: password ? '[redacted]' : typeof n.value?.value === 'string' ? n.value.value.slice(0, 1000) : n.value?.value,
        states: n.properties?.filter((p) => ['checked', 'disabled', 'expanded', 'focused', 'selected', 'required'].includes(p.name)),
      };
    });
    if (this.refs.size > 2000) {
      const keep = [...this.refs.entries()].slice(-1000);
      this.refs = new Map(keep);
    }
    if (epoch !== this.epoch) return { error: 'unstable', message: 'Navigation occurred during semantic capture' };
    return this.result(
      'accessibility',
      {
        target: { webContentsId: this.wc.id },
        documentGeneration: epoch,
        url: this.wc.getURL(),
        title: this.wc.getTitle(),
        loading: this.wc.isLoading(),
        frames: frameTree,
        frameCoverage,
        elements,
      },
      [
        ...(rows.length > Math.min(limit, 100) ? ['result_limit'] : []),
        ...frameCoverage.missingFrameIds.map((id) => `frame_not_read:${id}`),
        'Accessibility tree queried only for the root frame; iframe documents are outside this snapshot',
        'Canvas pixels require screenshot; virtualized content includes rendered items only',
        'Closed shadow roots may omit semantics',
      ],
      snapshotId,
      frameCoverage,
    );
  }
}
