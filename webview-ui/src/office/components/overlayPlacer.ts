/**
 * SMOOTH2-1104: where the office's DOM overlays (nameplates, bubbles, badges) sit, moved on every
 * frame the canvas draws WITHOUT React: each positioned element is bound once (a ref) with a function
 * from its character's projection to a screen point, and `run()` writes `transform: translate(...)`.
 * A transform never invalidates layout, and nothing is measured here (the container's size comes in
 * through `frame()`), so a frame costs the arithmetic and the style writes of what actually moved.
 * The same function places the element when it mounts, so the first paint and the moving one agree.
 * What an element SAYS (name, status, icon) is still React's, re-rendered when it changes.
 *
 * Deliberately free of React and of DOM reads (the elements are only written): unit-testable.
 */
import { drawnShift } from '../../agent-tycoon/floors.js';
import { isoFrame, isoOverlayFor } from '../../agent-tycoon/iso/render.js';
import { characterDrawn } from '../engine/officeState.js';
import type { OverlayProjection } from '../projection.js';
import type { Character } from '../types.js';

export interface Placed {
  /** Screen position in CSS px, in the overlay container (left/top 0 + this). */
  x: number;
  y: number;
  /** Written when given (a fading bubble); otherwise the element's own opacity stays. */
  opacity?: number;
}

/** One element's place from its character's projection this frame (`dpr` for sizes in CSS px). */
export type PlaceFn = (project: OverlayProjection, dpr: number) => Placed;

/** A character's view of the frame: which floor it is on and the projection that lands its feet. */
export interface CharView {
  project: OverlayProjection;
  /** 0: on the floor in focus; 1 (iso) or a stack offset (top-down): another floor shown; null: not drawn. */
  shift: number | null;
}

interface Bound {
  el: HTMLElement;
  ch: Character;
  fn: PlaceFn;
  last: string;
}

/** Snaps to the device pixel grid, as the browser did painting `left`/`top`. */
const snap = (v: number, dpr: number) => Math.round(v * dpr) / dpr;

export function createPlacer() {
  const items = new Map<string, Bound>();
  const views = new Map<number, CharView>();
  let base: OverlayProjection | null = null;
  let layout: object = {};
  let dpr = 1;

  const apply = (it: Bound) => {
    const p = it.fn(viewOf(it.ch).project, dpr);
    const t = `translate(${snap(p.x, dpr)}px,${snap(p.y, dpr)}px)`;
    const key = p.opacity === undefined ? t : `${t}|${p.opacity}`;
    if (it.last === key) return;
    it.last = key;
    it.el.style.transform = t;
    if (p.opacity !== undefined) it.el.style.opacity = String(p.opacity);
  };

  /** `ch` seen through this frame's projection (memoised per frame: iso lookups are not free). */
  function viewOf(ch: Character): CharView {
    let v = views.get(ch.id);
    if (v) return v;
    const b = base!;
    // ISO-PILOT: in the isometric building everything is placed from where it drew the feet; a
    // character off the floor in focus shows its bubble only.
    // Not drawn (gone home, in the elevator's car): nothing of it is placed either.
    const drawn = characterDrawn(ch);
    const iso = drawn ? isoOverlayFor(ch, dpr, b) : null;
    const shift = !drawn ? null : iso ? (iso.focused ? 0 : 1) : isoFrame() ? null : drawnShift(layout, ch.y);
    const project =
      iso?.project ?? (shift ? { ...b, toScreenY: (y: number) => b.toScreenY(y + shift) } : b);
    v = { project, shift };
    views.set(ch.id, v);
    return v;
  }

  return {
    /** A new frame: the base projection, the layout (floors) and the pixel ratio it was made with. */
    frame(next: OverlayProjection, nextLayout: object, nextDpr: number): void {
      base = next;
      layout = nextLayout;
      dpr = nextDpr;
      views.clear();
    },
    viewOf,
    /** A ref callback placing the element it is given: `key` names the slot, `fn` is its (latest) place. */
    bind(key: string, ch: Character, fn: PlaceFn): (el: HTMLElement | null) => void {
      let mine: Bound | undefined;
      return (el) => {
        if (el) {
          mine = { el, ch, fn, last: '' };
          items.set(key, mine);
          if (base) apply(mine); // mounted between frames: placed before it is ever painted
        } else if (mine && items.get(key) === mine) {
          items.delete(key);
        }
      };
    },
    /** Moves every bound element for the frame set by `frame()`. */
    run(): void {
      for (const it of items.values()) apply(it);
    },
  };
}

export type Placer = ReturnType<typeof createPlacer>;
/** Binds a slot of one character (the placer and the character already given). */
export type Bind = (key: string, fn: PlaceFn) => (el: HTMLElement | null) => void;
