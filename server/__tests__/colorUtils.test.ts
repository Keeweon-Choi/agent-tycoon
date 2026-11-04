/* eslint-disable agent-tycoon/no-inline-colors -- the expected spellings are the point of this test */
import { describe, expect, it } from 'vitest';

import { rgbaToHex } from '../../core/src/assets/colorUtils.js';

describe('rgbaToHex', () => {
  it('spells opaque, translucent and transparent pixels as before', () => {
    expect(rgbaToHex(6, 7, 12, 255)).toBe('#06070C');
    expect(rgbaToHex(6, 7, 12, 128)).toBe('#06070C80');
    expect(rgbaToHex(6, 7, 12, 1)).toBe('');
  });

  it('MEM-IDLE: keeps colours apart by alpha (one cached string per colour)', () => {
    expect(rgbaToHex(255, 255, 255, 255)).toBe('#FFFFFF');
    expect(rgbaToHex(255, 255, 255, 254)).toBe('#FFFFFFFE');
    expect(rgbaToHex(255, 255, 255, 255)).toBe('#FFFFFF');
  });
});
