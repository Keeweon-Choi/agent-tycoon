import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseSummaryStyle, reloadSummaryStyle, setSummaryStyle, SUMMARY_STYLE_KEY, summaryStyle } from './summaryStyle.js';

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
  reloadSummaryStyle();
});

describe('FEAT-HUD-SUMMARY-STYLES: the bottom-left summary setting', () => {
  it('the control center is the default; junk or nothing stored keeps it', () => {
    expect(parseSummaryStyle(null)).toBe('center');
    expect(parseSummaryStyle('stack')).toBe('center');
    expect(parseSummaryStyle('cards')).toBe('cards');
    expect(parseSummaryStyle('line')).toBe('line');
    vi.stubGlobal('localStorage', memoryStore());
    reloadSummaryStyle();
    expect(summaryStyle()).toBe('center');
    vi.stubGlobal('localStorage', memoryStore({ [SUMMARY_STYLE_KEY]: 'nonsense' }));
    reloadSummaryStyle();
    expect(summaryStyle()).toBe('center');
  });

  it('persists the choice and reads it back', () => {
    const store = memoryStore();
    vi.stubGlobal('localStorage', store);
    setSummaryStyle('line');
    expect(store.getItem(SUMMARY_STYLE_KEY)).toBe('line');
    expect(summaryStyle()).toBe('line');
    reloadSummaryStyle();
    expect(summaryStyle()).toBe('line');
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
    setSummaryStyle('cards');
    expect(summaryStyle()).toBe('cards');
    reloadSummaryStyle();
    expect(summaryStyle()).toBe('center');
  });
});
