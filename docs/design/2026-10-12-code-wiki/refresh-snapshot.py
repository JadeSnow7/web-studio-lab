from pathlib import Path
import json,hashlib
out=Path(__file__).resolve().parent; root=out.parents[2]
D='apps/desktop/src/'; S='apps/service/src/'
mods=[
('renderer','Renderer','界面与状态投影','Presentation · Chromium','选择、布局和只读业务投影。命令通过 window.studio 发往 Main。','UI 临时状态；业务事实来自 Main。',[(D+'renderer/src/state/workspace.ts',56),(D+'renderer/src/state/chat.ts',43),(D+'renderer/src/state/workspace.test.ts',1)],(60,90)),
('preload','Preload','窄接口桥接','Bridge · Electron preload','将具名接口暴露给 Renderer，传递 IPC 请求与订阅。','不拥有业务状态。',[(D+'preload/index.ts',41),('packages/protocol/src/protocol.test.ts',1)],(300,90)),
('workbench','WorkbenchApplication','工作台业务用例','Application · Electron Main','协调空间、资源、会话与任务；固定身份、版本和执行生命周期。','Main 唯一写入工作台业务事实。',[(D+'main/workbench/application.ts',410),(D+'main/workbench/ports.ts',22),(D+'main/workbench/application.test.ts',1)],(300,245)),
('host','Host / Browser','宿主能力适配','Adapter · Electron Main','实现工作台能力接口，连接 ChatService 与原生 Browser 控制器。','持有浏览器与能力适配句柄；报告运行事实。',[(D+'main/workbench/host.ts',50),(D+'main/preview/controller.ts',46),(D+'main/preview/controller-resource.test.ts',1)],(560,245)),
('service','Node Service','执行与环境适配','Adapter · Utility process','接收进程消息，承载 CodexChat、应用、PTY 与文件适配能力。','持有执行器和所属进程，回报事实。',[(S+'index.ts',213),(S+'codex-chat.ts',385),(S+'app-service.test.ts',1)],(560,90)),
('protocol','Protocol','跨进程协议 / schema','Contract · 无独立进程','定义请求、响应与事件信封；接收边界校验输入。','无业务 store、编排与平台驱动。',[('packages/protocol/src/workspace.ts',169),('packages/protocol/src/index.ts',1),('packages/protocol/src/protocol.test.ts',1)],(60,405)),
('guest','sbx / Guest','沙箱进程与通道','Adapter · Linux guest','通过 sbx 启动 guest helper，执行 Codex、应用与受管子进程。','GuestProcess 管理子进程关闭与清理确认。',[(S+'sbx.ts',262),(S+'guest-helper.py',1),(S+'sbx-contract.test.ts',1)],(560,405)),
('app','Standard App','固定全栈模板','Template · Linux guest','React / Vite 与 Hono 后端组成固定模板，支持受管启动与控制入口。','模板应用拥有自身数据；不拥有工作台 TaskRun。',[('templates/standard-app/server/app.ts',23),('templates/standard-app/src/agent/bridge.ts',23),('templates/standard-app/tests/app.test.ts',1)],(300,405))]
modules=[dict(id=i,name=n,subtitle=sub,layer=l,description=d,owner=o,sources=[{'path':p,'line':line} for p,line in ps],x=xy[0],y=xy[1]) for i,n,sub,l,d,o,ps,xy in mods]
edges=[('renderer','preload','具名桥接调用','window.studio.workbench.command / chat.send',D+'preload/index.ts',41),('preload','workbench','Electron IPC','workbench:command → application.command',D+'main/ipc.ts',78),('workbench','host','能力接口调用','WorkbenchRuntime.appStart / send / cancel',D+'main/workbench/ports.ts',22),('host','service','进程消息','ChatService.request → child.postMessage',D+'main/chat-service.ts',285),('service','guest','sbx 进程通道','SbxConnection.start → GuestProcess',S+'sbx.ts',262),('service','app','应用生命周期','AppService.start → startEntry',S+'app-service.ts',399),('host','app','原生 Browser 控制','WorkbenchHost.appUi → AppUiDriver',D+'main/workbench/host.ts',92)]
runtime=[dict(id='r'+str(k),a=a,b=b,type=t,label=l,path=p,line=ln) for k,(a,b,t,l,p,ln) in enumerate(edges)]
# Only imports inspected in the actual current files are represented below.
imports=[('renderer','protocol',D+'renderer/src/state/workspace.ts',1,'@wsl/protocol · 类型导入'),('preload','protocol',D+'preload/index.ts',1,'通道 schema / 类型（运行时 + 类型）'),('workbench','protocol',D+'main/workbench/application.ts',1,'@wsl/protocol · schema / 类型'),('host','protocol',D+'main/workbench/host.ts',1,'@wsl/protocol · 类型导入'),('service','protocol',S+'index.ts',1,'@wsl/protocol · schema / 类型'),('service','guest',S+'index.ts',15,'./sbx · 运行时代码 import')]
source_edges=[dict(id='s'+str(k),a=a,b=b,type='源码 import',label=l,path=p,line=ln) for k,(a,b,p,ln,l) in enumerate(imports)]
flows=[('message','个人发送消息','个人对话使用独立 chat 客户端；空间任务另经 Workbench 用例。',[
('renderer','提交消息','chatActions.send 调用具名 chat 接口。','本地 UI 调用',D+'renderer/src/state/chat.ts',43),('preload','跨越 Renderer 边界','chat.send 发送 chat:send 请求。','Electron IPC',D+'preload/index.ts',49),('host','Main 接收与校验','IPC handler 核对来源与协议后交给 ChatService。','Main handler',D+'main/ipc.ts',108),('host','发送服务请求','ChatService.send 经 request 投递 child.postMessage。','Utility process 消息',D+'main/chat-service.ts',395),('service','启动对话执行','服务将 send 请求交给 CodexChat.send。','服务内部调用',S+'index.ts',213),('guest','启动 Guest 执行器','CodexChat 调用 connection.start，sbx 启动 helper。','sbx 进程通道',S+'codex-chat.ts',385)]),
('start','启动受管 App','显式 startApp 命令沿工作台用例进入服务，应用启动事实再回报 Main。',[
('renderer','用户发出 startApp','App 管理界面通过 workspaceCommand 发送启动命令。','UI 命令',D+'renderer/src/workspace/ManagedAppDialog.tsx',19),('preload','传递空间命令','executeCommand → preload command → workbench:command。','Electron IPC',D+'renderer/src/state/workspace.ts',56),('workbench','编排启动用例','application.command 固定空间身份，调用 runtime.appStart。','应用能力接口',D+'main/workbench/application.ts',497),('host','调用宿主适配器','Host.appStart 调用 ChatService，核对回环地址。','宿主调用',D+'main/workbench/host.ts',50),('service','派发 app.start','ChatService.appStart 发送 app.start 消息。','Utility process 消息',D+'main/chat-service.ts',335),('guest','启动模板入口','服务调用 AppService.start 与 startEntry。','Guest 受管进程',S+'app-service.ts',399)]),
('cancel','取消空间任务','展示已派发任务的取消分支。取消已受理不等于所属进程已停止。',[
('renderer','发出 cancelRun','空间会话发送绑定 run 身份的取消命令。','UI 命令',D+'renderer/src/workspace/Session.tsx',494),('preload','传递取消命令','workspaceCommand 经 preload 与 Main IPC 进入用例。','Electron IPC',D+'renderer/src/state/workspace.ts',56),('workbench','进入 cancelling','已派发分支更新 cancelling 并 requestCancellation；注册阶段另有分支。','业务状态转换',D+'main/workbench/application.ts',1725),('host','请求执行器取消','application → Host.cancel → ChatService.cancel。','能力接口 / 进程消息',D+'main/workbench/host.ts',330),('service','执行取消清理','服务调用 CodexChat.cancel。','服务内部调用',S+'codex-chat.ts',521),('guest','等待停止确认','等待 turn.process.close 与清理确认；未确认时不能显示已停止。','进程停止确认',S+'codex-chat.ts',530)])]
flowdata=[dict(id=i,name=n,note=no,steps=[dict(module=m,title=t,description=d,type=ty,path=p,line=l) for m,t,d,ty,p,l in steps]) for i,n,no,steps in flows]
conventions=[('职责、目录、进程分别阅读','五组业务职责并不意味着五个目录；运行进程描述权限与通信边界。','docs/ARCHITECTURE.md',1),('Main 维护权威业务事实','Renderer 保存展示状态；适配器报告执行事实，由工作台用例协调。','docs/ARCHITECTURE.md',19),('协议只包含 DTO 与 schema','跨进程接收边界校验外部输入，协议包不承载业务编排。','CONTRIBUTING.md',22),('执行、验证与接受分别记录','执行结束不推导验证通过；验证记录须绑定代码版本，用户接受独立。','docs/ARCHITECTURE.md',135),('恢复不重放副作用','恢复描述、草稿与历史；不自动重启执行器或重放写动作。','CONTRIBUTING.md',41)]
refs={(r['path'],r['line']) for m in modules for r in m['sources']}
refs.update((e['path'],e['line']) for e in runtime+source_edges)
refs.update((s['path'],s['line']) for f in flowdata for s in f['steps'])
refs.update((p,l) for _,_,p,l in conventions)
sources={}; manifest=[]
for p,l in sorted(refs):
 f=root/p
 if not f.exists(): raise Exception('Missing '+p)
 content=f.read_bytes(); lines=content.decode().splitlines(); start=max(1,l-5); end=min(len(lines),start+34)
 key=p+':'+str(l); sources[key]=dict(path=p,start=start,end=end,text='\n'.join(lines[start-1:end]),sha256=hashlib.sha256(content).hexdigest())
 manifest.append(dict(path=p,start=start,end=end,sha256=hashlib.sha256(content).hexdigest()))
(out/'data.js').write_text('window.WIKI_DATA = '+json.dumps(dict(modules=modules,runtime=runtime,imports=source_edges,flows=flowdata,conventions=[dict(title=t,description=d,path=p,line=l) for t,d,p,l in conventions]),ensure_ascii=False,indent=2)+';\n')
(out/'sources.js').write_text('window.WIKI_SOURCES = '+json.dumps(sources,ensure_ascii=False,indent=2)+';\n')
(out/'snapshot-manifest.json').write_text(json.dumps(dict(commit='ea3bad9e6602ccec3484cc55b247bae5815975b4',scope='Only referenced source files; current working-tree bytes including uncommitted changes, not a whole-repository snapshot.',entries=manifest),ensure_ascii=False,indent=2)+'\n')
