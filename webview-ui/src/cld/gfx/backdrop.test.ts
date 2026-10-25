import { describe, expect, it } from 'vitest';

import { BACKDROP_ART_H, BACKDROP_ART_W, BACKDROP_PARALLAX } from '../../constants.js';
import { backdropScale, backdropStyle } from './backdrop.js';

describe('GFX backdrop', () => {
  it('covers the view at a whole number of device px per art px', () => {
    for (const [w, h] of [
      [1280, 744],
      [1170, 1896],
      [3840, 2160],
      [400, 200],
    ]) {
      const k = backdropScale(w, h);
      expect(Number.isInteger(k)).toBe(true);
      expect(BACKDROP_ART_W * k).toBeGreaterThanOrEqual(w);
      expect(BACKDROP_ART_H * k).toBeGreaterThanOrEqual(h);
      // and no bigger than it needs to be
      expect(k === 1 || BACKDROP_ART_W * (k - 1) < w || BACKDROP_ART_H * (k - 1) < h).toBe(true);
    }
    expect(backdropScale(1590, 440, 10)).toBe(3); // room for the parallax to move
  });

  it('is one crisp image when static, nothing when off, four capped layers with parallax', () => {
    const off = backdropStyle(1280, 744, 1, { on: false, parallax: false });
    expect(off.backgroundImage).toBe('');
    const still = backdropStyle(1280, 744, 2, { on: true, parallax: false });
    expect(still.imageRendering).toBe('pixelated');
    expect(still.backgroundImage.split('url(').length - 1).toBe(1);
    // dpr 2: 2560x1488 device px needs 4 device px per art px, 1600x900 CSS px.
    expect(still.backgroundSize).toBe('1600px 900px');
    const moving = backdropStyle(1280, 744, 1, { on: true, parallax: true });
    expect(moving.backgroundImage.split('url(').length - 1).toBe(4);
    expect(moving.backgroundPosition).toContain(`clamp(-${BACKDROP_PARALLAX.capPx}px`);
  });
});
