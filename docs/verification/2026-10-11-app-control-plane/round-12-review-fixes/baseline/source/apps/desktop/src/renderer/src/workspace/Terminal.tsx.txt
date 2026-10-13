import { useEffect, useRef, useState } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { WorkbenchResource } from '@wsl/protocol';
import { useStore } from '../lib/store';
import { workspaceCommand, workspaceStore } from '../state/workspace';
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
  const environment = useStore(workspaceStore, (state) =>
    state.snapshot?.environments.find((environment) => environment.environmentId === resource.environmentId),
  );
  const unavailable =
    resource.unavailableReason ?? (!environment?.capabilities.terminal ? (environment?.reason ?? '环境能力尚未核对或终端未配置') : null);
  const host = useRef<HTMLDivElement>(null),
    term = useRef<Xterm | null>(null),
    fit = useRef<FitAddon | null>(null);
  const latest = useRef(resource);
  useEffect(() => {
    latest.current = resource;
  }, [resource]);
  const rendered = useRef<RenderedTerminal>({ instanceId: null, sessionId: null, output: '', offset: 0 });
  const [truncated, setTruncated] = useState(false);
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
    if (delta.gap) setTruncated(true);
    else if (delta.reset) setTruncated(false);
    rendered.current = next;
    t.options.disableStdin = occluded || resource.terminal?.state !== 'running';
  }, [resource, occluded]);
  const activation = useRef('');
  useEffect(() => {
    const next = `${active}:${visible}`;
    const changed = activation.current !== next;
    activation.current = next;
    if (active && visible) fit.current?.fit();
    // Runtime readiness must not override focus chosen after a connection request.
    if (changed && active && visible && !occluded) term.current?.focus();
  }, [active, visible, occluded]);
  const running = resource.terminal?.state === 'running',
    busy = resource.terminal?.state === 'starting' || resource.terminal?.state === 'closing';
  return (
    <section className="terminal-panel" aria-label="资源终端">
      <div className="terminal-toolbar row space-between gap-8">
        <span role="status">
          {resource.environmentId ?? '未绑定环境'}
          {resource.terminal?.sandbox ? ` / ${resource.terminal.sandbox}` : ''} · {resource.terminal?.cwd ?? '工作目录未读取'} ·{' '}
          {resource.terminal?.state === 'running'
            ? '已连接'
            : resource.terminal?.state === 'closed'
              ? '已关闭，所属进程已确认退出'
              : resource.terminal?.state === 'failed'
                ? '连接失败'
                : (resource.terminal?.state ?? '尚未连接')}
        </span>
        {running ? (
          <div className="row gap-8">
            <button
              type="button"
              className="btn"
              onClick={() =>
                void workspaceCommand(workspaceId, {
                  type: 'terminalWrite',
                  resourceId: resource.resourceId,
                  instanceId: resource.instanceId!,
                  data: '\u0003',
                })
              }
            >
              中断（Ctrl-C）
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void workspaceCommand(workspaceId, {
                  type: 'stopInstance',
                  resourceId: resource.resourceId,
                  instanceId: resource.instanceId!,
                })
              }
            >
              关闭终端
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy || !resource.environmentId || !!unavailable}
            onClick={() => {
              term.current?.focus();
              void workspaceCommand(workspaceId, {
                type: 'terminalOpen',
                resourceId: resource.resourceId,
                cols: term.current?.cols ?? 80,
                rows: term.current?.rows ?? 24,
              });
            }}
          >
            {busy ? '正在连接或关闭…' : '连接终端'}
          </button>
        )}
      </div>
      {resource.terminal?.error ? <p role="alert">{resource.terminal.error}</p> : null}
      {unavailable ? <p role="status">{unavailable}</p> : null}
      {truncated ? <p role="status">未读输出已超出保留窗口；已从当前窗口重建显示。</p> : null}
      <div className="terminal-surface" ref={host} />
      <p className="muted small terminal-hint">输出最多保留 256 Ki 字符 · 隐藏窗格继续运行</p>
    </section>
  );
}
