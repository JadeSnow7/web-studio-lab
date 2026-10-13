# 候选增量独立只读复核

结论：此前发现的双来源schema3迁移阻断已修复，独立静态复核未发现本次范围剩余具体阻断。

候选：`/private/tmp/wsl-consolidate-review-20261011`，基于ea3bad9加source00与source01整合。本次只读源码、diff和coder日志，未运行测试，未修改候选或原树。

## 已修复并复核：P2 来源01实际schema3文件无法迁移

位置：`apps/desktop/src/main/workbench/repository.ts:28`，及 `space-app-persistence.test.ts:53` 的v3输入构造。

source01的原repository.save实际写入 `{schemaVersion:3,snapshot:business}`，没有catalog。修复前候选FileSchema的schema3分支要求catalog，且schemaVersion为discriminated union，不能退到v2分支。因此读取源01先前保存的App名称、说明、任务历史等真实profile时，在FileSchema.parse报缺catalog，migrateAppDescriptions与loadCatalog都不可达。修复前迁移测试只造带catalog的v3，验证的是主线资源目录版v3，未覆盖空间App来源真实v3。

最小负例：用来源01的snapshot（保留workspace.app，且可有appTarget）写入 `{schemaVersion:3,snapshot}`，调用新FileWorkbenchRepository.load，应成功迁移并随后发布schema4；修复前必定parse失败。修复需识别两种已存在的schema3形状：主线带catalog版保全现catalog；空间App无catalog版按legacy迁移catalog、保全workspace.app与旧publicResources，原字节备份后统一schema4。不建议给损坏schema3静默造空catalog。

最终修复已静态复核：repository.ts:29–37 用非空空间数组、每个空间显式且合法的 nullable app 字段识别来源01无catalog版v3；带catalog版仍完整校验catalog。外层strict使损坏catalog不能通过另一分支静默退化。load:119–126保全App元数据；loadCatalog:157–166从原始loadedFile保留publicResources后迁移；save:203–217保留原始schema3字节备份再原子写入schema4。缺app标记、空空间列表、非法App均拒绝，未将普通缺catalog的主线v3误迁移为空目录。

复核 space-app-persistence.test.ts:138–227：App为空/非空两例覆盖App identity/revision/description、旧publicResources进入catalog、原字节备份、schema4回读以及三类损坏输入拒绝。原始schema3-dual-source-red.txt为2失败/4通过，失败确为缺catalog；schema3-dual-source-green.txt为3文件20通过。typecheck/lint日志无诊断，退出成功由coder记录；本次未重新运行。此项已关闭；本次审查范围没有剩余具体阻断。

## 其他范围未发现新的阻断

- source01 metadata移植：SpaceAppSchema/updateApp/App revision、创建前持久化失败回滚、创建服务失败保留工程、名称同步浏览器标签、TaskVersion冻结appTarget/guestCwd、startRun重核对和结构化page/element（排除截图）、32000组合prompt前置拒绝；保留当前catalog与异步runLaunch流程。
- schema4主线迁移：v1/v2旧资源迁移、带catalog v3保全、schema4回读、legacy字节备份和冲突保护。无catalog来源01 v3缺口已按上述修复关闭。
- AppEditor：冻结workspace身份和revision、稳定SpacePage挂载、IME/重复提交/busy禁止关闭、失败保留草稿、创建已登记后转编辑；ManagedAppDialog入口衔接当前UI。
- AppService agentAdmission：持久化await前保留reservation，stop等待reservation，持久化返回后复查signal/stopping/closing，finally解锁；process先登记再解除reservation，防止stop成功后迟发CLI。未发现该新增门闩的死锁或新的晚启动路径。
- app-control：execute之后refresh验证run/space/session、project/appInstance与browser实例/generation；restart明确允许身份变更。当前追加检查能拒绝等待过程中归属变化的迟到回执。
- app-ui query与bridge：查询/调用后在releaseObjects cleanup完成之后再guard；guard检查abort/CDP detach/epoch/documentGeneration，桥接invoke增加pause状态核对，防止cleanup await期间导航/取消后成功返回。

## 证据与限制

审阅候选源码，对照source00原树对应AppService/AppControl/AppUiDriver具体diff、source01 frozen unstaged.patch与原repository写入代码；读coder-validation targeted-tests.txt（195 passed、exitCode0）和迁移测试构造。测试结果属于coder证据，独立审阅没有重新执行。最终Electron与全检查由根线程负责；没有将静态审阅提升为产品验收。
