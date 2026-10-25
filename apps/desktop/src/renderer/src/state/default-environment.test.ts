import { describe, expect, it } from 'vitest';
import type { EnvironmentDescription } from '@wsl/protocol';
import { defaultEnvironment, readEnvironmentPreference, rememberEnvironment } from './default-environment';
const local: EnvironmentDescription = {
  environmentId: 'local',
  kind: 'local',
  label: '本机',
  state: 'configured',
  reason: null,
  capabilities: { files: true, terminal: true, browser: true },
};
const sandbox: EnvironmentDescription = {
  ...local,
  environmentId: 'sandbox',
  kind: 'sandbox',
  capabilities: { files: false, terminal: true, browser: false },
};
describe('device local, space and resource-specific default environments', () => {
  it('filters capability before counting and refuses stale preferences even when another environment is unique', () => {
    expect(defaultEnvironment([local, sandbox], 'file', null)).toBe(local);
    expect(defaultEnvironment([local, sandbox], 'terminal', null)).toBeUndefined();
    expect(defaultEnvironment([local, sandbox], 'terminal', 'sandbox')).toBe(sandbox);
    expect(defaultEnvironment([local], 'terminal', 'sandbox')).toBeUndefined();
    expect(defaultEnvironment([local], 'terminal', 'corrupt')).toBeUndefined();
    expect(defaultEnvironment([{ ...local, state: 'unavailable' }], 'terminal', null)).toBeUndefined();
    expect(defaultEnvironment([local, sandbox], 'ssh', null)).toBeUndefined();
  });
  it('keeps preferences isolated by device storage, space and type; malformed data remains an explicit stale choice', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    rememberEnvironment(storage, 'a', 'terminal', 'sandbox');
    expect(readEnvironmentPreference(storage, 'a', 'terminal')).toBe('sandbox');
    expect(readEnvironmentPreference(storage, 'b', 'terminal')).toBeNull();
    expect(readEnvironmentPreference(storage, 'a', 'file')).toBeNull();
    expect(readEnvironmentPreference({ getItem: () => null }, 'a', 'terminal')).toBeNull();
    rememberEnvironment(storage, 'a', 'terminal', 'corrupt');
    expect(defaultEnvironment([local], 'terminal', readEnvironmentPreference(storage, 'a', 'terminal'))).toBeUndefined();
  });
});
