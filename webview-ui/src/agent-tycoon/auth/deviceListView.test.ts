import { describe, expect, it } from 'vitest';

import { deviceKindKey, devicePathKey } from './deviceListView.js';

describe('O2 device-list labels', () => {
  it('maps server kinds and paths to literal translation keys', () => {
    expect(deviceKindKey('phone')).toBe('auth.deviceKind.phone');
    expect(deviceKindKey('tablet')).toBe('auth.deviceKind.tablet');
    expect(deviceKindKey('desktop')).toBe('auth.deviceKind.desktop');
    expect(deviceKindKey('anything else')).toBe('auth.deviceKind.unknown');
    expect(devicePathKey('local')).toBe('auth.devicePath.local');
    expect(devicePathKey('lan')).toBe('auth.devicePath.lan');
    expect(devicePathKey('tailscale')).toBe('auth.devicePath.tailscale');
    expect(devicePathKey('anything else')).toBe('auth.devicePath.remote');
  });
});
