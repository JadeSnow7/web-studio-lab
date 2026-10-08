# 来源整合裁决

16 个工作树已经记录 HEAD、状态、文件字节摘要与可交付 diff。15 树实际字节稳定；Task5 49 个 dirty 文件稳定，324 个未改旧文件只有 committed fallback，实际字节 `undetermined`，禁止按未知项迁入。两个 primary/7ba6 冻结文件集逐字节相同，只计一个候选来源。

|来源|裁决及依据|
|---|---|
|primary / 7ba6 / 9630|逐文件相对4ab patch已保存；旧 demo/renderer-owned业务状态、缺失真实chat的UI与旧网络/resource流程被4ab运行基础取代。未识别独立修复；保留历史证据与原始差异。|
|eb15|空间功能由SR1按旧外壳重制；三个旧壳组件淘汰。原生DevTools来源、same-space定位、terminal关闭、遮挡等待、草稿/焦点/恢复各有现有迁移代码/测试。尚有review-renderer两项P2真实复现，交coder修复。|
|architecture / integration / guestbrowser / PR1|提交为4ab或其祖先，当前运行基础已纳入；仅祖先关系不代替文件覆盖，file-ledger保留非一致文件差异。规范/记录语义由主线程当前运行时审查，历史记录不覆盖。|
|delivery / task5 dirty|28文件相同，22文件有独立增量，delivery另有6项；不可按更新时间合并。delivery补frame绑定/AX完整性、DOM样式覆盖、terminal严格OSC归属及清理、bounded本地watch/generation失效与UI hints，须保留并按当前Main身份适配。协议/Provider候选已交coder，source ledger adapt/migrate表示需适配，不表示已通过。|
|远端docs606556c|对象已fetch并冻结refs；主线程审阅文档增量。|

逐文件裁决见file-ledger.json。2974条来源记录已完成语义分类；adapt/migrate 表示实施仍须适配或迁入，不等于已经整合通过。Phase1提交331c47f之后的迁入代码由主线程另审；来源冻结仍使用9e1df45基准，不能以新实现反写原始证据。

84条配置与当前文档差异按17个唯一路径复核：保留当前pnpm产品/VS001联合入口、lint环境配置和历史原字节保护；headless/ssh2三个独立依赖已在Phase1纳入。README/架构/设计/交互按最终接线同步，不覆盖旧壳、匿名状态或全未实现宣称。发现 eb15 的原生Select/Listbox ownership元数据遗漏，交Phase3补入；旧premium-audit明确淘汰，两个空间设计PNG仅作历史视觉参考。
