import { z } from 'zod';
import {
  ObservationSchema,
  ObservationSourcesSchema,
  ObservationErrorSchema,
  type HarnessDescriptor,
  type WorkflowIsolation,
} from '@wsl/protocol';
import type { HarnessEvent, NativeHarnessAdapter } from '../types';

/**
 * Codex CLI native 适配器（ADR-0003）。参数构造、JSONL 事件解析与 MCP 输出裁剪从 codex-chat.ts 原样迁入，行为不变；
 * 能力按已有验证记录声明（round-09/10/11 真实链路），版本由 sbx 连接检查实际探测。
 */
const EventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thread.started'), thread_id: z.string().min(1) }),
  z.object({ type: z.literal('turn.started') }),
  z.object({ type: z.literal('turn.completed') }),
  z.object({ type: z.literal('turn.failed'), error: z.object({ message: z.string() }) }),
  z.object({ type: z.literal('error'), message: z.string() }),
  z.object({
    type: z.literal('item.completed'),
    item: z.object({
      id: z.string(),
      type: z.string(),
      text: z.string().optional(),
      message: z.string().optional(),
      command: z.string().optional(),
      aggregated_output: z.string().optional(),
      exit_code: z.number().int().nullable().optional(),
      server: z.string().optional(),
      tool: z.string().optional(),
      arguments: z.unknown().optional(),
      result: z.unknown().optional(),
      error: z.unknown().optional(),
      status: z.string().optional(),
    }),
  }),
]);
export function parseCodexLine(line: string) {
  const raw: unknown = JSON.parse(line);
  const envelope = z.object({ type: z.string() }).parse(raw);
  if (!EventSchema.options.some((schema) => schema.shape.type.value === envelope.type)) return null;
  return EventSchema.parse(raw);
}
function boundedMcpOutput(item: { status?: string; result?: unknown; error?: unknown }): { output: string; truncated: boolean } {
  const raw = JSON.stringify({ status: item.status, result: item.result ?? null, error: item.error ?? null });
  if (raw.length <= 16000) return { output: raw, truncated: false };
  const boundedSummary = (output: string) =>
    output.length <= 16000 ? output : JSON.stringify({ truncated: true, receiptUnavailable: 'MCP metadata exceeded the record limit' });
  const object = (value: unknown): Record<string, unknown> | null =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  const result = object(item.result);
  let structured = object(result?.['structuredContent'] ?? result?.['structured_content']);
  if (!structured && Array.isArray(result?.['content'])) {
    const text = result['content'].find((entry: unknown) => object(entry)?.['type'] === 'text');
    const content = object(text)?.['text'];
    if (typeof content === 'string') {
      try {
        structured = object(JSON.parse(content));
      } catch {
        structured = null;
      }
    }
  }
  const data = object(structured?.['data']);
  const sources = ObservationSourcesSchema.safeParse(data);
  if (sources.success) {
    const receipt = {
      kind: sources.data.kind,
      workspaceId: sources.data.workspaceId,
      sourceCount: sources.data.sources.length,
      sources: [] as { resource: unknown; instance: unknown }[],
      sourcesOmitted: sources.data.sources.length,
    };
    const summary = () => JSON.stringify({ status: item.status, truncated: true, untrusted: structured?.['untrusted'] === true, receipt });
    for (const source of sources.data.sources) {
      receipt.sources.push({ resource: source.resource, instance: source.instance });
      receipt.sourcesOmitted--;
      if (summary().length > 16000) {
        receipt.sources.pop();
        receipt.sourcesOmitted++;
        break;
      }
    }
    return { output: boundedSummary(summary()), truncated: true };
  }
  const error = ObservationErrorSchema.safeParse(data);
  if (error.success) {
    return {
      output: boundedSummary(
        JSON.stringify({
          status: item.status,
          truncated: true,
          untrusted: structured?.['untrusted'] === true,
          receipt: {
            error: error.data.error,
            message: error.data.message.slice(0, 2000),
            messageOmitted: error.data.message.length > 2000,
            detailsOmitted: error.data.details !== undefined,
          },
        }),
      ),
      truncated: true,
    };
  }
  const observation = ObservationSchema.safeParse(data);
  if (observation.success) {
    const { data: _data, ...metadata } = observation.data;
    const summary = JSON.stringify({
      status: item.status,
      truncated: true,
      untrusted: structured?.['untrusted'] === true,
      receipt: metadata,
    });
    if (summary.length <= 16000) return { output: boundedSummary(summary), truncated: true };
    const {
      revision: _revision,
      coverage,
      nextCursor: _nextCursor,
      capturedAt: _capturedAt,
      startedAt: _startedAt,
      ...identity
    } = metadata;
    return {
      output: boundedSummary(
        JSON.stringify({
          status: item.status,
          truncated: true,
          untrusted: structured?.['untrusted'] === true,
          receipt: { ...identity, coverage: { status: coverage.status } },
          metadataOmitted: ['revision', 'coverage.range', 'coverage.reasons', 'nextCursor', 'capturedAt', 'startedAt'],
        }),
      ),
      truncated: true,
    };
  }
  const receipt: Record<string, unknown> = {};
  for (const key of ['resourceId', 'version', 'url', 'title', 'contentSha256', 'sourceSha256', 'truncated']) {
    if (data?.[key] !== undefined) receipt[key] = data[key];
  }
  if (typeof data?.['text'] === 'string') receipt['textExcerpt'] = data['text'].slice(0, 2000);
  if (Array.isArray(data?.['resources']))
    receipt['resourceIdentities'] = data['resources'].map((entry: unknown) => {
      const resource = object(entry);
      return { resourceId: resource?.['resourceId'], version: resource?.['version'], contentSha256: resource?.['contentSha256'] };
    });
  // Keep an explicit receipt when full MCP output cannot fit the UI record; never slice JSON into a misleading tail.
  const summary = JSON.stringify({ status: item.status, truncated: true, untrusted: structured?.['untrusted'] === true, receipt });
  return {
    output: boundedSummary(summary),
    truncated: true,
  };
}

export const codexAdapter: NativeHarnessAdapter = {
  label: 'Codex',
  mcpInjection: 'codex-config',
  requiresSessionRef: true,
  maxLineChars: 1048576,
  harnessId: 'codex',
  configDirEnv: 'CODEX_HOME',
  // 2026-10-22 在 guest 实测：`codex login status` 把结果写在 stderr，stdout 为空；
  // 已登录退出 0 并以“Logged in”开头，未登录退出 1 并输出“Not logged in”。两个流都看，两种结论同时出现时无法判断。
  selfCheck: {
    versionArgv: ['codex', '--version'],
    statusArgv: ['codex', 'login', 'status'],
    parseStatus(exitCode, stdout, stderr) {
      const lines = `${stdout}\n${stderr}`.split('\n').map((line) => line.trim());
      const loggedIn = lines.some((line) => line.startsWith('Logged in'));
      const loggedOut = lines.some((line) => line.startsWith('Not logged in'));
      if (exitCode === 0 && loggedIn && !loggedOut) return 'logged_in';
      if (exitCode === 1 && loggedOut && !loggedIn) return 'logged_out';
      return 'undetermined';
    },
  },
  descriptor(version: string | null): HarnessDescriptor {
    return {
      harnessId: 'codex',
      displayName: 'Codex CLI',
      adapter: 'native',
      version,
      capabilities: {
        structuredEvents: true,
        mcp: true,
        resume: true,
        permissionRequests: false,
        clientFs: false,
        clientTerminal: false,
        readOnlyMode: true,
        images: false,
      },
      capabilitySource: 'declared',
    };
  },
  argv(sessionRef: string | null): string[] {
    const common = ['codex', 'exec', '--sandbox', 'workspace-write'];
    return sessionRef
      ? [...common, 'resume', '--json', '--skip-git-repo-check', sessionRef, '-']
      : [...common, '--json', '--skip-git-repo-check', '-'];
  },
  /**
   * W3：readonly 是新会话的一次性 exec，--sandbox read-only，不携带 resume。
   * W6a：lane 仍是一次性 exec，但沙箱放宽到 workspace-write——写入只可能落在 helper 物化的
   * 独立 attempt 候选目录，该目录由 Lab 管理且每次 attempt 重建，CLI 不接触用户 checkout。
   * W9：execution 把 effective.model/tier 翻译成 codex CLI 开关——tier 映射
   * model_reasoning_effort（small→low、medium→medium、big→high），model 经 -m 原样透传
   * （≤64 chars 已由内核 validateOpts 定界）；两者可同帧组合，缺省 execution 时 argv 原样。
   */
  argvForIsolation(isolation: WorkflowIsolation, execution?: { model?: string; tier?: 'small' | 'medium' | 'big' }): string[] | null {
    const sandbox = isolation === 'readonly' ? 'read-only' : isolation === 'lane' ? 'workspace-write' : null;
    if (sandbox === null) return null;
    const extra: string[] = [];
    if (execution?.model !== undefined) extra.push('-m', execution.model);
    if (execution?.tier !== undefined) {
      const effort = { small: 'low', medium: 'medium', big: 'high' }[execution.tier];
      extra.push('-c', `model_reasoning_effort=${effort}`);
    }
    return ['codex', 'exec', '--sandbox', sandbox, '--json', '--skip-git-repo-check', ...extra, '-'];
  },
  parseLine(line: string): HarnessEvent[] | null {
    const event = parseCodexLine(line);
    if (!event) return null;
    if (event.type === 'thread.started') return [{ type: 'session', ref: event.thread_id }];
    if (event.type === 'turn.completed') return [{ type: 'turn_completed' }];
    if (event.type === 'turn.failed') return [{ type: 'turn_failed', message: event.error.message }];
    if (event.type === 'error') return [{ type: 'turn_failed', message: event.message }];
    if (event.type !== 'item.completed') return [];
    const item = event.item;
    if (item.type === 'agent_message') {
      if (!item.text?.trim()) throw new Error('Codex 回复缺少文本');
      return [{ type: 'message', id: item.id, text: item.text }];
    }
    if (item.type === 'error') {
      if (!item.message) throw new Error('Codex 警告缺少文本');
      return [{ type: 'warning', text: item.message.slice(0, 2000) }];
    }
    if (item.type === 'command_execution') {
      if (!item.command || item.aggregated_output === undefined || item.exit_code === undefined)
        throw new Error('Codex 工具执行记录缺少字段');
      return [
        {
          type: 'tool',
          id: item.id,
          command: item.command,
          output: item.aggregated_output.slice(-16000),
          exitCode: item.exit_code,
          truncated: item.aggregated_output.length > 16000,
        },
      ];
    }
    if (item.type === 'mcp_tool_call') {
      if (!item.server || !item.tool || !item.status || (item.result === undefined && item.error === undefined))
        throw new Error('Codex MCP 执行记录缺少字段');
      const bounded = boundedMcpOutput(item);
      return [
        {
          type: 'tool',
          id: item.id,
          command: `mcp:${item.server}.${item.tool} ${JSON.stringify(item.arguments ?? {})}`,
          output: bounded.output,
          exitCode: item.status === 'completed' && !item.error ? 0 : 1,
          truncated: bounded.truncated,
        },
      ];
    }
    return [];
  },
};
