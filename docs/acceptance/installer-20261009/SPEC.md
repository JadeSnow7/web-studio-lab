# INSTALLER-1 验收约定

基线为 `3e631a9e387190da5a2241945bbf7e14edbd5707`。本轮交付 main 已接入功能的 macOS ARM64 安装体验：DMG 与首次启动向导，sbx 和固定基础镜像首次联网获取，额外 guest 工具随包，正式包必须签名、公证。旧工作目录与历史证据保留。

| ID  | 必须结果                                               | 验证                                        |
| --- | ------------------------------------------------------ | ------------------------------------------- |
| I01 | Finder 启动无需开发工具、PATH、WSL 环境变量            | 安装后真实启动；干净机器另验                |
| I02 | 安装状态持久、结果真实，重复与重启不重复创建           | 单元负例与真实向导                          |
| I03 | 固定来源、散列、签名、版本；损坏载荷停止安装           | 下载、解包与签名负例                        |
| I04 | 唯一 mountless sandbox、skills off，保留既有安装和文件 | 身份、恢复检查与真实 sandbox                |
| I05 | Python 随包，guest 工具离线部署完整                    | 包内本地文件、PTY 与阻断下载安装            |
| I06 | 登录显式，不存储凭据输出，失败可重试                   | fixture 与用户登录现场                      |
| I07 | 本地根、SSH 可信指纹和 agent 通过应用配置              | 设置、文件、PTY、SFTP 实测                  |
| I08 | 已接入功能包内回归，取消有 guest 清理证据              | E2E 与 nonce 模型读取                       |
| I09 | Developer ID、Hardened Runtime、公证和票据有效         | codesign、spctl、stapler 和 quarantine 启动 |
| I10 | 历史失败不改写，源码与产物绑定，未验证明确标记         | 差异与交付记录审阅                          |

当前主机已安装开发工具与 sbx，不能代表干净机器。受限环境初始签名查询为 `0 valid identities found`；宿主只读复核找到一个 Apple Development 身份，未找到 Developer ID Application。notarytool 与 stapler 可用。已请求用户准备正式证书和已有公证钥匙串 profile。构建、fixture、历史通过与工具存在均不能替代正式验收。

不新增 C1–C3、guest 预览、自动更新或全局卸载；不提交、推送或发布。默认保留用户文件、既有 sandbox、全局设置及认证。
