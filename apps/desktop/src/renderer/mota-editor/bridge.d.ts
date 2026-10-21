import type { MotaEditorBridge } from '@wsl/protocol';
declare global {
  interface Window {
    motaEditor: MotaEditorBridge;
  }
}
export {};
