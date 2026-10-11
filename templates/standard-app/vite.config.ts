import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig(({ mode }) => ({
  // 受管开发实例用 `vite build --mode agent`；生产 `vite build` 为 false，桥接被消除。
  define: { __WSL_AGENT_BUILD__: JSON.stringify(mode === 'agent' || mode === 'development') },
  plugins: [react(), tailwindcss()],
  build: { outDir: 'dist/client' },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: { '/api': `http://127.0.0.1:${process.env.PORT ?? '3000'}` },
  },
}));
