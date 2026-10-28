import type { AppProfile } from '@wsl/protocol';
import { eduWebKind } from './edu-web';
import { standardAppKind } from './standard-app';
import type { ManagedAppKind } from './types';

type ProjectKind = AppProfile['projectKind'];

/** protocol 每新增一种 projectKind，这里必须同时登记，否则类型检查失败。 */
const APP_KINDS: { readonly [K in ProjectKind]: ManagedAppKind<Extract<AppProfile, { projectKind: K }>> } = {
  'standard-app': standardAppKind,
  'edu-web': eduWebKind,
};

export function appKindOf(profile: AppProfile): ManagedAppKind {
  return APP_KINDS[profile.projectKind];
}
