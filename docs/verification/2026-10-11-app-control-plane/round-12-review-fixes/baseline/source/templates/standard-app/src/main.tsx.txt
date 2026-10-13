import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing application root');
// Agent 桥接只存在于 agent/开发构建；生产构建中此分支与 bridge 模块被整体消除。
if (__WSL_AGENT_BUILD__) void import('./agent/bridge').then(({ mountAgentBridge }) => mountAgentBridge());
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
