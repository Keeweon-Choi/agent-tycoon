import { afterEach, describe, expect, it, vi } from 'vitest';

import { PIXEL_FONT_FAMILY, PIXEL_FONT_FAMILY_READABLE } from '../constants.js';
import {
  OLD_UI_FONT_KEY,
  parseUiTheme,
  pixelFontFamily,
  reloadUiTheme,
  setUiTheme,
  UI_THEME_KEY,
  uiTheme,
} from './uiTheme.js';

const memoryStore = (seed: Record<string, string> = {}): Storage => {
  const m = new Map<string, string>(Object.entries(seed));
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
  reloadUiTheme();
});

describe('UI-THEME', () => {
  it('junk keeps the default, modern', () => {
    expect(parseUiTheme(null)).toBe('modern');
    expect(parseUiTheme('comic')).toBe('modern');
    expect(parseUiTheme('pixel')).toBe('pixel');
  });

  it('persists, and the canvas family follows', () => {
    const store = memoryStore();
    vi.stubGlobal('localStorage', store);
    setUiTheme('modern');
    expect(store.getItem(UI_THEME_KEY)).toBe('modern');
    expect(uiTheme()).toBe('modern');
    expect(pixelFontFamily()).toBe(PIXEL_FONT_FAMILY_READABLE);
    setUiTheme('pixel');
    expect(pixelFontFamily()).toBe(PIXEL_FONT_FAMILY);
  });

  it('reads the old font key once: pixel stays pixel, readable becomes modern, the new key wins', () => {
    vi.stubGlobal('localStorage', memoryStore({ [OLD_UI_FONT_KEY]: 'pixel' }));
    reloadUiTheme();
    expect(uiTheme()).toBe('pixel');
    vi.stubGlobal('localStorage', memoryStore({ [OLD_UI_FONT_KEY]: 'readable' }));
    reloadUiTheme();
    expect(uiTheme()).toBe('modern');
    vi.stubGlobal(
      'localStorage',
      memoryStore({ [OLD_UI_FONT_KEY]: 'pixel', [UI_THEME_KEY]: 'modern' }),
    );
    reloadUiTheme();
    expect(uiTheme()).toBe('modern');
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
    setUiTheme('pixel');
    expect(uiTheme()).toBe('pixel');
  });
});
