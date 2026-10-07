# 首个 vertical slice 验收基线

本目录交付可复跑的测试基准。Electron 产品入口尚未实现，因此五条产品验收应失败；类型检查和基准自检应通过。[VS001](VS001.md) 定义成功条件、接口职责和证据约束，Zod 源码定义实际数据结构。

## 从干净 checkout 执行

需要 Node.js ≥22.12 和 npm。首次安装需要访问 npm registry。此阶段不要求 Electron、真实 Agent 凭据或 GUI 会话；它们是未来实现真实闭环时的前提。

```sh
npm ci
npm run typecheck
npm run baseline:selftest
npm run baseline
```

`npm run baseline` 创建独立运行目录并打印路径。当前预期退出码为 1，五项均为 `failed / target_missing`、`performed=false`；不能以 `|| true` 吞掉结果后宣称通过。安装失败、语法错误或环境缺失不是这份预期失败证据。

每次执行都从固定 fixture 创建新副本，分配新的 runId。五项检查共享这一次运行及其 CDP 会话，不分别调用五次 Agent。当前入口缺失时只保存真实存在的任务、输入、日志边界和失败报告，不会生成截图或 CDP 状态。

退出码 0 表示五项全部通过，1 表示五项已判定且至少一项失败，2 表示存在未能判定的检查。命令尚未进入执行器时的安装/加载错误也可能返回 1，必须同时检查 report 中的原因，不能只看退出码。

## 当前实现前基线（2026-10-07 方法修复）

PR #1 的两条 P2 修正了验收方法：已加载且 URL 匹配的空 DOM 立即交给 B03 判断；类型检查在原 tests/fixture 范围上加入 `src/**/*.ts` 和 `src/**/*.tsx`。增加了实际调用 `navigateAndObserve` 的合成 CDP transport 自检，覆盖空 DOM、loading、错误 URL 和正常单匹配；没有调用真实 Agent 或 Electron。

新当前回执为 [`78531515-547a-4d5e-a572-ff6efbf2a80b`](preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/receipt.json)，基准 SHA-256 为 `e6e980c11e0ac84baf26c52b5724a9a6706e3de480494aba549293425a2ab928`。macOS arm64 / Node v26.5.0：类型检查退出 0，自检 8/8 通过；[产品验收](preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/run/report.json)退出 1，五项仍为 `failed / target_missing / performed=false`，不是产品测试通过。HEAD 记录为修复前 `81efecd`，未提交的方法修复由 manifest 逐文件哈希绑定。

[隔离验证输出](preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/commands/)还记录：恢复旧 CDP 条件后新增空 DOM 回归失败；临时副本中合法的显式 `ExecuteTask` adapter 与 TSX 类型检查通过，错误 adapter 返回值及错误 TSX 赋值分别产生 TS2322。真实 checkout 不添加 adapter 占位实现。`src` 纳入编译不会自动证明无类型注解的动态导出满足 `ExecuteTask`；未来实现应显式声明该契约，运行时边界仍须校验。

## 历史实现前结果（原样保留）

2026-10-06 在 macOS arm64、Node v26.5.0 实测：类型检查退出 0，自检 5/5 通过，五条产品验收均为 `failed / target_missing / performed=false`，验收命令退出 1。没有调用真实 Agent、启动 Electron 或生成截图。初次受限环境因 tsx 本地 IPC 被拒而未进入自检，最终记录来自允许本地 IPC 的运行。

固定回执为 [`d1c9bc9e-4092-4697-83cf-d52d334b7686`](preimplementation/d1c9bc9e-4092-4697-83cf-d52d334b7686/receipt.json)。[原始命令输出](preimplementation/d1c9bc9e-4092-4697-83cf-d52d334b7686/commands/baseline.stdout.txt)、[report](preimplementation/d1c9bc9e-4092-4697-83cf-d52d334b7686/run/report.json)、[manifest](preimplementation/d1c9bc9e-4092-4697-83cf-d52d334b7686/run/manifest.json) 和[冻结任务](preimplementation/d1c9bc9e-4092-4697-83cf-d52d334b7686/run/task.json) 均已归档。基准 SHA-256 为 `92ac18313e5a30a5d72570c138f27ac41d6727d80a74f7bcff085cb67f318f6a`。

记录中的 Git HEAD 是尚未加入测试的产品基线 `536f0a1`，当时测试文件处于未提交状态；精确测试内容由 manifest 中的逐文件哈希绑定，不把 HEAD 冒充包含这些测试的提交。归档原样保留全部被 manifest 引用的产物，省略未纳入 manifest 的临时 `work/` 副本。receipt 另绑定 manifest 自身和命令输出的哈希。

旧回执及全部原始文件逐字节保留；旧指纹对应旧方法，不再声称与当前 checkout 相同。安装依赖后，下列命令验证新旧归档完整性，并仅将当前 checkout 与新基线比较：

```sh
node --import tsx --input-type=module - <<'JS'
import { readFileSync } from 'node:fs';
import { verifyManifest, baselineFingerprint } from './tests/vertical-slice/evidence.ts';
const historical = 'docs/acceptance/preimplementation/d1c9bc9e-4092-4697-83cf-d52d334b7686/run';
verifyManifest(historical, JSON.parse(readFileSync(`${historical}/manifest.json`, 'utf8')));
const dir = 'docs/acceptance/preimplementation/78531515-547a-4d5e-a572-ff6efbf2a80b/run';
const manifest = JSON.parse(readFileSync(`${dir}/manifest.json`, 'utf8'));
verifyManifest(dir, manifest);
if (baselineFingerprint(process.cwd()).sha256 !== manifest.baseline.sha256) {
  throw new Error('Current checkout uses a different baseline');
}
console.log('Both archives intact; current method baseline matches');
JS
```

## 文件树与实现接点

```text
package.json / package-lock.json     测试与固定页面依赖
tsconfig.json                       产品 src、测试和 fixture 类型检查
docs/acceptance/
  README.md                         执行入口和结果解释
  VS001.md                          冻结的成功条件
  preimplementation/<runId>/        原始实现前回执、命令输出与证据
fixtures/vertical-slice/page/
  package.json / index.html
  src/main.tsx / src/App.tsx         固定初始页面；Agent 只改运行副本的 App.tsx
tests/vertical-slice/
  contracts.ts                      Zod 任务、产品事件、日志与接口
  postcondition.ts                  独立状态断言
  cdp.ts                            指定页面的 CDP 连接和原始请求/响应记录
  evidence.ts                       文件快照、哈希、事件绑定与 manifest 检查
  run.ts                            一次运行与五项验收的命令入口
  selftest.test.ts                   合成正反例；不代替产品验收
src/vertical-slice/adapter.ts        未来产品唯一接点，当前不存在
records/vertical-slice/<runId>/      每次实际结果，默认被 Git 忽略
```

`src/vertical-slice/adapter.ts` 只在后续实现任务中新增。它需要符合 [ExecuteTask/AdapterContext](../../tests/vertical-slice/contracts.ts) 的导出接口。基准只通过这个接点请求真实 harness 修改与启动应用；直接 CDP 连接、状态断言和截图采集留在测试端。不得给验收命令接入返回预制结果的 adapter。

## 如何读五项结果

| 检查 | 对应可观察结果 |
| --- | --- |
| B01 | 有真实 harness 会话/退出记录，且只修改允许的页面文件 |
| B02 | Electron/CDP 页面身份属于本次启动和本次 run |
| B03 | 从同一 target 实际读取页面状态与 runId |
| B04 | 唯一、可见的标题精确为 `Hello Web Studio`，观测窗口无运行时异常 |
| B05 | 截图、原始日志及全部 manifest 引用可重新计算并匹配 |

完整判定及反例见 [VS001 的五条检查](VS001.md#五条冻结检查)。`failed / target_missing` 是当前缺失产品能力的基线；未来 adapter 存在后，同样的命令才会执行真实过程。自检中的合成样本只检验判定器的拒绝能力，不能记为上述五项已通过。

## 实现后的复验

1. 使用上述新当前基线，保留新旧实现前回执及其全部原始文件，审阅失败原因确实是产品入口缺失。
2. 后续产品改动只补 adapter 及实现它所需的最小 Electron/harness 生命周期；保持本基准、固定 fixture 和锁文件不变。
3. 原样执行上面的四条命令。新 runId 合理，基准内容指纹必须与实现前相同；任务中 runId 改变会使 task 指纹自然不同。
4. 对比两次 report/manifest，并审阅真实 harness 输出、代码 diff、Electron 页面截图和 CDP 请求/响应。五项全部 passed 才能认定该固定场景闭环通过。

若产品要增加依赖，应置于产品自己的清单，避免无意修改本基准依赖锁。确实需要修正测试方法时，先记录原因并保留旧回执；新指纹不能冒充旧基准的同基准复验。

最初的 `webContentsId → targetId` 映射和 Agent 来源需要结合产品代码、进程命令与真实输出审阅。哈希能检查文件是否混入或改变，不能独立证明执行者诚实。只有这个固定场景获得证据，不扩展为完整 IDE、打包交付或比赛产品验收。
