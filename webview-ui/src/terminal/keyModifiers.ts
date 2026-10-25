import {
  TERMINAL_SEQ_ARROW_DOWN,
  TERMINAL_SEQ_ARROW_LEFT,
  TERMINAL_SEQ_ARROW_RIGHT,
  TERMINAL_SEQ_ARROW_UP,
  TERMINAL_SEQ_BACK_TAB,
  TERMINAL_SEQ_DELETE,
  TERMINAL_SEQ_END,
  TERMINAL_SEQ_ENTER,
  TERMINAL_SEQ_HOME,
  TERMINAL_SEQ_INSERT,
  TERMINAL_SEQ_PAGE_DOWN,
  TERMINAL_SEQ_PAGE_UP,
  TERMINAL_SEQ_TAB,
} from '../constants.js';

/** Modifiers armed by the phone key bar for the next terminal input. */
export interface KeyModifiers {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** xterm's modifier argument: one, plus one bit per pressed modifier. */
export function modifierParameter({ ctrl, shift, alt }: KeyModifiers): number {
  return 1 + (shift ? 1 : 0) + (alt ? 2 : 0) + (ctrl ? 4 : 0);
}

/** Encode arrow, Home, End, and tilde-style navigation keys with xterm modifiers. */
export function encodeModifiedTerminalKey(data: string, modifiers: KeyModifiers): string | null {
  const m = modifierParameter(modifiers);
  const arrows: ReadonlyArray<readonly [string, string]> = [
    [TERMINAL_SEQ_ARROW_UP, 'A'],
    [TERMINAL_SEQ_ARROW_DOWN, 'B'],
    [TERMINAL_SEQ_ARROW_RIGHT, 'C'],
    [TERMINAL_SEQ_ARROW_LEFT, 'D'],
  ];
  const arrow = arrows.find(([sequence]) => sequence === data);
  if (arrow) return `\x1b[1;${m}${arrow[1]}`;
  if (data === TERMINAL_SEQ_HOME) return `\x1b[1;${m}H`;
  if (data === TERMINAL_SEQ_END) return `\x1b[1;${m}F`;

  const tildeKeys: ReadonlyArray<readonly [string, number]> = [
    [TERMINAL_SEQ_INSERT, 2],
    [TERMINAL_SEQ_DELETE, 3],
    [TERMINAL_SEQ_PAGE_UP, 5],
    [TERMINAL_SEQ_PAGE_DOWN, 6],
  ];
  const tilde = tildeKeys.find(([sequence]) => sequence === data);
  return tilde ? `\x1b[${tilde[1]};${m}~` : null;
}

function ctrlCharacter(data: string): string | null {
  if (/^[a-z]$/i.test(data)) return String.fromCharCode(data.toLowerCase().charCodeAt(0) - 96);
  if (data === ' ') return '\x00';
  const controlSymbols: Record<string, string> = {
    '@': '\x00',
    '[': '\x1b',
    '\\': '\x1c',
    ']': '\x1d',
    '^': '\x1e',
    _: '\x1f',
  };
  return controlSymbols[data] ?? null;
}

/** Apply one-shot phone-bar modifiers to a terminal data payload. */
export function applyModifiers(data: string, modifiers: KeyModifiers): string {
  if (!modifiers.ctrl && !modifiers.shift && !modifiers.alt) return data;
  const special = encodeModifiedTerminalKey(data, modifiers);
  if (special) return special;
  if (data === TERMINAL_SEQ_TAB && modifiers.shift) return TERMINAL_SEQ_BACK_TAB;
  if (data === TERMINAL_SEQ_ENTER) return modifiers.alt ? `\x1b${TERMINAL_SEQ_ENTER}` : data;
  // Browser input can contain an IME commit or a paste. Those are atomic and
  // must not be split or transformed by a modifier selected for one key.
  if (data.length !== 1) return data;
  if (modifiers.ctrl && data.charCodeAt(0) > 0x7f) return data;

  let result = modifiers.shift && /^[a-z]$/i.test(data) ? data.toUpperCase() : data;
  if (modifiers.ctrl) result = ctrlCharacter(result) ?? result;
  return modifiers.alt ? `\x1b${result}` : result;
}
