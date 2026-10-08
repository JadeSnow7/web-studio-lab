import { createStore } from '../lib/store';

export interface ConfirmModal {
  kind: 'confirm';
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => Promise<boolean>;
}
export type Modal = { kind: 'image'; title: string; src: string } | ConfirmModal | null;

export interface UiState {
  modal: Modal;
  /** ⌘L 时递增，地址栏据此获取焦点。 */
  addressFocusTick: number;
}
export const uiStore = createStore<UiState>({ modal: null, addressFocusTick: 0 });
export const uiActions = {
  openImage: (title: string, src: string) => uiStore.set((s) => ({ ...s, modal: { kind: 'image', title, src } })),
  openConfirm: (confirmation: Omit<ConfirmModal, 'kind'>) => uiStore.set((s) => ({ ...s, modal: { ...confirmation, kind: 'confirm' } })),
  closeModal: () => uiStore.set((s) => (s.modal === null ? s : { ...s, modal: null })),
  requestAddressFocus: () => uiStore.set((s) => ({ ...s, addressFocusTick: s.addressFocusTick + 1 })),
};
