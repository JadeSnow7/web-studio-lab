import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ioregScalar, parseIoregLocks } from './ioreg-state';
function assertValue(actual: unknown) {
  return {
    toEqual: (expected: unknown) => assert.deepEqual(actual, expected),
    toBe: (expected: unknown) => assert.equal(actual, expected),
    toBeUndefined: () => assert.equal(actual, undefined),
    not: { toContain: (value: string) => assert.equal(String(actual).includes(value), false) },
  };
}
const session = (body: string) => `"IOConsoleUsers" = ({${body}})`;
describe('ioreg diagnostic whitelist', () => {
  it('separates root and inline session lock states without private suffixes', () => {
    const parsed = parseIoregLocks(
      `{"IOConsoleLocked"=No,${session('"kCGSSessionOnConsoleKey"=Yes,"kCGSessionLoginDoneKey"=Yes,"CGSSessionScreenLockedTime"=123,"CGSSessionScreenIsLocked"=Yes,"private"="SYNTHETIC"')}}`,
    );
    assertValue(parsed).toEqual({
      IOConsoleLocked: false,
      kCGSSessionOnConsoleKey: true,
      kCGSessionLoginDoneKey: true,
      CGSSessionScreenIsLocked: true,
      CGSSessionScreenLockedTime: '123',
    });
    assertValue(JSON.stringify(parsed)).not.toContain('SYNTHETIC');
  });
  it('accepts multiline direct session fields and ignores nested same-name fields', () => {
    assertValue(
      parseIoregLocks(
        `{\n"IOConsoleLocked"=Yes\n${session('\n"CGSSessionScreenIsLocked"=No\n"nested"={"CGSSessionScreenIsLocked"=Yes,"IOConsoleLocked"=No}\n')}\n}`,
      ),
    ).toEqual({ IOConsoleLocked: true, CGSSessionScreenIsLocked: false });
  });
  it('does not read session fields from the root or unrelated containers', () => {
    assertValue(parseIoregLocks('{"CGSSessionScreenIsLocked"=No,"other"={"IOConsoleLocked"=No,"CGSSessionScreenIsLocked"=No}}')).toEqual(
      {},
    );
  });
  it('omits conflicting duplicate and multiple-session fields', () => {
    assertValue(parseIoregLocks('"IOConsoleLocked"=No\n"IOConsoleLocked"=Yes')).toEqual({});
    assertValue(parseIoregLocks('"IOConsoleUsers"=({"CGSSessionScreenIsLocked"=No},{"CGSSessionScreenIsLocked"=Yes})')).toEqual({});
  });
  it('retains consistent repeated observations without inferring missing fields', () => {
    assertValue(parseIoregLocks('"IOConsoleUsers"=({"CGSSessionScreenIsLocked"=Yes},{"CGSSessionScreenIsLocked"=Yes})')).toEqual({
      CGSSessionScreenIsLocked: true,
    });
    assertValue(parseIoregLocks('"IOConsoleLocked"=No')).toEqual({ IOConsoleLocked: false });
    assertValue(parseIoregLocks('')).toEqual({});
    assertValue(parseIoregLocks('"IOConsoleUsers"=({"CGSSessionScreenIsLocked"=No},{"other"=Yes})')).toEqual({});
    assertValue(parseIoregLocks('"other"={"IOConsoleLocked"=No}')).toEqual({});
    assertValue(parseIoregLocks('{"other"={"IOConsoleUsers"=({"CGSSessionScreenIsLocked"=No})}}')).toEqual({});
  });
  it('rejects unknown values, quoted bools and suffix injection', () => {
    for (const value of ['false', '0', 'Unknown', '"No"', 'No SECRET', 'No/private', 'No"private"=Yes', 'No "private"=Yes']) {
      assertValue(parseIoregLocks(session(`"CGSSessionScreenIsLocked"=${value}`))).toEqual({});
    }
    for (const value of ['123 SECRET', '"123"', '-1', '123private']) {
      assertValue(
        ioregScalar(session(`"CGSSessionScreenLockedTime"=${value},"private"="SECRET"`), 'CGSSessionScreenLockedTime'),
      ).toBeUndefined();
    }
  });
  it('does not parse escaped key-like strings or malformed containers as observations', () => {
    assertValue(parseIoregLocks('{"private"="escaped \\"IOConsoleLocked\\"=No"}')).toEqual({});
    for (const input of ['{"IOConsoleLocked"=No', '"IOConsoleLocked"=No}', '"IOConsoleUsers"=({"CGSSessionScreenIsLocked"=No])']) {
      assertValue(parseIoregLocks(input)).toEqual({});
    }
  });
  it('rejects duplicate keys masking missing or invalid session members', () => {
    for (const input of [
      '"IOConsoleUsers"=({"CGSSessionScreenIsLocked"=No,"CGSSessionScreenIsLocked"=No},{})',
      '"IOConsoleUsers"=({"CGSSessionScreenIsLocked"=No},Unknown)',
    ])
      assertValue(parseIoregLocks(input)).toEqual({});
  });
  it('supports ioreg tree headers and escaped private values without exposing them', () => {
    const privateValue = JSON.stringify('quoted "IOConsoleLocked"=Yes, hidden \\ account');
    assertValue(
      parseIoregLocks(
        `+-o Root <class IORegistryEntry, id 0x100, retain 20>\n {\n "IOConsoleLocked"=No\n "private"=${privateValue}\n ${session('"CGSSessionScreenIsLocked"=Yes')}\n }`,
      ),
    ).toEqual({ IOConsoleLocked: false, CGSSessionScreenIsLocked: true });
  });
  it('accepts tree prefixes, multiple HID nodes, angle data and empty unknown fields', () => {
    const input =
      '+-o Root <class Root>\n | +-o A <class IOHIDSystem>\n | {\n | "private"=(<00ff>,<"synthetic">)\n | "absent"=,\n | "HIDIdleTime"=123\n | }\n | +-o Branch <class Entry>\n | +-o B <class IOHIDSystem>\n | {\n | "HIDIdleTime"=123\n | }\n | +-o Tail <class Entry>\n';
    assertValue(ioregScalar(input, 'HIDIdleTime')).toBe('123');
    assertValue(parseIoregLocks(input)).toEqual({});
    assertValue(ioregScalar(input.replace('"HIDIdleTime"=123', '"HIDIdleTime"=456'), 'HIDIdleTime')).toBeUndefined();
  });
  it('rejects unmatched angle tokens and non-prefix pipe characters', () => {
    for (const value of ['<No', '| No', '<']) assertValue(parseIoregLocks(`{"IOConsoleLocked"=${value}}`)).toEqual({});
    assertValue(ioregScalar('{"HIDIdleTime"=<123}', 'HIDIdleTime')).toBeUndefined();
    assertValue(parseIoregLocks(session('"CGSSessionScreenIsLocked"=<No'))).toEqual({});
  });
  it('extracts only digit HID scalars and rejects conflicts', () => {
    assertValue(ioregScalar('{"HIDIdleTime"=123,"private"="SECRET"}', 'HIDIdleTime')).toBe('123');
    assertValue(ioregScalar('"HIDIdleTime"=123\n"HIDIdleTime"=456', 'HIDIdleTime')).toBeUndefined();
  });
});
