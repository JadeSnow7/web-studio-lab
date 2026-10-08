import { occlusion } from './occlusion';
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
}
export const uiStore = createStore<UiState>({ modal: null });
export const uiActions = {
  async openImage(title: string, src: string) {
    if (await occlusion.open('modal')) uiStore.set((s) => ({ ...s, modal: { kind: 'image', title, src } }));
  },
  async openConfirm(confirmation: Omit<ConfirmModal, 'kind'>) {
    if (await occlusion.open('modal')) uiStore.set((s) => ({ ...s, modal: { ...confirmation, kind: 'confirm' } }));
  },
  closeModal() {
    uiStore.set((s) => ({ ...s, modal: null }));
    occlusion.close('modal');
  },
};
