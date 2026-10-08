import type { WorkbenchTab } from '@wsl/protocol';
import { createStore } from '../lib/store';
import { occlusion } from './occlusion';
export type Editor = { kind: 'workspace' | 'rename-workspace' | 'tab' | 'rename-tab' | 'group'; tabId?: string };
export const spaceUiStore = createStore<{
  switcher: boolean;
  editor: Editor | null;
  name: string;
  kind: WorkbenchTab['targetRef']['kind'];
  tabMenu: string | null;
}>({ switcher: false, editor: null, name: '', kind: 'web', tabMenu: null });
const previous = new Map<string, HTMLElement | null>();
async function acquire(source: string) {
  previous.set(
    source,
    source === 'editor'
      ? ((occlusion.store.get()['switcher'] ? previous.get('switcher') : null) ??
          (occlusion.store.get()['tab-menu'] ? previous.get('tab-menu') : null) ??
          (document.activeElement instanceof HTMLElement ? document.activeElement : null))
      : document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null,
  );
  return occlusion.open(source);
}
function release(source: string) {
  occlusion.close(source);
  const element = previous.get(source);
  previous.delete(source);
  requestAnimationFrame(() => {
    if (element?.isConnected && !element.closest('dialog:not([open])')) element.focus();
    else document.querySelector<HTMLButtonElement>('[aria-label="切换空间"]')?.focus();
  });
}

export const spaceActions = {
  async openSwitcher() {
    if (await acquire('switcher')) spaceUiStore.set((s) => ({ ...s, switcher: true }));
  },
  closeSwitcher() {
    spaceUiStore.set((s) => ({ ...s, switcher: false }));
    release('switcher');
  },
  async openEditor(editor: Editor, name = '') {
    if (!(await acquire('editor'))) return;
    spaceUiStore.set((s) => ({ ...s, editor, name, switcher: false, tabMenu: null }));
    occlusion.close('switcher');
    occlusion.close('tab-menu');
    previous.delete('switcher');
    previous.delete('tab-menu');
  },
  closeEditor() {
    document.querySelector<HTMLDialogElement>('dialog.workspace-editor')?.close();
    spaceUiStore.set((s) => ({ ...s, editor: null }));
    release('editor');
  },
  async openTabMenu(tabMenu: string) {
    if (await acquire('tab-menu')) spaceUiStore.set((s) => ({ ...s, tabMenu }));
  },
  closeTabMenu() {
    spaceUiStore.set((s) => ({ ...s, tabMenu: null }));
    release('tab-menu');
  },
};
