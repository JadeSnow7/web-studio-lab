from pathlib import Path
import json, shutil
root=Path(__file__).resolve().parent
baseline=root.parent/'baseline/artifact'
canvas=json.loads((baseline/'project/canvas.json').read_text())
template=(root/'template.html').read_text()
logic=(root/'logic.js').read_text()
for name, board in canvas['boards'].items():
    stem=name.removesuffix('.dc.html')
    board['is_interactive']=True
    board['expand']='fill'
    board['h']=948
    board['title']={'RunPassed.dc.html':'02 检查通过，待你审阅','Overlay.dc.html':'07 浮层与中断恢复','Tasks.dc.html':'10 任务版本与决定'}.get(name,board['title'])+' · v0.3'
    (root/name).write_text(template.replace('__TITLE__',board['title']).replace('__LOGIC__',logic.replace('__BOARD__',stem)))
canvas['title']='Web Studio 工作台增量设计 v0.3 · 交互演示'
canvas['notes']['disclaimer']['text']='全部状态为交互演示；不调用模型、API或进程。Main承载共享状态主路径，其他画板为独立状态变体，不跨板传递运行状态。'
canvas['notes']['rowA']['text']='A · 页面问题 → 现场 → 确认 → 修改 → 检查 → 人工审阅 → 无模型复验'
canvas['launch']={'view':'canvas'}
(root/'canvas.json').write_text(json.dumps(canvas,ensure_ascii=False,indent=2)+'\n')
shutil.copyfile(baseline/'artifact-type/dc-runtime.js',root/'support.js')
links=''.join('<a href="'+n+'">'+b['title']+'</a>' for n,b in canvas['boards'].items())
(root/'index.html').write_text('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Web Studio v0.3 画板目录</title><style>body{font:14px system-ui;margin:32px;color:#1D1D1F;background:#F6F7F9}a{display:block;padding:14px;margin:8px 0;background:white;color:#0A67D1;border:1px solid #D8DCE3;border-radius:6px}</style><h1>Web Studio 工作台 v0.3</h1><p>交互演示 · 11个独立可编辑画板。Main完整共享状态流程；其余可回主流程。</p>'+links+'</html>')
print('Generated 11 Design Components; local runtime bundled, no remote dependencies.')
