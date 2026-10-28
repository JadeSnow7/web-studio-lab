import { describe, expect, it } from 'vitest';
import { AppProfileSchema } from '@wsl/protocol';
import { appKindOf } from './registry';

describe('appKindOf', () => {
  it('resolves every protocol projectKind to its own declaration', () => {
    for (const option of AppProfileSchema.options) {
      const projectKind = option.shape.projectKind.value;
      expect(appKindOf({ projectKind, profileVersion: 1 } as never).projectKind).toBe(projectKind);
    }
  });

  it('requires a pinned source wherever owned instances are recovered', () => {
    for (const option of AppProfileSchema.options) {
      const kind = appKindOf({ projectKind: option.shape.projectKind.value, profileVersion: 1 } as never);
      if (kind.recoversOwnedInstance) expect(kind.pinnedSource).not.toBeNull();
    }
  });
});
