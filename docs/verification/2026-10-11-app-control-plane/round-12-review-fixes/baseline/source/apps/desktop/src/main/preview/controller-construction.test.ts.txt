import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({
  views: [] as Array<{
    webContents: {
      close: ReturnType<typeof vi.fn>;
      session: {
        protocol: { handle: ReturnType<typeof vi.fn>; unhandle: ReturnType<typeof vi.fn> };
        webRequest: { onBeforeRequest: ReturnType<typeof vi.fn> };
        removeListener: ReturnType<typeof vi.fn>;
      };
    };
  }>,
  protocolFailure: false,
}));
vi.mock('electron', () => ({
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), {
      id: 42,
      close: vi.fn(),
      session: {
        protocol: {
          handle: vi.fn(() => {
            if (fixture.protocolFailure) throw new Error('protocol installation failed');
          }),
          unhandle: vi.fn(),
        },
        webRequest: { onBeforeRequest: vi.fn() },
        on: vi.fn(),
        removeListener: vi.fn(),
      },
      debugger: Object.assign(new EventEmitter(), { isAttached: () => false }),
      setWindowOpenHandler: vi.fn(),
    });
    constructor() {
      fixture.views.push(this);
    }
    setVisible = vi.fn();
    setBackgroundColor = vi.fn();
  },
}));
import { PreviewController } from './controller';
beforeEach(() => {
  fixture.views.length = 0;
  fixture.protocolFailure = false;
});
describe('R5 partial native construction cleanup', () => {
  it.each(['addChildView', 'protocol'])('cleans the native view and partial registrations when %s throws', (failure) => {
    const removeChildView = vi.fn();
    const addChildView = vi.fn(() => {
      if (failure === 'addChildView') throw new Error('attach failed');
    });
    fixture.protocolFailure = failure === 'protocol';
    const create = () =>
      new PreviewController({ contentView: { addChildView, removeChildView } } as unknown as BrowserWindow, {
        partition: 'fixture',
        homeUrl: 'wsl-demo://taskflow/',
        allowedOrigins: ['wsl-demo://taskflow'],
        onState: vi.fn(),
        onCaptured: vi.fn(),
      });
    expect(create).toThrow(failure === 'protocol' ? 'protocol installation failed' : 'attach failed');
    const view = fixture.views[0]!;
    expect(view.webContents.close).toHaveBeenCalledOnce();
    expect(removeChildView).toHaveBeenCalledWith(view);
    if (failure === 'protocol') {
      expect(view.webContents.session.protocol.unhandle).toHaveBeenCalledWith('https');
      expect(view.webContents.session.webRequest.onBeforeRequest).toHaveBeenLastCalledWith(null);
      expect(view.webContents.session.removeListener).toHaveBeenCalledWith('will-download', expect.any(Function));
    }
    fixture.protocolFailure = false;
    addChildView.mockImplementation(() => {});
    expect(create).not.toThrow();
  });
});
