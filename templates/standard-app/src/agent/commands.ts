import { z } from 'zod';

/**
 * Agent 命令目录：名称、说明与 zod 输入。构建时导出为 agent/app.manifest.json 中的 JSON Schema；
 * 运行实现由组件用 defineCommand / useAgentCommand 绑定。新增命令先在这里登记。
 * 语义命令只用于准备数据与观察状态，不能代替用户 UI 操作去制造被验收的行为结果。
 */
export const agentCommands = {
  'health.refresh': {
    description: '重新请求 /api/health 并返回应用服务连接状态（只读观察）',
    input: z.object({}).strict(),
  },
} satisfies Record<string, { description: string; input: z.ZodType }>;

export type AgentCommandName = keyof typeof agentCommands;
export type AgentCommandInput<N extends AgentCommandName> = z.infer<(typeof agentCommands)[N]['input']>;
