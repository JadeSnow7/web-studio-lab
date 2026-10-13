import { useEffect, useRef } from 'react';
import type { z } from 'zod';
import { agentCommands, type AgentCommandInput, type AgentCommandName } from './commands';

/**
 * L2 语义注册表。只有 agent/开发构建（__WSL_AGENT_BUILD__ 为 true）登记命令与状态；
 * 生产构建里这些函数是空操作，桥接模块根本不会被打包。
 */
type Registered = { input: z.ZodType; run: (input: unknown) => unknown };
const commands = new Map<string, Registered>();
const states = new Map<string, () => unknown>();

export function defineCommand<N extends AgentCommandName>(
  name: N,
  definition: { input: (typeof agentCommands)[N]['input']; run: (input: AgentCommandInput<N>) => unknown },
): () => void {
  if (!__WSL_AGENT_BUILD__) return () => undefined;
  const entry = agentCommands[name] as { input: z.ZodType } | undefined;
  if (!entry) throw new Error(`Agent 命令未在 src/agent/commands.ts 登记：${name}`);
  // 输入 schema 必须就是目录里的同一个对象，构建导出的 JSON Schema 才与运行时一致。
  if (definition.input !== entry.input) throw new Error(`Agent 命令输入与目录不一致：${name}`);
  if (commands.has(name)) throw new Error(`Agent 命令重复注册：${name}`);
  const registered: Registered = { input: entry.input, run: definition.run as (input: unknown) => unknown };
  commands.set(name, registered);
  return () => {
    if (commands.get(name) === registered) commands.delete(name);
  };
}

export function exposeState(name: string, getter: () => unknown): () => void {
  if (!__WSL_AGENT_BUILD__) return () => undefined;
  if (!/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)*$/.test(name)) throw new Error(`Agent 状态名无效：${name}`);
  if (states.has(name)) throw new Error(`Agent 状态重复注册：${name}`);
  states.set(name, getter);
  return () => {
    if (states.get(name) === getter) states.delete(name);
  };
}

/** 组件挂载时绑定命令实现，卸载时解除；始终调用最新渲染中的 run。 */
export function useAgentCommand<N extends AgentCommandName>(name: N, run: (input: AgentCommandInput<N>) => unknown): void {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => defineCommand(name, { input: agentCommands[name].input, run: (input) => latest.current(input) }), [name]);
}

/** 暴露最新渲染值的只读快照；值必须可 JSON 序列化。 */
export function useAgentState(name: string, value: unknown): void {
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => exposeState(name, () => latest.current), [name]);
}

/** 仅供 bridge 读取；生产构建中没有调用者。 */
export function registrySnapshot() {
  return { commands, states };
}
