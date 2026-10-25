import type { NativeBrowserFocus } from '@wsl/protocol';
import { app, Menu, BrowserWindow, type MenuItemConstructorOptions } from 'electron';
import type { ShellCommand } from '@wsl/protocol';
import { sendToRenderer } from './ipc';
import type { NativeMenuHost } from './native-menu';

/**
 * 原生菜单（OPS-1 S5）的生产宿主：在工作台窗口内弹出 Electron 菜单。
 * 菜单打开期间保留引用，关闭回调到达后释放；坐标已由 NativeMenuService 限制在内容区内。
 * 窗口关闭、工作台页面重新加载 / 导航或 renderer 进程退出时通知服务结束仍打开的菜单。
 */
export function nativeMenuHost(window: BrowserWindow): NativeMenuHost {
  const open = new Set<Menu>();
  return {
    contentSize: () => {
      if (window.isDestroyed()) return null;
      const [width = 0, height = 0] = window.getContentSize();
      return { width, height };
    },
    popup: (template, options) => {
      if (window.isDestroyed()) throw new Error('工作台窗口已关闭');
      const menu = Menu.buildFromTemplate(template);
      open.add(menu);
      menu.popup({
        window,
        ...options,
        callback: () => {
          open.delete(menu);
          options.callback();
        },
      });
    },
    close: () => {
      for (const menu of open) {
        open.delete(menu);
        if (!window.isDestroyed()) menu.closePopup(window);
      }
    },
    onInvalidated: (listener) => {
      window.on('closed', listener);
      window.webContents.on('render-process-gone', () => listener());
      window.webContents.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) listener();
      });
    },
  };
}

/**
 * 应用菜单承担全局快捷键：焦点在 Browser 区页面时，按键不会到达工作台 renderer，
 * 菜单加速键仍然生效。编辑菜单提供系统复制、粘贴与输入法相关的标准行为。
 */
export function installAppMenu(
  window: BrowserWindow,
  preview: {
    reload(): void | Promise<void>;
    openDevTools(): void | Promise<void>;
    nativeFocus(): NativeBrowserFocus | null;
  },
  options: { debugStatus?: boolean } = {},
): void {
  const command = (name: ShellCommand) => () => {
    if (window.isDestroyed() || BrowserWindow.getFocusedWindow() !== window) return;
    // Preserve native focus before renderer receives the command; focusing here would lose its owner.
    sendToRenderer(window, 'shell:command', { command: name, nativeBrowser: preview.nativeFocus() });
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
    {
      label: '文件',
      submenu: [
        { label: '新建网页标签', accelerator: 'CmdOrCtrl+T', click: command('new-web-tab') },
        { label: '关闭活动标签', accelerator: 'CmdOrCtrl+W', click: command('close-tab') },
        {
          label: '关闭窗口',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => {
            if (!window.isDestroyed() && BrowserWindow.getFocusedWindow() === window) window.close();
          },
        },
      ],
    },
    { role: 'editMenu', label: '编辑' },
    {
      label: '显示',
      submenu: [
        { label: '命令面板', accelerator: 'CmdOrCtrl+K', click: command('command-palette') },
        { label: '选择元素 / 取消点选', accelerator: 'CmdOrCtrl+E', click: command('toggle-capture') },
        { label: '左右分屏', accelerator: 'CmdOrCtrl+\\', click: command('split-pane') },
        { label: '取消活动会话回复', accelerator: 'CmdOrCtrl+.', click: command('cancel-session-run') },
        ...Array.from({ length: 9 }, (_, index) => ({
          label: index === 8 ? '最后一个标签' : `第 ${index + 1} 个标签`,
          accelerator: `CmdOrCtrl+${index + 1}`,
          click: command(`activate-tab-${index + 1}` as ShellCommand),
        })),
        { label: '显示或隐藏 Workshop', accelerator: 'CmdOrCtrl+B', click: command('toggle-workshop') },
        { label: '显示或隐藏通知', accelerator: 'CmdOrCtrl+Alt+B', click: command('toggle-right-panel') },
        { label: '专注模式', accelerator: 'CmdOrCtrl+Shift+F', click: command('toggle-focus-mode') },
        { label: '编辑地址', accelerator: 'CmdOrCtrl+L', click: command('focus-address') },
        { type: 'separator' },
        {
          label: '重新加载 Browser 区页面',
          accelerator: 'CmdOrCtrl+R',
          click: () => {
            if (window.isDestroyed() || BrowserWindow.getFocusedWindow() !== window) return;
            void Promise.resolve(preview.reload()).catch((error) => console.error('网页重新加载失败', error));
          },
        },
        {
          label: '打开 Browser 区页面 DevTools',
          accelerator: 'CmdOrCtrl+Alt+I',
          click: () => {
            if (window.isDestroyed() || BrowserWindow.getFocusedWindow() !== window) return;
            void Promise.resolve(preview.openDevTools()).catch((error) => console.error('网页 DevTools 操作失败', error));
          },
        },
        {
          label: '打开工作台 DevTools',
          click: () => {
            if (!window.isDestroyed() && BrowserWindow.getFocusedWindow() === window) window.webContents.openDevTools({ mode: 'detach' });
          },
        },
        // 诊断入口只在诊断通道启用时出现（status-interface.md §8.1）；点击经 debug:panel 事件通知 renderer 切换面板。
        ...(options.debugStatus
          ? ([
              {
                label: '诊断',
                // 不用 ⌥⌘D：它在 macOS 是系统级「显示 / 隐藏 Dock」，会被系统吃掉。
                accelerator: 'CmdOrCtrl+Alt+Shift+D',
                click: () => {
                  if (window.isDestroyed() || BrowserWindow.getFocusedWindow() !== window) return;
                  window.webContents.focus();
                  sendToRenderer(window, 'debug:panel', 'toggle');
                },
              },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏幕' },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        { type: 'separator' },
        { role: 'front', label: '全部置于前面' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
