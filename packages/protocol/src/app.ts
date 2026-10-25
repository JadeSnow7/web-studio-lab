import { z } from 'zod';

export const AppInfoSchema = z.object({
  appVersion: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  packaged: z.boolean(),
  /**
   * 诊断模式：开发服务器或 WSL_DEBUG_STATUS=1，与诊断通道是同一判定（只在 Main）。
   * renderer 据此决定是否显示未接入的演示入口（OPS-1 S4）；不授予权限，也不改变业务状态。
   */
  diagnostics: z.boolean(),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

/** 菜单与快捷键命令。主进程统一处理快捷键，焦点在 Browser 区页面时也能生效。 */
export const ShellCommandSchema = z.enum([
  'toggle-workshop',
  'toggle-right-panel',
  'toggle-focus-mode',
  'focus-address',
  'open-settings',
  'new-web-tab',
  'close-tab',
  'command-palette',
  'toggle-capture',
  'split-pane',
  'cancel-session-run',
  'activate-tab-1',
  'activate-tab-2',
  'activate-tab-3',
  'activate-tab-4',
  'activate-tab-5',
  'activate-tab-6',
  'activate-tab-7',
  'activate-tab-8',
  'activate-tab-9',
]);
export type ShellCommand = z.infer<typeof ShellCommandSchema>;

export const NativeBrowserFocusSchema = z
  .object({
    workspaceId: z.string().min(1),
    resourceId: z.string().min(1),
    webContentsId: z.number().int().positive(),
    documentGeneration: z.number().int().nonnegative(),
  })
  .strict();
export type NativeBrowserFocus = z.infer<typeof NativeBrowserFocusSchema>;
export const ShellCommandEventSchema = z
  .object({ command: ShellCommandSchema, nativeBrowser: NativeBrowserFocusSchema.nullable() })
  .strict();
export type ShellCommandEvent = z.infer<typeof ShellCommandEventSchema>;
