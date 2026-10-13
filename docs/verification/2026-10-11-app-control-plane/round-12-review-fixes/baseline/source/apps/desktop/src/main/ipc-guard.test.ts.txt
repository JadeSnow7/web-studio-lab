import { describe, expect, it } from 'vitest';
import { assertTrustedSender, isTrustedRendererUrl, type TrustedRenderer } from './ipc-guard';

const dev: TrustedRenderer = { kind: 'dev-server', origin: 'http://localhost:5173' };
const file: TrustedRenderer = {
  kind: 'file',
  url: 'file:///Applications/Web%20Studio%20Lab.app/Contents/Resources/app.asar/out/renderer/index.html',
};

describe('工作台页面来源', () => {
  it('开发模式只信任 dev server origin', () => {
    expect(isTrustedRendererUrl('http://localhost:5173/', dev)).toBe(true);
    expect(isTrustedRendererUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isTrustedRendererUrl('wsl-demo://taskflow/index.html', dev)).toBe(false);
  });
  it('打包后只信任 renderer/index.html 本身', () => {
    expect(isTrustedRendererUrl(file.url, file)).toBe(true);
    expect(isTrustedRendererUrl('file:///tmp/evil.html', file)).toBe(false);
  });
});

describe('IPC 发送者校验', () => {
  const ok = { isMainWindow: true, isTopFrame: true, frameUrl: 'http://localhost:5173/' };
  it('接受主窗口顶层工作台页面', () => {
    expect(() => assertTrustedSender(ok, dev)).not.toThrow();
  });
  it('拒绝 Browser 区视图、子 frame 与未知来源', () => {
    expect(() => assertTrustedSender({ ...ok, isMainWindow: false }, dev)).toThrow();
    expect(() => assertTrustedSender({ ...ok, isTopFrame: false }, dev)).toThrow();
    expect(() => assertTrustedSender({ ...ok, frameUrl: null }, dev)).toThrow();
    expect(() => assertTrustedSender({ ...ok, frameUrl: 'wsl-demo://taskflow/index.html' }, dev)).toThrow();
  });
});
