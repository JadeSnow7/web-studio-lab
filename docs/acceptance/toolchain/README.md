# PR1 基线工具链存档

这里的 `package.json` 与 `package-lock.json` 按原字节保存自 main `2466936454658153e47a430ce1da853826f69f69`，用于追溯 PR1 基线，不是当前安装入口。

根目录仍保留原字节 `package-lock.json`，因为既有 `baselineFingerprint` 将它作为固定验收指纹输入。它不匹配整合后的根 manifest，不用于 `npm install` / `npm ci`。验收实现与 `tsconfig.json` 保持不变；整合后根 manifest 的变化会产生新的基线指纹，不冒充旧回执。

当前根目录以 `pnpm-lock.yaml` 和 `pnpm install --frozen-lockfile` 为权威。产品保留 TypeScript 6.0.3；基线通过 `typescript-baseline` 别名保留 TypeScript 5.9.3，其余基线依赖沿用原精确版本。

`pnpm typecheck` 同时检查产品与基线，`pnpm baseline:selftest` 运行无模型基线自测。`pnpm baseline` 是原有显式运行入口，不属于默认 `check`；执行前仍须核对其模型和沙箱授权。
