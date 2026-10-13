# 本机外置构建产物

本仓库支持按 checkout 单独启用外置构建目录。默认位置是已挂载的 `/Volumes/Developer/BuildArtifacts/web-studio-lab/<checkout-id>/`，`checkout-id` 是 checkout 物理路径 SHA-256 的前 16 位；不同 checkout 不共享产物。未启用的开发者继续使用仓库内目录。

在仓库根目录执行：

```sh
node scripts/external-builds.mjs plan
pnpm builds:external
```

`plan` 只列出映射。启用时，将 `apps/desktop/out`、`apps/service/out`、`apps/desktop/release`、`apps/desktop/release-internal`、`packaging/generated` 和 `packaging/cache` 链接到外盘的同名相对目录，并写入忽略跟踪的 `.local/external-builds.json`（`{"schemaVersion":1}`）。既有真实目录会让启用失败，脚本不覆盖或删除旧产物；须先独立迁移并核对存量，再执行启用。已经正确设置的链接可以重复启用。

启用后，根目录的 `pnpm dev`、`pnpm build`、`pnpm build:service`、`pnpm payloads:prepare`、`pnpm package`、`pnpm package:unsigned`，以及 desktop 包的 dev/build/package 入口，都会先检查挂载和链接。磁盘缺失、外盘目录不存在或链接被替换时立即失败，不在内盘建立替代目录。现有运行和打包路径保持可用。直接调用底层 Vite、Electron Builder 或载荷脚本会绕过此前置检查，应使用上述 pnpm 入口。

可单独检查设置及运行脚本测试：

```sh
node scripts/external-builds.mjs verify
pnpm test:external-builds
```

本设置只迁移列出的构建产物与载荷下载缓存；依赖安装、测试截图和历史验证记录各自保留现有位置。启用外置目录不运行签名、公证或发布。
