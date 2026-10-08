import type { PreviewState } from '@wsl/protocol';
import { createStore } from '../lib/store';

/** 主进程推送的 Browser 区状态镜像；null 表示还没有收到第一份状态。 */
export const previewStore = createStore<PreviewState | null>(null);
