import { describe, expect, it } from 'vitest';

import {
  IME_START,
  imeFlush,
  imePending,
  imeRoute,
  type ImeState,
  imeText,
} from '../src/terminal/imeGuard.js';

/** Feeds textarea values through imeText; returns the PTY bytes and the last state. */
function type(values: string[], from: ImeState = IME_START, commit = false) {
  let state = from;
  let pty = '';
  for (const v of values) {
    const r = imeText(state, v, commit);
    state = r.state;
    pty += r.out;
  }
  return { state, pty };
}

describe('imeText: no composition (Safari Korean keyboard)', () => {
  it('sends a syllable once the next one starts, never the jamo', () => {
    const { state, pty } = type([
      '\u314e',
      '\ud558',
      '\ud55c',
      '\ud55c\u3131',
      '\ud55c\uadf8',
      '\ud55c\uae00',
    ]);
    expect(pty).toBe('\ud55c');
    expect(imePending(state)).toBe('\uae00');
    expect(imeFlush(state).out).toBe('\uae00');
  });

  it('a final consonant moving to the next syllable is still unsent', () => {
    // an + i = a-ni: the final n leaves the open syllable, which had not gone out.
    expect(type(['\u3147', '\uc544', '\uc548', '\uc544\ub2c8']).pty).toBe('\uc544');
  });

  it('backspace on the open syllable never deletes PTY text', () => {
    const typed = type(['\u3147', '\uc544', '\uc548', '\uc544\ub2c8']);
    const back = type(['\uc544'], typed.state);
    expect(back.pty).toBe('');
    expect(imePending(back.state)).toBe('');
  });

  it('a jamo typed after a syllable keeps the syllable open until it is joined', () => {
    // The keyboard types the vowel, then rewrites syllable + vowel as one (iOS may do either).
    expect(type(['\u314e', '\u314e\u314f', '\ud558']).pty).toBe('');
    expect(type(['\ud55c', '\ud55c\u3131', '\ud55c\uadf8']).pty).toBe('\ud55c');
  });

  it('text that is not Hangul goes at once', () => {
    expect(type(['a', 'ab', 'ab ']).pty).toBe('ab ');
  });
});

describe('imeText: compositions (Gboard, desktop IMEs)', () => {
  it('holds the whole composition until it is committed', () => {
    const composing = { ...IME_START, composing: true };
    const { state, pty } = type(
      [
        '\u314e',
        '\ud558',
        '\ud55c',
        '\ud55c\u3131',
        '\ud55c\uadf8',
        '\ud55c\uae00',
        '\ud55c\uadf8',
        '\ud55c\uae00',
      ],
      composing,
    );
    expect(pty).toBe('');
    expect(imeText({ ...state, composing: false }, '\ud55c\uae00', true).out).toBe('\ud55c\uae00');
  });

  it('text the IME takes back after the PTY had it becomes DELs', () => {
    // Gboard reopens a sent word on backspace and edits it.
    const sent = { ...IME_START, value: '\ud55c\uae00 ', sent: 3 };
    const { pty } = type(['\ud55c\uae00', '\ud55c\uadf8'], sent);
    expect(pty).toBe('\x7f\x7f');
  });

  it('an emoji taken back is one DEL', () => {
    const sent = { ...IME_START, value: 'a\u{1F600}', sent: 3 };
    expect(imeText(sent, 'a\u{1F601}', false).out).toBe('\x7f\u{1F601}');
  });

  it('after a key ended a composition early, the rest of it is not sent', () => {
    const open = { ...IME_START, value: '\uc694', composing: true };
    const flushed = imeFlush(open);
    expect(flushed.out).toBe('\uc694');
    expect(imeText(flushed.state, '', false).out).toBe('');
    expect(imeText(flushed.state, '\uc694', true).out).toBe('');
  });
});

describe('imeRoute', () => {
  const pending = { ...IME_START, value: '\ud55c', sent: 0 };
  it('IME keys and text events stay away from xterm', () => {
    expect(imeRoute(IME_START, { type: 'keydown', keyCode: 229 })).toBe('textarea');
    expect(imeRoute(IME_START, { type: 'keydown', key: '\u314f', keyCode: 0 })).toBe('textarea');
    expect(imeRoute(IME_START, { type: 'keypress', key: '\u314f' })).toBe('textarea');
    expect(imeRoute(IME_START, { type: 'input' })).toBe('textarea');
    expect(imeRoute(IME_START, { type: 'compositionend' })).toBe('textarea');
  });

  it('real keys go to xterm, after what is open', () => {
    expect(imeRoute(IME_START, { type: 'keypress', key: 'a' })).toBe('xterm');
    expect(imeRoute(pending, { type: 'keydown', key: 'Enter', keyCode: 13 })).toBe('flush');
    expect(imeRoute(pending, { type: 'keydown', key: ' ', keyCode: 32 })).toBe('flush');
    expect(imeRoute(IME_START, { type: 'keydown', key: 'Backspace', keyCode: 8 })).toBe('flush');
    // Chrome marks Enter typed before the IME's commit as composing: xterm still gets it.
    expect(
      imeRoute(IME_START, { type: 'keydown', key: 'Enter', keyCode: 13, isComposing: true }),
    ).toBe('flush');
    expect(imeRoute(pending, { type: 'keydown', key: 'Shift', keyCode: 16 })).toBe('xterm');
  });

  it('backspace edits an open syllable in the textarea', () => {
    expect(imeRoute(pending, { type: 'keydown', key: 'Backspace', keyCode: 8 })).toBe('textarea');
    expect(
      imeRoute(pending, { type: 'keydown', key: 'Backspace', keyCode: 8, ctrlKey: true }),
    ).toBe('flush');
  });
});
