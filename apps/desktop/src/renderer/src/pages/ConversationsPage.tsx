import { useState } from 'react';
import { Notice } from '../components/Badges';
import { DEMO_CONTACTS } from '../demo/sampleData';
import { useStore } from '../lib/store';
import { CONVERSATIONS, draftsStore, PERSONAL_CONVERSATION_ID, type ConversationInfo } from '../state/drafts';
import { Composer } from '../shell/Composer';
import { ChatMessages } from '../shell/ChatMessages';
import { shellActions } from '../state/shell';

type Section = 'agent' | 'people';

const AGENT_CONVERSATIONS = [PERSONAL_CONVERSATION_ID].map((id) => CONVERSATIONS[id]).filter((c): c is ConversationInfo => c !== undefined);

/** 会话页与右栏、首页共用同一会话与草稿。 */
export function ConversationsPage() {
  const [section, setSection] = useState<Section>('agent');
  const [selectedId, setSelectedId] = useState(AGENT_CONVERSATIONS[0]?.id ?? '');
  const drafts = useStore(draftsStore, (d) => d);
  const selected = CONVERSATIONS[selectedId] ?? null;

  return (
    <div className="page-columns">
      <nav className="page-sidebar page-sidebar-wide" aria-label="会话列表">
        <div className="segmented" role="tablist" aria-label="会话类别">
          <button type="button" role="tab" aria-selected={section === 'agent'} onClick={() => setSection('agent')}>
            Agent 工作
          </button>
          <button type="button" role="tab" aria-selected={section === 'people'} onClick={() => setSection('people')}>
            联系人与群聊
          </button>
        </div>
        {section === 'agent' ? (
          AGENT_CONVERSATIONS.map((c) => (
            <button
              key={c.id}
              type="button"
              className="conv-row"
              aria-current={c.id === selectedId ? 'true' : undefined}
              onClick={() => setSelectedId(c.id)}
            >
              <span className="row space-between">
                <strong>{c.title}</strong>
                <span className="muted small">Codex CLI</span>
              </span>
              <span className="muted small">{c.scopeLabel}</span>
              {drafts[c.id] ? <span className="small text-warn">草稿：{drafts[c.id]}</span> : null}
            </button>
          ))
        ) : (
          <>
            <Notice>人际消息不在本轮范围，以下是演示条目。</Notice>
            {DEMO_CONTACTS.map((c) => (
              <div key={c.id} className="conv-row conv-row-static">
                <strong>{c.name}</strong>
                <span className="muted small">{c.preview}</span>
              </div>
            ))}
          </>
        )}
      </nav>
      <section className="page-main conv-detail" aria-label="会话详情">
        <button type="button" className="btn" onClick={() => shellActions.navigate('space')}>
          返回空间工作会话
        </button>
        {selected ? (
          <>
            <div className="row space-between">
              <h1>
                {selected.scopeLabel} · {selected.title}
              </h1>
              <span className="chip">{selected.scope.kind === 'personal' ? '个人作用域' : '空间会话'}</span>
            </div>
            <ChatMessages conversationId={selected.id} />
            <Composer
              target={{ kind: 'conversation', conversation: selected }}
              sendBlockedReason={null}
              placeholder="输入消息…"
              harnessLabel={selected.scope.kind === 'personal' ? '默认 Agent' : 'Codex CLI'}
              rows={3}
            />
          </>
        ) : null}
      </section>
    </div>
  );
}
