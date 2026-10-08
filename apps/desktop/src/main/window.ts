import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow } from 'electron';
import type { TrustedRenderer } from './ipc-guard';

export const MIN_WINDOW = { width: 960, height: 640 } as const;

export function rendererSource(): TrustedRenderer {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (!app.isPackaged && devUrl) return { kind: 'dev-server', origin: new URL(devUrl).origin };
  return { kind: 'file', url: pathToFileURL(path.join(__dirname, '../renderer/index.html')).toString() };
}

export function createMainWindow(trusted: TrustedRenderer): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    show: false,
    title: 'Web Studio Lab',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 15 },
    backgroundColor: '#F6F7F9',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 工作台页面只停留在自身入口，不跟随链接导航。
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());

  if (trusted.kind === 'dev-server') {
    void window.loadURL(process.env['ELECTRON_RENDERER_URL'] as string);
  } else {
    void window.loadURL(trusted.url);
  }
  return window;
}
