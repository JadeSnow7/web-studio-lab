import { describe, expect, it } from 'vitest';
import { WorkbenchCommandSchema } from './workspace';

describe('workspace preference boundary', () => {
  it('accepts the workspace theme and rejects the retired sidebar write interface', () => {
    const command = { type: 'setPreferences', commandId: 'preferences-1', workspaceId: 'workspace-1', theme: 'warm' };
    expect(WorkbenchCommandSchema.parse(command)).toEqual(command);
    expect(WorkbenchCommandSchema.safeParse({ ...command, sidebarMode: 'pinned' }).success).toBe(false);
  });
});
