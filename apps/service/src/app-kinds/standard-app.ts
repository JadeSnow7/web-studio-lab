import type { AppProfile } from '@wsl/protocol';
import type { ManagedAppKind } from './types';

export const standardAppKind: ManagedAppKind<Extract<AppProfile, { projectKind: 'standard-app' }>> = {
  projectKind: 'standard-app',
  // 1.1.0 增加 Agent 控制面；既有 1.0.0 项目按原身份恢复，不强制升级。
  health: { templateId: 'wsl-standard-app', templateVersions: ['1.0.0', '1.1.0'] },
  pinnedSource: null,
  recoversOwnedInstance: false,
  installsDependencyArchive: true,
  unavailable: {},
};
