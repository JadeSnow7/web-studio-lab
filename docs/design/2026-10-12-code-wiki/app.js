'use strict';
const data = window.WIKI_DATA;
const sources = window.WIKI_SOURCES;
const $ = (id) => document.getElementById(id);
const moduleById = (id) => data.modules.find((item) => item.id === id);
let state = {
  page: 'overview',
  mode: 'runtime',
  module: 'workbench',
  flow: 'message',
  step: 0,
  tab: 'responsibility',
  query: '',
  edge: '',
};
let composing = false;
let dialogTrigger;
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(text, action, className) {
  const node = element('button', text, className);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}
function change(patch) {
  const focusedId = document.activeElement?.id;
  state = { ...state, ...patch };
  writeURL();
  render();
  if (focusedId) $(focusedId)?.focus({ preventScroll: true });
}
function writeURL() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state)) if (value !== '') params.set(key, value);
  history.replaceState(null, '', '#' + params.toString());
}
function readURL() {
  const params = new URLSearchParams(location.hash.slice(1));
  for (const key of Object.keys(state)) if (params.has(key)) state[key] = params.get(key);
  if (!['overview', 'flows', 'conventions'].includes(state.page)) state.page = 'overview';
  if (!['runtime', 'imports'].includes(state.mode)) state.mode = 'runtime';
  if (state.module && !moduleById(state.module)) state.module = 'workbench';
  if (!data.flows.some((flow) => flow.id === state.flow)) state.flow = 'message';
  if (!['responsibility', 'interface', 'source'].includes(state.tab)) state.tab = 'responsibility';
  const parsedStep = Number(state.step);
  state.step = Number.isInteger(parsedStep) && parsedStep >= 0 && parsedStep <= 5 ? parsedStep : 0;
  $('search').value = state.query;
}
function sourceButton(path, line) {
  const node = button(path.split('/').slice(-2).join('/'), () => openSource(path, line, node), 'source-link');
  node.title = path;
  node.setAttribute('aria-label', `阅读 ${path} 第 ${line} 行源码快照`);
  node.append(element('span', `L${line} · 阅读快照 ↗`));
  return node;
}
function openSource(path, line, trigger) {
  const source = sources[path + ':' + line];
  if (!source) throw new Error('Missing packaged source: ' + path + ':' + line);
  dialogTrigger = trigger;
  $('source-title').textContent = source.path;
  $('source-meta').textContent = `L${source.start}–${source.end} · SHA256 ${source.sha256}`;
  $('source-code').textContent = source.text
    .split('\n')
    .map((text, index) => `${String(source.start + index).padStart(4)}  ${text}`)
    .join('\n');
  $('source-dialog').showModal();
  $('close-source').focus();
}
function renderList() {
  const query = state.query.trim().toLocaleLowerCase('zh-CN');
  const filtered = data.modules.filter((item) =>
    [item.name, item.subtitle, item.description, ...item.sources.map((source) => source.path)]
      .join(' ')
      .toLocaleLowerCase('zh-CN')
      .includes(query),
  );
  $('module-list').replaceChildren(
    ...filtered.map((item) => {
      const node = button(item.name, () => change({ module: item.id, page: 'overview', edge: '' }), 'module-item');
      node.id = (node.classList.contains('node') ? 'map-' : 'list-') + item.id;
      node.setAttribute('aria-pressed', String(state.module === item.id));
      return node;
    }),
  );
  $('module-list').classList.toggle('search-results', Boolean(state.query));
  $('empty').hidden = filtered.length > 0;
  $('clear').hidden = !state.query;
}
function renderGraph() {
  const edges = data[state.mode];
  const nodes = data.modules.map((item, index) => {
    const node = button(undefined, () => change({ module: item.id, edge: '' }), 'node');
    // Map coordinates are normalized to the scrollable diagram's fixed readable canvas.
    node.style.left = item.x + 'px';
    node.style.top = item.y + 'px';
    node.append(
      element('span', String(index + 1).padStart(2, '0'), 'node-id'),
      element('strong', item.name),
      element('small', item.subtitle),
    );
    node.id = (node.classList.contains('node') ? 'map-' : 'list-') + item.id;
    node.setAttribute('aria-pressed', String(state.module === item.id));
    node.setAttribute('aria-label', item.name + '：' + item.subtitle);
    return node;
  });
  $('nodes').replaceChildren(...nodes);
  $('paths').replaceChildren(
    ...edges.map((edge) => {
      const a = moduleById(edge.a);
      const b = moduleById(edge.b);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      // Routes share the node canvas coordinates and keep crossings outside node bounds.
      const routes =
        state.mode === 'runtime'
          ? {
              'renderer-preload': 'M234 129 H300',
              'preload-workbench': 'M387 168 V245',
              'workbench-host': 'M474 284 H560',
              'host-service': 'M647 245 V168',
              'service-guest': 'M734 129 H770 V444 H734',
              'service-app': 'M600 168 V204 H520 V365 H430 V405',
              'host-app': 'M600 323 V350 H387 V405',
            }
          : {
              'renderer-protocol': 'M147 168 V405',
              'preload-protocol': 'M300 129 H270 V378 H190 V405',
              'workbench-protocol': 'M300 284 H260 V365 H210 V405',
              'host-protocol': 'M734 284 H754 V510 H260 V444 H234',
              'service-protocol': 'M647 90 V58 H30 V444 H60',
              'service-guest': 'M734 129 H770 V444 H734',
            };
      const route = routes[a.id + '-' + b.id];
      if (!route) throw new Error('Missing diagram route: ' + edge.id);
      path.setAttribute('d', route);
      path.setAttribute('class', 'edge' + (state.module ? (edge.a === state.module || edge.b === state.module ? ' active' : ' dim') : ''));
      return path;
    }),
  );
  $('edge-list').replaceChildren(
    ...edges.map((edge) => {
      const connected = edge.a === state.module || edge.b === state.module;
      const node = button(
        moduleById(edge.a).name + ' → ' + moduleById(edge.b).name,
        () => change({ edge: edge.id, module: edge.a, tab: 'interface' }),
        'edge-item' + (connected ? ' active' : '') + (state.edge === edge.id ? ' selected' : ''),
      );
      node.append(element('span', edge.type));
      node.id = 'edge-' + edge.id;
      node.setAttribute('aria-pressed', String(state.edge === edge.id));
      return node;
    }),
  );
  $('edge-count').textContent = String(edges.length).padStart(2, '0');
  $('legend').textContent = state.mode === 'runtime' ? '调用 / 跨进程通信' : '静态 import · 类型与运行依赖见连接详情';
}
function heading(text) {
  return element('h3', text);
}
function renderDetail() {
  const module = moduleById(state.module);
  const detail = $('detail');
  detail.replaceChildren();
  if (!module) {
    detail.append(
      element('div', '全图视角', 'detail-kicker'),
      element('h2', '从一个模块开始'),
      element('p', '点击地图或左侧列表，查看职责和直接上下游。', 'detail-subtitle'),
    );
    return;
  }
  detail.append(
    element('div', 'MODULE / ' + module.id.toUpperCase(), 'detail-kicker'),
    element('h2', module.name),
    element('p', module.subtitle, 'detail-subtitle'),
  );
  const tabs = element('div', undefined, 'detail-tabs');
  for (const [id, name] of [
    ['responsibility', '职责'],
    ['interface', '接口'],
    ['source', '源码'],
  ]) {
    const tab = button(name, () => change({ tab: id }), '');
    tab.id = 'detail-tab-' + id;
    tab.setAttribute('aria-pressed', String(state.tab === id));
    tabs.append(tab);
  }
  detail.append(tabs);
  const content = element('div', undefined, 'detail-content');
  const edges = data[state.mode];
  if (state.tab === 'source') {
    content.append(heading('实现入口与关联测试'));
    for (const source of module.sources) content.append(sourceButton(source.path, source.line));
    if (module.id === 'preload') content.append(element('p', 'Protocol 测试仅为关联契约测试，不表示独立 Preload 覆盖。'));
  } else if (state.tab === 'interface') {
    const relevant = state.edge
      ? edges.filter((edge) => edge.id === state.edge)
      : edges.filter((edge) => edge.a === module.id || edge.b === module.id);
    if (!relevant.length)
      content.append(
        element(
          'p',
          state.mode === 'runtime' && module.id === 'protocol'
            ? 'Protocol 不处于消息经过的路径。切换源码依赖查看契约引用。'
            : '当前地图未收录该模块的连接。',
        ),
      );
    for (const edge of relevant) {
      content.append(
        heading(edge.type),
        element('p', moduleById(edge.a).name + ' → ' + moduleById(edge.b).name),
        element('p', edge.label),
        sourceButton(edge.path, edge.line),
      );
    }
  } else {
    content.append(
      heading('职责'),
      element('p', module.description),
      heading('层次 / 进程'),
      element('p', module.layer),
      heading('状态所有者'),
      element('p', module.owner),
    );
    for (const [name, key, other] of [
      ['直接依赖 / 调用', 'a', 'b'],
      ['被依赖 / 调用方', 'b', 'a'],
    ]) {
      content.append(heading(name));
      const related = edges.filter((edge) => edge[key] === module.id);
      if (!related.length) content.append(element('p', '当前图未收录'));
      for (const edge of related)
        content.append(button(moduleById(edge[other]).name + ' ↗', () => change({ module: edge[other], edge: '' }), 'dependency-button'));
    }
  }
  content.append(element('p', '阅读边界：当前源码静态接线。测试入口用于定位，不代表本轮测试已执行。', 'boundary'));
  detail.append(content);
}
function renderFlows() {
  const flow = data.flows.find((item) => item.id === state.flow);
  $('flow-tabs').replaceChildren(
    ...data.flows.map((item) => {
      const node = button(item.name, () => change({ flow: item.id, step: 0 }));
      node.id = 'flow-' + item.id;
      node.setAttribute('aria-pressed', String(item.id === flow.id));
      return node;
    }),
  );
  $('flow-note').textContent = flow.note;
  $('step-list').replaceChildren(
    ...flow.steps.map((step, index) => {
      const node = button(undefined, () => change({ step: index }), 'step-button');
      const description = element('span', step.title);
      description.append(element('small', moduleById(step.module).name));
      node.append(element('span', String(index + 1).padStart(2, '0'), 'number'), description);
      node.id = 'step-' + index;
      node.setAttribute('aria-pressed', String(state.step === index));
      return node;
    }),
  );
  const step = flow.steps[state.step];
  $('step-detail').replaceChildren(
    element('div', `STEP ${String(state.step + 1).padStart(2, '0')} / 06`, 'detail-kicker'),
    element('h2', step.title),
    element('p', step.description),
    heading('所属模块 / 通信方式'),
    element('p', moduleById(step.module).name + ' · ' + step.type),
    heading('代码入口'),
    sourceButton(step.path, step.line),
  );
  $('step-count').textContent = `${state.step + 1} / 6`;
  $('previous').disabled = state.step === 0;
  $('next').disabled = state.step === 5;
}
function renderConventions() {
  $('convention-list').replaceChildren(
    ...data.conventions.map((item, index) => {
      const article = element('article', undefined, 'convention');
      const body = element('div');
      body.append(element('h2', item.title), element('p', item.description), sourceButton(item.path, item.line));
      article.append(element('span', String(index + 1).padStart(2, '0')), body);
      return article;
    }),
  );
}
function render() {
  const titles = {
    overview: ['工作台架构', '沿着模块与连接，理解职责、状态归属和代码入口。', '架构总览'],
    flows: ['关键流程', '从用户动作到执行器，逐步阅读跨模块调用。', '关键流程'],
    conventions: ['设计约定', '理解代码结构之前，先确认职责与状态的边界。', '设计约定'],
  };
  const [title, intro, breadcrumb] = titles[state.page];
  $('title').textContent = title;
  $('intro').textContent = intro;
  $('breadcrumb').textContent = breadcrumb;
  document.title = title + ' · Code Wiki';
  for (const page of Object.keys(titles)) $(page).hidden = page !== state.page;
  document.querySelectorAll('[data-page]').forEach((node) => {
    if (node.dataset.page === state.page) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  });
  document.querySelectorAll('[data-mode]').forEach((node) => node.setAttribute('aria-pressed', String(node.dataset.mode === state.mode)));
  renderList();
  renderGraph();
  renderDetail();
  renderFlows();
  renderConventions();
  $('status').textContent = breadcrumb + (state.page === 'overview' && state.module ? '，已选择 ' + moduleById(state.module).name : '');
}
$('search').addEventListener('compositionstart', () => {
  composing = true;
});
$('search').addEventListener('compositionend', () => {
  composing = false;
  change({ query: $('search').value });
});
$('search').addEventListener('input', () => {
  if (!composing) change({ query: $('search').value });
});
$('source-dialog').addEventListener('close', () => {
  if (dialogTrigger?.isConnected) dialogTrigger.focus();
});
window.addEventListener('hashchange', () => {
  readURL();
  render();
});
readURL();
render();

window.wikiAction = (action, value) => {
  if (action === 'page') change({ page: value });
  if (action === 'mode') change({ mode: value, edge: '' });
  if (action === 'reset') change({ module: '', edge: '' });
  if (action === 'clear') {
    $('search').value = '';
    change({ query: '' });
    $('search').focus();
  }
  if (action === 'previous') change({ step: Math.max(0, state.step - 1) });
  if (action === 'next') change({ step: Math.min(5, state.step + 1) });
  if (action === 'close-source') $('source-dialog').close();
};
