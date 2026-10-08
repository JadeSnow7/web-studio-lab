# 第三方依赖说明

## parse5 与 entities（公开文档解析）

本轮使用 parse5 8.0.1（MIT），其依赖 entities 8.1.0（BSD-2-Clause），均由 npm 官方包分发。用途是在 Electron main 中解析真实 HTML 为无脚本正文；不把第三方 HTML 原样渲染。完整许可文本随安装包位于各包 LICENSE；版本由 pnpm-lock.yaml 固定。
