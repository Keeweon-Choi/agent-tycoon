import { describe, expect, it } from 'vitest';

import { type ShellGateInput, shellRefusal } from './gate.js';

const allowed: ShellGateInput = {
  enabled: true,
  privileged: true,
  registered: true,
  proofAt: 1_000_000,
  now: 1_119_000,
  originAllowed: true,
  hostAllowed: true,
  rateAllowed: true,
  openCount: 0,
};

describe('shell gate', () => {
  it('accepts a registered privileged session with a fresh proof', () => {
    expect(shellRefusal(allowed)).toBeNull();
  });
  it.each([
    [{ enabled: false }, 'disabled'],
    [{ privileged: false }, 'session'],
    [{ registered: false }, 'device'],
    [{ proofAt: undefined }, 'proof'],
    [{ originAllowed: false }, 'origin'],
    [{ hostAllowed: false }, 'host'],
    [{ rateAllowed: false }, 'rate'],
    [{ openCount: 3 }, 'cap'],
  ] as const)('refuses %j as %s', (change, refusal) => {
    expect(shellRefusal({ ...allowed, ...change })).toBe(refusal);
  });
  it('accepts 119 seconds and refuses 121 seconds', () => {
    expect(shellRefusal({ ...allowed, now: 1_119_000 })).toBeNull();
    expect(shellRefusal({ ...allowed, now: 1_121_000 })).toBe('proof');
  });
});
