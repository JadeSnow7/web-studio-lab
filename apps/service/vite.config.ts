import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * workflow VM worker 是 node:worker_threads 启动的真实文件，不进单文件 bundle：
 * 构建后原样复制到 out/vm-worker.mjs，其 imports（quickjs-emscripten 闭包，
 * 含 wasmfile 的 emscripten-module.wasm）复制到 out/node_modules/。
 * 这样开发产物与打包 extraResources（service/ 整目录）下都能按 Node 解析运行。
 */
const WORKER_RUNTIME_PACKAGES = [
  'quickjs-emscripten',
  'quickjs-emscripten-core',
  '@jitl/quickjs-ffi-types',
  '@jitl/quickjs-wasmfile-release-sync',
  '@jitl/quickjs-wasmfile-release-asyncify',
  '@jitl/quickjs-wasmfile-debug-sync',
  '@jitl/quickjs-wasmfile-debug-asyncify',
];

function packageDirOf(require_: NodeRequire, name: string): string {
  try {
    return path.dirname(require_.resolve(`${name}/package.json`));
  } catch {
    // exports 未开放 ./package.json 时退回入口向上找包根。
    let dir = path.dirname(require_.resolve(name));
    for (;;) {
      if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
      const up = path.dirname(dir);
      if (up === dir) throw new Error(`无法定位 ${name} 的包根`);
      dir = up;
    }
  }
}

const workflowWorkerPlugin = {
  name: 'wsl-workflow-worker-assets',
  apply: 'build' as const,
  closeBundle() {
    const serviceDir = path.resolve('../service');
    const outDir = path.join(serviceDir, 'out');
    fs.copyFileSync(path.join(serviceDir, 'src/workflow/vm-worker.mjs'), path.join(outDir, 'vm-worker.mjs'));
    const require_ = createRequire(path.join(serviceDir, 'package.json'));
    for (const name of WORKER_RUNTIME_PACKAGES) {
      const src = packageDirOf(require_, name);
      const dest = path.join(outDir, 'node_modules', name);
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(path.join(src, 'package.json'), path.join(dest, 'package.json'));
      fs.cpSync(path.join(src, 'dist'), path.join(dest, 'dist'), { recursive: true });
    }
  },
};

// 单独构建 Node 服务；desktop main 只启动构建产物，不导入其源码。
export default {
  resolve: {
    alias: {
      '@xterm/headless': path.resolve('../service/node_modules/@xterm/headless/lib-headless/xterm-headless.js'),
      '@wsl/protocol': path.resolve('../../packages/protocol/src/index.ts'),
      zod: path.resolve('node_modules/zod'),
    },
  },
  plugins: [workflowWorkerPlugin],
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
