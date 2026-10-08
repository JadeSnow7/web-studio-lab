import { useEffect, useRef } from 'react';
import { Terminal as Xterm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { WorkbenchResource } from '@wsl/protocol';
import { workspaceCommand } from '../state/workspace';
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
  const host = useRef<HTMLDivElement>(null),
    term = useRef<Xterm | null>(null),
    fit = useRef<FitAddon | null>(null);
  const latest = useRef(resource);
  useEffect(() => {
    latest.current = resource;
  }, [resource]);
  const rendered = useRef({ instanceId: null as string | null, output: '' });
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
    t.textarea?.setAttribute('aria-label', '沙箱终端输入');
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
      rendered.current = { instanceId: null, output: '' };
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
    if (rendered.current.instanceId !== resource.instanceId || !output.startsWith(rendered.current.output)) {
      t.reset();
      t.write(output);
    } else t.write(output.slice(rendered.current.output.length));
    rendered.current = { instanceId: resource.instanceId, output };
    t.options.disableStdin = occluded || resource.terminal?.state !== 'running';
  }, [resource, occluded]);
  const activation = useRef('');
  useEffect(() => {
    const next = `${active}:${visible}:${resource.terminal?.state}`;
    const changed = activation.current !== next;
    activation.current = next;
    if (active && visible) fit.current?.fit();
    // Closing a dialog restores its trigger; only pane activation or connection requests terminal focus.
    if (changed && active && visible && !occluded) term.current?.focus();
  }, [active, visible, occluded, resource.terminal?.state]);
  const running = resource.terminal?.state === 'running',
    busy = resource.terminal?.state === 'starting' || resource.terminal?.state === 'closing';
  return (
    <section className="terminal-panel" aria-label="沙箱终端">
      <div className="terminal-toolbar row space-between gap-8">
        <span role="status">
          {resource.terminal?.sandbox ?? 'sbx'} · {resource.terminal?.cwd ?? '工作目录未读取'} ·{' '}
          {resource.terminal?.state === 'running'
            ? '已连接'
            : resource.terminal?.state === 'closed'
              ? '已关闭，远端进程已退出'
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
            disabled={busy}
            onClick={() =>
              void workspaceCommand(workspaceId, {
                type: 'terminalOpen',
                resourceId: resource.resourceId,
                cols: term.current?.cols ?? 80,
                rows: term.current?.rows ?? 24,
              })
            }
          >
            {busy ? '正在连接或关闭…' : '连接终端'}
          </button>
        )}
      </div>
      {resource.terminal?.error ? <p role="alert">{resource.terminal.error}</p> : null}
      <div className="terminal-surface" ref={host} />
      <p className="muted small terminal-hint">输出最多保留 256 Ki 字符 · 隐藏窗格继续运行</p>
    </section>
  );
}
