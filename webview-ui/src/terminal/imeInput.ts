import {
  IME_GUARD_OFF_KEY,
  IME_START,
  imeFlush,
  type ImeOut,
  imePending,
  imeRebase,
  imeRoute,
  type ImeState,
  imeText,
} from './imeGuard.js';

/** The DOM half of the IME layer (imeGuard.ts holds the rules): capture listeners on a pane's host. */
const EVENTS = [
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'keydown',
  'keypress',
  'beforeinput',
  'input',
  'focusout',
] as const;

/** Input types that are not typing: xterm (or the clipboard code) already sent them. */
const NOT_TYPED = /^insertFrom(Paste|Drop|Yank)/;

function guardOff(): boolean {
  try {
    return localStorage.getItem(IME_GUARD_OFF_KEY) === 'off';
  } catch {
    return false;
  }
}

export interface ImeInput {
  /** Send what is still open (before a key bar key or a paste goes in). */
  flush: () => void;
  detach: () => void;
}

/**
 * Own `host`'s terminal text input. `send` is xterm's input path (term.input),
 * so the one-shot key bar modifiers and the socket see it like a key.
 */
export function attachImeInput(
  host: HTMLElement,
  send: (data: string) => void,
  font: () => { family: string; sizePx: number },
): ImeInput {
  if (guardOff()) return { flush: () => undefined, detach: () => undefined };
  let state: ImeState = IME_START;
  let endTimer: ReturnType<typeof setTimeout> | null = null;
  // xterm sent a keypress itself (space, punctuation) without cancelling it: the
  // browser still types it into the textarea, and that is not new text.
  let xtermTyped = false;
  const textarea = () => host.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea');

  // The open text, drawn at the cursor in xterm's own composition view (xterm never
  // composes now, so the element is ours).
  const preview = () => {
    const view = host.querySelector<HTMLElement>('.xterm .composition-view');
    const ta = textarea();
    if (!view || !ta) return;
    const text = imePending(state);
    view.textContent = text;
    view.classList.toggle('active', text !== '');
    if (!text) return;
    const { family, sizePx } = font();
    Object.assign(view.style, {
      left: ta.style.left,
      top: ta.style.top,
      height: ta.style.height,
      lineHeight: ta.style.lineHeight,
      fontFamily: family,
      fontSize: `${sizePx}px`,
    });
  };
  const apply = ({ state: next, out }: ImeOut) => {
    state = next;
    if (out) send(out);
    preview();
  };
  /** A compositionend's commit, read once the browser has written the final text. */
  const settle = (value: string) => {
    if (!endTimer) return;
    clearTimeout(endTimer);
    endTimer = null;
    if (state.dropping) apply({ state: { ...imeRebase(state, value), dropping: false }, out: '' });
    else apply(imeText(state, value, true));
  };
  const flush = () => {
    const ta = textarea();
    if (ta) settle(ta.value);
    apply(imeFlush(state));
    // Nothing open is left in the textarea: empty it, so a keyboard never rewrites
    // text the PTY already has (xterm does the same on Enter).
    if (ta && !state.composing) {
      ta.value = '';
      state = imeRebase(state, '');
    }
  };

  const onEvent = (ev: Event) => {
    const ta = ev.target;
    if (!(ta instanceof HTMLTextAreaElement) || !ta.classList.contains('xterm-helper-textarea'))
      return;
    const e = ev as Event & Partial<KeyboardEvent & InputEvent>;
    if (ev.type === 'beforeinput') {
      // Changed behind our back (xterm emptied it, a right-click selection): not typed.
      if (!endTimer && ta.value !== state.value) state = imeRebase(state, ta.value);
      return;
    }
    if (ev.type === 'focusout') {
      if (!state.composing) flush();
      return;
    }
    const route = imeRoute(state, {
      type: ev.type,
      key: e.key,
      keyCode: e.keyCode,
      isComposing: e.isComposing,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      metaKey: e.metaKey,
    });
    if (ev.type === 'keydown') xtermTyped = false;
    if (route === 'xterm') {
      if (ev.type === 'keypress') xtermTyped = true;
      return;
    }
    if (route === 'flush') {
      flush();
      return;
    }
    ev.stopPropagation();
    switch (ev.type) {
      case 'compositionstart':
        settle(ta.value);
        state = { ...state, composing: true };
        break;
      case 'compositionupdate':
        state = { ...state, composing: true };
        break;
      case 'compositionend':
        state = { ...state, composing: false };
        // Some browsers write the final text after compositionend (xterm waits a tick too).
        endTimer = setTimeout(() => settle(ta.value), 0);
        break;
      case 'input':
        if (endTimer) settle(ta.value);
        else if (xtermTyped || NOT_TYPED.test(e.inputType ?? '')) {
          xtermTyped = false;
          state = imeRebase(state, ta.value);
        } else apply(imeText(state, ta.value, false));
        break;
    }
  };
  for (const type of EVENTS) host.addEventListener(type, onEvent, true);
  return {
    flush,
    detach: () => {
      if (endTimer) clearTimeout(endTimer);
      for (const type of EVENTS) host.removeEventListener(type, onEvent, true);
    },
  };
}
