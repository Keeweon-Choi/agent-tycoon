/**
 * G1: the office is a game, not a web page. Game areas (the canvas, HUD chrome, cards, docks)
 * get no browser menu, no text selection and no image/link drag; text areas (inputs, the
 * terminal, anything marked `data-selectable`) keep the browser's own. Selection is CSS
 * (index.css, same selector list); this file holds the one contextmenu / dragstart listener and
 * the tiny registry through which a target type shows our own menu instead.
 */

/** CSS `closest` list of what is a text area. `data-selectable` counts on a mouse only: on a
 *  phone a long press there would select the page (the owner's bug). */
const EDITABLE = 'input, textarea, [contenteditable]:not([contenteditable="false"]), .xterm';
const SELECTABLE = '[data-selectable]';

interface Closest {
  closest(selector: string): unknown;
}

export function isTextTarget(target: unknown, coarse: boolean): boolean {
  const el = target as Partial<Closest> | null;
  if (typeof el?.closest !== 'function') return false;
  return (
    !!el.closest(EDITABLE) ||
    !!el.closest('[data-selectable="always"]') ||
    (!coarse && !!el.closest(SELECTABLE))
  );
}

// ── Registry ──────────────────────────────────────────────────

export interface ContextEvent {
  target: EventTarget | null;
  x: number;
  y: number;
  /** The Menu key / Shift+F10: no pointer position to hit-test. */
  keyboard: boolean;
}
/** Shows this type's menu for the event; false when the event is not on one of its targets. */
type Opener = (ev: ContextEvent) => boolean;

const openers = new Map<string, Opener>();
const handled = new WeakSet<Event>();

/** A target type (character, furniture, room, project) shows its menu through `open`. */
export function registerContextTarget(type: string, open: Opener): () => void {
  openers.set(type, open);
  return () => void (openers.get(type) === open && openers.delete(type));
}

/** The type whose menu opened, or null. */
export function openContextMenu(ev: ContextEvent): string | null {
  for (const [type, open] of openers) if (open(ev)) return type;
  return null;
}

/** True when our own menu already answered this contextmenu event (the canvas then skips its walk). */
export const isContextHandled = (e: Event): boolean => handled.has(e);

// ── Listeners ─────────────────────────────────────────────────

const coarsePointer = () => window.matchMedia('(pointer: coarse)').matches;

/** Keyboard-made contextmenu events carry button 0 and no mouse, touch or pen pointer. */
const fromKeyboard = (e: MouseEvent): boolean =>
  e.button === 0 &&
  !e.ctrlKey &&
  !['mouse', 'touch', 'pen'].includes((e as PointerEvent).pointerType);

export function installInputPolicy(): () => void {
  const onContextMenu = (e: MouseEvent) => {
    if (isTextTarget(e.target, coarsePointer())) return;
    e.preventDefault();
    const keyboard = fromKeyboard(e);
    if (openContextMenu({ target: e.target, x: e.clientX, y: e.clientY, keyboard })) handled.add(e);
  };
  const onDragStart = (e: DragEvent) => {
    const el = e.target as Element | null;
    // ponytail: only images and links; a dragged text selection is a text area's own business.
    if (el?.closest?.('[draggable="true"]') || !el?.closest?.('img, a')) return;
    if (!isTextTarget(el, coarsePointer())) e.preventDefault();
  };
  document.addEventListener('contextmenu', onContextMenu, true);
  document.addEventListener('dragstart', onDragStart, true);
  return () => {
    document.removeEventListener('contextmenu', onContextMenu, true);
    document.removeEventListener('dragstart', onDragStart, true);
  };
}
