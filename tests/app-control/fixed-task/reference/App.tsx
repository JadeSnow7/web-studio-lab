import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from './components/Button';
import { useAgentCommand, useAgentState } from './agent/registry';

const healthSchema = z.object({
  ok: z.literal(true),
  templateId: z.string(),
  templateVersion: z.string(),
  identity: z.object({ workspaceId: z.string(), environmentId: z.string(), projectId: z.string(), appInstanceId: z.string() }),
});

const kvSchema = z.object({ value: z.string() });

/** 固定任务的参考实现：仅用于证明基准能接受正确实现，不随模板分发。 */
function WelcomeCard() {
  const [value, setValue] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<Promise<Response> | null>(null);
  const ensureSession = () =>
    (session.current ??= fetch('/api/dev/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: 'A' }),
    }));
  useEffect(() => {
    void (async () => {
      await ensureSession();
      const response = await fetch('/api/kv/welcome', { cache: 'no-store' });
      setValue(response.ok ? kvSchema.parse(await response.json()).value : '');
    })();
  }, []);
  useAgentState('welcome', { value, saving, error });
  const save = async () => {
    const text = draft.trim();
    if (!text) {
      setError('请输入欢迎语');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await ensureSession();
      const response = await fetch('/api/kv/welcome', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ value: text }),
      });
      if (!response.ok) throw new Error(`保存失败（${response.status}）`);
      setValue(kvSchema.parse(await response.json()).value);
      setDraft('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };
  return (
    <section aria-labelledby="welcome-heading" className="mt-6 rounded-xl border border-slate-200 bg-white p-6">
      <h2 id="welcome-heading" className="font-semibold text-slate-900">
        欢迎语
      </h2>
      <p className="mt-2 text-sm text-slate-700" data-testid="welcome-value">
        {value ?? '加载中…'}
      </p>
      <div className="mt-4 flex flex-wrap gap-3">
        <input
          aria-label="欢迎语"
          className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm"
          data-testid="welcome-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button data-testid="welcome-save" disabled={saving} onClick={() => void save()}>
          保存欢迎语
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm text-red-600" data-testid="welcome-error">
          {error}
        </p>
      )}
    </section>
  );
}

export default function App() {
  const [health, setHealth] = useState<z.infer<typeof healthSchema> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    setBusy(true);
    try {
      const response = await fetch('/api/health', { signal, cache: 'no-store' });
      if (!response.ok) throw new Error(`服务暂不可用（${response.status}）`);
      setHealth(healthSchema.parse(await response.json()));
      setError('');
    } catch (cause) {
      if (signal?.aborted) return;
      setHealth(null);
      setError(cause instanceof Error ? cause.message : '无法连接应用服务');
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);
  // 只读观察：Agent 通过 app.state.read / health.refresh 佐证 UI 结果，不代替用户操作。
  const healthState = {
    status: error ? 'error' : health ? 'ok' : 'loading',
    busy,
    error: error || null,
    identity: health?.identity ?? null,
  };
  useAgentState('app.health', healthState);
  useAgentCommand('health.refresh', async () => {
    await refresh();
    return null;
  });
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 sm:py-24">
      <p className="mb-8 text-sm font-medium tracking-wide text-slate-500">WEB STUDIO LAB / 标准应用</p>
      <h1 className="mb-4 text-3xl font-semibold tracking-tight text-slate-900">从这里开始构建</h1>
      <p className="max-w-xl leading-7 text-slate-600">这是你的应用起点。在工作台中描述需求，逐步构建页面和功能。</p>
      <section aria-labelledby="service-heading" className="mt-10 rounded-xl border border-slate-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 id="service-heading" className="font-semibold text-slate-900">
              应用服务
            </h2>
            <p role="status" aria-live="polite" className="mt-2 text-sm text-slate-600" data-testid="health-status">
              {error || (health ? '已连接 · 数据库就绪' : '正在连接…')}
            </p>
          </div>
          <Button
            data-testid="health-refresh"
            disabled={busy}
            onClick={() => {
              void refresh();
            }}
          >
            {busy ? '检查中…' : '检查连接'}
          </Button>
        </div>
        {health && (
          <dl className="mt-6 grid gap-4 border-t border-slate-100 pt-5 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-slate-500">项目</dt>
              <dd className="mt-1 break-all font-mono text-slate-800" data-testid="project-id">
                {health.identity.projectId}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">应用实例</dt>
              <dd className="mt-1 break-all font-mono text-slate-800" data-testid="app-instance-id">
                {health.identity.appInstanceId}
              </dd>
            </div>
          </dl>
        )}
      </section>
      <WelcomeCard />
      <p className="mt-6 text-xs leading-6 text-slate-500">标准模板 1.1.0 · 页面与 API 由同一个应用服务提供</p>
    </main>
  );
}
