import { z } from 'zod';

export const AppInfoSchema = z.object({
  appVersion: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  packaged: z.boolean(),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

/** 菜单与快捷键命令。主进程统一处理快捷键，焦点在 Browser 区页面时也能生效。 */
export const ShellCommandSchema = z.enum(['toggle-workshop', 'toggle-right-panel', 'focus-address', 'open-settings']);
export type ShellCommand = z.infer<typeof ShellCommandSchema>;
