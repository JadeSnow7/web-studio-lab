# 参赛文档源稿

- [oschina-2026.md](oschina-2026.md)：按四项评审维度组织的作品介绍，明确当前能力与待补材料。
- [oschina-2026-evidence.md](oschina-2026-evidence.md)：每条论点的证据边界、归档指纹和固定提交链接。
- [export_pdf.py](export_pdf.py)：把两份 Markdown 合并为带引用链接的审阅 PDF。

本目录只负责文档，不接入或实现 vertical slice。证据以源稿列出的固定仓库快照为准；不能因后续 main 改变而自动升级本文结论。正式提交前更新真实产品运行、视频、版本和报名信息。

## 导出 PDF

导出使用 Python 3.10+、Pandoc 2.17+、ReportLab 4+ 和支持简体中文的静态 TrueType 字体。依赖仅用于文档工具，不修改项目 npm 清单、锁文件或 acceptance 基准。

```sh
python3 -m pip install 'reportlab>=4,<5'
python3 docs/submission/export_pdf.py \
  --font /absolute/path/to/NotoSansSC-Regular.ttf \
  --output output/submission/oschina-2026-draft.pdf
```

Pandoc 需要另外安装并可从 PATH 调用。字体由用户指定，不打包第三方字体到仓库。输出目录默认由 `.gitignore` 排除。

PDF 包含作品介绍和证据索引：E01-E13 引用跳转到索引；已核验源码与归档的相对链接转换为源稿对应快照的 GitHub 地址。正文和索引仍是编辑入口，不直接修改生成的 PDF。导出后应检查中文、表格换页和链接，再确定正式提交版本。

## 更新与复核

1. 核对 README、产品代码与真实运行记录，再修改能力表述。
2. 新成功证据应使用新的 runId、产品提交和版本，并保持场景边界。原实现前记录原样保留。
3. 同步更新证据索引与源稿中的快照；导出工具从源稿读取快照 SHA，不使用浮动 main。
4. 检查 Markdown 相对链接、PDF 排版和待补材料状态；本目录变更不得修改 acceptance、fixture、测试或依赖锁。
