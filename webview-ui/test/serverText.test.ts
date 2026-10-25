import { describe, expect, it } from 'vitest';

import { koText, matchKorean, refused, SERVER_TEXT } from '../../core/src/cld/serverText.js';
import { serverLine, serverText } from '../src/cld/serverText.js';
import { en } from '../src/i18n/en.js';
import { setLanguage, translate } from '../src/i18n/index.js';
import { ko } from '../src/i18n/ko.js';

const holes = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const codes = Object.keys(SERVER_TEXT) as Array<keyof typeof SERVER_TEXT>;

describe('server text table', () => {
  it('gives every daemon code a Korean and an English string with the same holes', () => {
    for (const code of codes) {
      const key = `srv.${code}` as keyof typeof en;
      expect(en[key], `${code} en`).toBeTruthy();
      expect(ko[key], `${code} ko`).toBeTruthy();
      expect(/[가-힣]/.test(en[key]), `${code} en has Hangul`).toBe(false);
      expect(/[가-힣]/.test(ko[key]), `${code} ko has no Hangul`).toBe(true);
      expect(holes(en[key]), `${code} holes`).toEqual(holes(ko[key]));
    }
  });

  it('shows the viewer language for a known code and the daemon text for an unknown one', () => {
    const r = refused('name_win_reserved', { name: 'CON' });
    expect(r.error).toBe('CON: Windows가 장치 이름으로 쓰는 이름이라 쓸 수 없어요');
    expect(translate('srv.name_win_reserved', r.errorParams, 'en')).toBe(
      '"CON" is a device name on Windows, so it cannot be used.',
    );
    expect(serverText({ error: '새 문구', errorCode: 'not_in_table' })).toBe('새 문구');
    expect(serverText({}, 'fallback')).toBe('fallback');
  });

  it('maps a bare daemon line (a warning, a note) back to its entry and holes, and leaves others alone', () => {
    expect(matchKorean(SERVER_TEXT.path_unc.ko)?.code).toBe('path_unc');
    expect(matchKorean(koText('floor_limit', { max: 9 }))).toEqual({
      code: 'floor_limit',
      params: { max: '9' },
    });
    expect(serverLine('git said no')).toBe('git said no');
  });

  it('matches every table entry back to itself with its own holes', () => {
    for (const code of codes) {
      const vars = Object.fromEntries(
        [...SERVER_TEXT[code].ko.matchAll(/\{(\w+)\}/g)].map((m) => [m[1], 'v1']),
      );
      const text = koText(code, vars);
      const hit = matchKorean(text);
      expect(koText(hit!.code, hit!.params), code).toBe(text);
      expect(hit!.code, `${code} is read as ${hit!.code}`).toBe(code);
    }
  });

  it("reads an owner message as the owner, and the queue's words, in the viewer's language", () => {
    const hold = koText('ev_send_hold', { to: 'b' });
    setLanguage('en');
    try {
      expect(serverLine(koText('ev_send', { from: koText('ev_owner'), to: 'b' }))).toBe(
        'Owner → b message',
      );
      expect(serverLine(hold)).toBe('Held a queued message to b');
    } finally {
      setLanguage('ko');
    }
  });
});
