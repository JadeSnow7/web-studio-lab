# 异常边界测试覆盖复核

这是主线程及只读审查代理对断言正文的映射，不是最终运行结果。执行结果另见本目录 README 和命令回执。原有 169 个执行源文件审查及新增代码逐阶段 manifest 保持独立。

| 边界 | 已核对的断言入口 |
| --- | --- |
| 标签和历史 | e2e/workspace-runtime.spec.ts 的 A06/A07：重开同一 run、重复发送不产生第二运行；workspace-observation.spec.ts：历史 version/run 对话、自落点不移位、PTY重复输出和裁剪窗口 |
| 多空间与环境 | observation-application.test.ts：冻结SSH请求后切空间，原环境/空间归并，新空间无记录，伪造空间/代次结果拒绝；environment-resources.test.ts：跨资源cursor、伪造workspace和旧实例拒绝 |
| 取消与迟到 | observation-application.test.ts：AbortSignal、迟到不改cancelled归档、完成与归档先后、环境发现期间取消、来源集合冻结及实例替换；受控Electron对应场景只限build |
| 失效与缺口 | observation-terminal.test.ts：cursor绑定/eviction/截断/dispose/迟到输出；observation-application.test.ts：重启复用native数字ID仍拒绝旧capture |
| 文件与watch | observation-files.test.ts：父路径替换、UTF8续读与变化后stale_cursor、越界/根外symlink/凭据路径、搜索不跟symlink、closed提示一次且最后、双close/关闭后不可读、迟到与取消 |
| SSH配置及生命周期 | environment-resources.test.ts：无默认根、部分配置不给权限、列表不连接、启动前失败；ssh-terminal.test.ts：启动中关闭/断线、等待关闭期间断线仍cleanup unknown；产品agent/真PTY由phase4b单独证明 |
| 本地PTY清理 | local-terminal.test.ts、local-terminal-detached.test.ts、local-terminal-failure.test.ts：真实PTY、失败命令保留shell、忽略HUP、立即close、UTF8预算、setsid/reparent后代、出生身份复用保护、缺清理回执拒绝shutdown和替换 |
| MCP预算与证据 | observation-mcp.test.ts：scope、其他会话拒绝、取消/断开、4并发、完整UTF8帧/结果、64次；Main滚动200历史后仍拒第65次、run终态scope拒绝 |
| 迁移与恢复 | observation-persistence.test.ts：schema1身份/layout/theme和无授权占位、schema2无runtime handle、未来schema原字节、不可变归档；注册资源不启动终端；Electron重启run数仍1且明确旧模型上下文未恢复 |

源码/单元只能支持对应边界。程序拖放与composition不支持真实拖拽或中文候选窗；Provider私钥/pipe回环不支持产品agent/真PTY；恢复run计数不等于独立统计所有guest子进程启动数。关闭watch后实际文件变化、整个授权根替换的补充用例由Phase4b-C复验补齐。
