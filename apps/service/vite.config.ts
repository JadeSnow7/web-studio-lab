import path from 'node:path';

// 单独构建 Node 服务；desktop main 只启动构建产物，不导入其源码。
export default {
  resolve: {
    alias: {
      '@xterm/headless': path.resolve('../service/node_modules/@xterm/headless/lib-headless/xterm-headless.js'),
      '@wsl/protocol': path.resolve('../../packages/protocol/src/index.ts'),
      zod: path.resolve('node_modules/zod'),
    },
  },
  ssr: { noExternal: true },
  build: {
    ssr: path.resolve('../service/src/index.ts'),
    outDir: path.resolve('../service/out'),
    emptyOutDir: true,
    rollupOptions: {
      external: (id: string) => id === 'cpu-features' || id.endsWith('.node'),
      output: { format: 'cjs', entryFileNames: 'index.cjs' },
    },
  },
};
