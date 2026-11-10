import { describe, expect, it } from 'vitest';

import { TOPDOWN_WORLD_PX } from '../../constants.js';
import META from './art/topdown-night.json';
import { backdropPlacement, backdropStyle } from './backdrop.js';

describe('GFX2 top-down backdrop', () => {
  it('is one crisp picture with the roof colour around it, nothing when off', () => {
    expect(backdropStyle(true)).toMatchObject({
      imageRendering: 'pixelated',
      backgroundRepeat: 'repeat',
    });
    expect(backdropStyle(false).backgroundImage).toBe('');
  });

  it('sits its roofed hole under the floor shown, a whole number of device px per picture px', () => {
    for (const [zoom, dpr] of [
      [2, 1],
      [4, 2],
      [5, 3],
    ]) {
      const offset = { x: 37, y: -11 };
      const centre = { x: 280, y: 200 };
      const at = backdropPlacement(offset, zoom, dpr, centre);
      const [w, h] = at.size.split(' ').map((v) => parseFloat(v) * dpr);
      const [left, top] = at.position.split(' ').map((v) => parseFloat(v) * dpr);
      expect(w).toBeCloseTo(META.w * TOPDOWN_WORLD_PX * zoom);
      expect(h).toBeCloseTo(META.h * TOPDOWN_WORLD_PX * zoom);
      expect(Math.abs(left - Math.round(left))).toBeLessThan(1e-6);
      // The hole's centre lands on the floor's centre (device px).
      expect(left + META.holeX * TOPDOWN_WORLD_PX * zoom).toBeCloseTo(
        offset.x + centre.x * zoom,
        0,
      );
      expect(top + META.holeY * TOPDOWN_WORLD_PX * zoom).toBeCloseTo(offset.y + centre.y * zoom, 0);
    }
  });
});
