import { useEffect, useMemo, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { StatusScope, WorkbenchResource } from '@wsl/protocol';
import { Icon } from '../components/Icon';
import { StatusDot, StatusSlot } from '../components/Status';
import { ackScope, statusPresentationActions, useStatusViewByKey, type StatusView } from '../state/status-view';
import { workspaceCommand } from '../state/workspace';
import { terminalDelta, type RenderedTerminal } from './presentation';
import '@xterm/xterm/css/xterm.css';

export function Terminal({
  workspaceId,
  resource,
  active,
  visible,
  occluded,
  theme,
}: {
  workspaceId: string;
  resource: WorkbenchResource;
  active: boolean;
  visible: boolean;
  occluded: boolean;
  theme: string;
}) {
  const { resourceId } = resource;
  const scope = useMemo<StatusScope>(() => ({ kind: 'resource', workspaceId, resourceId }), [workspaceId, resourceId]);
  // 状态文案与「不可用」判断都来自事实层（terminal:<id>:state / :unavailable）；组件不再自行推导。
  const stateView = useStatusViewByKey(scope, `terminal:${resourceId}:state`);
  const unavailable = useStatusViewByKey(scope, `terminal:${resourceId}:unavailable`);
  const host = useRef<HTMLDivElement>(null),
    term = useRef<Xterm | null>(null),
    fit = useRef<FitAddon | null>(null);
  const latest = useRef(resource);
  useEffect(() => {
    latest.current = resource;
  }, [resource]);
  const rendered = useRef<RenderedTerminal>({ instanceId: null, sessionId: null, output: '', offset: 0 });
  useEffect(() => {
    const t = new Xterm({
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(),
      fontSize: 13,
      screenReaderMode: true,
      cursorBlink: true,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    t.textarea?.setAttribute('aria-label', '终端输入');
    term.current = t;
    fit.current = f;
    const input = t.onData((data) => {
      const r = latest.current;
      if (r.instanceId && r.terminal?.state === 'running')
        void workspaceCommand(workspaceId, { type: 'terminalWrite', resourceId: r.resourceId, instanceId: r.instanceId, data });
    });
    const resize = t.onResize(({ cols, rows }) => {
      const r = latest.current;
      if (r.instanceId && r.terminal?.state === 'running')
        void workspaceCommand(workspaceId, { type: 'terminalResize', resourceId: r.resourceId, instanceId: r.instanceId, cols, rows });
    });
    const observer = new ResizeObserver(() => {
      if (host.current?.clientWidth && host.current.clientHeight) f.fit();
    });
    observer.observe(host.current!);
    return () => {
      observer.disconnect();
      input.dispose();
      resize.dispose();
      t.dispose();
      term.current = null;
      rendered.current = { instanceId: null, sessionId: null, output: '', offset: 0 };
    };
  }, [workspaceId, resource.resourceId]);
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    const syncTheme = () => {
      const css = getComputedStyle(document.documentElement);
      t.options.theme = {
        background: css.getPropertyValue('--content').trim(),
        foreground: css.getPropertyValue('--text').trim(),
        cursor: css.getPropertyValue('--accent').trim(),
        selectionBackground: css.getPropertyValue('--accent-soft').trim(),
      };
    };
    syncTheme();
    // The workbench resolves system theme on the shared root after child effects.
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, [theme]);
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    const output = resource.terminal?.output ?? '';
    const next = {
      instanceId: resource.instanceId,
      sessionId: resource.terminal?.sessionId ?? null,
      output,
      offset: resource.terminal?.outputOffset ?? 0,
    };
    const delta = terminalDelta(rendered.current, next);
    if (delta.reset) t.reset();
    if (delta.text) t.write(delta.text);
    if (delta.gap)
      statusPresentationActions.setTerminalGap(resource.resourceId, { instanceId: resource.instanceId, sessionId: next.sessionId });
    else if (delta.reset) statusPresentationActions.clearTerminalGap(resource.resourceId);
    rendered.current = next;
    t.options.disableStdin = occluded || resource.terminal?.state !== 'running';
  }, [resource, occluded]);
  // 标签激活 / 连接引起的程序性聚焦不是用户与窗格交互：focus() 同步派发 focusin，用标记让 onFocusCapture 跳过这一次。
  const programmaticFocus = useRef(false);
  const focusTerminal = () => {
    programmaticFocus.current = true;
    try {
      term.current?.focus();
    } finally {
      programmaticFocus.current = false;
    }
  };
  const activation = useRef('');
  useEffect(() => {
    const next = `${active}:${visible}`;
    const changed = activation.current !== next;
    activation.current = next;
    if (active && visible) fit.current?.fit();
    // Runtime readiness must not override focus chosen after a connection request.
    if (changed && active && visible && !occluded) focusTerminal();
  }, [active, visible, occluded]);
  const running = resource.terminal?.state === 'running',
    busy = resource.terminal?.state === 'starting' || resource.terminal?.state === 'closing';
  const connect = () => {
    focusTerminal();
    void workspaceCommand(workspaceId, {
      type: 'terminalOpen',
      resourceId: resource.resourceId,
      cols: term.current?.cols ?? 80,
      rows: term.current?.rows ?? 24,
    });
  };
  const onAction = (view: StatusView) => {
    if (view.action?.id === 'terminal.connect' && !view.action.disabled) connect();
  };
  // 与窗格交互（点击、按键、终端获得焦点）后确认其中的 confirmation；unresolved / progress 不受影响。
  const acknowledge = () => ackScope(scope);
  // 鼠标点击按钮引起的焦点不算（会在 click 里确认；mousedown 时确认会让槽高度变化、点击落空）；键盘 / 文本输入的焦点才算。
  const acknowledgeFocus = (event: React.FocusEvent<HTMLElement>) => {
    if (!programmaticFocus.current && event.target.matches(':focus-visible')) acknowledge();
  };
  const cwd = resource.terminal?.cwd ?? null;
  const cwdTail = cwd ? (cwd.split('/').filter(Boolean).at(-1) ?? cwd) : null;
  const origin = [resource.terminal?.sandbox, cwd].filter(Boolean).join(' · ');
  return (
    <section
      className="terminal-panel"
      aria-label="资源终端"
      onClickCapture={acknowledge}
      onKeyDownCapture={acknowledge}
      onFocusCapture={acknowledgeFocus}
    >
      <div className="terminal-toolbar row space-between gap-8">
        <span className="terminal-capsule" title={origin || undefined}>
          <span className="terminal-capsule-text">
            {resource.environmentId ?? '未绑定环境'}
            {cwdTail ? ` · ${cwdTail}` : ''}
          </span>
          {/* 沙箱全名与绝对 cwd 不外露，但保留在视觉隐藏文本里（悬停 title 同内容）。 */}
          {origin ? <span className="sr-only">{origin}</span> : null}
          {stateView ? <StatusDot view={stateView} /> : null}
        </span>
        {running ? (
          <div className="row gap-8">
            <button
              type="button"
              className="icon-btn"
              aria-label="中断（Ctrl-C）"
              title="中断（Ctrl-C）"
              onClick={() =>
                void workspaceCommand(workspaceId, {
                  type: 'terminalWrite',
                  resourceId: resource.resourceId,
                  instanceId: resource.instanceId!,
                  data: '\u0003',
                })
              }
            >
              <Icon name="stop" size={16} />
            </button>
            <button
              type="button"
              className="icon-btn"
              aria-label="关闭终端"
              title="关闭终端"
              disabled={busy}
              onClick={() =>
                void workspaceCommand(workspaceId, {
                  type: 'stopInstance',
                  resourceId: resource.resourceId,
                  instanceId: resource.instanceId!,
                })
              }
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        ) : (
          <button type="button" className="btn" disabled={busy || !resource.environmentId || !!unavailable} onClick={connect}>
            连接终端
          </button>
        )}
      </div>
      {/* 连接动作只在工具栏出现一次，槽里不重复渲染同名按钮。 */}
      <StatusSlot scope={scope} onAction={onAction} omitActions={['terminal.connect']} />
      <div className="terminal-surface" ref={host} />
    </section>
  );
}
