import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { ShellCommand } from '@wsl/protocol';
import { sendToRenderer } from './ipc';

/**
 * 应用菜单承担全局快捷键：焦点在 Browser 区页面时，按键不会到达工作台 renderer，
 * 菜单加速键仍然生效。编辑菜单提供系统复制、粘贴与输入法相关的标准行为。
 */
export function installAppMenu(
  window: BrowserWindow,
  preview: { reload(): void | Promise<void>; openDevTools(): void | Promise<void> },
): void {
  const command = (name: ShellCommand) => () => {
    if (window.isDestroyed()) return;
    window.webContents.focus();
    sendToRenderer(window, 'shell:command', name);
  };

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about', label: '关于 Web Studio Lab' },
        { type: 'separator' },
        { label: '应用设置…', accelerator: 'CmdOrCtrl+,', click: command('open-settings') },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 Web Studio Lab' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 Web Studio Lab' },
      ],
    },
    { role: 'editMenu', label: '编辑' },
    {
      label: '显示',
      submenu: [
        { label: '显示或隐藏 Workshop', accelerator: 'CmdOrCtrl+B', click: command('toggle-workshop') },
        { label: '显示或隐藏通知', accelerator: 'CmdOrCtrl+Alt+B', click: command('toggle-right-panel') },
        { label: '专注模式', accelerator: 'CmdOrCtrl+Shift+F', click: command('toggle-focus-mode') },
        { label: '编辑地址', accelerator: 'CmdOrCtrl+L', click: command('focus-address') },
        { type: 'separator' },
        {
          label: '重新加载 Browser 区页面',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            void Promise.resolve(preview.reload()).catch((error) => console.error('网页重新加载失败', error));
          },
        },
        {
          label: '打开 Browser 区页面 DevTools',
          accelerator: 'CmdOrCtrl+Alt+I',
          click: () => {
            void Promise.resolve(preview.openDevTools()).catch((error) => console.error('网页 DevTools 操作失败', error));
          },
        },
        { label: '打开工作台 DevTools', click: () => window.webContents.openDevTools({ mode: 'detach' }) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' },
      ],
    },
    { role: 'windowMenu', label: '窗口' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
