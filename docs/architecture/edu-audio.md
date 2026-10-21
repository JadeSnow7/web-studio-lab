# edu 学生录音权限与回收

仅当前前台空间、可见且运行中的 edu 学生主 frame 可请求音频。Main 同时核对当前资源实例、应用租约、页面代次、webContents 与精确 origin；`/admin`、子 frame、视频、屏幕、隐藏、已停止及旧实例均拒绝。Electron request/check 共用同一纯判定，缺失媒体种类的 check 拒绝，request 必须明确仅包含 audio。系统授权由原生 getUserMedia 触发，不由宿主提前请求。

预览在空白 renderer 上启用 CDP Page 域，随后注册 document-start 监视器，再加载导入站点。闭包保留原生 getUserMedia、track.stop、readyState getter 和 clone 方法；原始轨道、track clone、stream clone 都受跟踪。页面不能替换这些方法或监视器，也不能伪造其清理回执。Main 使用实际文档 UUID、pending 数及所有原生轨道的 ended 状态核验，不使用网页自报或是否有声音作为依据。

隐藏、freeze、切空间、停止、退出和导航先同步撤销申请资格，再清理。迟到授权在旧 epoch 上立即结束轨道并拒绝交付。显式导航先等待旧文档清理；原生主 frame 导航被拦截一次，清理后通过同一导航路径继续。清理最多等待 2 秒；无法核验、文档失配、调试连接丢失或截止时间到达均报告失败并销毁预览。销毁不是正常清理通过。音轨失败不阻止 guest 停止回收；取消退出可重新启用仍有效学生页的申请资格，不自动开始录音。

App 与 Electron helper 的 entitlement 保留 electron-builder 默认运行权限并增加 audio-input；Python 仍用单独权限文件。麦克风用途说明随 App Info.plist 写入。

## 验证边界

`e2e/edu-audio.spec.ts` 用同一生产 PreviewController 在独立 Electron harness 中运行。默认 `synthetic-device` 只启用 Chromium 假设备，不读取 WAV、不使用 fake UI、不关闭媒体或 renderer 沙箱；权限 callback 和 native CDP stop 回执写入测试结果。该测试不运行 guest、edu 后端或模型，不代表完整工作台业务、签名包或实体录音验收。

```sh
env -u ELECTRON_RUN_AS_NODE pnpm exec playwright test e2e/edu-audio.spec.ts
```

显式 `WSL_EDU_AUDIO_MODE=physical` 不带假设备 flag，会请求实体麦克风；只在用户已授权配合时运行，并单独记录。此 harness 的 physical 结果也不替代当前签名包中的学生业务录音、试听、重录与评分验收。
