import { useCallback, useEffect, useState } from 'react';
import type { WorkflowCommandCard, WorkflowRunRow, WorkflowStatusProjection } from '@wsl/protocol';

/**
 * W5 最小可信入口：命令卡展示脚本/args/输入/hash 与批准状态；
 * builtin 代码即批准，saved 命令保存即失效、须显式「批准」后才可运行。
 * 状态详情经 workflow:update tick 驱动重取；renderer 只持有展示状态。
 */

const STATUS_LABELS: Record<string, string> = {
  running: '运行中',
  stopping: '停止中',
  stopped: '已停止',
  completed: '已完成',
  failed: '失败',
  needs_reconciliation: '待核对',
};
const TERMINAL = new Set(['completed', 'failed', 'stopped']);

const CHANGE_LABELS: Record<string, string> = { added: '新增', modified: '修改', deleted: '删除', renamed: '重命名' };

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function timeText(ms: number): string {
  return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false });
}

interface CommandEditorState {
  /** 编辑中的 saved commandId；新建为 null。 */
  commandId: string | null;
  name: string;
  script: string;
  argsText: string;
  deadlineMs: string;
}

const EMPTY_EDITOR: CommandEditorState = { commandId: null, name: '', script: '', argsText: '{}', deadlineMs: '60000' };

function CommandCard({
  card,
  busy,
  onRun,
  onApprove,
  onEdit,
  onDelete,
}: {
  card: WorkflowCommandCard;
  busy: boolean;
  onRun: (commandId: string) => void;
  onApprove: (commandId: string) => void;
  onEdit: (card: WorkflowCommandCard) => void;
  onDelete: (commandId: string) => void;
}) {
  return (
    <section className="workflow-card" data-command-id={card.commandId}>
      <h3>
        {card.name} <span className="muted">{card.source === 'builtin' ? '内置' : '已保存'}</span>
      </h3>
      <p className="muted">{card.description}</p>
      <p className="muted">阶段：{card.phases.join(' → ') || '（无）'}</p>
      <p className="muted">输入文件：{card.inputFilePaths.length ? card.inputFilePaths.join('、') : '（无）'}</p>
      <p className="muted" title={`scriptHash ${card.scriptHash} · argsHash ${card.argsHash}`}>
        hash：{card.scriptHash.slice(0, 12)}… / {card.argsHash.slice(0, 12)}…
      </p>
      <p className="muted">
        args：{JSON.stringify(card.args)} · 时限 {Math.round(card.deadlineMs / 1000)}s
      </p>
      <p data-approval={card.approved ? 'approved' : 'pending'} className={card.approved ? 'muted' : 'workflow-error'}>
        {card.approved ? '已批准' : '待批准'}
      </p>
      {card.requiresApp ? (
        <p className="muted" data-requires-app>
          执行需受管 App · lane 候选（应用前须审阅授权）
        </p>
      ) : null}
      <details>
        <summary>脚本源码</summary>
        <pre className="workflow-script">{card.script}</pre>
      </details>
      <nav className="row gap-8" aria-label="命令操作">
        <button type="button" className="btn" disabled={busy || !card.approved} onClick={() => onRun(card.commandId)}>
          运行
        </button>
        {!card.approved ? (
          <button type="button" className="btn" disabled={busy} onClick={() => onApprove(card.commandId)}>
            批准
          </button>
        ) : null}
        {card.source === 'saved' ? (
          <>
            <button type="button" className="btn" disabled={busy} onClick={() => onEdit(card)}>
              编辑
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => onDelete(card.commandId)}>
              删除
            </button>
          </>
        ) : null}
      </nav>
    </section>
  );
}

function CommandEditor({
  state,
  busy,
  onChange,
  onSubmit,
  onCancel,
}: {
  state: CommandEditorState;
  busy: boolean;
  onChange: (next: CommandEditorState) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="workflow-card" data-command-editor={state.commandId ?? 'new'}>
      <h3>{state.commandId === null ? '新建命令' : '编辑命令'}</h3>
      <label className="muted">
        名称
        <input aria-label="命令名称" value={state.name} disabled={busy} onChange={(e) => onChange({ ...state, name: e.target.value })} />
      </label>
      <label className="muted">
        脚本
        <textarea
          aria-label="命令脚本"
          rows={10}
          value={state.script}
          disabled={busy}
          onChange={(e) => onChange({ ...state, script: e.target.value })}
        />
      </label>
      <label className="muted">
        args JSON
        <textarea
          aria-label="命令 args"
          rows={3}
          value={state.argsText}
          disabled={busy}
          onChange={(e) => onChange({ ...state, argsText: e.target.value })}
        />
      </label>
      <label className="muted">
        时限（毫秒）
        <input
          aria-label="命令时限"
          value={state.deadlineMs}
          disabled={busy}
          onChange={(e) => onChange({ ...state, deadlineMs: e.target.value })}
        />
      </label>
      <nav className="row gap-8" aria-label="命令表单操作">
        <button type="button" className="btn" disabled={busy} onClick={onSubmit}>
          保存命令
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          取消
        </button>
      </nav>
      <p className="muted">保存后需重新批准才能运行；saved 命令不支持冻结输入文件。</p>
    </section>
  );
}

function CallTable({ calls }: { calls: WorkflowStatusProjection['calls'] }) {
  if (!calls.length) return <p className="muted">尚无调用。</p>;
  return (
    <table className="workflow-calls">
      <thead>
        <tr>
          <th>#</th>
          <th>调用</th>
          <th>阶段</th>
          <th>状态</th>
          <th>尝试</th>
          <th>usage</th>
        </tr>
      </thead>
      <tbody>
        {calls.map((call) => (
          <tr key={call.seq} data-call-seq={call.seq}>
            <td>{call.seq}</td>
            <td>{call.label ?? '（未命名）'}</td>
            <td>{call.phase ?? '—'}</td>
            <td>
              {call.status === 'conflict' ? 'conflict（冲突）' : call.status}
              {call.cachedFromRunId ? <span className="workflow-cached">（cached）</span> : null}
              {call.code ? <span className="muted"> · {call.code}</span> : null}
              {/* W8：冲突文件与保留候选树引用——候选保留在 Lab 存储中可诊断，不自动合并。 */}
              {call.conflictFiles?.length ? (
                <span className="muted" title={`保留候选 ${call.candidateRef ?? ''}`}>
                  {' '}
                  · 冲突：{call.conflictFiles.join('、')} · 候选 {call.candidateRef?.slice(0, 10)}…
                </span>
              ) : null}
            </td>
            <td>{call.attempts}</td>
            <td>{call.usage ? `in ${call.usage.inputTokens} / out ${call.usage.outputTokens}` : '未知'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * W6b：候选快照面板——文件变更清单、diff 预览（只读）与显式「应用候选」。
 * 候选只进 Lab 管理的隔离存储；应用需要 run 终态 + 绑定受管 App，由 Main
 * 在写租约下做基线冲突核对——点击之外不会有任何写入。
 */
function CandidatePanel({
  row,
  busy,
  patchText,
  patchLoading,
  onTogglePatch,
  onApply,
}: {
  row: WorkflowRunRow;
  busy: boolean;
  patchText: string | null;
  patchLoading: boolean;
  onTogglePatch: () => void;
  onApply: () => void;
}) {
  const candidate = row.candidate;
  if (!candidate) return null;
  const bound = row.appTarget !== null && row.appTarget !== undefined;
  const terminal = TERMINAL.has(row.status);
  return (
    <section className="workflow-card" aria-label="候选快照" data-candidate>
      <h3>候选快照</h3>
      <p
        className="muted"
        title={`baseTree ${candidate.baseTree}\ncurrentTree ${candidate.currentTree}\npatchSha256 ${candidate.patchSha256}`}
      >
        基线 {candidate.baseTree.slice(0, 10)}… → 当前 {candidate.currentTree.slice(0, 10)}…
        {candidate.appliedAt !== null ? ` · 已应用 ${timeText(candidate.appliedAt)}` : ''}
      </p>
      {!bound ? (
        <p className="workflow-error" data-candidate-unbound>
          该 run 未绑定受管 App——候选仅存档，无法应用。
        </p>
      ) : null}
      {candidate.files.length ? (
        <table className="workflow-calls">
          <thead>
            <tr>
              <th>文件</th>
              <th>变更</th>
              <th>+/−</th>
            </tr>
          </thead>
          <tbody>
            {candidate.files.map((file) => (
              <tr key={file.path}>
                <td>{file.path}</td>
                <td>{CHANGE_LABELS[file.change] ?? file.change}</td>
                <td>{file.binary ? '二进制' : `+${file.additions} −${file.deletions}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted">候选无文件变更。</p>
      )}
      <nav className="row gap-8" aria-label="候选操作">
        <button type="button" className="btn" disabled={busy || patchLoading} onClick={onTogglePatch}>
          {patchText !== null ? '收起差异' : patchLoading ? '加载中…' : '查看差异'}
        </button>
        {terminal && bound ? (
          <button type="button" className="btn" disabled={busy} onClick={onApply} data-apply-candidate>
            应用候选到应用
          </button>
        ) : null}
      </nav>
      {patchText !== null ? (
        <pre className="workflow-script" data-candidate-patch>
          {patchText}
        </pre>
      ) : null}
    </section>
  );
}

export function WorkflowsPage() {
  const [commands, setCommands] = useState<WorkflowCommandCard[] | null>(null);
  const [runs, setRuns] = useState<WorkflowRunRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkflowStatusProjection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<CommandEditorState | null>(null);
  /** W6b：候选 diff 预览（runId + 文本）；换 run 或再点一次清空。 */
  const [patch, setPatch] = useState<{ runId: string; text: string } | null>(null);
  const [patchLoading, setPatchLoading] = useState(false);

  const refreshCommands = useCallback(async () => {
    try {
      setCommands(await window.studio.workflow.commands());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      setRuns(await window.studio.workflow.runs());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshDetail = useCallback(async (runId: string) => {
    try {
      setDetail(await window.studio.workflow.status(runId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void window.studio.workflow
      .commands()
      .then(setCommands)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    const timer = setTimeout(() => void refreshRuns(), 0);
    const unsubscribe = window.studio.workflow.onUpdate((update) => {
      void refreshRuns();
      setSelected((current) => {
        if (current === update.workflowRunId) void refreshDetail(update.workflowRunId);
        return current;
      });
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, [refreshCommands, refreshRuns, refreshDetail]);

  const selectRun = (runId: string) => {
    setSelected(runId);
    setDetail(null);
    setPatch(null);
    void refreshDetail(runId);
  };

  const commandOf = (row: WorkflowRunRow) => commands?.find((card) => card.scriptHash === row.scriptHash) ?? null;

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await Promise.all([refreshCommands(), refreshRuns()]);
      if (selected) await refreshDetail(selected);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const runCommand = (commandId: string) => void act(() => window.studio.workflow.run(crypto.randomUUID(), commandId));
  /** W6b：只读 diff 预览——不产生任何写入。 */
  const togglePatch = (row: WorkflowRunRow) => {
    if (patch?.runId === row.runId) {
      setPatch(null);
      return;
    }
    setPatchLoading(true);
    void window.studio.workflow
      .patch(row.runId)
      .then((result) => setPatch({ runId: row.runId, text: result.patch }))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setPatchLoading(false));
  };
  /** W6b：显式授权应用候选；冲突/忙/不可用错误码由 Main 前缀返回并展示在错误条。 */
  const applyCandidate = (row: WorkflowRunRow) => void act(() => window.studio.workflow.apply(row.runId));
  const approveCommand = (commandId: string) => void act(() => window.studio.workflow.approveCommand(commandId));
  const deleteCommand = (commandId: string) => void act(() => window.studio.workflow.deleteCommand(commandId));
  const resumeRun = (row: WorkflowRunRow) => {
    const command = commandOf(row);
    if (!command) {
      setError('该 run 的脚本不来自当前命令仓储，不能续跑');
      return;
    }
    void act(() => window.studio.workflow.resume(crypto.randomUUID(), row.runId, command.commandId));
  };

  const submitEditor = () => {
    if (!editor) return;
    let args: unknown;
    try {
      args = JSON.parse(editor.argsText || 'null');
    } catch (e) {
      setError(`args 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const deadlineMs = Number(editor.deadlineMs);
    if (!Number.isInteger(deadlineMs) || deadlineMs <= 0) {
      setError('时限必须是正整数毫秒');
      return;
    }
    void act(async () => {
      await window.studio.workflow.saveCommand({
        ...(editor.commandId !== null ? { commandId: editor.commandId } : {}),
        name: editor.name,
        script: editor.script,
        args,
        deadlineMs,
      });
      setEditor(null);
    });
  };

  const openEditor = (card: WorkflowCommandCard) =>
    setEditor({
      commandId: card.commandId,
      name: card.name,
      script: card.script,
      argsText: JSON.stringify(card.args ?? {}),
      deadlineMs: String(card.deadlineMs),
    });

  const selectedRow = runs.find((row) => row.runId === selected) ?? null;

  return (
    <div className="page-columns">
      <nav className="page-sidebar page-sidebar-wide" aria-label="工作流命令与运行记录">
        <h2>命令</h2>
        {(commands ?? []).map((card) => (
          <CommandCard
            key={card.commandId}
            card={card}
            busy={busy}
            onRun={runCommand}
            onApprove={approveCommand}
            onEdit={openEditor}
            onDelete={deleteCommand}
          />
        ))}
        {commands === null ? <p className="muted">正在加载命令…</p> : null}
        {editor === null ? (
          <button type="button" className="btn" disabled={busy} onClick={() => setEditor(EMPTY_EDITOR)}>
            新建命令
          </button>
        ) : (
          <CommandEditor state={editor} busy={busy} onChange={setEditor} onSubmit={submitEditor} onCancel={() => setEditor(null)} />
        )}
        <h2>运行记录</h2>
        {runs.map((row) => (
          <button
            key={row.runId}
            type="button"
            className="conv-row"
            title={row.runId}
            aria-current={selected === row.runId ? 'true' : undefined}
            onClick={() => selectRun(row.runId)}
          >
            {(commandOf(row)?.name ?? '未知命令') + ' · ' + row.runId.slice(0, 8)}
            <span className="muted" data-run-status={row.status}>
              {' '}
              {statusLabel(row.status)} · {timeText(row.createdMs)}
              {row.candidate ? ' · 候选' : ''}
            </span>
          </button>
        ))}
        {!runs.length ? <p className="muted">尚无运行。</p> : null}
      </nav>
      <section className="page-main" aria-label="工作流详情">
        {error ? (
          <p role="alert" className="workflow-error">
            {error}
          </p>
        ) : null}
        {selectedRow ? (
          <>
            <h2 title={selectedRow.runId}>
              {commandOf(selectedRow)?.name ?? '未知命令'} · {selectedRow.runId.slice(0, 8)}
            </h2>
            <p data-status={selectedRow.status}>
              状态：{statusLabel(selectedRow.status)}
              {selectedRow.failureCode ? ` · ${selectedRow.failureCode}` : ''}
            </p>
            <nav className="row gap-8" aria-label="运行操作">
              {selectedRow.status === 'running' || selectedRow.status === 'stopping' ? (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void act(() => window.studio.workflow.stop(selectedRow.runId))}
                >
                  停止
                </button>
              ) : null}
              {selectedRow.status === 'needs_reconciliation' ? (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => void act(() => window.studio.workflow.reconcile(selectedRow.runId))}
                >
                  标记已停止
                </button>
              ) : null}
              {TERMINAL.has(selectedRow.status) && commandOf(selectedRow) ? (
                <button type="button" className="btn" disabled={busy} onClick={() => resumeRun(selectedRow)}>
                  续跑
                </button>
              ) : null}
            </nav>
            <CandidatePanel
              row={selectedRow}
              busy={busy}
              patchText={patch?.runId === selectedRow.runId ? patch.text : null}
              patchLoading={patchLoading}
              onTogglePatch={() => togglePatch(selectedRow)}
              onApply={() => applyCandidate(selectedRow)}
            />
            {detail ? (
              <>
                <CallTable calls={detail.calls} />
                {detail.result !== undefined ? (
                  <details>
                    <summary>运行结果</summary>
                    <pre className="workflow-script">{JSON.stringify(detail.result, null, 2)}</pre>
                  </details>
                ) : null}
                {detail.logTail.length ? (
                  <details>
                    <summary>日志尾部</summary>
                    <pre className="workflow-script">{detail.logTail.map((entry) => `[${entry.kind}] ${entry.text}`).join('\n')}</pre>
                  </details>
                ) : null}
              </>
            ) : (
              <p className="muted">正在加载状态…</p>
            )}
          </>
        ) : (
          <p className="muted">选择命令卡运行，或选择一条运行记录查看详情。</p>
        )}
      </section>
    </div>
  );
}
