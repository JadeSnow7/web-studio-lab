import {
  ChatSlotSchema,
  selectionDisplayName,
  type ChatConversation,
  type ChatStatus,
  type HarnessProfileId,
  type HarnessProfilesSnapshot,
  type HarnessSelection,
} from '@wsl/protocol';
import { personalReferencesStore } from './references';
import { createStore } from '../lib/store';
import { draftActions, draftsStore, CONVERSATIONS } from './drafts';

export interface ChatState {
  status: ChatStatus | null;
  conversations: Readonly<Record<string, ChatConversation>>;
  errors: Readonly<Record<string, string | null>>;
  pending: Readonly<Record<string, boolean>>;
  /** Main 持有的 Harness Profile 快照（W4a）；只读投影，修改经 `profileActions`。 */
  profiles: HarnessProfilesSnapshot | null;
  profilesError: string | null;
}
export const chatStore = createStore<ChatState>({
  status: null,
  conversations: {},
  errors: {},
  pending: {},
  profiles: null,
  profilesError: null,
});

/** 某个选择（缺省为全局默认）对应的 Harness 可用性；服务尚未报告时为 null。 */
export function selectedHarness(state: ChatState, selection?: HarnessSelection | null) {
  const chosen = selection ?? state.profiles?.defaultSelection;
  return state.status?.harnesses.find((item) => item.descriptor.harnessId === chosen?.harnessId) ?? null;
}
/** 某个选择（缺省为全局默认）对应的 Harness 名称。 */
export function selectedHarnessName(state: ChatState, selection?: HarnessSelection | null): string {
  return selectionDisplayName(selection ?? state.profiles?.defaultSelection, state.status?.harnesses);
}

/** 服务序号全局递增：旧初始查询、旧轮次响应与 reset 前事件不会覆盖新快照。 */
export function projectConversation(state: ChatState, snapshot: ChatConversation): ChatState {
  const old = state.conversations[snapshot.conversationId];
  if (old && old.seq >= snapshot.seq) return state;
  return { ...state, conversations: { ...state.conversations, [snapshot.conversationId]: snapshot } };
}
export function receiveConversation(snapshot: ChatConversation) {
  chatStore.set((state) => projectConversation(state, snapshot));
}
export function chatBlockedReason(id: string): string | null {
  const state = chatStore.get();
  if (!state.status?.available) return state.status?.reason ?? `正在检查 ${selectedHarnessName(state)}…`;
  const conversation = state.conversations[id];
  return state.pending[id] || conversation?.state === 'running' || conversation?.state === 'cancelling' ? '正在等待当前回复结束' : null;
}
async function act(id: string, action: () => Promise<ChatConversation>): Promise<boolean> {
  if (chatStore.get().pending[id]) return false;
  chatStore.set((state) => ({ ...state, pending: { ...state.pending, [id]: true }, errors: { ...state.errors, [id]: null } }));
  try {
    receiveConversation(await action());
    return true;
  } catch (error) {
    chatStore.set((state) => ({ ...state, errors: { ...state.errors, [id]: (error as Error).message } }));
    return false;
  } finally {
    chatStore.set((state) => ({ ...state, pending: { ...state.pending, [id]: false } }));
  }
}
export const chatActions = {
  async send(id: string, text: string) {
    if (chatBlockedReason(id)) return false;
    const accepted = await act(id, () =>
      window.studio.chat.send(ChatSlotSchema.parse(id), text, structuredClone(personalReferencesStore.get())),
    );
    if (accepted && draftsStore.get()[id] === text) draftActions.set(id, '');
    return accepted;
  },
  cancel: (id: string) => act(id, () => window.studio.chat.cancel(ChatSlotSchema.parse(id))),
  reset: (id: string) => act(id, () => window.studio.chat.reset(ChatSlotSchema.parse(id))),
};
async function profileAct(action: () => Promise<HarnessProfilesSnapshot>): Promise<boolean> {
  try {
    const profiles = await action();
    chatStore.set((state) => ({ ...state, profiles, profilesError: null }));
    return true;
  } catch (error) {
    chatStore.set((state) => ({ ...state, profilesError: (error as Error).message }));
    return false;
  }
}
export const profileActions = {
  create: (label: string) => profileAct(() => window.studio.chat.profiles.create(label)),
  check: (profileId: HarnessProfileId) => profileAct(() => window.studio.chat.profiles.check(profileId)),
  remove: (profileId: HarnessProfileId) => profileAct(() => window.studio.chat.profiles.remove(profileId)),
  setDefault: (selection: HarnessSelection) => profileAct(() => window.studio.chat.profiles.setDefault(selection)),
};
export async function initializeChat() {
  window.studio.chat.onStatus((status) => chatStore.set((state) => ({ ...state, status })));
  window.studio.chat.profiles.onChange((profiles) => chatStore.set((state) => ({ ...state, profiles, profilesError: null })));
  void profileAct(() => window.studio.chat.profiles.get());
  window.studio.chat.onConversation(receiveConversation);
  try {
    const status = await window.studio.chat.getStatus();
    chatStore.set((state) => ({ ...state, status }));
    await Promise.all(
      Object.keys(CONVERSATIONS)
        .filter((id) => CONVERSATIONS[id]?.scope.kind === 'personal')
        .map(async (id) => receiveConversation(await window.studio.chat.get(ChatSlotSchema.parse(id)))),
    );
  } catch (error) {
    chatStore.set((state) => ({
      ...state,
      status: { available: false, reason: (error as Error).message, version: null, sandbox: null, cwd: null, harnesses: [] },
    }));
  }
}
