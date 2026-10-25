import { afterEach, describe, expect, it, vi } from 'vitest';

import { NAMEPLATE_SIZES } from '../constants.js';
import {
  nameplateSizes,
  parseUiScale,
  reloadUiScale,
  setUiScale,
  UI_SCALE_KEY,
  uiScale,
} from './uiScale.js';

function memoryStore(): Storage {
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
}

afterEach(() => {
  vi.unstubAllGlobals();
  reloadUiScale();
});

describe('UI-SCALE setting', () => {
  it('parses the three steps; junk and nothing are medium', () => {
    expect(['small', 'medium', 'large'].map(parseUiScale)).toEqual(['small', 'medium', 'large']);
    for (const junk of [null, '', 'huge', 'LARGE', '{"x":1}']) expect(parseUiScale(junk)).toBe('medium');
  });

  it('round-trips through the store', () => {
    const store = memoryStore();
    vi.stubGlobal('localStorage', store);
    setUiScale('large');
    expect(store.getItem(UI_SCALE_KEY)).toBe('large');
    reloadUiScale();
    expect(uiScale()).toBe('large');
    store.setItem(UI_SCALE_KEY, 'nonsense');
    reloadUiScale();
    expect(uiScale()).toBe('medium');
  });

  it('a blocked store keeps medium, and a choice still holds for this visit', () => {
    const blocked = memoryStore();
    blocked.getItem = () => {
      throw new Error('SecurityError');
    };
    blocked.setItem = () => {
      throw new Error('SecurityError');
    };
    vi.stubGlobal('localStorage', blocked);
    reloadUiScale();
    expect(uiScale()).toBe('medium');
    setUiScale('small');
    expect(uiScale()).toBe('small');
  });

  it("looks up the nameplate's sizes per step (owner 10-24)", () => {
    expect(nameplateSizes('small')).toMatchObject({ name: 16, ring: 20, fatigue: 12, rank: 2, nameMax: 104 });
    expect(nameplateSizes('medium')).toMatchObject({ name: 16, ring: 22, fatigue: 14, rank: 2, nameMax: 104 });
    expect(nameplateSizes('large')).toMatchObject({ name: 20, ring: 26, fatigue: 18, rank: 3, nameMax: 150 });
    expect(nameplateSizes('medium')).toBe(NAMEPLATE_SIZES.medium);
  });
});
