/**
 * Which Enter sends a message (T-0054 follow-up). Desktop: Enter sends,
 * Shift+Enter breaks the line. A touch device (coarse pointer, no hover) has no
 * Shift worth reaching for and a send button in view, so there Enter is a
 * newline and only the button sends. Never mid-composition: the Hangul IME's
 * Enter commits the syllable, it is not the user's "send". Ctrl+Enter (Cmd+Enter
 * on a Mac) is 즉시 보내기, on any device: the message may go in while the lead works.
 */
export const TOUCH_QUERY = '(pointer: coarse) and (hover: none)';

export interface EnterKey {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  /** 229 is what Safari reports for a keydown the IME handled. */
  keyCode?: number;
}

export const isTouchDevice = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia(TOUCH_QUERY).matches;

export function enterSends(e: EnterKey, touch: boolean): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229 && !touch;
}

export function enterSendsNow(e: EnterKey): boolean {
  return (
    e.key === 'Enter' &&
    !!(e.ctrlKey || e.metaKey) &&
    !e.shiftKey &&
    !e.isComposing &&
    e.keyCode !== 229
  );
}

/** Ctrl+X then Ctrl+S: Claude Code's send-now chord, the second key within this. */
export const CHORD_MS = 1_500;

export interface ChordKey {
  key: string;
  ctrlKey: boolean;
  /** Text is selected in the box: Ctrl+X cuts it, as usual. */
  selected: boolean;
}

/** One key of the Ctrl+X Ctrl+S chord (`armedAt`: when Ctrl+X armed it, or null).
 *  `consume`: the key is the chord's (no cut, no browser save); `send`: 즉시 보내기. */
export function chordStep(
  armedAt: number | null,
  e: ChordKey,
  now: number,
): { armedAt: number | null; send: boolean; consume: boolean } {
  const key = e.key.toLowerCase();
  if (key === 'control') return { armedAt, send: false, consume: false };
  if (e.ctrlKey && key === 'x' && !e.selected) return { armedAt: now, send: false, consume: true };
  if (e.ctrlKey && key === 's' && armedAt !== null && now - armedAt <= CHORD_MS)
    return { armedAt: null, send: true, consume: true };
  return { armedAt: null, send: false, consume: false };
}
