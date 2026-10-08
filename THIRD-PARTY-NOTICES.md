# 第三方依赖说明

## parse5 与 entities（公开文档解析）

本轮使用 parse5 8.0.1（MIT），其依赖 entities 8.1.0（BSD-2-Clause），均由 npm 官方包分发。用途是在 Electron main 中解析真实 HTML 为无脚本正文；不把第三方 HTML 原样渲染。完整许可文本随安装包位于各包 LICENSE；版本由 pnpm-lock.yaml 固定。

## 统一观察与环境适配（2026-10-08）

| 依赖            | 固定版本 | 用途与包内许可依据                                                                                                         |
| --------------- | -------- | -------------------------------------------------------------------------------------------------------------------------- |
| @xterm/headless | 6.0.0    | 由同一 PTY 流构造可读取的 VT 屏幕；package.json 标注 MIT，上游 xterm.js commit 为 f447274f430fd22513f6adbf9862d19524471c04 |
| ssh2            | 1.17.0   | 使用 SSH agent、host-key pin、shell channel 与 SFTP；包内 LICENSE 为 Brian White 的 MIT 许可文本                           |
| asn1            | 0.2.6    | ssh2 依赖；MIT                                                                                                             |
| bcrypt-pbkdf    | 1.0.2    | ssh2 依赖；包元数据标注 BSD-3-Clause，包内 LICENSE 还列出 bcrypt_pbkdf 和 Javascript 优化部分的各自许可                    |
| tweetnacl       | 0.14.5   | bcrypt-pbkdf 依赖；Unlicense                                                                                               |

完整依赖图与精确版本仍以 pnpm-lock.yaml 为准。ssh2 还声明可选 cpu-features/nan；这张表不是整个产品的许可证审计或发布清单。当前仅生成本地未签名试用包，未进行正式发布。公开分发前需核对最终打包内容和随包许可文本，不能把 npm 元数据摘要当作完整许可附件。
