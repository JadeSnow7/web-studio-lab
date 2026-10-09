import { useEffect, useRef, useState } from 'react';
import { SshSettingsSchema, type RuntimeConfig, type SetupSnapshot } from '@wsl/protocol';
import { Notice } from '../components/Badges';
import { useStore } from '../lib/store';
import { setupStore } from '../state/setup';
const stages: Record<SetupSnapshot['stage'], string> = {
  check: '检查设备与安装载荷',
  sbx: '准备 Docker Sandboxes',
  'docker-login': 'Docker 登录',
  sandbox: '创建隔离沙箱',
  tools: '部署沙箱工具',
  'model-login': '模型登录',
  probe: '检查必需功能',
  ready: '环境已准备',
};
const emptySsh = { host: '', port: '22', username: '', hostKeySha256: '', root: '' };
export function SetupSettings() {
  const state = useStore(setupStore, (value) => value);
  return state.snapshot ? (
    <SetupSettingsForm snapshot={state.snapshot} stateError={state.error} />
  ) : (
    <section aria-labelledby="settings-installation">
      <h2 id="settings-installation">比赛环境安装</h2>
      <p role="status">正在读取安装状态…</p>
      {state.error && <Notice tone="bad">{state.error}</Notice>}
    </section>
  );
}
function SetupSettingsForm({ snapshot, stateError }: { snapshot: SetupSnapshot; stateError: string | null }) {
  const [draft, setDraft] = useState<Pick<RuntimeConfig, 'localRoot' | 'ssh'>>(() => ({
    localRoot: snapshot.config.localRoot,
    ssh: snapshot.config.ssh,
  }));
  const [sshEnabled, setSshEnabled] = useState(!!snapshot.config.ssh);
  const [ssh, setSsh] = useState(() =>
    snapshot.config.ssh ? { ...snapshot.config.ssh, port: String(snapshot.config.ssh.port) } : emptySsh,
  );
  const [consent, setConsent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const form = useRef<HTMLFormElement>(null);
  const rootChooser = useRef<HTMLButtonElement>(null);
  const restoreChooserFocus = useRef(false);
  async function run(action: () => Promise<unknown>) {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setPending(false);
    }
  }
  const blocked = pending || !!snapshot?.busy || snapshot?.error?.code === 'configuration-invalid';
  useEffect(() => {
    if (!blocked && restoreChooserFocus.current) {
      restoreChooserFocus.current = false;
      rootChooser.current?.focus();
    }
  }, [blocked]);
  async function save() {
    if (!draft) return;
    let settings: Pick<RuntimeConfig, 'localRoot' | 'ssh'> = { localRoot: draft.localRoot, ssh: null };
    if (sshEnabled) {
      const result = SshSettingsSchema.safeParse({ ...ssh, port: Number(ssh.port) });
      if (!result.success) {
        const errors: Record<string, string> = {};
        for (const issue of result.error.issues)
          errors[String(issue.path[0])] =
            issue.path[0] === 'hostKeySha256'
              ? '请输入可信主机公钥的 64 位 SHA-256 十六进制指纹'
              : '请填写有效的' +
                ({ host: '主机', port: '端口（1–65535）', username: '用户名', root: '绝对目录' }[String(issue.path[0])] ?? '值');
        setFieldErrors(errors);
        const field = form.current?.elements.namedItem(Object.keys(errors)[0] ?? '');
        if (field instanceof HTMLElement) field.focus();
        return;
      }
      settings = { ...settings, ssh: result.data };
    }
    setFieldErrors({});
    await run(async () => {
      await window.studio.setup.save(settings);
      setDraft(settings);
    });
  }
  return (
    <section aria-labelledby="settings-installation">
      <h2 id="settings-installation">比赛环境安装</h2>
      <p className="muted">首次准备需要网络获取 Docker Sandboxes 与基础环境。项目工具随包安装；登录在系统终端中完成。</p>
      {stateError && <Notice tone="bad">{stateError}</Notice>}
      {!snapshot ? (
        <p role="status">正在读取安装状态…</p>
      ) : (
        <>
          <p role="status" aria-live="polite">
            {stages[snapshot.stage]}
            {snapshot.busy ? ' · 正在进行' : ''}
          </p>
          {snapshot.error && <Notice tone="bad">{snapshot.error.message}</Notice>}
          {error && <Notice tone="bad">{error}</Notice>}
          {snapshot.restartRequired && <Notice tone="warn">配置已保存，重启应用后生效。正在运行的会话与终端继续使用原配置。</Notice>}
          {snapshot.stage === 'ready' && <Notice>工具与凭据配置已检查。真实模型回复尚未验证，请在重启后通过会话使用。</Notice>}
          {snapshot.stage === 'docker-login' && <Notice>请登录 Docker；已有有效登录可直接继续准备。</Notice>}
          {snapshot.stage === 'model-login' && <Notice>请完成模型登录，然后检查环境。已有凭据会保留。</Notice>}
          <div className="row">
            <button type="button" className="btn" disabled={blocked} onClick={() => void run(() => window.studio.setup.check())}>
              检查安装条件
            </button>
            <button type="button" className="btn" disabled={blocked} onClick={() => void run(() => window.studio.setup.prepare())}>
              {snapshot.stage === 'check' ? '开始准备' : '继续准备'}
            </button>
            {snapshot.error && (
              <button type="button" className="btn" disabled={blocked} onClick={() => void run(() => window.studio.setup.retry())}>
                重试安装
              </button>
            )}
            {(snapshot.busy || snapshot.pendingLogin) && (
              <button
                type="button"
                className="btn"
                onClick={() => void window.studio.setup.cancel().catch((failure: unknown) => setError((failure as Error).message))}
              >
                取消安装操作
              </button>
            )}
          </div>
          {snapshot.config.sbxBinary && (
            <div className="stack-8">
              <button
                type="button"
                className="btn"
                disabled={blocked}
                onClick={() => void run(() => window.studio.setup.login('docker', false))}
              >
                打开 Docker 登录
              </button>
              <label className="row">
                <input type="checkbox" checked={consent} disabled={blocked} onChange={(event) => setConsent(event.target.checked)} />
                允许本次登录更新 sbx 全局 OpenAI OAuth 凭据（影响其他沙箱）
              </label>
              <button
                type="button"
                className="btn"
                disabled={blocked || !consent}
                onClick={() => void run(() => window.studio.setup.login('openai', true))}
              >
                打开模型登录
              </button>
            </div>
          )}
          <h3>本地目录与 SSH</h3>
          <form
            ref={form}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (!blocked) void save();
            }}
          >
            <label className="field">
              已授权本地目录
              <input readOnly value={draft?.localRoot ?? ''} placeholder="未授权，本地文件和终端不可用" />
            </label>
            <div className="row">
              <button
                type="button"
                className="btn"
                ref={rootChooser}
                disabled={blocked}
                onClick={() =>
                  void run(async () => {
                    restoreChooserFocus.current = true;
                    const root = await window.studio.setup.chooseRoot();
                    if (root) setDraft((current) => (current ? { ...current, localRoot: root } : current));
                  })
                }
              >
                选择本地目录
              </button>
              <button
                type="button"
                className="btn"
                disabled={blocked || !draft?.localRoot}
                onClick={() => setDraft((current) => (current ? { ...current, localRoot: null } : current))}
              >
                清除目录授权
              </button>
            </div>
            <label className="row">
              <input type="checkbox" checked={sshEnabled} disabled={blocked} onChange={(event) => setSshEnabled(event.target.checked)} />
              配置可信 SSH 环境
            </label>
            {sshEnabled && (
              <>
                {(['host', 'port', 'username', 'hostKeySha256', 'root'] as const).map((key) => (
                  <label className="field" key={key}>
                    {
                      {
                        host: 'SSH 主机',
                        port: 'SSH 端口',
                        username: 'SSH 用户名',
                        hostKeySha256: '可信主机 SHA-256 指纹',
                        root: 'SSH 授权目录',
                      }[key]
                    }
                    <input
                      name={key}
                      aria-label={
                        {
                          host: 'SSH 主机',
                          port: 'SSH 端口',
                          username: 'SSH 用户名',
                          hostKeySha256: '可信主机 SHA-256 指纹',
                          root: 'SSH 授权目录',
                        }[key]
                      }
                      value={ssh[key]}
                      disabled={blocked}
                      aria-invalid={!!fieldErrors[key]}
                      aria-describedby={fieldErrors[key] ? 'ssh-error-' + key : undefined}
                      onChange={(event) => setSsh((current) => ({ ...current, [key]: event.target.value }))}
                    />
                    {fieldErrors[key] && (
                      <span id={'ssh-error-' + key} className="text-warn">
                        {fieldErrors[key]}
                      </span>
                    )}
                  </label>
                ))}
                <p className="muted">使用本设备已有 SSH agent；应用不保存私钥。主机指纹须从可信渠道取得。</p>
              </>
            )}
            <button className="btn" type="submit" disabled={blocked || !draft}>
              保存环境配置
            </button>
          </form>
        </>
      )}
    </section>
  );
}
