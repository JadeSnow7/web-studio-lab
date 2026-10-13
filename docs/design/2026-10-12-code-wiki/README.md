# Code Wiki 交互原型

这是可离线查看的独立原型：8个模块、运行通信/源码依赖地图、模块搜索和详情、3条静态代码流程、设计约定与实际源码摘录。尚未实现自动依赖提取、完整调用图、全文 Wiki、实时源码同步或产品内集成。

仓库根目录运行：

```sh
node docs/design/2026-10-12-code-wiki/serve.mjs
```

打开 http://127.0.0.1:4317 。可用 `WIKI_PORT=4318` 替换端口。服务器仅绑定回环地址，只服务本目录白名单静态资产。也可直接用浏览器打开 `index.html`，无需依赖安装、构建、网络字体或模型。

`data.js` 是人工核对的阅读地图，并非完整 import graph；节点为聚合阅读单元。`sources.js` 保留 2026-10-12 主工作树的源码摘录，每个摘录提供路径、行号与完整文件 SHA256。`snapshot-manifest.json` 仅记录引用文件，不是全仓快照；`ea3bad9` 为基准 HEAD，摘录包含当时未提交修改。2026-10-13 整合保留这些历史字节，没有将其刷新为 PR 候选源码；状态界面和此后修复须直接阅读当前实现。

更新时先人工核对 `refresh-snapshot.py` 的模块/流程/边与代码位置，再从仓库根目录运行：

```sh
python3 docs/design/2026-10-12-code-wiki/refresh-snapshot.py
node --check docs/design/2026-10-12-code-wiki/app.js
node --check docs/design/2026-10-12-code-wiki/serve.mjs
```

刷新脚本只读取列明源码与文档，并写入本原型目录的 `data.js`、`sources.js`、`snapshot-manifest.json`。应复核摘录与图中连接，再验证运行/源码视图、清除搜索、源码弹窗 Escape 与焦点恢复、流程步骤及390px窄屏。自动检查与静态图不代表产品验收或用户接受。
