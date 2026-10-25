/**
 * Korean (and any IME) input in a terminal pane: composed text reaches the
 * PTY once, as composed text (T-0078, U-33).
 *
 * xterm.js only half-owns its hidden textarea: it reads an IME's result at
 * compositionend, but keypress, keydown and `insertText` input events send
 * text on their own. Safari's Korean keyboard (iPhone, and macOS Safari)
 * opens no composition at all (WebKit bug 274700): each key is a keypress
 * with the jamo, and the keyboard then rewrites the open syllable in the
 * textarea. xterm sent every keypress: "ㅇㅏㄴㅣ ㄸㅗ" for "아니 또" (10-22 12:30).
 * Gboard composes a whole word and its space reached the PTY before the word.
 *
 * So the textarea is the one source of text: xterm never sees keypresses of
 * non-ASCII characters, keydown 229, composition or input events (imeRoute);
 * after each change the textarea's value is compared with what the PTY has
 * (imeText). Text is sent when it is final: at compositionend, or, with no
 * composition, all but a trailing Hangul syllable (and a jamo typed after
 * it), which the keyboard may still rewrite. Keys xterm handles (Enter, space, arrows, ASCII, a key bar
 * key) send everything still open first (imeFlush). Text the IME takes back
 * after the PTY had it (Gboard reopening a word) becomes DELs.
 *
 * `localStorage['cld.ime-guard'] = 'off'` switches the layer off (xterm's own
 * path: for comparing, and if a device's keyboard ever disagrees with it).
 */

export const IME_GUARD_OFF_KEY = 'cld.ime-guard';

export interface ImeState {
  /** The textarea's value as last seen. */
  value: string;
  /** How much of `value` the PTY already has. */
  sent: number;
  /** A composition is open. */
  composing: boolean;
  /** A key ended the open composition early (its text was sent): the rest of it is not. */
  dropping: boolean;
}

export const IME_START: ImeState = { value: '', sent: 0, composing: false, dropping: false };

export interface ImeOut {
  state: ImeState;
  /** Bytes for the PTY. */
  out: string;
}

const DEL = '\x7f';
/** Hangul jamo, compatibility jamo, syllables: a trailing one may still be rewritten. */
const OPEN_HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7a3]$/;
/** A compatibility jamo (what a phone keyboard types) may still join the syllable before it. */
const LONE_JAMO = /[\u3131-\u318e]$/;

/** How many trailing characters a keyboard with no composition may still rewrite. */
function stillOpen(tail: string): number {
  if (!OPEN_HANGUL.test(tail)) return 0;
  return LONE_JAMO.test(tail) && OPEN_HANGUL.test(tail.slice(0, -1)) ? 2 : 1;
}

/** Text the PTY does not have yet: what the terminal shows as the open composition. */
export function imePending(s: ImeState): string {
  return s.value.slice(s.sent);
}

/** The value changed by something other than typing (xterm cleared it, a paste): nothing to send. */
export function imeRebase(s: ImeState, value: string): ImeState {
  return { ...s, value, sent: value.length };
}

/**
 * The textarea now holds `value`. `commit`: the IME said its text is final
 * (compositionend). Returns what the PTY gets.
 */
export function imeText(s: ImeState, value: string, commit: boolean): ImeOut {
  if (s.dropping) return { state: imeRebase(s, value), out: '' };
  let p = 0;
  while (p < s.value.length && p < value.length && s.value[p] === value[p]) p++;
  // Never split a surrogate pair: an emoji that changed is taken back whole.
  if (p > 0 && /[\ud800-\udbff]/.test(value[p - 1] ?? '')) p--;
  let out = '';
  let sent = s.sent;
  if (p < sent) {
    out = DEL.repeat([...s.value.slice(p, sent)].length);
    sent = p;
  }
  const tail = value.slice(sent);
  const ready = commit ? tail : s.composing ? '' : tail.slice(0, tail.length - stillOpen(tail));
  return { state: { ...s, value, sent: sent + ready.length }, out: out + ready };
}

/** Send everything still open, now: a key xterm handles comes next. */
export function imeFlush(s: ImeState): ImeOut {
  return {
    state: { ...s, sent: s.value.length, dropping: s.composing },
    out: imePending(s),
  };
}

/** What the layer reads of a DOM event. */
export interface ImeEvent {
  type: string;
  key?: string;
  keyCode?: number;
  isComposing?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
}

/**
 * Who handles `ev`: 'textarea' keeps it from xterm (the browser changes the
 * textarea and imeText reads the result), 'xterm' lets xterm have it,
 * 'flush' sends what is open and then lets xterm have it.
 */
export function imeRoute(s: ImeState, ev: ImeEvent): 'textarea' | 'xterm' | 'flush' {
  switch (ev.type) {
    case 'compositionstart':
    case 'compositionupdate':
    case 'compositionend':
    case 'input':
      return 'textarea';
    case 'keypress':
      return s.composing || (ev.key?.codePointAt(0) ?? 0) > 0x7f ? 'textarea' : 'xterm';
    case 'keydown': {
      const code = ev.keyCode ?? 0;
      if (code === 229) return 'textarea';
      if (code === 16 || code === 17 || code === 18 || code === 91 || code === 93) return 'xterm';
      // A real key while composing (Chrome: Enter typed before the IME's commit): xterm
      // must get it; the open text goes first.
      if (s.composing || ev.isComposing) return 'flush';
      const plain = !ev.ctrlKey && !ev.altKey && !ev.metaKey;
      // Safari's Korean keyboard: the jamo's keydown. The browser types it into the textarea.
      if (plain && [...(ev.key ?? '')].length === 1 && (ev.key?.codePointAt(0) ?? 0) > 0x7f)
        return 'textarea';
      // Backspace while a syllable is open edits the syllable, not the PTY.
      if (plain && (code === 8 || code === 46) && imePending(s)) return 'textarea';
      return 'flush';
    }
    default:
      return 'xterm';
  }
}
