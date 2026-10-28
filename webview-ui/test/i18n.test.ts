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
