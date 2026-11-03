import { describe, expect, it } from 'vitest';

import { clampZoom, parseZoom, scaledSize, stepZoom, zoomPercent } from './zoomState.js';

describe('text zoom steps', () => {
  it('moves one step and stops at the ends', () => {
    expect(stepZoom(1, 1)).toBe(1.15);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(3, 1)).toBe(3);
    expect(stepZoom(0.6, -1)).toBe(0.6);
  });
  it('a value between steps goes to the neighbouring step', () => {
    expect(stepZoom(1.2, 1)).toBe(1.3);
    expect(stepZoom(1.2, -1)).toBe(1.15);
  });
  it('clamps and parses what storage may hold', () => {
    expect(clampZoom(9)).toBe(3);
    expect(clampZoom(0.1)).toBe(0.6);
    expect(parseZoom(null)).toBe(1);
    expect(parseZoom('abc')).toBe(1);
    expect(parseZoom('-2')).toBe(1);
    expect(parseZoom('1.5')).toBe(1.5);
    expect(parseZoom('50')).toBe(3);
  });
  it('formats', () => {
    expect(zoomPercent(1.15)).toBe(115);
    expect(scaledSize('var(--text-xs)', 1)).toBeUndefined();
    expect(scaledSize('var(--text-xs)', 1.5)).toBe('calc(var(--text-xs) * 1.5)');
  });
});
