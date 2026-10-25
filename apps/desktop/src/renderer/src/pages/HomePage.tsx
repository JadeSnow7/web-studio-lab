import { useState } from 'react';
import type { WorkspaceSnapshot } from '@wsl/protocol';
import { Notice } from '../components/Badges';
import { Icon } from '../components/Icon';
import { BrandLogo } from '../components/BrandLogo';
import { useStore } from '../lib/store';
import { homeTarget } from '../state/drafts';
import { demoEntriesVisible, environmentStore } from '../state/execution';
import { shellActions } from '../state/shell';
import { workspaceStore, switchWorkspace } from '../state/workspace';
import { useWorkspaceRunStatus } from '../state/status-view';
import { StatusDot } from '../components/Status';
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

/** 输入区说明：不再常驻可见，改为输入框的可访问描述与悬停。 */
const NO_OTHER_SPACES = '不读取其他空间';
const REFERENCE_HINT = '可从个人收藏中选择明确的正文版本作为参考。';

/** 空间卡片：有进行中的任务时，标题旁画状态点（文字视觉隐藏）。 */
function SpaceCard({ workspace }: { workspace: WorkspaceSnapshot }) {
  const running = useWorkspaceRunStatus(workspace.workspaceId);
  return (
    <button
      type="button"
      className="space-card"
      onClick={() => {
        void switchWorkspace(workspace.workspaceId).then(() => {
          if (workspaceStore.get().selectedId === workspace.workspaceId) shellActions.navigate('space');
        });
      }}
    >
      <span className="row space-between">
        <strong>
          {workspace.name}
          {running ? <StatusDot view={running} /> : null}
        </strong>
        <span className="chip">继续工作</span>
      </span>
      <span className="muted small">
        任务版本数 {workspace.sessions.reduce((count, session) => count + session.taskVersions.length, 0)} · 运行 {workspace.runs.length} ·
        标签 {workspace.tabs.length}
      </span>
    </button>
  );
}

/** 首页：个人作用域的混合输入。它不读取任何空间，也不会向后台空间发送。 */
export function HomePage({ onCreateWorkspace }: { onCreateWorkspace?: () => void } = {}) {
  const [selectedMode, setMode] = useState<HomeMode>('chat');
  // 「搜索」「打开」尚未接入：正式构建只保留对话，开发服务器或 WSL_DEBUG_STATUS=1 时才显示（OPS-1 S4）。
  const showModes = useStore(environmentStore, demoEntriesVisible);
  const mode: HomeMode = showModes ? selectedMode : 'chat';
  const snapshot = useStore(workspaceStore, (s) => s.snapshot);
  // 首页对话的接收方是个人默认 Agent，不是空间里的 Codex 会话，原因按模式说明。
  const blocked = mode === 'chat' ? null : MODE_BLOCKED[mode];

  return (
    <div className="home">
      <div className="home-greeting">
        <BrandLogo size={64} />
        <h1>今天从哪里开始？</h1>
      </div>
      <section className="home-card" aria-label="混合输入">
        <div className="row gap-8">
          {showModes ? (
            <div className="segmented" role="radiogroup" aria-label="输入模式">
              {MODES.map((m) => (
                <button key={m.mode} type="button" role="radio" aria-checked={mode === m.mode} onClick={() => setMode(m.mode)}>
                  {m.label}
                </button>
              ))}
            </div>
          ) : null}
          <span className="chip" title={NO_OTHER_SPACES}>
            <Icon name="user" size={13} /> 个人 · 默认 Agent
          </span>
        </div>
        {mode === 'chat' ? <ChatMessages conversationId={'conv-personal-default'} /> : null}
        <Composer
          target={homeTarget()}
          sendBlockedReason={blocked}
          placeholder="描述你想做的事…"
          harnessLabel={mode === 'chat' ? '默认 Agent' : (MODES.find((m) => m.mode === mode)?.label ?? '')}
          rows={3}
          descriptions={[NO_OTHER_SPACES, REFERENCE_HINT]}
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
            <SpaceCard key={workspace.workspaceId} workspace={workspace} />
          ))}
          {!snapshot?.workspaces.length ? <p className="muted">尚无可用空间。</p> : null}
        </div>
      </section>
    </div>
  );
}
