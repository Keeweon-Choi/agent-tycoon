import { beforeEach, expect, it } from 'vitest';

import { setLanguage } from '../../i18n/index.js';
import { canonicalizeMentions, chooseMention, filterMentions, mentionAt, mentionDisplay, replyPrefill } from './roomMentions.js';

beforeEach(() => setLanguage('ko'));

it('finds an @word at the caret, including Korean project names', () => {
  expect(mentionAt('\ubc30\ud3ec\ub294 @\uc11c\uc6b8', 7)).toEqual({ from: 4, query: '\uc11c\uc6b8' });
  expect(mentionAt('\uba54\uc77c a@b', 8)).toBeNull();
  expect(mentionAt('\uc774\ubbf8 @\uc774\ub984 \ub2e4\uc74c', 9)).toBeNull();
});

it('filters room members and offers \uc804\uccb4 first without duplicates', () => {
  expect(filterMentions(['\uc11c\uc6b8 API', '\uc804\uccb4', '\ubd80\uc0b0'], '')).toEqual(['\uc804\uccb4', '\uc11c\uc6b8 API', '\ubd80\uc0b0']);
  expect(filterMentions(['\uc11c\uc6b8 API', '\ubd80\uc0b0'], '\uc11c')).toEqual(['\uc11c\uc6b8 API']);
  expect(filterMentions(['alpha'], '\uc804')).toEqual(['\uc804\uccb4']);
});

it('replaces only the active mention and leaves a space for the next one', () => {
  expect(chooseMention('\uc548\ub155 @\uc11c, \ub2e4\uc74c', 5, '\uc11c\uc6b8 API')).toEqual({
    text: '\uc548\ub155 @\uc11c\uc6b8 API , \ub2e4\uc74c',
    cursor: 11,
  });
});

it('displays and sends the English all-member alias using the daemon marker', () => {
  setLanguage('en');
  expect(filterMentions(['alpha'], 'every')).toEqual(['\uc804\uccb4']);
  expect(mentionDisplay('\uc804\uccb4')).toBe('everyone');
  expect(canonicalizeMentions('Hi @everyone, @alpha')).toBe('Hi @\uc804\uccb4, @alpha');
});

it('a reply tags the replied-to member, once, and nobody else', () => {
  const members = ['alpha', 'beta gamma'];
  expect(replyPrefill('', 'alpha', members)).toBe('@alpha ');
  expect(replyPrefill('ok', 'beta gamma', members)).toBe('@beta gamma ok');
  expect(replyPrefill('@alpha ok', 'alpha', members)).toBe('@alpha ok');
  expect(replyPrefill('', undefined, members)).toBe(''); // the boss's own message
  expect(replyPrefill('', 'cld-gui', members)).toBe(''); // a system line
});
