/**
 * ISO-PILOT camera: what the isometric building is framed on. Two views (the floor panel's
 * one toggle, the floors store's `stacked`): the whole building, or the floor in focus. A
 * new focus glides the camera to that floor (at once with reduced motion); a follow keeps a
 * character in the middle; a manual pan or zoom is left alone until the next focus change.
 * Pure but for its small state object (the Node runner tests it).
 */
import { CAMERA_FOLLOW_LERP, ISO_FRAME_MARGIN, ZOOM_MAX, ZOOM_MIN } from '../../constants.js';
import { glidePan } from '../camera.js';
import { floorBox, type IsoStack, panTo, type Pt } from './projection.js';

type Box = IsoStack['box'];

/** The iso px every pan is about: the building's centre (a stable reference). */
export const stackCentre = (stack: IsoStack): Pt => ({
  x: (stack.box.x0 + stack.box.x1) / 2,
  y: (stack.box.y0 + stack.box.y1) / 2,
});

/** The largest whole zoom at which `box` (and a margin) fits the view. */
export function fitZoom(view: { w: number; h: number }, box: Box, dpr = 1): number {
  const m = 2 * ISO_FRAME_MARGIN * dpr;
  const z = Math.floor(
    Math.min((view.w - m) / (box.x1 - box.x0), (view.h - m) / (box.y1 - box.y0)),
  );
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
}

/** Keep the view's centre over the building (the pan can never lose it). */
export function clampIsoPan(pan: Pt, stack: IsoStack, zoom: number): Pt {
  const c = stackCentre(stack);
  const at = { x: c.x - pan.x / zoom, y: c.y - pan.y / zoom };
  const x = Math.max(stack.box.x0, Math.min(stack.box.x1, at.x));
  const y = Math.max(stack.box.y0, Math.min(stack.box.y1, at.y));
  return x === at.x && y === at.y ? pan : panTo({ x, y }, c, zoom);
}

/** The iso px the view centres on for a focus, in either view. In the whole-building view the
 *  building stays centred while it fits, else the focus floor is brought as near the middle as
 *  the building's ends allow. */
export function viewTarget(
  stack: IsoStack,
  level: number,
  building: boolean,
  view: { w: number; h: number },
  zoom: number,
): Pt {
  const f = floorBox(stack, level);
  const mid = (b: Box): Pt => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
  if (!building) return mid(f);
  const b = stack.box;
  const half = view.h / 2 / zoom;
  const centre = mid(b);
  if (b.y1 - b.y0 <= 2 * half) return centre;
  return { x: centre.x, y: Math.max(b.y0 + half, Math.min(b.y1 - half, mid(f).y)) };
}

export interface IsoCamState {
  /** What the view was last framed for. */
  frameKey: string | null;
  focusKey: string | null;
  glide: Pt | null;
  /** The pan the glide last wrote (another one means the user moved the camera). */
  wrote: Pt | null;
}
export const newIsoCam = (): IsoCamState => ({
  frameKey: null,
  focusKey: null,
  glide: null,
  wrote: null,
});

/**
 * One frame of the camera: the pan to use now, and a new zoom when the view must be framed
 * again (the view toggled, the window resized, the building changed).
 */
export function isoCameraStep(
  st: IsoCamState,
  input: {
    stack: IsoStack;
    level: number;
    focusId: string;
    building: boolean;
    view: { w: number; h: number };
    dpr: number;
    zoom: number;
    pan: Pt;
    /** Iso px of a followed character, or null. */
    follow: Pt | null;
    reduced: boolean;
    dt: number;
  },
): { pan: Pt; zoom?: number } {
  const { stack, view, building } = input;
  const centre = stackCentre(stack);
  const frameKey = [building, view.w, view.h, stack.floors.length, stack.cols, stack.depth].join(
    '|',
  );
  if (frameKey !== st.frameKey) {
    st.frameKey = frameKey;
    st.focusKey = input.focusId;
    st.glide = null;
    const box = building ? stack.box : floorBox(stack, input.level);
    const zoom = fitZoom(view, box, input.dpr);
    const pan = panTo(viewTarget(stack, input.level, building, view, zoom), centre, zoom);
    st.wrote = pan;
    return { pan, zoom };
  }
  let pan = input.pan;
  if (input.follow) {
    st.glide = null;
    const target = panTo(input.follow, centre, input.zoom);
    pan = {
      x: pan.x + (target.x - pan.x) * CAMERA_FOLLOW_LERP,
      y: pan.y + (target.y - pan.y) * CAMERA_FOLLOW_LERP,
    };
    st.wrote = pan;
    return { pan };
  }
  if (input.focusId !== st.focusKey) {
    st.focusKey = input.focusId;
    const target = panTo(
      viewTarget(stack, input.level, building, view, input.zoom),
      centre,
      input.zoom,
    );
    if (input.reduced) {
      st.glide = null;
      st.wrote = target;
      return { pan: target };
    }
    st.glide = target;
    st.wrote = pan;
  }
  if (st.glide) {
    if (st.wrote && (pan.x !== st.wrote.x || pan.y !== st.wrote.y))
      st.glide = null; // moved by hand
    else {
      pan = glidePan(pan, st.glide, input.dt);
      if (pan.x === st.glide.x && pan.y === st.glide.y) st.glide = null;
      st.wrote = pan;
    }
  }
  return { pan };
}
