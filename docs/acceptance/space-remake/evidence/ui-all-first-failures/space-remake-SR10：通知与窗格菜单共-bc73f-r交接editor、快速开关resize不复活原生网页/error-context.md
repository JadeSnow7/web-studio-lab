# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: space-remake.spec.ts >> SR10：通知与窗格菜单共存、switcher交接editor、快速开关resize不复活原生网页
- Location: e2e/space-remake.spec.ts:76:1

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  getByRole('complementary', { name: '通知栏' })
Expected: 0
Received: 1
Timeout:  5000ms

Call log:
  - Expect "toHaveCount" getByRole('complementary', { name: '通知栏' }) with timeout 5000ms
  - waiting for getByRole('complementary', { name: '通知栏' })
    14 × locator resolved to 1 element
       - unexpected value "1"

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - banner [ref=e4]:
    - button "显示或隐藏 Workshop（⌘B）" [ref=e5] [cursor=pointer]
    - button "切换空间" [ref=e8]:
      - generic [ref=e9]: ▦
      - strong [ref=e10]: TaskFlow
      - generic [ref=e11]: ⌄
    - button "Codex CLI · 对话不可用" [ref=e13] [cursor=pointer]
  - generic [ref=e15]:
    - complementary "Workshop" [ref=e16]:
      - navigation "Workshop 导航" [ref=e17]:
        - button "首页" [ref=e18] [cursor=pointer]
        - button "空间" [ref=e21] [cursor=pointer]
        - button "资源" [ref=e27] [cursor=pointer]
        - button "会话" [ref=e30] [cursor=pointer]
        - button "任务" [ref=e33] [cursor=pointer]
        - button "取消固定 Workshop" [pressed] [ref=e37] [cursor=pointer]
        - button "设置" [ref=e40] [cursor=pointer]
      - region "空间导航" [ref=e44]:
        - generic [ref=e45]:
          - strong [ref=e46]: TaskFlow
          - generic [ref=e47]: 空间标签
        - navigation "空间标签" [ref=e48]:
          - generic [ref=e49]:
            - button "TaskFlow 预览" [ref=e50]
            - button "TaskFlow 预览操作" [ref=e56] [cursor=pointer]: ···
          - generic [ref=e57]:
            - button "开发终端" [ref=e58]
            - button "开发终端操作" [ref=e64] [cursor=pointer]: ···
          - generic [ref=e65]:
            - button "Agent 会话" [ref=e66]
            - button "Agent 会话操作" [ref=e71] [cursor=pointer]: ···
          - group [ref=e72]:
            - generic "后台资源 / 已关闭标签" [ref=e73]
        - button "新建标签" [ref=e74] [cursor=pointer]
        - generic [ref=e77]:
          - button "搜索空间或标签" [ref=e78] [cursor=pointer]
          - generic [ref=e79]: 关闭窗格保留标签 · 隐藏继续运行
    - main [ref=e80]:
      - region "TaskFlow工作现场" [ref=e83]:
        - generic [ref=e85]:
          - button "聚焦窗格 · TaskFlow 预览" [ref=e86]:
            - generic [ref=e90]: TaskFlow 预览
          - generic [ref=e91]:
            - button "左右分屏" [ref=e92] [cursor=pointer]: ◫
            - button "上下分屏" [ref=e93] [cursor=pointer]: ⬒
            - button "专注当前窗格" [ref=e94] [cursor=pointer]: ⤢
            - button "窗格操作" [ref=e95] [cursor=pointer]: ···
            - button "关闭窗格" [ref=e96] [cursor=pointer]: ×
        - generic [ref=e97]:
          - generic [ref=e98]:
            - button "聚焦窗格 · 空窗格" [ref=e99]:
              - generic [ref=e100]: 空窗格
            - generic [ref=e101]:
              - button "左右分屏" [ref=e102] [cursor=pointer]: ◫
              - button "上下分屏" [ref=e103] [cursor=pointer]: ⬒
              - button "专注当前窗格" [ref=e104] [cursor=pointer]: ⤢
              - button "窗格操作" [ref=e105] [cursor=pointer]: ···
              - button "关闭窗格" [ref=e106] [cursor=pointer]: ×
          - generic [ref=e107]: 选择左侧标签，在此打开内容。
        - generic [ref=e108]:
          - generic [ref=e109]:
            - button "后退" [disabled] [ref=e110]
            - button "前进" [disabled] [ref=e113]
            - button "刷新页面" [ref=e116] [cursor=pointer]
            - generic [ref=e120]:
              - generic [ref=e121]: 页面地址
              - textbox "页面地址" [ref=e122]: wsl-demo://taskflow/index.html
            - button "选择元素" [ref=e123] [cursor=pointer]
          - generic [ref=e124]:
            - generic [ref=e125]:
              - text: 关联会话
              - combobox "关联会话" [ref=e126]:
                - option "明确选择会话" [selected]
                - option "Agent 会话"
            - button "新建关联会话" [ref=e127] [cursor=pointer]
            - button "采集到关联会话" [disabled] [ref=e128]
            - button "打开关联会话" [disabled] [ref=e129]
          - generic [ref=e130]:
            - generic [ref=e131]: 公开 HTTPS 网页 · 只读参考资源
            - button "加入空间" [disabled] [ref=e132]
            - button "查看空间资源" [ref=e133] [cursor=pointer]
          - paragraph [ref=e135]: 浮层打开期间网页已让位，关闭后恢复
        - menu "窗格操作" [ref=e136]:
          - menuitem "平均分割" [active] [ref=e137]
          - menuitem "关闭菜单" [ref=e138]
    - button "通知 · 0 条未读" [expanded] [ref=e139] [cursor=pointer]:
      - generic [ref=e142]: "0"
    - complementary "通知栏" [ref=e143]:
      - generic [ref=e144]:
        - strong [ref=e145]: 通知
        - generic [ref=e146]:
          - button "固定通知" [ref=e147] [cursor=pointer]
          - button "收起通知栏" [ref=e150] [cursor=pointer]
      - region "通知" [ref=e153]:
        - paragraph [ref=e154]: 打开运行与标记已读分别记录。
        - group [ref=e155]:
          - generic "历史演示动态（只读）" [ref=e156]
        - paragraph [ref=e157]: 暂无运行通知。
```

# Test source

```ts
  1   | import { mkdtemp } from 'node:fs/promises';
  2   | import { tmpdir } from 'node:os';
  3   | import path from 'node:path';
  4   | import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
  5   | import { launchApp, previewInfo, setWindowSize, workspaceSnapshot, workshopNavigate, windowShots } from './helpers';
  6   | let app: ElectronApplication;
  7   | let page: Page;
  8   | test.afterEach(async () => {
  9   |   await app?.close();
  10  | });
  11  | const tabs = () => page.getByRole('navigation', { name: '空间标签', exact: true });
  12  | const notifications = () => page.getByRole('button', { name: /^通知 · \d+ 条未读$/ });
  13  | const nativeVisible = () => previewInfo(app).then((p) => p.visible);
  14  | async function launch() {
  15  |   ({ app, page } = await launchApp());
  16  |   await setWindowSize(app, 1440, 900);
  17  |   await expect(tabs()).toBeVisible();
  18  |   await expect.poll(nativeVisible).toBe(true);
  19  | }
  20  | 
  21  | test('SR01/02/07/09：六个入口、空间专属标签、设置主题、草稿与原实例保持', async () => {
  22  |   await launch();
  23  |   await expect(page.getByRole('tablist', { name: /TaskFlow.*标签/ })).toHaveCount(0);
  24  |   await expect(page.getByRole('button', { name: '工作坊', exact: true })).toHaveCount(0);
  25  |   const before = await previewInfo(app);
  26  |   await tabs().getByRole('button', { name: 'Agent 会话', exact: true }).click();
  27  |   await page.getByRole('navigation', { name: '会话视图' }).getByRole('button', { name: '任务', exact: true }).click();
  28  |   await page.getByRole('textbox', { name: '修改目标' }).fill('保留跨页中文草稿742');
  29  |   for (const name of ['首页', '资源', '会话', '任务', '设置']) {
  30  |     await workshopNavigate(page, name);
  31  |     await expect(tabs()).toHaveCount(0);
  32  |     await expect.poll(nativeVisible).toBe(false);
  33  |   }
  34  |   const theme = page.getByLabel('空间主题 · TaskFlow');
  35  |   await expect(theme).toBeVisible();
  36  |   for (const value of ['dark', 'warm', 'light', 'system']) {
  37  |     await theme.selectOption(value);
  38  |     await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]?.theme).toBe(value);
  39  |     if (value !== 'system') await expect(page.locator('html')).toHaveAttribute('data-theme', value);
  40  |   }
  41  |   await workshopNavigate(page, '空间');
  42  |   await expect(page.getByRole('textbox', { name: '修改目标' })).toHaveValue('保留跨页中文草稿742');
  43  |   await tabs().getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
  44  |   await expect.poll(nativeVisible).toBe(true);
  45  |   expect((await previewInfo(app)).id).toBe(before.id);
  46  |   await windowShots(app, page, 'remake-six-sections');
  47  | });
  48  | 
  49  | test('SR03/04/06/10：左右气泡、原生遮挡集合、通知不自动固定、关闭恢复焦点', async () => {
  50  |   await launch();
  51  |   await page.getByRole('button', { name: '取消固定 Workshop', exact: true }).click();
  52  |   await expect(tabs()).toHaveCount(0);
  53  |   await page.getByRole('button', { name: '展开 Workshop', exact: true }).click();
  54  |   await expect(page.getByRole('complementary', { name: 'Workshop（临时展开）' })).toBeVisible();
  55  |   await expect.poll(nativeVisible).toBe(false);
  56  |   await page.getByRole('button', { name: '固定 Workshop', exact: true }).focus();
  57  |   await notifications().evaluate((button) => (button as HTMLButtonElement).click());
  58  |   await expect(page.getByRole('complementary', { name: '通知栏' })).toHaveClass(/right-panel-overlay/);
  59  |   await expect(page.getByRole('button', { name: '固定通知', exact: true })).toHaveAttribute('aria-pressed', 'false');
  60  |   await expect(page.getByRole('complementary', { name: '通知栏' }).getByRole('textbox')).toHaveCount(0);
  61  |   await page.getByRole('button', { name: '收起通知栏', exact: true }).evaluate((button) => (button as HTMLButtonElement).click());
  62  |   await expect(page.getByRole('complementary', { name: 'Workshop（临时展开）' })).toBeVisible();
  63  |   await expect.poll(nativeVisible).toBe(false);
  64  |   await page.getByRole('complementary', { name: 'Workshop（临时展开）' }).press('Escape');
  65  |   await expect.poll(nativeVisible).toBe(true);
  66  |   await expect(page.getByRole('button', { name: '展开 Workshop', exact: true })).toBeFocused();
  67  |   const native = (await previewInfo(app)).bounds;
  68  |   for (const trigger of [page.getByRole('button', { name: '展开 Workshop', exact: true }), notifications()]) {
  69  |     const bounds = await trigger.boundingBox();
  70  |     if (!bounds) throw new Error('missing trigger');
  71  |     expect(bounds.x + bounds.width <= native.x || bounds.x >= native.x + native.width).toBe(true);
  72  |   }
  73  |   await windowShots(app, page, 'remake-floating-panels');
  74  | });
  75  | 
  76  | test('SR10：通知与窗格菜单共存、switcher交接editor、快速开关resize不复活原生网页', async () => {
  77  |   await launch();
  78  |   await page.getByRole('button', { name: '左右分屏', exact: true }).click();
  79  |   await notifications().click();
  80  |   await page.getByRole('button', { name: '窗格操作', exact: true }).first().click();
  81  |   await page.getByRole('button', { name: '收起通知栏', exact: true }).click();
  82  |   await expect.poll(nativeVisible).toBe(false);
  83  |   await page.getByRole('menuitem', { name: '关闭菜单', exact: true }).click();
  84  |   await expect.poll(nativeVisible).toBe(true);
  85  |   await notifications().click();
  86  |   await page.getByRole('button', { name: '窗格操作', exact: true }).first().click();
  87  |   await page.keyboard.press('Escape');
  88  |   await expect(page.getByRole('menuitem', { name: '关闭菜单', exact: true })).toHaveCount(0);
  89  |   await expect(page.getByRole('complementary', { name: '通知栏' })).toBeVisible();
  90  |   await expect.poll(nativeVisible).toBe(false);
  91  |   await page.keyboard.press('Escape');
> 92  |   await expect(page.getByRole('complementary', { name: '通知栏' })).toHaveCount(0);
      |                                                                  ^ Error: expect(locator).toHaveCount(expected) failed
  93  |   await expect(notifications()).toBeFocused();
  94  |   await expect.poll(nativeVisible).toBe(true);
  95  |   await page.getByRole('button', { name: '切换空间', exact: true }).click();
  96  |   await expect.poll(nativeVisible).toBe(false);
  97  |   await page.getByRole('button', { name: '新建空间', exact: true }).click();
  98  |   await expect(page.getByRole('dialog', { name: '新建空间', exact: true })).toBeVisible();
  99  |   await expect.poll(nativeVisible).toBe(false);
  100 |   await page.getByRole('button', { name: '取消', exact: true }).click();
  101 |   await expect.poll(nativeVisible).toBe(true);
  102 |   await expect(page.getByRole('button', { name: '切换空间', exact: true })).toBeFocused();
  103 |   for (let index = 0; index < 3; index++) {
  104 |     await notifications().click();
  105 |     await setWindowSize(app, 1420 + index * 5, 900);
  106 |     await expect.poll(nativeVisible).toBe(false);
  107 |     await notifications().click();
  108 |     await expect.poll(nativeVisible).toBe(true);
  109 |   }
  110 | });
  111 | 
  112 | test('SR05/11：独立固定偏好、窄窗投影不改分割树、重启只恢复pin', async () => {
  113 |   const userData = await mkdtemp(path.join(tmpdir(), 'wsl-remake-restart-'));
  114 |   ({ app, page } = await launchApp({ userData }));
  115 |   await setWindowSize(app, 1440, 900);
  116 |   await expect(tabs()).toBeVisible();
  117 |   await page.getByRole('button', { name: '左右分屏', exact: true }).click();
  118 |   const snapshot = await workspaceSnapshot(page),
  119 |     layout = snapshot.workspaces[0]?.layout;
  120 |   await notifications().click();
  121 |   await page.getByRole('button', { name: '固定通知', exact: true }).click();
  122 |   await expect(page.getByRole('complementary', { name: '通知栏' })).not.toHaveClass(/right-panel-overlay/);
  123 |   await page.getByRole('button', { name: '收起通知栏', exact: true }).click();
  124 |   const pinned = await page.evaluate(() => localStorage.getItem('wsl-shell-panels-v1'));
  125 |   expect(JSON.parse(pinned ?? '{}')).toEqual({ leftPinned: true, rightPinned: true });
  126 |   await notifications().click();
  127 |   await setWindowSize(app, 1024, 720);
  128 |   await expect(tabs()).toHaveCount(0);
  129 |   expect((await workspaceSnapshot(page)).workspaces[0]?.layout).toEqual(layout);
  130 |   await notifications().click();
  131 |   await expect.poll(nativeVisible).toBe(false);
  132 |   await page.getByRole('button', { name: '收起通知栏', exact: true }).click();
  133 |   await setWindowSize(app, 1440, 900);
  134 |   await expect(tabs()).toBeVisible();
  135 |   expect((await workspaceSnapshot(page)).workspaces[0]?.layout).toEqual(layout);
  136 |   await app.close();
  137 |   ({ app, page } = await launchApp({ userData }));
  138 |   await setWindowSize(app, 1440, 900);
  139 |   await expect(tabs()).toBeVisible();
  140 |   expect((await workspaceSnapshot(page)).workspaces[0]?.layout).toEqual(layout);
  141 |   await expect(page.getByRole('complementary', { name: '通知栏' })).not.toHaveClass(/right-panel-overlay/);
  142 |   await page.getByRole('button', { name: '取消固定通知', exact: true }).click();
  143 |   await expect(page.getByRole('complementary', { name: '通知栏' })).toHaveCount(0);
  144 | });
  145 | 
  146 | test('SR01/09：首页新建对话框取消回原入口，主题同步实际终端与系统', async () => {
  147 |   await launch();
  148 |   await page.getByRole('button', { name: '切换空间', exact: true }).click();
  149 |   await page.getByRole('button', { name: '管理空间', exact: true }).click();
  150 |   await page.getByRole('button', { name: '取消', exact: true }).click();
  151 |   await workshopNavigate(page, '首页');
  152 |   const create = page.getByRole('button', { name: '新建空间', exact: true });
  153 |   await create.click();
  154 |   await expect(page.getByRole('dialog', { name: '新建空间', exact: true })).toBeVisible();
  155 |   await page.getByRole('button', { name: '取消', exact: true }).click();
  156 |   await expect(create).toBeFocused();
  157 |   await expect(page.getByRole('heading', { name: '今天从哪里开始？' })).toBeVisible();
  158 |   await create.click();
  159 |   await page.getByRole('dialog', { name: '新建空间', exact: true }).getByLabel('名称').fill('首页新空间742');
  160 |   await page.getByRole('button', { name: '保存', exact: true }).click();
  161 |   await expect(page.getByRole('button', { name: '切换空间', exact: true })).toContainText('首页新空间742');
  162 |   await expect(tabs()).toBeVisible();
  163 |   await page.getByRole('button', { name: '新建标签', exact: true }).click();
  164 |   await page.getByLabel('名称', { exact: true }).fill('主题终端742');
  165 |   await page.getByLabel('标签类型').selectOption('terminal');
  166 |   await page.getByRole('button', { name: '保存', exact: true }).click();
  167 |   await tabs().getByRole('button', { name: '主题终端742', exact: true }).click();
  168 |   await workshopNavigate(page, '设置');
  169 |   const theme = page.getByLabel('空间主题 · 首页新空间742');
  170 |   for (const value of ['light', 'dark', 'warm']) {
  171 |     await theme.selectOption(value);
  172 |     await expect(page.locator('html')).toHaveAttribute('data-theme', value);
  173 |     await workshopNavigate(page, '空间');
  174 |     await expect
  175 |       .poll(() =>
  176 |         page
  177 |           .locator('.xterm-scrollable-element')
  178 |           .last()
  179 |           .evaluate((element) => {
  180 |             const swatch = document.createElement('span');
  181 |             swatch.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--content');
  182 |             document.body.append(swatch);
  183 |             const expected = getComputedStyle(swatch).backgroundColor;
  184 |             swatch.remove();
  185 |             return getComputedStyle(element).backgroundColor === expected;
  186 |           }),
  187 |       )
  188 |       .toBe(true);
  189 |     await windowShots(app, page, `remake-terminal-${value}`);
  190 |     await workshopNavigate(page, '设置');
  191 |   }
  192 |   await theme.selectOption('system');
```