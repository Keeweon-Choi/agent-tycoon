import { describe, expect, it } from 'vitest';

import {
  TERMINAL_SEQ_ARROW_UP,
  TERMINAL_SEQ_DELETE,
  TERMINAL_SEQ_ENTER,
  TERMINAL_SEQ_HOME,
  TERMINAL_SEQ_INSERT,
  TERMINAL_SEQ_PAGE_DOWN,
  TERMINAL_SEQ_PAGE_UP,
} from '../src/constants.js';
import {
  applyModifiers,
  type KeyModifiers,
  modifierParameter,
} from '../src/terminal/keyModifiers.js';
import {
  consumeArmedKeyModifiers,
  getArmedKeyModifiers,
  resetArmedKeyModifiersForTests,
  toggleArmedKeyModifier,
} from '../src/terminal/keyModifierStore.js';

const none: KeyModifiers = { ctrl: false, shift: false, alt: false };
const withModifiers = (next: Partial<KeyModifiers>): KeyModifiers => ({ ...none, ...next });

describe('phone terminal key modifiers', () => {
  it('uses xterm modifier parameters for arrows and navigation keys', () => {
    expect(modifierParameter(none)).toBe(1);
    expect(modifierParameter(withModifiers({ shift: true }))).toBe(2);
    expect(modifierParameter(withModifiers({ alt: true }))).toBe(3);
    expect(modifierParameter(withModifiers({ ctrl: true }))).toBe(5);
    expect(modifierParameter(withModifiers({ ctrl: true, shift: true }))).toBe(6);
    expect(applyModifiers(TERMINAL_SEQ_ARROW_UP, withModifiers({ ctrl: true, shift: true }))).toBe(
      '\x1b[1;6A',
    );
    expect(applyModifiers(TERMINAL_SEQ_HOME, withModifiers({ alt: true }))).toBe('\x1b[1;3H');
    expect(applyModifiers(TERMINAL_SEQ_INSERT, withModifiers({ ctrl: true }))).toBe('\x1b[2;5~');
    expect(applyModifiers(TERMINAL_SEQ_DELETE, withModifiers({ shift: true }))).toBe('\x1b[3;2~');
    expect(applyModifiers(TERMINAL_SEQ_PAGE_UP, withModifiers({ alt: true }))).toBe('\x1b[5;3~');
    expect(applyModifiers(TERMINAL_SEQ_PAGE_DOWN, withModifiers({ ctrl: true }))).toBe('\x1b[6;5~');
  });

  it('leaves unmodified bar sequences byte-for-byte unchanged', () => {
    expect(applyModifiers(TERMINAL_SEQ_ARROW_UP, none)).toBe(TERMINAL_SEQ_ARROW_UP);
    expect(applyModifiers(TERMINAL_SEQ_HOME, none)).toBe(TERMINAL_SEQ_HOME);
    expect(applyModifiers(TERMINAL_SEQ_INSERT, none)).toBe(TERMINAL_SEQ_INSERT);
    expect(applyModifiers(TERMINAL_SEQ_DELETE, none)).toBe(TERMINAL_SEQ_DELETE);
    expect(applyModifiers(TERMINAL_SEQ_PAGE_UP, none)).toBe(TERMINAL_SEQ_PAGE_UP);
    expect(applyModifiers(TERMINAL_SEQ_PAGE_DOWN, none)).toBe(TERMINAL_SEQ_PAGE_DOWN);
  });

  it('encodes Ctrl letters, Ctrl symbols, Shift letters, and Alt prefixes', () => {
    expect(applyModifiers('a', withModifiers({ ctrl: true }))).toBe('\x01');
    expect(applyModifiers('Z', withModifiers({ ctrl: true }))).toBe('\x1a');
    expect(applyModifiers('@', withModifiers({ ctrl: true }))).toBe('\x00');
    expect(applyModifiers('[', withModifiers({ ctrl: true }))).toBe('\x1b');
    expect(applyModifiers('\\', withModifiers({ ctrl: true }))).toBe('\x1c');
    expect(applyModifiers(']', withModifiers({ ctrl: true }))).toBe('\x1d');
    expect(applyModifiers('^', withModifiers({ ctrl: true }))).toBe('\x1e');
    expect(applyModifiers('_', withModifiers({ ctrl: true }))).toBe('\x1f');
    expect(applyModifiers(' ', withModifiers({ ctrl: true }))).toBe('\x00');
    expect(applyModifiers('c', withModifiers({ shift: true }))).toBe('C');
    expect(applyModifiers('c', withModifiers({ alt: true, ctrl: true }))).toBe('\x1b\x03');
  });

  it('encodes End with modifiers and Shift+Tab as back-tab', () => {
    expect(applyModifiers('\x1b[F', withModifiers({ ctrl: true }))).toBe('\x1b[1;5F');
    expect(applyModifiers('\t', withModifiers({ shift: true }))).toBe('\x1b[Z');
    expect(applyModifiers('\t', withModifiers({ ctrl: true }))).toBe('\t');
  });

  it('keeps Enter plain unless Alt is armed', () => {
    expect(applyModifiers(TERMINAL_SEQ_ENTER, withModifiers({ ctrl: true, shift: true }))).toBe(
      '\r',
    );
    expect(applyModifiers(TERMINAL_SEQ_ENTER, withModifiers({ alt: true }))).toBe('\x1b\r');
  });

  it('passes multi-character and Ctrl non-ASCII input through unchanged', () => {
    expect(applyModifiers('pasted text', withModifiers({ ctrl: true, alt: true }))).toBe(
      'pasted text',
    );
    expect(applyModifiers('한', withModifiers({ ctrl: true, alt: true }))).toBe('한');
  });

  it('releases the shared armed state after one use', () => {
    resetArmedKeyModifiersForTests();
    toggleArmedKeyModifier('ctrl');
    toggleArmedKeyModifier('shift');
    expect(applyModifiers('한', consumeArmedKeyModifiers())).toBe('한');
    expect(getArmedKeyModifiers()).toEqual(none);
  });
});
