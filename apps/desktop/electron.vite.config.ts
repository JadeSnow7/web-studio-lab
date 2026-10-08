import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// main 与 preload 把依赖（含 @wsl/protocol 与 zod）全部打进产物：
// 沙箱 preload 不能 require 第三方模块，打包后的应用也不携带 node_modules。
export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve('src/renderer/index.html'),
      },
    },
  },
});
