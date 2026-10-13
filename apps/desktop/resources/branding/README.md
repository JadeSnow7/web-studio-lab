# Web Studio Lab 标识资产

`logo.svg` 是可编辑主稿：四条独立 W 曲线、半透明玻璃底板、细亮边与浅浮雕阴影。`logo-small.svg` 保留玻璃底板，扩大笔画缝隙并移除阴影和内侧细边，供 24px 顶栏与 favicon 使用。两份源稿均为原生 SVG 路径与渐变，未嵌入生成图片。

`icon.png` 是 1024×1024 RGBA 导出；`packaging/icon.icns` 由标准 macOS iconset 生成，包含 16、32、128、256、512pt 的 1× 与 2× 表示（实际像素 16–1024px），其中 128px 以下使用小尺寸源稿。圆角底板之外透明，底板内部保留实际 alpha；它是静态磨砂外观，不读取或模糊桌面背景。

导出需要 macOS 的 `/usr/bin/iconutil`、Node 与外部 Sharp 工具，Sharp 不是应用依赖。脚本在临时 iconset 中渲染十个标准尺寸，由 iconutil 组装 ICNS，最后清理临时目录；失败直接报错，不切换编码实现。本轮使用 Codex 随附的 Sharp；复现时把已安装 Sharp 模块的绝对路径作为参数传入，不需要修改产品依赖：

```sh
node scripts/branding/export-icons.mjs /absolute/path/to/sharp
```

Renderer 经 Vite 导入两份 SVG；favicon 也由 Vite 解析。Main 从 `app.getAppPath()/resources/branding/icon.png` 读取 Dock / BrowserWindow 图标，electron-builder 将该目录放入应用文件，并显式使用 `packaging/icon.icns` 作为 macOS 图标。
