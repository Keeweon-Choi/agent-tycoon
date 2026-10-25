import { describe, expect, it } from 'vitest';

import { deviceLabel, deviceSource } from './device.js';

describe('device', () => {
  it('deviceLabel: iPhone/iPad -> ios, Android before Linux, Windows, Macintosh, Linux, else web', () => {
    const ua = {
      iphone:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
      ipad: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
      android:
        'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36',
      windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120',
      mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
      linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0',
    };
    expect(deviceLabel(ua.iphone)).toBe('ios');
    expect(deviceLabel(ua.ipad)).toBe('ios');
    expect(deviceLabel(ua.android)).toBe('android');
    expect(deviceLabel(ua.windows)).toBe('windows');
    expect(deviceLabel(ua.mac)).toBe('mac');
    expect(deviceLabel(ua.linux)).toBe('linux');
    expect(deviceLabel('curl/8.5.0')).toBe('web');
    expect(deviceLabel('')).toBe('web');
    expect(deviceLabel(undefined)).toBe('web');
  });

  it('deviceSource: [a-z0-9-] only, 16 characters at most, no control characters', () => {
    expect(deviceSource('ios')).toBe('gui:ios');
    expect(deviceSource('Mac\nBook; rm -rf /\x00\x1b')).toBe('gui:macbookrm-rf');
    expect(deviceSource('a'.repeat(40))).toBe(`gui:${'a'.repeat(16)}`);
    expect(deviceSource('\n한글 ')).toBe('gui:web');
    expect(deviceSource('')).toBe('gui:web');
  });
});
