import { useId, useRef, useState } from 'react';
import { HarnessProfileSchema, PROFILE_CREATABLE_HARNESSES, selectionDisplayName, type HarnessProfile } from '@wsl/protocol';
import { Notice } from '../components/Badges';
import { useStore } from '../lib/store';
import { useImeForm } from '../lib/ime';
import { chatStore, profileActions } from '../state/chat';
import { workspaceCommand, workspaceStore } from '../state/workspace';
import { shellActions } from '../state/shell';
import { profileLabel } from '../workspace/HarnessSelect';

/** 登录命令只供用户在 sandbox 终端里自己输入；Lab 不代为执行认证（W4-12）。 */
function loginCommand(profile: HarnessProfile): string {
  if (profile.harnessId === 'codex') return '在主机终端执行 sbx secret set openai --oauth（sbx 默认账号由 sbx secret 管理）';
  const login = 'claude-agent-acp --cli auth login --claudeai';
  return profile.configDir ? `${profile.configDir.env}=${profile.configDir.path} ${login}` : login;
}

/** 设置页的 Harness 与 Profile 管理（W4a）：只展示 Main 的快照，修改经 `profileActions`。 */
export function HarnessProfiles() {
  const profiles = useStore(chatStore, (state) => state.profiles);
  const error = useStore(chatStore, (state) => state.profilesError);
  // 选择器必须返回稳定引用：缺省的空数组放在订阅之外，否则每次读取都是新值，订阅会无限重渲染。
  const reported = useStore(chatStore, (state) => state.status?.harnesses);
  const harnesses = reported ?? [];
  const activeWorkspaceId = useStore(workspaceStore, (state) => state.snapshot?.activeWorkspaceId ?? null);
  const [label, setLabel] = useState('');
  const [validation, setValidation] = useState<string | null>(null);
  const labelInput = useRef<HTMLInputElement>(null);
  const validationId = useId();
  const ime = useImeForm();
  const [busy, setBusy] = useState<string | null>(null);
  const pending = useRef(false);
  const run = async (key: string, action: () => Promise<boolean>) => {
    // Block same-turn submits before React has rendered the disabled controls.
    if (pending.current) return false;
    pending.current = true;
    setBusy(key);
    try {
      return await action();
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };
  const openTerminal = async () => {
    if (!activeWorkspaceId) return;
    const result = await workspaceCommand(activeWorkspaceId, {
      type: 'createTab',
      kind: 'terminal',
      environmentId: 'sandbox',
      title: 'Profile 登录',
    });
    if (result?.ok) shellActions.navigate('space');
  };
  return (
    <>
      <h2 id="settings-profiles">Harness 与 Profile</h2>
      {error ? <Notice tone="warn">{error}</Notice> : null}
      <table className="table" aria-label="Harness 可用性">
        <thead>
          <tr>
            <th>Harness</th>
            <th>接入方式</th>
            <th>版本</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {harnesses.map((item) => (
            <tr key={item.descriptor.harnessId}>
              <td>{item.descriptor.displayName}</td>
              <td>{item.descriptor.adapter}</td>
              <td>{item.descriptor.version ?? '未报告'}</td>
              <td>{item.available ? '可用' : (item.reason ?? '不可用')}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {profiles ? (
        <>
          <table className="table" aria-label="Profile 列表">
            <thead>
              <tr>
                <th>Profile</th>
                <th>配置目录</th>
                <th>最近自检</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {profiles.profiles.map((profile) => {
                const isDefault = profiles.defaultSelection.profileId === profile.profileId;
                return (
                  <tr key={profile.profileId} data-profile-id={profile.profileId}>
                    <td>
                      {profileLabel(profile, selectionDisplayName(profile, harnesses))}
                      {isDefault ? ' · 默认' : ''}
                    </td>
                    <td>
                      <code className="wrap">{profile.configDir?.path ?? '默认目录'}</code>
                    </td>
                    <td>
                      {profile.check
                        ? `${profile.check.cliVersion ?? '版本未知'} · ${new Date(profile.check.checkedAt).toLocaleString()}${profile.check.reason ? ` · ${profile.check.reason}` : ''}`
                        : '未自检'}
                      <div className="muted small">
                        登录：<code className="wrap">{loginCommand(profile)}</code>
                      </div>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn"
                        disabled={busy !== null}
                        onClick={() => void run('check:' + profile.profileId, () => profileActions.check(profile.profileId))}
                      >
                        {busy === 'check:' + profile.profileId ? '自检中…' : '自检'}
                      </button>{' '}
                      <button
                        type="button"
                        className="btn"
                        disabled={busy !== null || isDefault}
                        onClick={() =>
                          void run('default', () =>
                            profileActions.setDefault({ harnessId: profile.harnessId, profileId: profile.profileId }),
                          )
                        }
                      >
                        设为默认
                      </button>{' '}
                      {profile.builtin ? null : (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={busy !== null}
                          onClick={() => void run('remove', () => profileActions.remove(profile.profileId))}
                        >
                          删除
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <form
            className="row"
            noValidate
            {...ime.handlers}
            onSubmit={(event) => {
              event.preventDefault();
              if (pending.current || ime.composing.current) return;
              const parsed = HarnessProfileSchema.shape.label.safeParse(label);
              if (!parsed.success) {
                setValidation('请填写 1–60 个字符的标签（首尾空白不计）。');
                labelInput.current?.focus();
                return;
              }
              setValidation(null);
              void run('create', () => profileActions.create(parsed.data)).then((ok) => ok && setLabel(''));
            }}
          >
            <label className="field">
              <span>
                新建{' '}
                {PROFILE_CREATABLE_HARNESSES.map((id) =>
                  selectionDisplayName({ harnessId: id, profileId: `${id}:default` }, harnesses),
                ).join('、')}{' '}
                Profile
              </span>
              <input
                ref={labelInput}
                value={label}
                maxLength={60}
                placeholder="标签，例如：工作账号"
                disabled={busy !== null}
                aria-invalid={validation !== null}
                aria-describedby={validation ? validationId : undefined}
                onChange={(event) => {
                  if (pending.current) return;
                  setLabel(event.target.value);
                  setValidation(null);
                }}
              />
              {validation ? (
                <span id={validationId} className="text-warn" role="alert">
                  {validation}
                </span>
              ) : null}
            </label>
            <button type="submit" className="btn" disabled={busy !== null} aria-busy={busy === 'create'}>
              新建
            </button>
            <button type="button" className="btn btn-ghost" disabled={!activeWorkspaceId} onClick={() => void openTerminal()}>
              打开 sandbox 终端
            </button>
          </form>
          <Notice>
            Lab 只保存配置目录引用和自检结果，不读取或保存凭据。登录在 sandbox 终端里由你自己完成；删除 Profile 不删除 sandbox
            内的目录与登录数据。认证失败或配额耗尽时执行会失败并说明原因，不会自动换用其他 Profile。
          </Notice>
        </>
      ) : (
        <Notice>{error ? '无法读取 Profile。' : '正在读取 Profile…'}</Notice>
      )}
    </>
  );
}
