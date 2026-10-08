import { useState } from 'react';
import { Notice } from '../components/Badges';
import { Icon } from '../components/Icon';
import { useStore } from '../lib/store';
import { homeTarget } from '../state/drafts';
import { shellActions } from '../state/shell';
import { workspaceStore, switchWorkspace } from '../state/workspace';
import { ChatMessages } from '../shell/ChatMessages';
import { Composer } from '../shell/Composer';

type HomeMode = 'chat' | 'search' | 'open';

const MODES: ReadonlyArray<{ mode: HomeMode; label: string }> = [
  { mode: 'chat', label: '对话' },
  { mode: 'search', label: '搜索' },
  { mode: 'open', label: '打开' },
];

const MODE_BLOCKED: Record<HomeMode, string> = {
  chat: 'Codex CLI 个人对话不附带空间或页面内容；应用内消息仅本次启动可见',
  search: '搜索尚未接入',
  open: '从首页打开地址需要临时空间，尚未接入；请在空间的 Browser 区打开演示页面',
};

/** 首页：个人作用域的混合输入。它不读取任何空间，也不会向后台空间发送。 */
export function HomePage({ onCreateWorkspace }: { onCreateWorkspace?: () => void } = {}) {
  const [mode, setMode] = useState<HomeMode>('chat');
  const snapshot = useStore(workspaceStore, (s) => s.snapshot);
  // 首页对话的接收方是个人默认 Agent，不是空间里的 Codex 会话，原因按模式说明。
  const blocked = mode === 'chat' ? null : MODE_BLOCKED[mode];

  return (
    <div className="home">
      <h1>今天从哪里开始？</h1>
      <section className="home-card" aria-label="混合输入">
        <div className="row gap-8">
          <div className="segmented" role="radiogroup" aria-label="输入模式">
            {MODES.map((m) => (
              <button key={m.mode} type="button" role="radio" aria-checked={mode === m.mode} onClick={() => setMode(m.mode)}>
                {m.label}
              </button>
            ))}
          </div>
          <span className="chip">
            <Icon name="user" size={13} /> 个人 · 默认 Agent
          </span>
          <span className="muted small">不读取其他空间</span>
        </div>
        {mode === 'chat' ? <ChatMessages conversationId={'conv-personal-default'} /> : null}
        <Composer
          target={homeTarget()}
          sendBlockedReason={blocked}
          placeholder="描述你想做的事…"
          harnessLabel={mode === 'chat' ? '默认 Agent' : (MODES.find((m) => m.mode === mode)?.label ?? '')}
          rows={3}
        />
        <Notice>{MODE_BLOCKED[mode]}。</Notice>
      </section>

      <section className="home-section" aria-label="近期空间">
        <div className="row space-between">
          <h2>近期空间</h2>
          <button className="btn btn-ghost" type="button" disabled={!onCreateWorkspace} onClick={onCreateWorkspace}>
            新建空间
          </button>
        </div>
        <div className="space-cards">
          {snapshot?.workspaces.map((workspace) => (
            <button
              type="button"
              className="space-card"
              key={workspace.workspaceId}
              onClick={() => {
                void switchWorkspace(workspace.workspaceId).then(() => {
                  if (workspaceStore.get().selectedId === workspace.workspaceId) shellActions.navigate('space');
                });
              }}
            >
              <span className="row space-between">
                <strong>{workspace.name}</strong>
                <span className="chip">继续工作</span>
              </span>
              <span className="muted small">
                任务版本数 {workspace.sessions.reduce((count, session) => count + session.taskVersions.length, 0)} · 运行{' '}
                {workspace.runs.length} · 标签 {workspace.tabs.length}
              </span>
            </button>
          ))}
          {!snapshot?.workspaces.length ? <p className="muted">尚无可用空间。</p> : null}
        </div>
      </section>
    </div>
  );
}
