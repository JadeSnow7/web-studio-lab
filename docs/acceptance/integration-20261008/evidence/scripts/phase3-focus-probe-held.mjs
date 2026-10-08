import { writeFile } from "node:fs/promises";
import { launchApp, workspaceSnapshot } from "../../../../../e2e/helpers";
const events = [];
const { app, page } = await launchApp();
try {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setTitle("F26 \u539F\u751F\u7126\u70B9\u8BCA\u65AD \xB7 \u672C\u8F6E\u7A97\u53E3"));
  await app.evaluate(({ app: app2, BrowserWindow, webContents }) => {
    const state = globalThis;
    state.__focusProbe = [];
    const record = (kind, data = {}) => state.__focusProbe.push({ time: Date.now(), kind, data, windows: BrowserWindow.getAllWindows().map((w) => ({ id: w.id, focused: w.isFocused(), visible: w.isVisible(), minimized: w.isMinimized() })), contents: webContents.getAllWebContents().map((w) => ({ id: w.id, url: w.getURL(), focused: w.isFocused() })), focused: webContents.getFocusedWebContents()?.id ?? null });
    const attach = (wc) => {
      wc.on("focus", () => record("native-focus", { id: wc.id }));
      wc.on("blur", () => record("native-blur", { id: wc.id }));
      const send = wc.send.bind(wc);
      wc.send = (channel, ...args) => {
        if (channel === "chat:status" || channel === "workbench:event") record(channel, args);
        send(channel, ...args);
      };
    };
    webContents.getAllWebContents().forEach(attach);
    app2.on("web-contents-created", (_event, wc) => attach(wc));
    BrowserWindow.getAllWindows().forEach((w) => {
      w.on("focus", () => record("window-focus"));
      w.on("blur", () => record("window-blur"));
    });
    record("installed");
  });
  await page.evaluate(() => {
    const state = window;
    state.__focusProbe = [];
    const record = (kind, data = {}) => state.__focusProbe.push({ time: Date.now(), kind, data, active: document.activeElement?.outerHTML, dialogs: [...document.querySelectorAll("dialog")].map((d) => ({ open: d.open, text: d.getAttribute("aria-label") })), occlusion: document.body.className });
    window.addEventListener("focus", () => record("renderer-window-focus"));
    window.addEventListener("blur", () => record("renderer-window-blur"));
    document.addEventListener("focusin", () => record("renderer-focusin"));
    document.addEventListener("focusout", () => record("renderer-focusout"));
    window.studio.workbench.onEvent((event) => record("snapshot", event));
  });
  const checkpoint = async (kind) => events.push({ time: Date.now(), kind, snapshot: await workspaceSnapshot(page), renderer: await page.evaluate(() => ({ active: document.activeElement?.outerHTML, dialogs: [...document.querySelectorAll("dialog")].map((d) => ({ open: d.open })), body: document.body.className })), native: await app.evaluate(({ BrowserWindow, webContents }) => ({ windows: BrowserWindow.getAllWindows().map((w) => ({ id: w.id, focused: w.isFocused(), visible: w.isVisible(), minimized: w.isMinimized() })), contents: webContents.getAllWebContents().map((w) => ({ id: w.id, focused: w.isFocused(), url: w.getURL() })), focused: webContents.getFocusedWebContents()?.id ?? null })) });
  await checkpoint("start");
  await page.getByRole("button", { name: "\u5DE6\u53F3\u5206\u5C4F", exact: true }).click();
  await page.getByRole("button", { name: "\u65B0\u5EFA\u6807\u7B7E", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "\u65B0\u5EFA\u6807\u7B7E" });
  await dialog.getByLabel("\u540D\u79F0").fill("\u7B2C\u4E8C\u7F51\u9875742");
  await dialog.getByRole("button", { name: "\u4FDD\u5B58", exact: true }).click();
  await checkpoint("save-clicked");
  await dialog.waitFor({ state: "hidden" });
  const second = (await workspaceSnapshot(page)).workspaces[0].resources.find((r) => r.title === "\u7B2C\u4E8C\u7F51\u9875742");
  await page.locator(`#address-${second.resourceId}`).fill("wsl-demo://taskflow/members.html");
  await page.locator(`#address-${second.resourceId}`).press("Enter");
  const web = (await workspaceSnapshot(page)).workspaces[0].resources.find((r) => r.title === "TaskFlow \u9884\u89C8");
  await checkpoint("before-native-focus");
  await app.evaluate(({ app: app2, webContents, BrowserWindow }, id) => {
    app2.focus({ steal: true });
    BrowserWindow.getAllWindows()[0].show();
    BrowserWindow.getAllWindows()[0].focus();
    const wc = webContents.fromId(id);
    wc.focus();
    wc.sendInputEvent({ type: "mouseDown", x: 80, y: 80, button: "left", clickCount: 1 });
    wc.sendInputEvent({ type: "mouseUp", x: 80, y: 80, button: "left", clickCount: 1 });
  }, web.preview.page.webContentsId);
  for (let i = 0; i < 15; i++) {
    await checkpoint(`after-focus-${i}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  events.push({ kind: "native-events", events: await app.evaluate(() => globalThis.__focusProbe) });
  events.push({ kind: "renderer-events", events: await page.evaluate(() => window.__focusProbe) });
  await writeFile(new URL("../phase3-focus-probe-held.json", import.meta.url), JSON.stringify(events, null, 2) + "\n");
  console.log(JSON.stringify(await app.evaluate(({ app: app2 }) => ({ pid: process.pid, executable: process.execPath, userData: app2.getPath("userData") }))));
  await new Promise((resolve) => app.process().once("exit", resolve));
} finally {
  await writeFile(new URL("../phase3-focus-probe-held-final.json", import.meta.url), JSON.stringify(events, null, 2) + "\n");
  await app.close();
}
