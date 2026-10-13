import type { StudioApi, StudioDebugApi } from '@wsl/protocol';

declare global {
  interface Window {
    /**
     * preload 暴露的窄 API，见 packages/protocol/src/bridge.ts。
     * `debug` 只在 Main 启用诊断通道（开发服务器或 WSL_DEBUG_STATUS=1）时存在。
     */
    readonly studio: StudioApi & { readonly debug?: StudioDebugApi };
  }
}

export {};
