import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initializeTerminal } from './state/terminal';
import { initializeChat } from './state/chat';
import { App } from './App';
import { environmentStore } from './state/execution';
import { track } from './state/errors';
import { previewStore } from './state/preview';
import { shellActions } from './state/shell';
import { uiActions } from './state/ui';
import { workbenchActions } from './state/workbench';
import './styles/app.css';

const { studio } = window;
void initializeChat();
void initializeTerminal();

// 主进程推送的事件是 Browser 区状态与现场的唯一来源。
studio.preview.onState((state) => previewStore.set(() => state));
studio.preview.onCaptured((capture) => workbenchActions.setCapture(capture));
studio.shell.onCommand((command) => {
  switch (command) {
    case 'toggle-workshop':
      shellActions.toggleWorkshop();
      break;
    case 'toggle-right-panel':
      shellActions.toggleRightPanel();
      break;
    case 'open-settings':
      shellActions.navigate('settings');
      break;
    case 'focus-address':
      shellActions.navigate('space');
      shellActions.setBrowserTab('preview');
      uiActions.requestAddressFocus();
      break;
  }
});

// 首次读取只在还没收到推送时使用，避免旧响应覆盖更新的推送。
void track('读取 Browser 区状态', studio.preview.getState()).then((state) => {
  if (state) previewStore.set((current) => current ?? state);
});
void track('读取执行服务状态', studio.execution.getStatus()).then((execution) => {
  if (execution) environmentStore.set((env) => ({ ...env, execution }));
});
void track('读取应用信息', studio.app.getInfo()).then((appInfo) => {
  if (appInfo) environmentStore.set((env) => ({ ...env, appInfo }));
});

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 节点');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
