import { afterEach, describe, expect, it, vi } from 'vitest';

import { PIXEL_FONT_FAMILY, PIXEL_FONT_FAMILY_READABLE } from '../constants.js';
import { parseUiFont, pixelFontFamily, reloadUiFont, setUiFont, UI_FONT_KEY, uiFont } from './uiFont.js';

const memoryStore = (): Storage => {
  const m = new Map<string, string>();
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() {
      return m.size;
    },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  reloadUiFont();
});

describe('UI-FONT', () => {
  it('junk keeps the pixel look', () => {
    expect(parseUiFont(null)).toBe('pixel');
    expect(parseUiFont('comic')).toBe('pixel');
    expect(parseUiFont('readable')).toBe('readable');
  });

  it('persists, and the canvas family follows', () => {
    const store = memoryStore();
    vi.stubGlobal('localStorage', store);
    setUiFont('readable');
    expect(store.getItem(UI_FONT_KEY)).toBe('readable');
    expect(uiFont()).toBe('readable');
    expect(pixelFontFamily()).toBe(PIXEL_FONT_FAMILY_READABLE);
    setUiFont('pixel');
    expect(pixelFontFamily()).toBe(PIXEL_FONT_FAMILY);
  });

  it('a blocked store still switches for this visit', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    setUiFont('readable');
    expect(uiFont()).toBe('readable');
  });
});
