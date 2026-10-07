// 演示页面的固定示例数据。不是生成 App，也不读写任何 API。
const tasks = [
  { id: 1, title: '完善首页', status: '进行中', owner: 'A', dueDate: '2026-10-09' },
  { id: 2, title: '移动端适配', status: '待开始', owner: 'B', dueDate: '2026-10-10' },
  { id: 3, title: '结果验收', status: '待开始', owner: 'A', dueDate: null },
];

// 演示 C3 的现象：页面读取了错误字段 deadline，固定契约字段是 dueDate。
function dueText(task) {
  const value = task.deadline;
  if (value === undefined) {
    console.error(`[TaskFlow 演示] 任务 ${task.id} 缺少字段 deadline，无法显示截止日期`);
    return '未设置';
  }
  return value ?? '未设置';
}

function renderList() {
  const body = document.querySelector('#task-rows');
  if (!body) return;
  for (const task of tasks) {
    const row = document.createElement('tr');
    row.dataset.testid = `task-row-${task.id}`;
    row.innerHTML = `
      <td><a href="task.html?id=${task.id}">${task.title}</a></td>
      <td><span class="status" data-status="${task.status}">${task.status}</span></td>
      <td>${task.owner}</td>
      <td class="missing" data-testid="due-${task.id}">${dueText(task)}</td>`;
    body.append(row);
  }
}

function renderDetail() {
  const target = document.querySelector('#task-detail');
  if (!target) return;
  const id = Number(new URLSearchParams(location.search).get('id'));
  const task = tasks.find((t) => t.id === id);
  if (!task) {
    target.innerHTML = '<p>没有这个任务。</p>';
    return;
  }
  document.title = `${task.title} · TaskFlow 演示`;
  target.innerHTML = `
    <h1>${task.title}</h1>
    <div class="card">
      <dl class="detail">
        <dt>状态</dt><dd><span class="status" data-status="${task.status}">${task.status}</span></dd>
        <dt>负责人</dt><dd>${task.owner}</dd>
        <dt>截止日期</dt><dd class="missing">${dueText(task)}</dd>
      </dl>
    </div>
    <div style="display:flex;gap:8px">
      <button class="primary" type="button" data-testid="edit-task">编辑任务</button>
      <a href="index.html"><button class="secondary" type="button">返回列表</button></a>
    </div>
    <p class="note">当前演示身份是 B。演示页面对任何身份都显示“编辑任务”，这正是 C2 要由服务端收紧的权限问题。</p>`;
}

renderList();
renderDetail();
