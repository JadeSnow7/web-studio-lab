import { registrySnapshot } from './registry';

/**
 * Host 经 CDP 调用的唯一页面入口（wsl-agent-bridge/v1）。只在 agent/开发构建中由 main.tsx 动态导入；
 * 只能读取已暴露状态或调用已登记命令，参数先经命令目录的 zod schema 校验。不执行任何传入代码。
 */
const BRIDGE_ID = 'wsl-agent-bridge/v1';
const MAX_RESPONSE = 65536;
type Failure = { code: string; message: string; issues?: { path: string; message: string }[] };

function reply(value: { ok: true; data: unknown } | { ok: false; error: Failure }): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return JSON.stringify({ ok: false, error: { code: 'command_failed', message: '结果不能 JSON 序列化' } });
  }
  return text.length > MAX_RESPONSE
    ? JSON.stringify({ ok: false, error: { code: 'command_failed', message: `结果超过 ${MAX_RESPONSE} 字符预算` } })
    : text;
}

export async function handleAgentRequest(json: string): Promise<string> {
  let request: unknown;
  try {
    request = JSON.parse(json);
  } catch {
    return reply({ ok: false, error: { code: 'invalid_request', message: '请求不是 JSON' } });
  }
  const { commands, states } = registrySnapshot();
  if (!request || typeof request !== 'object' || !('op' in request))
    return reply({ ok: false, error: { code: 'invalid_request', message: '缺少 op' } });
  const body = request as { op: unknown; name?: unknown; names?: unknown; input?: unknown };
  if (body.op === 'describe')
    return reply({ ok: true, data: { version: 1, commands: [...commands.keys()].sort(), states: [...states.keys()].sort() } });
  if (body.op === 'state') {
    const names = Array.isArray(body.names) ? body.names.filter((name): name is string => typeof name === 'string') : [...states.keys()];
    const values: Record<string, unknown> = {};
    for (const name of names.sort()) {
      const getter = states.get(name);
      if (!getter) return reply({ ok: false, error: { code: 'state_not_found', message: `未暴露状态：${name}` } });
      values[name] = getter();
    }
    return reply({ ok: true, data: values });
  }
  if (body.op !== 'invoke' || typeof body.name !== 'string')
    return reply({ ok: false, error: { code: 'invalid_request', message: '未知操作' } });
  const command = commands.get(body.name);
  if (!command) return reply({ ok: false, error: { code: 'command_not_found', message: `命令未挂载：${body.name}` } });
  const parsed = command.input.safeParse(body.input ?? {});
  if (!parsed.success)
    return reply({
      ok: false,
      error: {
        code: 'command_invalid_input',
        message: `命令 ${body.name} 的输入不符合 schema`,
        issues: parsed.error.issues.slice(0, 50).map((issue) => ({ path: issue.path.join('.') || '(root)', message: issue.message })),
      },
    });
  try {
    return reply({ ok: true, data: (await command.run(parsed.data)) ?? null });
  } catch (error) {
    return reply({ ok: false, error: { code: 'command_failed', message: error instanceof Error ? error.message : String(error) } });
  }
}

export function mountAgentBridge(target: object = window): void {
  if (Object.prototype.hasOwnProperty.call(target, '__WSL_AGENT__')) return;
  Object.defineProperty(target, '__WSL_AGENT__', {
    value: Object.freeze({ id: BRIDGE_ID, version: 1, call: handleAgentRequest }),
    writable: false,
    configurable: false,
    enumerable: false,
  });
}
