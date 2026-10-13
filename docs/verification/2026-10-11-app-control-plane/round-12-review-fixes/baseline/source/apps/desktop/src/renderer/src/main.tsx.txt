import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/app.css';
import { initializeChat } from './state/chat';
import { environmentStore } from './state/execution';
import { track } from './state/errors';
void initializeChat();
void track('读取执行能力', window.studio.execution.getStatus()).then((execution) => {
  if (execution) environmentStore.set((e) => ({ ...e, execution }));
});
void track('读取应用信息', window.studio.app.getInfo()).then((appInfo) => {
  if (appInfo) environmentStore.set((e) => ({ ...e, appInfo }));
});

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 节点');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
