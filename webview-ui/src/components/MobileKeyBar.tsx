import type { ReactNode, TouchEvent as ReactTouchEvent } from 'react';
import { useRef, useSyncExternalStore } from 'react';

import {
  MOBILE_KEY_HEIGHT_PX,
  MOBILE_TRACKPAD_STEP_PX,
  type MobileKeyModifier,
  TERMINAL_SEQ_ARROW_DOWN,
  TERMINAL_SEQ_ARROW_LEFT,
  TERMINAL_SEQ_ARROW_RIGHT,
  TERMINAL_SEQ_ARROW_UP,
  TERMINAL_SEQ_DELETE,
  TERMINAL_SEQ_END,
  TERMINAL_SEQ_ESC,
  TERMINAL_SEQ_HOME,
  TERMINAL_SEQ_INSERT,
  TERMINAL_SEQ_NEWLINE,
  TERMINAL_SEQ_PAGE_DOWN,
  TERMINAL_SEQ_PAGE_UP,
} from '../constants.js';
import { t, type TranslationKey } from '../i18n/index.js';
import { applyModifiers } from '../terminal/keyModifiers.js';
import {
  consumeArmedKeyModifiers,
  getArmedKeyModifiers,
  hasArmedKeyModifiers,
  subscribeArmedKeyModifiers,
  toggleArmedKeyModifier,
} from '../terminal/keyModifierStore.js';
import { findTouch, withinTapSlop } from '../touch/touchPrimitives.js';

interface MobileKeyBarProps {
  /** Writes the key's byte sequence to the active terminal's PTY. */
  onKey: (sequence: string) => void;
  /** Enter, or chat:sendNow during a Claude turn (submitTerminalLine). */
  onSend: () => void;
}

type Arrow = 'up' | 'down' | 'left' | 'right';
/** A key: the bytes it writes, a sticky modifier, an arrow, or send. */
type BarKey = { aria: TranslationKey } & (
  | { label: TranslationKey; sequence: string }
  | { label: TranslationKey; modifier: MobileKeyModifier }
  | { arrow: Arrow; sequence: string }
  | { label: TranslationKey; send: true }
);

/**
 * U-33, the owner's layout (10-24 21:4x): one 7-column grid, every key the same size, so
 * the arrows form a keyboard's inverted T (up over down) and the rows line up.
 */
const KEYS: ReadonlyArray<BarKey> = [
  { label: 'u33.keyEsc', aria: 'u33.ariaEsc', sequence: TERMINAL_SEQ_ESC },
  { label: 'u33.keyIns', aria: 'upstream.mobileKeyInsert', sequence: TERMINAL_SEQ_INSERT },
  { label: 'u33.keyHome', aria: 'upstream.mobileKeyHome', sequence: TERMINAL_SEQ_HOME },
  { label: 'u33.keyPgUp', aria: 'upstream.mobileKeyPageUp', sequence: TERMINAL_SEQ_PAGE_UP },
  { label: 'u33.keyNewline', aria: 'u33.ariaNewline', sequence: TERMINAL_SEQ_NEWLINE },
  { arrow: 'up', aria: 'upstream.mobileKeyArrowUp', sequence: TERMINAL_SEQ_ARROW_UP },
  { label: 'u33.keySend', aria: 'u33.ariaSend', send: true },
  { label: 'u33.keyCtrl', aria: 'upstream.mobileKeyCtrl', modifier: 'ctrl' },
  { label: 'u33.keyDel', aria: 'upstream.mobileKeyDelete', sequence: TERMINAL_SEQ_DELETE },
  { label: 'u33.keyEnd', aria: 'u33.ariaEnd', sequence: TERMINAL_SEQ_END },
  { label: 'u33.keyPgDn', aria: 'upstream.mobileKeyPageDown', sequence: TERMINAL_SEQ_PAGE_DOWN },
  { arrow: 'left', aria: 'upstream.mobileKeyArrowLeft', sequence: TERMINAL_SEQ_ARROW_LEFT },
  { arrow: 'down', aria: 'upstream.mobileKeyArrowDown', sequence: TERMINAL_SEQ_ARROW_DOWN },
  { arrow: 'right', aria: 'upstream.mobileKeyArrowRight', sequence: TERMINAL_SEQ_ARROW_RIGHT },
];

/** Pixel icons (the pixel font has no arrow glyphs), on a 7 x 7 grid. */
function PixelIcon({ children, rotate = 0 }: { children: ReactNode; rotate?: number }) {
  return (
    <svg
      viewBox="0 0 7 7"
      width={14}
      height={14}
      style={{ transform: `rotate(${rotate}deg)` }}
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}
const ARROW_TURN: Record<Arrow, number> = { up: 0, right: 90, down: 180, left: 270 };
const ArrowIcon = ({ arrow }: { arrow: Arrow }) => (
  <PixelIcon rotate={ARROW_TURN[arrow]}>
    <path d="M3 0h1v1H3zM2 1h3v1H2zM1 2h5v1H1zM0 3h7v1H0zM2 4h3v3H2z" />
  </PixelIcon>
);

/**
 * Accessory keys shown above the software keyboard in terminal view. The
 * iOS form-assistant bar (prev/next arrows + Done) is WebKit chrome that web
 * content cannot alter or remove, so these rows sit directly above it and
 * supply the keys a Claude Code TUI needs that a phone keyboard lacks.
 */
export function MobileKeyBar({ onKey, onSend }: MobileKeyBarProps) {
  const armed = useSyncExternalStore(
    subscribeArmedKeyModifiers,
    getArmedKeyModifiers,
    getArmedKeyModifiers,
  );
  // A touch only counts as a key press if it didn't travel.
  const touchStartRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const onKeyTouchStart = (e: ReactTouchEvent) => {
    const touch = e.changedTouches[0];
    touchStartRef.current = touch
      ? { id: touch.identifier, x: touch.clientX, y: touch.clientY }
      : null;
  };
  const endedAsTap = (e: ReactTouchEvent) => {
    const s = touchStartRef.current;
    const touch = s ? findTouch(e.changedTouches, s.id) : null;
    return s !== null && touch !== null && withinTapSlop(touch.clientX - s.x, touch.clientY - s.y);
  };
  const sendKey = (sequence: string) => onKey(applyModifiers(sequence, consumeArmedKeyModifiers()));
  const release = () => {
    // Send is not a key a modifier applies to; it still uses it up.
    if (hasArmedKeyModifiers()) consumeArmedKeyModifiers();
  };
  const press = (key: BarKey) => {
    if ('modifier' in key) toggleArmedKeyModifier(key.modifier);
    else if ('sequence' in key) sendKey(key.sequence);
    else {
      release();
      onSend();
    }
  };

  // The old trackpad key's gesture lives on the arrow keys: press one, hold and
  // slide, and every MOBILE_TRACKPAD_STEP_PX of travel emits the matching arrow,
  // each axis independent, retracing when the finger backs up. One drag walks a
  // /resume menu or the input-line cursor; a tap is just that arrow. The pad
  // follows the finger that pressed it, by identifier.
  const padRef = useRef<{
    id: number;
    startX: number;
    startY: number;
    sentX: number;
    sentY: number;
    slid: boolean;
  } | null>(null);
  const onPadTouchStart = (e: ReactTouchEvent) => {
    if (padRef.current && findTouch(e.touches, padRef.current.id)) return;
    const touch = e.changedTouches[0];
    if (!touch) return;
    padRef.current = {
      id: touch.identifier,
      startX: touch.clientX,
      startY: touch.clientY,
      sentX: 0,
      sentY: 0,
      slid: false,
    };
  };
  const onPadTouchMove = (e: ReactTouchEvent) => {
    const s = padRef.current;
    const touch = s ? findTouch(e.touches, s.id) : null;
    if (!s || !touch) return;
    const stepsX = Math.trunc((touch.clientX - s.startX) / MOBILE_TRACKPAD_STEP_PX);
    const stepsY = Math.trunc((touch.clientY - s.startY) / MOBILE_TRACKPAD_STEP_PX);
    const emit = (sequence: string) => {
      s.slid = true;
      sendKey(sequence);
    };
    for (; s.sentY < stepsY; s.sentY++) emit(TERMINAL_SEQ_ARROW_DOWN);
    for (; s.sentY > stepsY; s.sentY--) emit(TERMINAL_SEQ_ARROW_UP);
    for (; s.sentX < stepsX; s.sentX++) emit(TERMINAL_SEQ_ARROW_RIGHT);
    for (; s.sentX > stepsX; s.sentX--) emit(TERMINAL_SEQ_ARROW_LEFT);
  };
  const onPadTouchEnd = (e: ReactTouchEvent, sequence: string) => {
    const s = padRef.current;
    const touch = s ? findTouch(e.changedTouches, s.id) : null;
    if (s && touch) {
      padRef.current = null;
      if (!s.slid && withinTapSlop(touch.clientX - s.startX, touch.clientY - s.startY))
        sendKey(sequence);
    }
    // Keep the keyboard: swallow the synthesized mousedown that would blur the textarea.
    e.preventDefault();
  };

  const keyClass =
    'flex items-center justify-center whitespace-nowrap overflow-hidden bg-btn-bg border-2 border-border rounded-none text-text text-2xs leading-none px-2 cursor-pointer active:bg-btn-hover';
  const renderKey = (key: BarKey) => {
    const arrow = 'arrow' in key ? key : null;
    const on = 'modifier' in key && armed[key.modifier];
    return (
      <button
        key={key.aria}
        type="button"
        aria-label={t(key.aria)}
        aria-pressed={'modifier' in key ? on : undefined}
        style={{ height: MOBILE_KEY_HEIGHT_PX }}
        className={`${keyClass} min-w-0${on ? ' bg-btn-hover' : ''}${arrow ? ' touch-none select-none' : ''}`}
        onTouchStart={arrow ? onPadTouchStart : onKeyTouchStart}
        onTouchMove={arrow ? onPadTouchMove : undefined}
        onTouchCancel={
          arrow
            ? () => {
                padRef.current = null;
              }
            : undefined
        }
        // preventDefault on touchend swallows the synthesized mousedown that
        // would blur the terminal's textarea and dismiss the keyboard: the key
        // acts here and the suppressed click never fires. Reading the clipboard
        // inside touchend keeps the user activation iOS requires.
        onTouchEnd={(e) => {
          if (arrow) {
            onPadTouchEnd(e, arrow.sequence);
            return;
          }
          e.preventDefault();
          if (endedAsTap(e)) press(key);
        }}
        // Mouse path (desktop emulation): block the focus steal, act on click.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => press(key)}
      >
        {'label' in key ? t(key.label) : arrow && <ArrowIcon arrow={arrow.arrow} />}
      </button>
    );
  };
  return (
    // touch-none: no drag on the bar may start an iOS page pan (with the keyboard up
    // Safari pans the layout viewport on any vertical drag it gets to claim).
    <div
      data-touch-compact
      className="shrink-0 grid grid-cols-7 gap-4 px-8 py-2 bg-bg border-t-2 border-border touch-none"
    >
      {KEYS.map(renderKey)}
    </div>
  );
}
