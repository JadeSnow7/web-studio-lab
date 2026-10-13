import { createStore } from '../lib/store';
export const personalReferencesStore = createStore<Array<{ resourceId: string; version: number }>>([]);
