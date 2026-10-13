import type { StudioApi } from '@wsl/protocol';

declare global {
  interface Window {
    /** preload 暴露的窄 API，见 packages/protocol/src/bridge.ts。 */
    readonly studio: StudioApi;
  }
}

export {};
