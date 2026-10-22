import { selectionDisplayName, type HarnessProfile, type HarnessSelection } from '@wsl/protocol';
import { useStore } from '../lib/store';
import { chatStore } from '../state/chat';

const LOGIN_LABEL: Record<NonNullable<HarnessProfile['check']>['login'], string> = {
  logged_in: '已登录',
  logged_out: '未登录',
  undetermined: '无法判断',
};

/** 一个 Profile 的显示文本：Harness · 标签 · 最近一次自检结果。 */
export function profileLabel(profile: HarnessProfile, harnessName: string): string {
  const check = profile.check ? LOGIN_LABEL[profile.check.login] : '未自检';
  return `${harnessName} · ${profile.label} · ${check}`;
}

const keyOf = (selection: HarnessSelection) => `${selection.harnessId}|${selection.profileId}`;

/**
 * 会话的 Harness 与 Profile 选择（W4-7）。只是展示与提交选择；能否执行由 Main 在 startRun 时按最新自检判断，
 * 已创建的执行不随这里变化。
 */
export function HarnessSelectField({
  selection,
  onChange,
}: {
  selection: HarnessSelection | null;
  onChange: (selection: HarnessSelection | null) => void;
}) {
  const profiles = useStore(chatStore, (state) => state.profiles);
  const harnesses = useStore(chatStore, (state) => state.status?.harnesses);
  if (!profiles) return null;
  const name = (choice: HarnessSelection) => selectionDisplayName(choice, harnesses);
  const defaultProfile = profiles.profiles.find((profile) => profile.profileId === profiles.defaultSelection.profileId);
  return (
    <label className="field">
      <span>执行 Agent</span>
      <select
        aria-label="执行 Agent"
        value={selection ? keyOf(selection) : ''}
        onChange={(event) => {
          const profile = profiles.profiles.find((item) => keyOf(item) === event.target.value);
          onChange(profile ? { harnessId: profile.harnessId, profileId: profile.profileId } : null);
        }}
      >
        <option value="">跟随默认（{defaultProfile ? profileLabel(defaultProfile, name(profiles.defaultSelection)) : '未设置'}）</option>
        {profiles.profiles.map((profile) => (
          <option key={profile.profileId} value={keyOf(profile)}>
            {profileLabel(profile, name(profile))}
          </option>
        ))}
      </select>
    </label>
  );
}
