/**
 * ISO-PILOT camera: what the isometric building is framed on. Two views (the floor panel's
 * one toggle, the floors store's `stacked`): the whole building, or the floor in focus. A
 * new focus glides the camera to that floor (at once with reduced motion); a follow keeps a
 * character in the middle; a manual pan or zoom is left alone until the next focus change.
 * Pure but for its small state object (the Node runner tests it).
 */
import {
  CAMERA_FOLLOW_LERP,
  ISO_FRAME_MARGIN,
  ISO_SLAB_H,
  ISO_WALL_H,
  PHONE_ISO_SETTLE_S,
  PHONE_ISO_ZOOM_MAX,
  PHONE_ISO_ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_MIN,
} from '../../constants.js';
import { glidePan, initialCameraFit } from '../camera.js';
import { floorBox, isoAt, type IsoStack, panTo, type Pt } from './projection.js';

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

/** PHONE-ZOOM: the zoom a phone frames `box` at: the fit, but never farther than a character
 *  stays readable (the box then overflows and is panned) nor closer than one small room. */
export const phoneFitZoom = (view: { w: number; h: number }, box: Box, dpr = 1): number =>
  Math.max(PHONE_ISO_ZOOM_MIN, Math.min(PHONE_ISO_ZOOM_MAX, fitZoom(view, box, dpr)));

/**
 * PHONE-ZOOM: the iso bounds of the rooms (area labels) of floor `level` that hold an
 * occupant; when none does, of every room on the floor; null when the floor has no rooms.
 */
export function occupiedRoomsBox(
  stack: IsoStack,
  level: number,
  layout: { cols: number; areaTiles?: ReadonlyArray<string | null> },
  occupants: ReadonlyArray<{ tileCol: number; tileRow: number }>,
): Box | null {
  const floor = stack.floors[level];
  const tiles = layout.areaTiles;
  if (!floor || !tiles) return null;
  const at = (c: number, r: number) => tiles[(floor.row + r) * layout.cols + c] ?? null;
  const used = new Set<string>();
  for (const o of occupants) {
    const label = at(o.tileCol, o.tileRow - floor.row);
    if (label !== null && o.tileRow >= floor.row && o.tileRow < floor.row + floor.rows)
      used.add(label);
  }
  let [c0, r0, c1, r1] = [Infinity, Infinity, -1, -1];
  for (let r = 0; r < floor.rows; r++)
    for (let c = 0; c < layout.cols; c++) {
      const label = at(c, r);
      if (label === null || (used.size > 0 && !used.has(label))) continue;
      [c0, r0, c1, r1] = [Math.min(c0, c), Math.min(r0, r), Math.max(c1, c), Math.max(r1, r)];
    }
  if (c1 < 0) return null;
  const p = (col: number, row: number) => isoAt(col, row, level, stack.lifts);
  return {
    x0: p(c0, r1 + 1).x,
    x1: p(c1 + 1, r0).x,
    y0: p(c0, r0).y - ISO_WALL_H,
    y1: p(c1 + 1, r1 + 1).y + ISO_SLAB_H,
  };
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

const boxMid = (b: Box): Pt => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });

export interface IsoCamState {
  /** What the view was last framed for. */
  frameKey: string | null;
  focusKey: string | null;
  glide: Pt | null;
  /** The last frame was the phone's (the floor's occupied rooms), not the building or the slab. */
  phoneFit: boolean;
  /** Whether the building view was on at the last frame (a toggle is a new ask). */
  building: boolean | null;
  /** Seconds left in which the phone framing follows the agents as they arrive. */
  settle: number;
  /** The pan the glide last wrote (another one means the user moved the camera). */
  wrote: Pt | null;
}
export const newIsoCam = (): IsoCamState => ({
  frameKey: null,
  focusKey: null,
  glide: null,
  phoneFit: false,
  building: null,
  settle: 0,
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
    /** The phone shell starts close to the current floor, not the whole building. */
    phone?: boolean;
    /** Phone: the iso bounds of the focus floor's occupied rooms (see occupiedRoomsBox). */
    phoneBox?: () => Box | null;
    /** A drag, pinch, wheel, or saved camera owns its zoom and pan. */
    manual?: boolean;
  },
): { pan: Pt; zoom?: number } {
  const { stack, view, building } = input;
  const centre = stackCentre(stack);
  const frameKey = [
    building,
    view.w,
    view.h,
    stack.floors.length,
    stack.cols,
    stack.depth,
    stack.lifts.join(','),
  ].join('|');
  if (frameKey !== st.frameKey) {
    const firstFit = st.frameKey === null;
    // A phone opens on the floor; a later view toggle (or a resize) keeps what was asked for.
    const phoneFit =
      input.phone === true &&
      (firstFit ? true : st.building !== building ? !building : st.phoneFit);
    st.frameKey = frameKey;
    st.focusKey = input.focusId;
    st.glide = null;
    st.building = building;
    st.phoneFit = phoneFit;
    st.settle = phoneFit && !input.manual ? PHONE_ISO_SETTLE_S : 0;
    const floor = floorBox(stack, input.level);
    const rooms = phoneFit ? (input.phoneBox?.() ?? floor) : floor;
    const desktopBox = building ? stack.box : floor;
    const fit = initialCameraFit({
      phone: phoneFit,
      desktop: { box: desktopBox, zoom: fitZoom(view, desktopBox, input.dpr) },
      phoneTarget: { box: rooms, zoom: phoneFitZoom(view, rooms, input.dpr) },
      ...(input.manual && { storedZoom: input.zoom }),
    });
    if (input.manual) {
      st.wrote = null;
      return { pan: input.pan };
    }
    const pan = panTo(
      fit.phoneTarget ? boxMid(fit.box) : viewTarget(stack, input.level, building, view, fit.zoom),
      centre,
      fit.zoom,
    );
    st.wrote = pan;
    return { pan, zoom: fit.zoom };
  }
  let pan = input.pan;
  if (st.settle > 0) {
    // The agents arrive after the first frame: until the user touches the camera, or the phone
    // has had PHONE_ISO_SETTLE_S, the framing follows the rooms they sit in.
    st.settle = input.manual || input.focusId !== st.focusKey ? 0 : st.settle - input.dt;
    const rooms = input.phoneBox?.();
    if (rooms && st.settle > 0 && !input.follow) {
      const zoom = phoneFitZoom(view, rooms, input.dpr);
      const next = panTo(boxMid(rooms), centre, zoom);
      st.wrote = next;
      return { pan: next, ...(zoom !== input.zoom && { zoom }) };
    }
  }
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
    const rooms = st.phoneFit ? input.phoneBox?.() : null;
    const target = panTo(
      rooms ? boxMid(rooms) : viewTarget(stack, input.level, building, view, input.zoom),
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
