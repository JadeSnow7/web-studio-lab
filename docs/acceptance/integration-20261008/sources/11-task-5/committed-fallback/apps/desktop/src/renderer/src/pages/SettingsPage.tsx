import { Notice } from '../components/Badges';
import { useStore } from '../lib/store';
import { chatStore } from '../state/chat';
import { environmentStore } from '../state/execution';
import { shellActions, shellStore } from '../state/shell';

const CAPABILITIES = ['createSession', 'observeState', 'cancel', 'pause', 'resume', 'enforceScope'] as const;

export function SettingsPage() {
  const env = useStore(environmentStore, (e) => e);
  const pinned = useStore(shellStore, (s) => s.workshop.pinned);
  const chat = useStore(chatStore, (state) => state.status);

  return (
    <div className="page-columns">
      <nav className="page-sidebar" aria-label="设置分组">
        <a className="side-item" href="#settings-appearance">
          外观与窗口
        </a>
        <a className="side-item" href="#settings-harness">
          连接与 Harness
        </a>
        <a className="side-item" href="#settings-about">
          关于
        </a>
      </nav>
      <section className="page-main settings" aria-label="应用设置">
        <h1>应用设置</h1>
        <p className="muted">本设备的应用行为与连接能力。账号资料由首页头像进入（尚未接入）。</p>

        <h2 id="settings-appearance">外观与窗口</h2>
        <fieldset className="field">
          <legend>主题</legend>
          <label className="check">
            <input type="radio" name="theme" defaultChecked /> 极简白
          </label>
          <label className="check check-disabled">
            <input type="radio" name="theme" disabled /> 暗黑（后续版本）
          </label>
          <label className="check check-disabled">
            <input type="radio" name="theme" disabled /> 暖色（后续版本）
          </label>
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={pinned} onChange={(e) => shellActions.setPinned(e.target.checked)} />
          固定显示 Workshop（⌘B 只切换显隐，图钉单独控制固定）
        </label>

        <h2 id="settings-harness">连接与 Harness</h2>
        <Notice tone="warn">{env.execution?.reason ?? '正在读取执行服务状态…'}</Notice>
        <dl className="kv">
          <dt>主 Harness</dt>
          <dd>{chat ? `Codex CLI · ${chat.available ? '对话已连接' : '对话不可用'}` : '读取中…'}</dd>
          <dt>沙箱</dt>
          <dd>{chat?.sandbox ?? '未选择'}</dd>
          <dt>工作目录</dt>
          <dd>
            <code className="wrap">{chat?.cwd ?? '未读取'}</code>
          </dd>
          <dt>CLI 版本</dt>
          <dd>{chat?.version ?? '未读取'}</dd>
          <dt>模型</dt>
          <dd>由 Codex CLI 默认配置决定；连接检查不代表模型回复已验证</dd>
        </dl>
        <Notice>{chat?.reason ?? '对话已连接；任务执行服务仍未接入。'}</Notice>
        <table className="table">
          <thead>
            <tr>
              <th>能力</th>
              <th>支持</th>
              <th>验证</th>
            </tr>
          </thead>
          <tbody>
            {CAPABILITIES.map((c) => (
              <tr key={c}>
                <td>
                  <code>{c}</code>
                </td>
                <td>未知</td>
                <td className="text-warn">未验证</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted small">对话与终端使用所选 sbx 中的环境；OAuth 由 Docker Sandboxes 宿主凭据存储管理。</p>

        <h2 id="settings-about">关于</h2>
        <dl className="kv">
          <dt>版本</dt>
          <dd>{env.appInfo ? `${env.appInfo.appVersion}${env.appInfo.packaged ? '（打包）' : '（开发模式）'}` : '读取中…'}</dd>
          <dt>Electron</dt>
          <dd>{env.appInfo?.electron ?? '—'}</dd>
          <dt>Chromium</dt>
          <dd>{env.appInfo?.chrome ?? '—'}</dd>
          <dt>Node</dt>
          <dd>{env.appInfo?.node ?? '—'}</dd>
          <dt>平台</dt>
          <dd>{env.appInfo ? `${env.appInfo.platform} / ${env.appInfo.arch}` : '—'}</dd>
        </dl>
      </section>
    </div>
  );
}
