import { ChatMessages } from './ChatMessages';
import { Composer } from './Composer';
import { DemoBadge, Notice } from '../components/Badges';
import { Icon } from '../components/Icon';
import { DEMO_CONTACTS, DEMO_FEED } from '../demo/sampleData';
import { useStore } from '../lib/store';
import { spacePanelTarget } from '../state/drafts';
import { shellActions, shellStore, type RightTab } from '../state/shell';

const TABS: ReadonlyArray<{ tab: RightTab; label: string }> = [
  { tab: 'space', label: '空间' },
  { tab: 'contacts', label: '联系人' },
  { tab: 'feed', label: '动态' },
];

export function sendBlockedReasonFor(reason: string | null | undefined): string {
  return reason ?? '执行服务状态未知';
}

function SpaceTab() {
  const scope = useStore(shellStore, (s) => s.activeScope);
  const target = spacePanelTarget(scope);
  if (target.kind === 'none') {
    return (
      <div className="panel-empty">
        <Icon name="space" size={24} />
        <strong>{target.reason}</strong>
        <p>首页处于个人作用域，后台的空间不会被当成发送目标；在空间里未发出的草稿仍然保留。</p>
        <button type="button" className="btn" onClick={() => shellActions.navigate('space')}>
          继续 TaskFlow 演示空间
        </button>
      </div>
    );
  }
  return (
    <>
      <div className="panel-sub">
        <strong>
          {target.conversation.scopeLabel} · {target.conversation.title}
        </strong>
        <span className="muted">Codex CLI · 对话</span>
      </div>
      <ChatMessages conversationId={target.conversation.id} />
      <div className="panel-foot">
        <Composer target={target} sendBlockedReason={null} placeholder="补充要求…" harnessLabel="Codex CLI" />
      </div>
    </>
  );
}

function ContactsTab() {
  return (
    <div className="panel-scroll">
      <Notice>人际消息不在本轮范围：联系人与群聊只展示演示条目，不能发送。收件人与当前空间无关。</Notice>
      <ul className="plain-list">
        {DEMO_CONTACTS.map((c) => (
          <li key={c.id} className="contact-row">
            <span className={`avatar avatar-${c.kind}`}>{c.initial}</span>
            <span className="contact-main">
              <strong>{c.name}</strong>
              <span className="muted">{c.preview}</span>
            </span>
            <span className="muted small">{c.time}</span>
          </li>
        ))}
      </ul>
      <DemoBadge />
    </div>
  );
}

function FeedTab() {
  return (
    <div className="panel-scroll">
      <ul className="plain-list">
        {DEMO_FEED.map((f) => (
          <li key={f.id} className="feed-item">
            <span className="muted small">{f.meta}</span>
            <strong>{f.title}</strong>
            <span className="muted">{f.note}</span>
          </li>
        ))}
      </ul>
      <p className="muted small">动态是只读视图，这里没有输入框。</p>
    </div>
  );
}

export function RightPanel({ overlay }: { overlay: boolean }) {
  const tab = useStore(shellStore, (s) => s.rightPanel.tab);
  return (
    <aside className={overlay ? 'right-panel right-panel-overlay' : 'right-panel'} aria-label="通信栏">
      <div className="panel-head">
        <div className="segmented" role="tablist" aria-label="通信分区">
          {TABS.map((t) => (
            <button key={t.tab} type="button" role="tab" aria-selected={tab === t.tab} onClick={() => shellActions.openRightPanel(t.tab)}>
              {t.label}
            </button>
          ))}
        </div>
        {overlay ? (
          <button type="button" className="icon-btn" aria-label="收起通信栏" onClick={shellActions.toggleRightPanel}>
            <Icon name="close" size={15} />
          </button>
        ) : null}
      </div>
      {tab === 'space' ? <SpaceTab /> : tab === 'contacts' ? <ContactsTab /> : <FeedTab />}
    </aside>
  );
}
