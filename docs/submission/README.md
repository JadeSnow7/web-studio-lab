# 参赛文档本地审阅稿

[作品介绍](oschina-2026.md)和[证据索引](oschina-2026-evidence.md)描述 2026-10-08 的本地整合状态，保留 VS001 的历史快照与原判定。本轮不发布、不提交参赛材料；稿件存在不表示真实产品验收、视频或报名已完成。

导出工具已接入，由 [export_pdf.py](export_pdf.py) 将两份源稿合成 PDF，正文和索引仍是编辑入口。E01–E14 跳转到 PDF 内部索引；历史公开 URL 原样保留，本地相对链接明确指向本地文件，不能把未推送的代码和证据转换成虚构 GitHub 快照。

## 导出

工具需要 Python 3.10+、Pandoc 2.17+、ReportLab 4+ 及覆盖简体中文的字体。只使用现有文档运行环境，不修改项目 npm 依赖或复制系统字体。macOS 可显式指定已验证可读取的 STHeiti TTC：

```sh
python3 docs/submission/export_pdf.py \
  --font '/System/Library/Fonts/STHeiti Light.ttc' \
  --output output/submission/oschina-2026-draft.pdf
```

其他机器可传已安装的中文 TTF/TTC。Pandoc 须在 PATH 中；ReportLab 缺失时需先配置文档运行环境。输出必须位于验收归档之外，默认 output/submission 为生成文件目录。PDF 页脚使用当前稿件日期，不将其当成所有历史证据的运行日期。

导出后逐页渲染检查中文、长 SHA/路径、表格跨页、内部锚点和外部/本地链接。只有导出命令退出0不足以判断版面和引用通过；本轮结果由[整合记录](../acceptance/integration-20261008/task-summary.md)说明。

## 更新依据

更新能力描述前核对当前源码、对应提交和原始运行证据。新成功记录使用新 run 与方法/产品指纹，历史失败原样保留。正式材料仍需补齐实际视频、报名与版本信息；本地审阅 PDF 不替代这些材料。
