import { afterEach, describe, expect, it } from 'vitest';

import { en } from '../src/i18n/en.js';
import { getLanguage, setLanguage, translate } from '../src/i18n/index.js';
import { ko } from '../src/i18n/ko.js';

const before = getLanguage();
afterEach(() => setLanguage(before));

describe('i18n', () => {
  it('keeps English and Korean keys in parity', () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
  });

  it('falls back to English for a missing Korean entry', () => {
    expect(translate('settings.title', undefined, 'ko', {})).toBe('Settings');
  });

  it('replaces named placeholders and leaves missing variables visible', () => {
    expect(translate('messenger.send', { name: 'Ada' }, 'en')).toBe('Send to Ada');
    expect(
      translate('settings.title', { name: 'Ada' }, 'ko', { 'settings.title': '안녕 {name} {missing}' }),
    ).toBe('안녕 Ada {missing}');
  });

  it('labels the bypass recommendation in both the Intro and Settings', () => {
    expect(translate('onboarding.bypass.recommended', undefined, 'en')).toBe('Recommended');
    expect(translate('settings.bypass.recommended', undefined, 'ko')).toBe('추천');
  });
});

describe('lazy spec strings', () => {
  it('a spec key shows itself before the strings are registered, and never throws', async () => {
    expect(translate('spec.graph.title', undefined, 'en')).toBe('spec.graph.title');
    expect(translate('spec.graph.title', undefined, 'ko')).toBe('spec.graph.title');
  });

  it('translates in both languages once registered, also when registered twice', async () => {
    const { specEn } = await import('../src/i18n/spec.en.js');
    const { specKo } = await import('../src/i18n/spec.ko.js');
    await import('../src/i18n/specStrings.js');
    const { addStrings } = await import('../src/i18n/lazy.js');
    addStrings(specEn, specKo);
    expect(translate('spec.noJobs', undefined, 'en')).toBe(specEn['spec.noJobs']);
    expect(translate('spec.noJobs', undefined, 'ko')).toBe(specKo['spec.noJobs']);
    expect(specKo['spec.noJobs']).not.toBe(specEn['spec.noJobs']);
    expect(translate('spec.exit', { code: 3 }, 'en')).toBe('exit 3');
  });

  it('keeps the spec strings in English and Korean parity, apart from the main bundle ones', async () => {
    const { specEn } = await import('../src/i18n/spec.en.js');
    const { specKo } = await import('../src/i18n/spec.ko.js');
    expect(Object.keys(specKo).sort()).toEqual(Object.keys(specEn).sort());
    expect(Object.keys(specEn).filter((k) => k in en)).toEqual([]);
  });
});
