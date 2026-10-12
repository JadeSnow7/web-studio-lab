import { useEffect, useMemo, useRef, useState } from 'react';
import type { DebugStatusSnapshot, StatusDomain, StatusFact, StatusTransition, WorkbenchSnapshot } from '@wsl/protocol';
import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import {
  KIND_ORDER,
  debugActions,
  debugStore,
  describeCapture,
  groupFacts,
  kindCounts,
  matchesFilter,
  useRendererViews,
  type DebugFilter,
} from '../state/debug';
import { reportError } from '../state/errors';
import { panes, workspaceStore } from '../state/workspace';

/*
 * 诊断面板（status-interface.md §8.3）：事实（按 domain 分组，含白名单 raw）、转换时间线、
 * 以及「当前会话现场（不可导出）」。仅当 preload 暴露 `studio.debug`（Main 启用诊断通道）时可打开。
 * 复制 JSON 只复制 Main 已脱敏的事实与转换；会话现场只在面板内显示，来自 Renderer 已有的会话快照，不发送到 Main。
 */

export function DebugPanel() {
  const open = useStore(debugStore, (s) => s.open);
  return open ? <DebugDialog /> : null;
}

const TIMELINE_LIMIT = 100;

const timeOf = (at: string) => {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? at : date.toLocaleTimeString('zh-CN', { hour12: false });
};
const endpoint = (value: StatusTransition['from']) => (value ? `${value.phase}/${value.kind}` : 'null');

/** 复制：优先异步剪贴板 API；权限不可用时回退到选区复制，两者都失败才报错。 */
async function copyText(text: string, host: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // 回退到 execCommand；失败由下面统一报告。
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  host.appendChild(area);
  try {
    area.select();
    if (!document.execCommand('copy')) throw new Error('剪贴板不可用');
  } finally {
    area.remove();
  }
}

function DebugDialog() {
  const ref = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<DebugStatusSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<DebugFilter>({ domain: 'all', kind: 'all' });
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const views = useRendererViews();

  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      else document.querySelector<HTMLButtonElement>('[aria-label="切换空间"]')?.focus();
    };
  }, []);

  // 实时订阅：每条转换到达后重新读取（读取合并，避免并发请求乱序）。
  useEffect(() => {
    const debug = window.studio.debug;
    if (!debug) return;
    let active = true;
    let running = false;
    let again = false;
    const load = async () => {
      if (running) {
        again = true;
        return;
      }
      running = true;
      try {
        do {
          again = false;
          const next = await debug.status();
          if (active) {
            setData(next);
            setLoadError(null);
          }
        } while (again && active);
      } catch (error) {
        if (active) setLoadError(error instanceof Error ? error.message : String(error));
      } finally {
        running = false;
      }
    };
    void load();
    const unsubscribe = debug.onTransition(() => void load());
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const facts = useMemo(() => data?.facts ?? [], [data]);
  const counts = kindCounts(facts);
  const domains = useMemo(() => [...new Set(facts.map((fact) => fact.domain))], [facts]);
  const groups = useMemo(() => groupFacts(facts.filter((fact) => matchesFilter(filter, fact))), [facts, filter]);
  const selected = facts.find((fact) => fact.key === selectedKey) ?? null;
  const timeline = useMemo(
    () =>
      (data?.transitions ?? [])
        .filter((transition) => matchesFilter(filter, { key: transition.key, kind: (transition.to ?? transition.from)!.kind }))
        .slice(-TIMELINE_LIMIT)
        .reverse(),
    [data, filter],
  );

  const copy = async () => {
    const debug = window.studio.debug;
    if (!debug || !ref.current) return;
    try {
      // 复制的是 Main 已脱敏的快照，不含会话现场。
      await copyText(JSON.stringify(await debug.status(), null, 2), ref.current);
      setCopied(true);
    } catch (error) {
      setCopied(false);
      reportError('复制诊断 JSON', error);
    }
  };

  return (
    <dialog
      ref={ref}
      className="debug-panel"
      aria-label="诊断"
      onCancel={(event) => {
        event.preventDefault();
        debugActions.close();
      }}
    >
      <header className="debug-head">
        <strong>诊断 · 状态</strong>
        <code className="debug-meta">{data ? `appInstanceId ${data.appInstanceId} · seq ${data.seq}` : '正在读取…'}</code>
        <span className="debug-spacer" />
        <button type="button" className="btn" onClick={() => void copy()}>
          复制 JSON（已脱敏）
        </button>
        <span role="status" className="muted small">
          {copied ? '已复制（已脱敏）' : ''}
        </span>
        <button type="button" className="icon-btn" aria-label="关闭诊断" onClick={debugActions.close}>
          <Icon name="close" size={15} />
        </button>
      </header>
      {loadError ? (
        <p role="alert" className="debug-error">
          诊断数据读取失败：{loadError}
        </p>
      ) : null}
      <div className="debug-filters">
        <div role="radiogroup" aria-label="种类" className="debug-kinds">
          {(['all', ...KIND_ORDER] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              role="radio"
              aria-checked={filter.kind === kind}
              onClick={() => setFilter((current) => ({ ...current, kind }))}
            >
              {kind === 'all' ? '全部' : kind} · {counts[kind]}
            </button>
          ))}
        </div>
        <label className="debug-domain">
          domain
          <select
            value={filter.domain}
            onChange={(event) => setFilter((current) => ({ ...current, domain: event.target.value as StatusDomain | 'all' }))}
          >
            <option value="all">全部</option>
            {domains.map((domain) => (
              <option key={domain} value={domain}>
                {domain}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="debug-body">
        <section className="debug-facts" aria-label="事实">
          {groups.length ? (
            groups.map((group) => (
              <div key={group.domain} className="debug-group">
                <h3>
                  {group.domain} · {group.facts.length}
                </h3>
                <table>
                  <thead>
                    <tr>
                      <th>种类</th>
                      <th>key</th>
                      <th>phase</th>
                      <th>通道</th>
                      <th>label</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.facts.map((fact) => (
                      <FactRow
                        key={fact.key}
                        fact={fact}
                        channel={views.get(fact.key)?.channel ?? '—'}
                        selected={fact.key === selectedKey}
                        onSelect={() => setSelectedKey(fact.key)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            ))
          ) : (
            <p className="muted">{data ? '没有符合过滤条件的事实。' : '正在读取…'}</p>
          )}
        </section>
        <div className="debug-side">
          <FactDetail fact={selected} view={selected ? views.get(selected.key) : undefined} />
          <section aria-label="转换时间线" className="debug-timeline">
            <strong>最近转换</strong>
            {timeline.length ? (
              <ol>
                {timeline.map((transition) => (
                  <li key={transition.seq}>
                    {timeOf(transition.at)} · <code>{transition.key}</code> · {endpoint(transition.from)} → {endpoint(transition.to)} · seq{' '}
                    {transition.seq}
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted small">暂无转换。</p>
            )}
          </section>
          <SessionField />
        </div>
      </div>
    </dialog>
  );
}

function FactRow({ fact, channel, selected, onSelect }: { fact: StatusFact; channel: string; selected: boolean; onSelect: () => void }) {
  return (
    <tr className={selected ? 'debug-row-selected' : undefined} data-status-key={fact.key}>
      <td>{fact.kind}</td>
      <td>
        <button type="button" className="debug-key" aria-pressed={selected} onClick={onSelect}>
          <code>{fact.key}</code>
        </button>
      </td>
      <td>{fact.phase}</td>
      <td>{channel}</td>
      <td>{fact.label}</td>
    </tr>
  );
}

function FactDetail({ fact, view }: { fact: StatusFact | null; view: { channel: string; visible: boolean } | undefined }) {
  if (!fact) return <p className="muted small">选择左侧一条事实，查看 detail、动作与 raw。</p>;
  return (
    <section aria-label="事实详情" className="debug-detail">
      <strong>{fact.label}</strong>
      <code>
        {fact.key} · phase {fact.phase} · kind {fact.kind} · 通道 {view ? `${view.channel}${view.visible ? '' : '（折叠）'}` : '—'}
      </code>
      {fact.detail ? <span className="small">detail：{fact.detail}</span> : null}
      {fact.action ? (
        <span className="small">
          动作：{fact.action.label} → <code>{fact.action.id}</code>
          {fact.action.disabled ? '（禁用）' : ''}
        </span>
      ) : null}
      <pre aria-label={`raw（${fact.domain} 白名单）`}>{JSON.stringify(fact.raw, null, 2)}</pre>
    </section>
  );
}

/* ---------- 当前会话现场（不可导出） ---------- */

function activeSessionId(workspace: WorkbenchSnapshot['workspaces'][number]): string | undefined {
  const pane = panes(workspace.layout).find((item) => item.paneId === workspace.activePaneId);
  const tab = workspace.tabs.find((item) => item.tabId === pane?.tabId);
  const active = tab?.targetRef.kind === 'session' ? workspace.sessions.find((s) => s.resourceId === tab.targetRef.resourceId) : undefined;
  return (active ?? workspace.sessions.find((s) => s.context) ?? workspace.sessions[0])?.sessionId;
}

/**
 * 原产品界面中的页面现场 JSON、各类 ID、evidenceRef 与执行绑定。
 * 数据来自 Renderer 已有的 workbench 快照；这里不调用任何 IPC，也不写入剪贴板或日志。
 */
function SessionField() {
  const snapshot = useStore(workspaceStore, (s) => s.snapshot);
  const selectedId = useStore(workspaceStore, (s) => s.selectedId);
  const workspace = snapshot?.workspaces.find((w) => w.workspaceId === selectedId);
  const [expanded, setExpanded] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [entry, setEntry] = useState('current');
  const current = workspace?.sessions.find((s) => s.sessionId === (sessionId ?? (workspace ? activeSessionId(workspace) : undefined)));
  const entries = current
    ? [
        { id: 'current', label: '当前现场', capture: current.context },
        ...current.taskVersions.map((version, index) => ({
          id: version.taskVersionId,
          label: `任务 v${index + 1} 采集`,
          capture: version.capture,
        })),
      ].filter((item) => item.capture)
    : [];
  const chosen = entries.find((item) => item.id === entry) ?? entries[0];
  const runs = workspace && current ? workspace.runs.filter((run) => run.sessionId === current.sessionId) : [];
  const observations = current?.observations ?? [];

  return (
    <section aria-label="当前会话现场（不可导出）" className="debug-session">
      <div className="debug-session-head">
        <span>
          当前会话现场（PageCapture）
          <br />
          <span className="muted">仅面板内查看 · 不可导出：不复制、不写入日志、不发送到 Main</span>
        </span>
        <button type="button" className="btn" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? '收起' : '查看'}
        </button>
      </div>
      {expanded ? (
        !workspace || !current ? (
          <p className="muted small">当前空间没有会话。</p>
        ) : (
          <div className="debug-session-body">
            <label className="field">
              会话
              <select
                value={current.sessionId}
                onChange={(event) => {
                  setSessionId(event.target.value);
                  setEntry('current');
                }}
              >
                {workspace.sessions.map((session) => (
                  <option key={session.sessionId} value={session.sessionId}>
                    {session.title}
                  </option>
                ))}
              </select>
            </label>
            <dl className="debug-ids">
              <dt>空间</dt>
              <dd>{workspace.workspaceId}</dd>
              <dt>会话</dt>
              <dd>{current.sessionId}</dd>
              <dt>会话资源</dt>
              <dd>{current.resourceId}</dd>
              <dt>现场适用性</dt>
              <dd>{current.contextApplicability}</dd>
              {current.captureRequest ? (
                <>
                  <dt>采集请求</dt>
                  <dd>
                    {current.captureRequest.requestId} · {current.captureRequest.state}
                  </dd>
                </>
              ) : null}
            </dl>
            <strong className="small">运行与执行绑定</strong>
            {runs.length ? (
              <ul className="debug-list">
                {runs.map((run) => (
                  <li key={run.runId}>
                    运行 {run.runId} · 任务版本 {run.taskVersionId} · {run.state} · 执行绑定{' '}
                    {run.executionBinding
                      ? `${run.executionBinding.generation} / ${run.executionBinding.turnId ?? '未返回 turnId'}`
                      : '未记录'}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">此会话没有运行。</p>
            )}
            <strong className="small">观察记录（requestId / 运行 / 资源实例 / evidenceRef）</strong>
            {observations.length ? (
              <ul className="debug-list">
                {observations.map((record) => (
                  <li key={record.request.requestId}>
                    {record.request.requestId} · {record.request.tool} · {record.state} · 运行 {record.request.runId ?? '无运行'}
                    {record.request.target
                      ? ` · 资源 ${record.request.target.resourceId} · 环境 ${record.request.target.environmentId} · 实例 ${record.request.target.instanceId} / ${record.request.target.instanceGeneration}`
                      : ''}
                    {record.evidenceRef ? ` · 归档 ${record.evidenceRef}` : ''}
                    {record.result && 'evidenceRef' in record.result && record.result.evidenceRef
                      ? ` · 观察证据 ${record.result.evidenceRef}`
                      : ''}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">此会话没有观察记录。</p>
            )}
            <strong className="small">页面现场（PageCapture，截图仅显示类型与大小）</strong>
            {chosen?.capture ? (
              <>
                <label className="field">
                  采集条目
                  <select value={chosen.id} onChange={(event) => setEntry(event.target.value)}>
                    {entries.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </label>
                <pre aria-label="会话现场 JSON（不可导出）">{JSON.stringify(describeCapture(chosen.capture), null, 2)}</pre>
              </>
            ) : (
              <p className="muted small">此会话尚无页面现场。</p>
            )}
          </div>
        )
      ) : null}
    </section>
  );
}
