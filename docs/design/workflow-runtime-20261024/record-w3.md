# W3 执行记录（2026-10-24）

范围：只读 Harness 能力——workflow `agent()` 调用经既有 guest 执行核心以独立身份/目录运行只读 argv。离线能力包：不建产品 wiring、不调真实 sbx。

## 交付

- `apps/service/src/workflow/readonly-guest-adapter.ts`：`ReadonlyGuestAdapter` 实现 `WorkflowCallAdapter`。一次 attempt 一次 `GuestProcess`：argv 经 `harness.argvForIsolation('readonly')`（Codex 为 `codex exec --sandbox read-only`，新会话不携带 resume）；`workspace:{runId, files}` 把冻结输入物化到独立 mkdtemp 目录作 cwd；**不携带** `mcp`/`resourceBundle`/`observation`/`stdin`——子运行无 wsl_space 工具面，无递归 workflow 能力，材料边界内不含主项目与共享 Git 元数据。
- `harness/types.ts`：`NativeHarnessAdapter` 增加可选 `argvForIsolation?(isolation)`；缺省/返回 null → 该隔离档 unavailable（ACP spec-harness 不实现此接口，天然不可传入）。
- `harness/codex/adapter.ts`：实现 readonly argv。
- `engine.ts`：`spec.input?`（`WorkflowRunInputSchema` 边界校验）+ `createAdapter(spec)` 工厂缝（runId/input 随 run 进适配器）；`packages/protocol` 增加输入 DTO；desktop `engine-port.ts` 同形。
- 测试：`readonly-guest-adapter.test.ts` 17 例（FakeGuest 边界）、codex adapter +1、engine +1。

## 关键语义（主 Agent 复核确认）

- **终态只在 `proc.done` 落定后 yield**：先报结果再发现清理失败会违反"清理未确认是真实失败"的既有不变量。自管迭代器（非裸生成器）保证内核 timeout/stop 调 `return()` 时先唤醒内部 race 再进同一 `proc.close()` 清理——裸异步生成器挂在 pending await 时会忽略 return。
- **失败优先级**：首因保留；`turn_completed` 后 `cleanup{ok:false}`/`done{!confirmed}` 仍 yield `failed{crash}`。
- **停止复用原路径**：abort/return 都走 `proc.close()` 等清理回执，不产出终态（内核按 stopped 记录）；close 单例防重复发起。
- **只读证明（离线层）**：start spec 断言=只读 argv + 物化文件边界 + 无工具面；真实 guest 隔离证据属 P0b（sb x live）。
- `session`/`tool`/`warning` 收集进有界内存轨迹（CallEvent 尚无轨迹通道）；`workspace` 帧计数不消费。

## 验证（主 Agent 独立复跑）

| 命令                                                                  | 结果                                                     |
| --------------------------------------------------------------------- | -------------------------------------------------------- |
| `pnpm --filter @wsl/service exec vitest run src/workflow src/harness` | 11 文件 121 测试通过（workflow 91 + harness 30），约 30s |
| `pnpm --filter @wsl/desktop exec vitest run src/main/workflow`        | 14/14                                                    |
| typecheck ×3（protocol/service/desktop）                              | 通过                                                     |
| eslint + prettier（触及路径）                                         | 通过                                                     |

## 未做

真实 sbx 连接装配与存活证明（P0b/W4）、Main 侧冻结输入→files 的真实快照管线（W4+）、ACP readonly 能力映射（标 unavailable，独立验证后再开放）、lane/shared、UI、Ultra。无 commit/push。
