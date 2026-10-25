import { expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import type { WorkbenchCommand, WorkbenchResult, WorkbenchSnapshot } from '../packages/protocol/src';
import {
  launchApp,
  openBrowserMenu,
  openNewTabForm,
  paneMenu,
  setWindowSize,
  workspaceSnapshot,
  previewClick,
  previewElementCenter,
  workshopNavigate,
  browserState,
  previewInfo,
  target,
} from './helpers';

const test = base.extend<{ initialAddressLoad: boolean }>({ initialAddressLoad: [false, { option: true }] });
type AddressTrace = { at: number; event: string; [key: string]: unknown };
type ReviewGate = {
  commands: WorkbenchCommand[];
  failCriteria: boolean;
  failStart: boolean;
  holdConfirm: boolean;
  holdNavigate: boolean;
  holdStart: boolean;
  releases: Array<() => void>;
  navigationReplies: Array<{ commandId: string; url: string | undefined; ok: boolean; release: () => void }>;
  events: AddressTrace[];
  record: (event: string, data?: Record<string, unknown>) => void;
};
type ReviewGlobal = typeof globalThis & {
  reviewGate: ReviewGate;
  screenshotGate: { armed: boolean; entered: number; release: (() => void) | null };
  __wslAddressInitialLoad?: { held: { url: string; webContentsId: number } | null; release: (() => void) | null; events: AddressTrace[] };
};
type AddressWindow = Window & {
  addressTrace?: { events: AddressTrace[]; urls: string[]; record: (event: string, data?: Record<string, unknown>) => void };
};
let app: ElectronApplication, page: Page;
test.beforeEach(async ({ initialAddressLoad }) => {
  ({ app, page } = await launchApp({
    sbxBin: new URL('./fixtures/sbx.mjs', import.meta.url).pathname,
    addressInitialLoadGate: initialAddressLoad,
    addressNavigationObserver: true,
  }));
  await setWindowSize(app, 1440, 900);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.contentView.children.length)).toBe(1);
  await app.evaluate(({ ipcMain, BrowserWindow, webContents }) => {
    const host = globalThis as ReviewGlobal;
    host.reviewGate = {
      commands: [],
      failCriteria: false,
      failStart: false,
      holdConfirm: false,
      holdNavigate: false,
      holdStart: false,
      releases: [],
      navigationReplies: [],
      events: [],
      record: (event, data = {}) => {
        const window = BrowserWindow.getAllWindows()[0]!;
        const wc = (window.contentView.children[0] as Electron.WebContentsView | undefined)?.webContents;
        host.reviewGate.events.push({
          at: Date.now(),
          event,
          mainPid: process.pid,
          windowId: window.id,
          windowFocused: window.isFocused(),
          rendererId: window.webContents.id,
          rendererPid: window.webContents.getOSProcessId(),
          rendererFocused: window.webContents.isFocused(),
          webContentsId: wc?.id,
          nativePid: wc?.getOSProcessId(),
          nativeFocused: wc?.isFocused(),
          nativeUrl: wc?.getURL(),
          focusedWebContentsId: webContents.getFocusedWebContents()?.id ?? null,
          nativeViews: window.contentView.children.map((view) => {
            const contents = (view as Electron.WebContentsView).webContents;
            return { id: contents.id, pid: contents.getOSProcessId(), url: contents.getURL(), focused: contents.isFocused() };
          }),
          ...data,
        });
      },
    };
    const contents = BrowserWindow.getAllWindows()[0]!.webContents;
    const send = contents.send.bind(contents);
    contents.send = (channel, ...args: unknown[]) => {
      const payload = args[0] as { snapshot?: WorkbenchSnapshot } | undefined;
      if (channel === 'workbench:event' && payload?.snapshot)
        host.reviewGate.record('snapshot-sent', {
          seq: payload.snapshot.seq,
          urls: payload.snapshot.workspaces.flatMap((w) => w.resources.flatMap((r) => (r.preview ? [r.preview.page.url] : []))),
        });
      return send(channel, ...args);
    };
    const native = (BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView).webContents;
    native.on('did-start-loading', () => host.reviewGate.record('native-did-start-loading'));
    native.on('did-stop-loading', () => host.reviewGate.record('native-did-stop-loading'));
    native.on('did-navigate', () => host.reviewGate.record('native-did-navigate'));
    native.on('did-navigate-in-page', () => host.reviewGate.record('native-did-navigate-in-page'));
    native.on('focus', () => host.reviewGate.record('native-focus'));
    native.on('blur', () => host.reviewGate.record('native-blur'));
    type Handler = (event: Electron.IpcMainInvokeEvent, command?: WorkbenchCommand) => Promise<unknown>;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers;
    const command = handlers.get('workbench:command')!;
    const get = handlers.get('workbench:get-snapshot')!;
    ipcMain.removeHandler('workbench:command');
    ipcMain.handle('workbench:command', async (event, request: WorkbenchCommand): Promise<WorkbenchResult> => {
      const gate = host.reviewGate;
      gate.commands.push(request);
      const navigation = request.type === 'browserAction' && request.action === 'navigate';
      if (navigation) gate.record('navigate-command', { url: request.url, commandId: request.commandId });
      if (gate.holdConfirm && request.type === 'confirmTask')
        await new Promise<void>((resolve) => {
          gate.releases.push(resolve);
        });
      if (
        (gate.failCriteria && request.type === 'saveTaskCriteria') ||
        (gate.failStart && request.type === 'startRun') ||
        (gate.holdConfirm && request.type === 'confirmTask')
      )
        return {
          ok: false,
          error: { code: 'execution_failed', message: 'review: injected persistence/executor failure' },
          snapshot: (await get(event)) as WorkbenchSnapshot,
        };
      const result = (await command(event, request)) as WorkbenchResult;
      if (navigation) {
        gate.record('navigate-executed', { url: request.url, commandId: request.commandId, ok: result.ok });
        // Hold only the genuine reply, after navigation and its normal snapshots have happened.
        if (gate.holdNavigate)
          await new Promise<void>((resolve) => {
            gate.navigationReplies.push({ commandId: request.commandId, url: request.url, ok: result.ok, release: resolve });
          });
        gate.record('navigate-reply', { url: request.url, commandId: request.commandId, ok: result.ok });
      }
      if (gate.holdStart && request.type === 'startRun')
        await new Promise<void>((resolve) => {
          gate.releases.push(resolve);
        });
      return result;
    });
  });
});
test.afterEach(async ({ initialAddressLoad }, info) => {
  try {
    const renderer = await page?.evaluate(() => (window as AddressWindow).addressTrace?.events ?? null);
    if (renderer)
      await info.attach('address-order.json', {
        contentType: 'application/json',
        body: JSON.stringify({
          initialAddressLoad,
          scope: 'Real native loads, snapshots and input APIs; composition lifecycle/isComposing events are synthetic, not OS IME proof.',
          renderer,
          main: await app.evaluate(() => (globalThis as ReviewGlobal).reviewGate.events),
          initialLoad: await app.evaluate(() => (globalThis as ReviewGlobal).__wslAddressInitialLoad?.events ?? []),
        }),
      });
  } finally {
    try {
      await release();
      await app.evaluate(() => (globalThis as ReviewGlobal).__wslAddressInitialLoad?.release?.());
    } finally {
      await app?.close();
    }
  }
});
const session = () => page.getByRole('region', { name: 'Agent 会话内容' });
async function openSession() {
  await page.getByRole('button', { name: 'Agent 会话', exact: true }).click();
  await session().getByRole('button', { name: '任务', exact: true }).click();
}
async function release() {
  const commandIds = await app.evaluate(() => {
    const gate = (globalThis as ReviewGlobal).reviewGate;
    for (const resolve of gate.releases.splice(0)) resolve();
    const replies = gate.navigationReplies.splice(0);
    for (const reply of replies) reply.release();
    return replies.map((reply) => reply.commandId);
  });
  await navigationSettlementBarrier(commandIds);
}

const homeUrl = 'wsl-demo://taskflow/index.html';
const membersUrl = 'wsl-demo://taskflow/members.html';
const taskUrl = 'wsl-demo://taskflow/task.html?id=1';
const addressInput = () => page.locator('.workspace-browser:visible').getByLabel('页面地址');
async function traceAddress() {
  await page.evaluate(() => {
    const events: AddressTrace[] = [];
    const trace = ((window as AddressWindow).addressTrace = {
      events,
      urls: [] as string[],
      record: (event: string, data: Record<string, unknown> = {}) => {
        const input = Array.from(document.querySelectorAll<HTMLInputElement>('.workspace-browser input[id^="address-"]')).find(
          (node) => node.getClientRects().length > 0,
        );
        events.push({
          at: performance.timeOrigin + performance.now(),
          event,
          value: input?.value,
          start: input?.selectionStart,
          end: input?.selectionEnd,
          focused: input === document.activeElement,
          documentHasFocus: document.hasFocus(),
          ...data,
        });
      },
    });
    for (const name of ['focus', 'blur', 'select', 'keydown', 'beforeinput', 'input', 'compositionstart', 'compositionend'])
      document.addEventListener(
        name,
        (event) => {
          if (!(event.target instanceof HTMLInputElement) || !event.target.id.startsWith('address-')) return;
          trace.record(name, {
            trusted: event.isTrusted,
            key: event instanceof KeyboardEvent ? event.key : null,
            composing: event instanceof KeyboardEvent || event instanceof InputEvent ? event.isComposing : null,
            data: event instanceof InputEvent ? event.data : null,
            inputType: event instanceof InputEvent ? event.inputType : null,
          });
        },
        true,
      );
    window.studio.workbench.onEvent(({ snapshot }) => {
      const urls = snapshot.workspaces.flatMap((w) => w.resources.flatMap((r) => (r.preview ? [r.preview.page.url] : [])));
      trace.urls.push(...urls);
      trace.record('snapshot-received', { seq: snapshot.seq, urls });
    });
  });
}
async function addressCheckpoint(label: string) {
  await app.evaluate((_, event) => (globalThis as ReviewGlobal).reviewGate.record(event), label);
  return addressInput().evaluate((input: HTMLInputElement, event) => {
    (window as AddressWindow).addressTrace?.record(event);
    return { value: input.value, start: input.selectionStart, end: input.selectionEnd, focused: input === document.activeElement };
  }, label);
}
async function addressPaintBarrier() {
  // Snapshot roundtrip and rendering opportunities; reply release separately requires the original invoke's settlement.
  await workspaceSnapshot(page);
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}
async function navigationSettlementBarrier(commandIds: string[]) {
  if (commandIds.length === 0) return;
  await expect
    .poll(() =>
      page.evaluate((ids) => {
        const markers = Array.from(document.querySelectorAll<HTMLMetaElement>('meta[data-wsl-address-command-id]'));
        return ids.every((id) =>
          markers.some(
            (marker) =>
              marker.dataset.wslAddressCommandId === id &&
              (marker.dataset.wslAddressSettled === 'fulfilled' || marker.dataset.wslAddressSettled === 'rejected'),
          ),
        );
      }, commandIds),
    )
    .toBe(true);
  // The preload's actual invoke has settled; subsequent renderer work gets two frames before assertions.
  await addressPaintBarrier();
  await page.evaluate((ids) => {
    for (const marker of document.querySelectorAll<HTMLMetaElement>('meta[data-wsl-address-command-id]'))
      if (ids.some((id) => id === marker.dataset.wslAddressCommandId))
        (window as AddressWindow).addressTrace?.record('navigation-invoke-settled', {
          commandId: marker.dataset.wslAddressCommandId,
          status: marker.dataset.wslAddressSettled,
        });
  }, commandIds);
}
async function expectPageUrl(url: string) {
  await expect.poll(async () => (await previewInfo(app)).url).toBe(url);
  await expect
    .poll(async () => {
      const state = await browserState(page);
      return { url: state.page.url, loading: state.loading };
    })
    .toEqual({ url, loading: false });
  await addressPaintBarrier();
}
async function readyAddress() {
  await traceAddress();
  await expectPageUrl(homeUrl);
  await expect(addressInput()).toHaveValue(homeUrl);
}
async function backgroundNavigation(url: string) {
  await addressCheckpoint('before-native-update');
  await app.evaluate(async ({ BrowserWindow }, targetUrl) => {
    const wc = (BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView).webContents;
    await wc.loadURL(targetUrl);
  }, url);
  await expectPageUrl(url);
  await expect.poll(() => page.evaluate((targetUrl) => (window as AddressWindow).addressTrace!.urls.includes(targetUrl), url)).toBe(true);
}
async function holdNavigationReplies() {
  await app.evaluate(() => {
    (globalThis as ReviewGlobal).reviewGate.holdNavigate = true;
  });
}
async function expectHeldReply(url: string) {
  await expect
    .poll(() =>
      app.evaluate(
        (_, targetUrl) => (globalThis as ReviewGlobal).reviewGate.navigationReplies.find((reply) => reply.url === targetUrl)?.ok,
        url,
      ),
    )
    .toBe(true);
  await expectPageUrl(url);
}
async function releaseNavigationReply(url: string) {
  const commandId = await app.evaluate((_, targetUrl) => {
    const replies = (globalThis as ReviewGlobal).reviewGate.navigationReplies;
    const index = replies.findIndex((reply) => reply.url === targetUrl);
    if (index < 0) throw new Error(`No real navigation reply held for ${targetUrl}`);
    const reply = replies.splice(index, 1)[0]!;
    reply.release();
    return reply.commandId;
  }, url);
  await navigationSettlementBarrier([commandId]);
  await addressCheckpoint('after-reply-delivery');
}
async function navigationUrls() {
  return app.evaluate(() =>
    (globalThis as ReviewGlobal).reviewGate.commands.flatMap((c) => (c.type === 'browserAction' && c.action === 'navigate' ? [c.url] : [])),
  );
}

test('rejected address navigation preserves the typed URL and focus', async () => {
  await readyAddress();
  const address = page.getByLabel('页面地址');
  await address.fill('file:///review-forbidden');
  await address.press('Enter');
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: /denied|允许|拒绝|导航|不支持/ })
      .first(),
  ).toBeVisible();
  await expect(address).toHaveValue('file:///review-forbidden');
  await expect(address).toBeFocused();
  await address.press('ControlOrMeta+A');
  await page.keyboard.insertText(taskUrl);
  await address.press('Enter');
  await expectPageUrl(taskUrl);
  await expect(address).toHaveValue(taskUrl);
});

test('navigation deduplicates pending submits, honors IME, and retains newer edits after success', async () => {
  await readyAddress();
  await holdNavigationReplies();
  const address = page.getByLabel('页面地址');
  await address.fill('wsl-demo://taskflow/members.html');
  await address.dispatchEvent('compositionstart');
  await address.press('Enter');
  expect(
    await app.evaluate(
      () => (globalThis as ReviewGlobal).reviewGate.commands.filter((c) => c.type === 'browserAction' && c.action === 'navigate').length,
    ),
  ).toBe(0);
  await address.dispatchEvent('compositionend');
  await address.press('Enter');
  await expectHeldReply(membersUrl);
  await address.press('Enter');
  await address.fill('wsl-demo://taskflow/task.html?id=1');
  try {
    expect(
      await app.evaluate(
        () => (globalThis as ReviewGlobal).reviewGate.commands.filter((c) => c.type === 'browserAction' && c.action === 'navigate').length,
      ),
    ).toBe(1);
  } finally {
    await release();
  }
  await addressPaintBarrier();
  await expect
    .poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.resources.find((r) => r.kind === 'web')!.preview!.page.url)
    .toContain('members.html');
  await expect(address).toHaveValue('wsl-demo://taskflow/task.html?id=1');
});

for (const mode of ['empty first projection', 'selected URL', 'focused unchanged', 'typed draft'] as const)
  test.describe(`address race: ${mode}`, () => {
    test.use({ initialAddressLoad: mode === 'empty first projection' });
    test.skip(mode === 'empty first projection' && target === 'packaged', 'Initial-load bootstrap controls the build entrypoint only.');
    test('native projection between focus and keyboard input preserves value, selection and the complete requested URL', async () => {
      if (mode === 'empty first projection') {
        await traceAddress();
        await expect.poll(() => app.evaluate(() => (globalThis as ReviewGlobal).__wslAddressInitialLoad?.held?.url)).toBe(homeUrl);
        await expect.poll(async () => (await browserState(page)).page.url).toBe('');
        await expect(addressInput()).toHaveValue('');
      } else await readyAddress();
      const address = addressInput();
      await address.click();
      await address.press('ControlOrMeta+A');
      if (mode === 'focused unchanged') await address.press('ArrowRight');
      const prefix = 'wsl-demo://taskflow/';
      if (mode === 'typed draft') await page.keyboard.insertText(prefix);
      const value = mode === 'empty first projection' ? '' : mode === 'typed draft' ? prefix : homeUrl;
      const start = mode === 'selected URL' ? 0 : value.length;
      const frozen = { value, start, end: value.length, focused: true };
      expect(await addressCheckpoint('focus-selection-before-update')).toEqual(frozen);
      if (mode === 'empty first projection') {
        await app.evaluate(() => {
          const gate = (globalThis as ReviewGlobal).__wslAddressInitialLoad!;
          if (!gate.release) throw new Error('Initial native load is not held');
          gate.release();
        });
        await expectPageUrl(homeUrl);
        await expect.poll(() => page.evaluate((url) => (window as AddressWindow).addressTrace!.urls.includes(url), homeUrl)).toBe(true);
      } else await backgroundNavigation(membersUrl);
      // Soft here so the failing baseline still records the subsequent real input and Main command.
      expect.soft(await addressCheckpoint('focus-selection-after-update')).toEqual(frozen);
      const requested = mode === 'focused unchanged' ? `${homeUrl}?address=focused` : `${taskUrl}&address=${encodeURIComponent(mode)}`;
      const insertion =
        mode === 'focused unchanged' ? '?address=focused' : mode === 'typed draft' ? requested.slice(prefix.length) : requested;
      await page.keyboard.insertText(insertion);
      expect.soft(await addressCheckpoint('after-trusted-input')).toEqual({
        value: requested,
        start: requested.length,
        end: requested.length,
        focused: true,
      });
      expect
        .soft(await page.evaluate(() => (window as AddressWindow).addressTrace!.events))
        .toContainEqual(expect.objectContaining({ event: 'input', trusted: true, value: requested }));
      await page.keyboard.press('Enter');
      await expect.poll(navigationUrls).toEqual([requested]);
      await expectPageUrl(requested);
      expect(
        await app.evaluate(
          (_, url) =>
            (globalThis as ReviewGlobal).reviewGate.events.some(
              (event) => event.event === 'native-did-navigate' && event.nativeUrl === url,
            ),
          requested,
        ),
      ).toBe(true);
      await expect(address).toHaveValue(requested);
    });
    if (mode === 'empty first projection')
      test('rejected unchanged empty submission remains editable after blur and the first native projection', async () => {
        await traceAddress();
        await expect.poll(async () => (await browserState(page)).page.url).toBe('');
        const address = addressInput();
        await expect(address).toHaveValue('');
        await address.click();
        await address.press('Enter');
        await expect(page.getByRole('alert').filter({ hasText: '请输入地址' }).first()).toBeVisible();
        expect(await navigationUrls()).toEqual(['']);
        await page.getByRole('button', { name: '选择元素', exact: true }).focus();
        await app.evaluate(() => {
          const gate = (globalThis as ReviewGlobal).__wslAddressInitialLoad!;
          if (!gate.release) throw new Error('Initial native load is not held');
          gate.release();
        });
        await expectPageUrl(homeUrl);
        await expect(address).toHaveValue('');
        await address.click();
        await page.keyboard.insertText(taskUrl);
        await address.press('Enter');
        await expectPageUrl(taskUrl);
        await expect(address).toHaveValue(taskUrl);
      });
  });

test('address lifecycle: a real prior reply after blur and refocus cannot end an unchanged new edit', async () => {
  await readyAddress();
  await holdNavigationReplies();
  const address = addressInput();
  await address.fill(membersUrl);
  await address.press('Enter');
  await expectHeldReply(membersUrl);
  await page.getByRole('button', { name: '选择元素', exact: true }).focus();
  await address.click();
  await address.press('ControlOrMeta+A');
  const frozen = await addressCheckpoint('refocus-without-first-change');
  await releaseNavigationReply(membersUrl);
  expect(await addressCheckpoint('late-prior-reply')).toEqual(frozen);
  expect(frozen).toEqual({ value: membersUrl, start: 0, end: membersUrl.length, focused: true });
});

test('address lifecycle: two different submissions execute while replies are held and settle in reverse order', async () => {
  await readyAddress();
  await holdNavigationReplies();
  const address = addressInput();
  await address.fill(membersUrl);
  await address.press('Enter');
  await expectHeldReply(membersUrl);
  await address.press('Enter');
  await address.fill(taskUrl);
  await address.press('Enter');
  await expectHeldReply(taskUrl);
  expect(await navigationUrls()).toEqual([membersUrl, taskUrl]);
  await releaseNavigationReply(taskUrl);
  await expect(address).not.toBeFocused();
  await expect(address).toHaveValue(taskUrl);
  await address.click();
  await address.press('ControlOrMeta+A');
  const frozen = await addressCheckpoint('new-focus-after-newest-reply');
  await releaseNavigationReply(membersUrl);
  expect(await addressCheckpoint('oldest-reply-last')).toEqual(frozen);
  await expectPageUrl(taskUrl);
});

test('address lifecycle: IME Escape and Enter preserve composition; Escape invalidates a reply and freezes the latest projection', async () => {
  await readyAddress();
  await holdNavigationReplies();
  const address = addressInput();
  await address.fill('wsl-demo://taskflow/task.html?id=');
  // Synthetic composition metadata tests React's guard, not an actual OS input method.
  await address.dispatchEvent('compositionstart');
  await page.keyboard.insertText('1');
  await address.dispatchEvent('keydown', { key: 'Escape', code: 'Escape', isComposing: true, bubbles: true });
  await expect(address).toHaveValue(taskUrl);
  await address.press('Enter');
  expect(await navigationUrls()).toEqual([]);
  await address.dispatchEvent('compositionend');
  await address.press('Enter');
  await expectHeldReply(taskUrl);
  await backgroundNavigation(membersUrl);
  await expect(address).toHaveValue(taskUrl);
  // No new onChange since submission: Escape itself must invalidate the held reply.
  await address.press('Escape');
  await expect(address).toHaveValue(membersUrl);
  await expect(address).toBeFocused();
  await address.press('ControlOrMeta+A');
  const frozen = await addressCheckpoint('escape-refreezes-projection');
  await backgroundNavigation(homeUrl);
  expect(await addressCheckpoint('projection-after-escape')).toEqual(frozen);
  await releaseNavigationReply(taskUrl);
  expect(await addressCheckpoint('escaped-request-reply')).toEqual(frozen);
  await app.evaluate(() => {
    (globalThis as ReviewGlobal).reviewGate.holdNavigate = false;
  });
  await page.keyboard.insertText(taskUrl);
  await page.keyboard.press('Enter');
  await expectPageUrl(taskUrl);
});

test('address lifecycle: unchanged blur releases the freeze while dirty blur and refocus preserve the draft', async () => {
  await readyAddress();
  const address = addressInput();
  await address.click();
  await address.press('ControlOrMeta+A');
  await backgroundNavigation(membersUrl);
  await expect(address).toHaveValue(homeUrl);
  await page.getByRole('button', { name: '选择元素', exact: true }).focus();
  await expect(address).toHaveValue(membersUrl);
  await address.click();
  await address.press('ControlOrMeta+A');
  const draft = `${taskUrl}&draft=unsent`;
  await page.keyboard.insertText(draft);
  await page.getByRole('button', { name: '选择元素', exact: true }).focus();
  await backgroundNavigation(homeUrl);
  await expect(address).toHaveValue(draft);
  await address.click();
  await address.press('ControlOrMeta+A');
  expect(await addressCheckpoint('dirty-refocus')).toEqual({ value: draft, start: 0, end: draft.length, focused: true });
  expect((await browserState(page)).page.url).toBe(homeUrl);
  expect(await navigationUrls()).toEqual([]);
});

for (const destination of ['tab', 'space'] as const)
  test(`address lifecycle: ${destination} switching releases pristine focus, preserves submitted drafts and rejects old focus ownership`, async () => {
    await readyAddress();
    const initial = (await workspaceSnapshot(page)).workspaces[0]!;
    const owner = initial.resources.find((r) => r.kind === 'web')!;
    const updateHiddenOwner = async (url: string) => {
      // Main tracks genuine native navigation; the UI draft retains the submitted text separately.
      await app.evaluate(
        async ({ webContents }, { id, url }) => {
          await webContents.fromId(id)!.loadURL(url);
        },
        { id: owner.preview!.page.webContentsId, url },
      );
      await expect
        .poll(
          async () =>
            (await workspaceSnapshot(page)).workspaces
              .find((w) => w.workspaceId === initial.workspaceId)!
              .resources.find((r) => r.resourceId === owner.resourceId)!.preview!.page.url,
        )
        .toBe(url);
      await expect.poll(() => page.evaluate((url) => (window as AddressWindow).addressTrace!.urls.includes(url), url)).toBe(true);
    };
    const selectSpace = async (name: string) => {
      await page.getByRole('button', { name: '切换空间', exact: true }).click();
      await page
        .getByRole('dialog', { name: '切换空间' })
        .getByRole('button', { name: new RegExp(`${name}.*个标签`) })
        .click();
    };
    if (destination === 'space') {
      await page.getByRole('button', { name: '切换空间', exact: true }).click();
      await page.getByRole('dialog', { name: '切换空间' }).getByRole('button', { name: '新建空间', exact: true }).click();
      const create = page.getByRole('dialog', { name: '新建空间', exact: true });
      await create.getByLabel('名称').fill('Address other space');
      await create.getByRole('button', { name: '保存', exact: true }).click();
      await expect(create).toBeHidden();
    }
    const createTab = await openNewTabForm(app, page, '网页');
    await expect(createTab.getByLabel('标签类型')).toHaveValue('web');
    await createTab.getByLabel('名称').fill('Address other web');
    const otherUrl = `${homeUrl}?other=1`;
    await createTab.getByLabel('网页地址').fill(otherUrl);
    await createTab.getByRole('button', { name: '保存', exact: true }).click();
    await expect(createTab).toBeHidden();
    await expect(addressInput()).toHaveValue(otherUrl);
    const created = await workspaceSnapshot(page);
    const otherResource = created.workspaces
      .find((w) => w.workspaceId === created.activeWorkspaceId)!
      .resources.find((r) => r.kind === 'web' && r.url === otherUrl)!;
    const ownerAddress = page.locator(`[id="address-${owner.resourceId}"]`);
    const otherAddress = page.locator(`[id="address-${otherResource.resourceId}"]`);
    const tabs = () => page.getByRole('navigation', { name: '空间标签' });
    const showOwner = async () => {
      if (destination === 'space') await selectSpace('TaskFlow');
      await tabs().getByRole('button', { name: 'TaskFlow 预览', exact: true }).click();
      await expect(ownerAddress).toBeVisible();
      await expect(otherAddress).toBeHidden();
    };
    const showOther = async () => {
      if (destination === 'space') await selectSpace('Address other space');
      await tabs().getByRole('button', { name: 'Address other web', exact: true }).click();
      await expect(otherAddress).toBeVisible();
      await expect(ownerAddress).toBeHidden();
    };
    await showOwner();
    await addressInput().click();
    await addressInput().press('ControlOrMeta+A');
    await showOther();
    await updateHiddenOwner(membersUrl);
    await showOwner();
    await expect(addressInput()).toHaveValue(membersUrl);
    await holdNavigationReplies();
    await addressInput().fill(taskUrl);
    await addressInput().press('Enter');
    await expectHeldReply(taskUrl);
    // No new onChange/refocus after submission: hiding alone must invalidate this completion.
    await showOther();
    await addressInput().click();
    await addressInput().press('ControlOrMeta+A');
    const other = await addressCheckpoint('other-object-focused');
    expect(other).toEqual({ value: otherUrl, start: 0, end: otherUrl.length, focused: true });
    const hiddenUrl = `${homeUrl}?hidden=owner-after-submit`;
    await updateHiddenOwner(hiddenUrl);
    expect(await addressCheckpoint('hidden-owner-page-updated')).toEqual(other);
    await releaseNavigationReply(taskUrl);
    expect(await addressCheckpoint('owner-completed-while-hidden')).toEqual(other);
    await showOwner();
    await expect(addressInput()).toHaveValue(taskUrl);
    expect((await browserState(page)).page.url).toBe(hiddenUrl);
    // Main tracks the successful native page while the UI draft retains the user's submitted text.
    expect(
      (await workspaceSnapshot(page)).workspaces
        .find((w) => w.workspaceId === initial.workspaceId)!
        .resources.find((r) => r.resourceId === owner.resourceId)!.url,
    ).toBe(hiddenUrl);
    expect(await navigationUrls()).toEqual([taskUrl]);
  });

// OPS-1 S2：底部输入框是唯一的目标输入，「发送」是唯一的确认入口（「确认任务（生成新版本）」已移除）；范围与验收在「任务设置」中。
test('send freezes visible criteria despite autosave failure and keeps failed input', async () => {
  await openSession();
  await app.evaluate(() => {
    const gate = (globalThis as ReviewGlobal).reviewGate;
    gate.failCriteria = true;
    gate.failStart = true;
  });
  await session().getByLabel('会话消息').fill('保留当前目标');
  await session()
    .getByRole('button', { name: /^任务设置/ })
    .click();
  await session().getByLabel('允许修改范围（每行一条）').fill('src/current.ts');
  await session().getByLabel('验收条件（每行一条）').fill('当前验收一\n当前验收二');
  await session().getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.taskVersions.length).toBe(1);
  const version = (await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.taskVersions[0]!;
  expect(version.acceptance).toEqual(['当前验收一', '当前验收二']);
  expect(version.allowedScopes).toEqual(['src/current.ts']);
  await expect(session().getByLabel('会话消息')).toHaveValue('保留当前目标');
  await expect(session().getByLabel('验收条件（每行一条）')).toHaveValue('当前验收一\n当前验收二');
});

test('failed send does not navigate away from the view chosen during the pending confirmation', async () => {
  await openSession();
  await session().getByRole('button', { name: '对话', exact: true }).click();
  await session().getByLabel('会话消息').fill('确认失败后保留');
  await app.evaluate(() => {
    (globalThis as ReviewGlobal).reviewGate.holdConfirm = true;
  });
  await session().getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as ReviewGlobal).reviewGate.releases.length)).toBe(1);
  await session().getByRole('button', { name: '任务', exact: true }).click();
  await release();
  await expect(session().getByRole('button', { name: '任务', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(session().getByLabel('会话消息')).toHaveValue('确认失败后保留');
  expect((await workspaceSnapshot(page)).workspaces[0]!.sessions[0]!.taskVersions).toHaveLength(0);
});

for (const destination of ['tab', 'route', 'space', 'session-view-keyboard'] as const)
  test(`late screenshot preserves its owner without returning from ${destination}`, async () => {
    if (destination === 'session-view-keyboard') {
      await paneMenu(app, page, '左右分屏');
      await page.getByRole('button', { name: 'Agent 会话', exact: true }).click();
    }
    const initial = (await workspaceSnapshot(page)).workspaces[0]!;
    await app.evaluate(({ BrowserWindow }) => {
      const host = globalThis as ReviewGlobal;
      host.screenshotGate = { armed: true, entered: 0, release: null };
      const view = BrowserWindow.getAllWindows()[0]!.contentView.children[0] as Electron.WebContentsView;
      const capture = view.webContents.capturePage.bind(view.webContents);
      view.webContents.capturePage = async (...args) => {
        const image = await capture(...args);
        const gate = host.screenshotGate;
        if (gate.armed) {
          gate.armed = false;
          gate.entered++;
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        return image;
      };
    });
    // 接收者原生菜单（OPS-1 S1）只设定接收者；「选择元素」一步发起采集。
    await openBrowserMenu(app, page, '接收会话', initial.sessions[0]!.title);
    await page.getByRole('button', { name: '选择元素', exact: true }).click();
    await expect(page.getByRole('button', { name: '选择中 · Esc 取消' })).toBeVisible();
    await previewClick(app, await previewElementCenter(app, '[data-testid="due-1"]'));
    await expect.poll(() => app.evaluate(() => (globalThis as ReviewGlobal).screenshotGate.entered)).toBe(1);
    if (destination === 'tab') await page.getByRole('button', { name: 'Agent 会话', exact: true }).click();
    else if (destination === 'route') await workshopNavigate(page, '任务');
    else if (destination === 'session-view-keyboard') {
      const paneFocusCount = await app.evaluate(
        () => (globalThis as ReviewGlobal).reviewGate.commands.filter((c) => c.type === 'focusPane').length,
      );
      // Keyboard tabbing reaches the visible sibling pane without firing its pointer-down focus handler.
      await session().getByRole('button', { name: '对话', exact: true }).focus();
      await session().getByRole('button', { name: '对话', exact: true }).press('Tab');
      await expect(session().getByRole('button', { name: '任务', exact: true })).toBeFocused();
      await session().getByRole('button', { name: '任务', exact: true }).press('Enter');
      expect(await app.evaluate(() => (globalThis as ReviewGlobal).reviewGate.commands.filter((c) => c.type === 'focusPane').length)).toBe(
        paneFocusCount,
      );
      await expect(session().getByRole('button', { name: '任务', exact: true })).toHaveAttribute('aria-pressed', 'true');
    } else {
      await page.getByRole('button', { name: '切换空间', exact: true }).click();
      await page.getByRole('dialog', { name: '切换空间' }).getByRole('button', { name: '新建空间', exact: true }).click();
      const create = page.getByRole('dialog', { name: '新建空间', exact: true });
      await create.getByLabel('名称').fill('Review 其它空间');
      await create.getByRole('button', { name: '保存', exact: true }).click();
    }
    await app.evaluate(() => (globalThis as ReviewGlobal).screenshotGate.release!());
    await expect
      .poll(
        async () =>
          (await workspaceSnapshot(page)).workspaces.find((w) => w.workspaceId === initial.workspaceId)!.sessions[0]!.captureRequest?.state,
      )
      .toBe('completed');
    expect(
      await app.evaluate(() => (globalThis as ReviewGlobal).reviewGate.commands.filter((c) => c.type === 'locateSession').length),
    ).toBe(0);
    if (destination === 'route') await expect(page.getByRole('heading', { name: '任务历史' })).toBeVisible();
    else if (destination === 'space')
      await expect(page.getByRole('button', { name: '切换空间', exact: true })).toContainText('Review 其它空间');
    else
      await expect(
        session().getByRole('button', { name: destination === 'session-view-keyboard' ? '任务' : '对话', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
  });

test('cancel reaches Main and stops the owned run while the startRun response is pending', async () => {
  await openSession();
  await app.evaluate(() => {
    (globalThis as ReviewGlobal).reviewGate.holdStart = true;
  });
  await session().getByLabel('会话消息').fill('[slow]');
  await session().getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => app.evaluate(() => (globalThis as ReviewGlobal).reviewGate.releases.length)).toBe(1);
  try {
    await session().getByRole('button', { name: '取消回复' }).click();
    await expect.poll(async () => (await workspaceSnapshot(page)).workspaces[0]!.runs[0]!.state).toBe('cancelled');
    expect(await app.evaluate(() => (globalThis as ReviewGlobal).reviewGate.commands.some((c) => c.type === 'cancelRun'))).toBe(true);
  } finally {
    await release();
  }
  await expect(session().getByLabel('会话消息')).toHaveValue('[slow]');
});
