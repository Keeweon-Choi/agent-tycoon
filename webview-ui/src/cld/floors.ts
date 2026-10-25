/**
 * Floors (T-0027). The daemon stacks the building's floors into the one
 * office layout (`cldFloors` in it says which rows are which floor) and sends
 * the floor list (buildingState). This browser draws every floor, with the
 * current one opaque and interactive and the others translucent, unless its
 * per-browser setting selects one floor. Idle characters wander on their own
 * floor; the one-floor view switches with elevator doors.
 *
 * The pure helpers come first (the Node runner tests them), then the store.
 */
import { useSyncExternalStore } from 'react';

import type { BuildingState } from '../../../core/src/messages.js';
import { mapOffset } from '../office/projection.js';
import type { Character } from '../office/types.js';
import { TILE_SIZE } from '../office/types.js';
import type { MapPart } from './camera.js';
import { cldGetSnapshot, virtualAgentId } from './officeStore.js';

/** A floor's rows in the stacked layout (the daemon's `cldFloors`). */
export interface FloorRect {
  id: string;
  row: number;
  rows: number;
  cols: number;
}

/** What shows on another floor's button: the bubble that would be over a character there. */
export type FloorBadge = 'permission' | 'waiting';

/** Door timings: shut, switch behind them, a breath, open. Under 300 ms in all
 *  (240), with room for a busy machine's late timers. */
export const DOOR_CLOSE_MS = 100;
export const DOOR_HOLD_MS = 40;
export const DOOR_OPEN_MS = 100;
/** CSS px a touch must travel along the picker to change floors. */
export const SWIPE_MIN_PX = 24;
/** How often the floor badges are worked out (in game time). */
const BADGE_EVERY_S = 0.25;

// ── Pure ─────────────────────────────────────────────────────

/** The layout's floors, or null for an office of one floor. */
export function floorRects(layout: object): FloorRect[] | null {
  const rects = (layout as { cldFloors?: unknown }).cldFloors;
  return Array.isArray(rects) && rects.length > 1 ? (rects as FloorRect[]) : null;
}

/** The floor shown: `id`'s rect, else floor 1's; null in an office of one floor. */
export function shownRect(layout: object, id: string): FloorRect | null {
  const rects = floorRects(layout);
  return rects ? (rects.find((r) => r.id === id) ?? rects[0]) : null;
}

/** Which floor tile row `row` is on (-1: a gap between floors, or off the map). */
export function floorIndexAt(rects: FloorRect[], row: number): number {
  return rects.findIndex((r) => row >= r.row && row < r.row + r.rows);
}

/** The world-px rows a floor owns: its own, plus one tile above for the wall
 *  tops and heads of its top row (the gap above is void). */
export function floorBand(rect: FloorRect): { top: number; bottom: number } {
  return { top: (rect.row - 1) * TILE_SIZE, bottom: (rect.row + rect.rows) * TILE_SIZE };
}

/** Whether world y (sprite px) is on floor `rect` (always, with no floors). */
export function onFloor(rect: FloorRect | null, worldY: number): boolean {
  if (!rect) return true;
  const { top, bottom } = floorBand(rect);
  return worldY >= top && worldY < bottom;
}

/** World pixels each floor moves in the stacked view, relative to `current`. */
export function stackShifts(rects: FloorRect[], current: number): number[] {
  if (!rects.length) return [];
  const gap = rects.length > 1 ? rects[1].row - rects[0].row - rects[0].rows : 0;
  const absolute = new Array<number>(rects.length);
  let row = rects[0].row;
  for (let k = rects.length - 1; k >= 0; k--) {
    absolute[k] = (row - rects[k].row) * TILE_SIZE;
    row += rects[k].rows + gap;
  }
  return absolute.map((shift) => shift - absolute[current]);
}

/** Rows covered by the displayed stack in the current floor's world rows. */
export function stackSpan(rects: FloorRect[], shifts: number[]): MapPart {
  const row = Math.min(...rects.map((r, i) => r.row + shifts[i] / TILE_SIZE));
  const bottom = Math.max(...rects.map((r, i) => r.row + r.rows + shifts[i] / TILE_SIZE));
  return { row, rows: bottom - row, cols: Math.max(...rects.map((r) => r.cols)) };
}

/** The canvas rect (device px) the shown floor is drawn in, or null to draw it all. */
export function floorClip(
  rect: FloorRect | null,
  map: { cols: number; rows: number },
  canvas: { w: number; h: number },
  zoom: number,
  pan: { x: number; y: number },
): { x: number; y: number; w: number; h: number } | null {
  if (!rect) return null;
  const { offsetX, offsetY } = mapOffset(
    canvas.w,
    canvas.h,
    map.cols,
    map.rows,
    zoom,
    pan.x,
    pan.y,
  );
  const { top, bottom } = floorBand(rect);
  return {
    x: offsetX,
    y: offsetY + top * zoom,
    w: rect.cols * TILE_SIZE * zoom,
    h: (bottom - top) * zoom,
  };
}

/**
 * What the renderer walks each frame (the tile map and the area labels) with
 * every row off the shown floor emptied: drawn off the floor or not, the whole
 * building would cost a draw per tile per frame, and an emptied row costs a
 * comparison per tile. Memoized per map and floor; null rect: as given.
 */
const viewCache = new WeakMap<
  FloorRect,
  {
    tileMap: unknown;
    areaTiles: unknown;
    view: { tileMap: unknown[][]; areaTiles: unknown[] | undefined };
  }
>();
export function floorView<T, A>(
  tileMap: T[][],
  areaTiles: Array<A | null> | undefined,
  rect: FloorRect | null,
  empty: T,
): { tileMap: T[][]; areaTiles: Array<A | null> | undefined } {
  if (!rect) return { tileMap, areaTiles };
  const c = viewCache.get(rect);
  if (c?.tileMap === tileMap && c.areaTiles === areaTiles)
    return c.view as { tileMap: T[][]; areaTiles: Array<A | null> | undefined };
  const cols = tileMap[0]?.length ?? 0;
  const on = (r: number) => r >= rect.row && r < rect.row + rect.rows;
  const blank = new Array<T>(cols).fill(empty);
  const view = {
    tileMap: tileMap.map((row, r) => (on(r) ? row : blank)),
    areaTiles: areaTiles?.map((label, i) => (on(Math.floor(i / cols)) ? label : null)),
  };
  viewCache.set(rect, { tileMap, areaTiles, view });
  return view;
}

/** 1-9 from the digit row by position (AZERTY types `&` there) or from the
 *  numpad while it types digits (NumLock off, its keys are the arrows that
 *  pan); null for anything else and for Ctrl/Meta/Alt chords. 0 resets the
 *  camera (T-0025). */
export function floorKey(e: {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): number | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const m = /^(Digit|Numpad)([1-9])$/.exec(e.code);
  if (!m || (m[1] === 'Numpad' && e.key !== m[2])) return null;
  return Number(m[2]);
}

/** A swipe on the floor picker: up goes a floor up (+1), down a floor down (-1). */
export function swipeStep(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dy) < SWIPE_MIN_PX || Math.abs(dy) <= Math.abs(dx)) return 0;
  return dy < 0 ? 1 : -1;
}

/** One character as the badges see it. */
export interface BadgeInput {
  floor: number;
  /** A permission bubble is up (it stays until answered). */
  permission: boolean;
  /** Blocked on the user right now (AskUserQuestion). */
  blocked: boolean;
  /** When its turn ended while this browser watched (ms), else null. */
  waitingSince: number | null;
}

/**
 * Each floor's badge: 'permission' when someone there waits for an approval,
 * else 'waiting' when someone there asks the user something or finished a
 * turn since the floor was last looked at (`viewedAt`, ms per floor). The
 * floor shown (`current`) has none: its own bubbles are on screen.
 */
export function floorBadges(
  floors: number,
  items: BadgeInput[],
  viewedAt: number[],
  current: number,
): Array<FloorBadge | null> {
  const out = new Array<FloorBadge | null>(floors).fill(null);
  for (const it of items) {
    if (it.floor === current || it.floor < 0 || it.floor >= floors) continue;
    if (it.permission) out[it.floor] = 'permission';
    else if (
      out[it.floor] === null &&
      (it.blocked || (it.waitingSince !== null && it.waitingSince > (viewedAt[it.floor] ?? 0)))
    )
      out[it.floor] = 'waiting';
  }
  return out;
}

// ── Store ────────────────────────────────────────────────────

export interface Doors {
  phase: 'closing' | 'opening';
  /** The floor the doors open on. */
  target: string;
  /** Up (1) or down (-1), for the display's arrow. */
  dir: 1 | -1;
  seq: number;
}

export interface FloorSnapshot {
  building: BuildingState | null;
  /** The floor this browser shows (a floor id). */
  current: string;
  /** This browser draws every floor. */
  stacked: boolean;
  doors: Doors | null;
  /** Floor id -> its badge. */
  badges: Record<string, FloorBadge>;
  /** A character dragged off the canvas, for the floor buttons to take. */
  dragging: { id: number; name: string } | null;
  /** The floor editor is open (desktop). */
  editing: boolean;
}

const FLOOR_KEY = 'cld.floor';
const FLOOR_VIEW_KEY = 'cld.floor-view';
const storedStacked = (): boolean => {
  try {
    return localStorage.getItem(FLOOR_VIEW_KEY) !== 'one';
  } catch {
    return true;
  }
};
const storedFloor = (): string => {
  try {
    return localStorage.getItem(FLOOR_KEY) ?? '1';
  } catch {
    return '1';
  }
};
const storeFloor = (id: string) => {
  try {
    localStorage.setItem(FLOOR_KEY, id);
  } catch {
    // Private browsing or a locked-down webview: this tab still remembers it.
  }
};

let snap: FloorSnapshot = {
  building: null,
  current: storedFloor(),
  stacked: storedStacked(),
  doors: null,
  badges: {},
  dragging: null,
  editing: false,
};
const listeners = new Set<() => void>();
const set = (next: Partial<FloorSnapshot>) => {
  snap = { ...snap, ...next };
  listeners.forEach((l) => l());
};
export const floorsSubscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const floorsSnapshot = () => snap;
export const useFloors = () => useSyncExternalStore(floorsSubscribe, floorsSnapshot);

export function setStackedView(on: boolean): void {
  set({ stacked: on, doors: null });
  if (doorTimer) clearTimeout(doorTimer);
  doorTimer = null;
  queued = null;
  try {
    localStorage.setItem(FLOOR_VIEW_KEY, on ? 'all' : 'one');
  } catch {
    // Keep the in-memory choice when storage is unavailable.
  }
}

/** The floor shown, in a layout (null: one floor, draw it all). */
export const currentRect = (layout: object): FloorRect | null => shownRect(layout, snap.current);

/** World-pixel vertical shift for a drawn point, or null when it is hidden. */
export function drawnShift(layout: object, worldY: number): number | null {
  const rect = currentRect(layout);
  if (onFloor(rect, worldY)) return 0;
  if (!snap.stacked) return null;
  const rects = floorRects(layout);
  if (!rects || !rect) return null;
  const k = rects.findIndex((r) => onFloor(r, worldY));
  return k < 0 ? null : stackShifts(rects, rects.indexOf(rect))[k];
}

/** Another displayed floor under a point in the current floor's world space. */
export function stackedFloorAt(layout: object, worldX: number, worldY: number): string | null {
  if (!snap.stacked) return null;
  const rects = floorRects(layout);
  const rect = currentRect(layout);
  if (!rects || !rect) return null;
  const current = rects.indexOf(rect);
  const shifts = stackShifts(rects, current);
  const k = rects.findIndex(
    (r, i) =>
      i !== current && worldX >= 0 && worldX < r.cols * TILE_SIZE && onFloor(r, worldY - shifts[i]),
  );
  return k < 0 ? null : rects[k].id;
}

/** Camera bounds for the whole stack, or only the floor shown. */
export function cameraRect(layout: object): MapPart | null {
  const rect = currentRect(layout);
  const rects = floorRects(layout);
  return snap.stacked && rects && rect
    ? stackSpan(rects, stackShifts(rects, rects.indexOf(rect)))
    : rect;
}

/** buildingState: the floor shown stays, unless it is gone (then floor 1). */
export function floorsHandleMessage(msg: BuildingState): void {
  // An `error` is the toast's (officeStore), not part of the building.
  const building: BuildingState = {
    type: msg.type,
    floors: msg.floors,
    perProject: msg.perProject,
    ...(msg.decor && { decor: msg.decor }),
  };
  const known = building.floors.some((f) => f.id === snap.current);
  set({ building, current: known ? snap.current : (building.floors[0]?.id ?? '1') });
}

let doorTimer: ReturnType<typeof setTimeout> | null = null;
let queued: string | null = null;
let doorSeq = 0;
export const reducedMotion = () =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Go to floor `id`: the doors shut, the floor changes behind them, they open. */
export function goToFloor(id: string): void {
  const floors = snap.building?.floors ?? [];
  if (!floors.some((f) => f.id === id)) return;
  if (snap.doors?.phase === 'closing') {
    set({ doors: { ...snap.doors, target: id } }); // still shutting: open on this one
    return;
  }
  if (snap.doors) {
    queued = id; // opening: go on once they are open
    return;
  }
  if (id === snap.current) return;
  storeFloor(id);
  if (reducedMotion() || snap.stacked) {
    set({ current: id });
    return;
  }
  const index = (f: string) => floors.findIndex((x) => x.id === f);
  const dir = index(id) > index(snap.current) ? 1 : -1;
  set({ doors: { phase: 'closing', target: id, dir, seq: ++doorSeq } });
  doorTimer = setTimeout(() => {
    const doors = snap.doors!;
    storeFloor(doors.target);
    set({ current: doors.target, doors: { ...doors, phase: 'opening' } });
    doorTimer = setTimeout(() => {
      doorTimer = null;
      set({ doors: null });
      const next = queued;
      queued = null;
      if (next) goToFloor(next);
    }, DOOR_HOLD_MS + DOOR_OPEN_MS);
  }, DOOR_CLOSE_MS);
}

/** The floor `step` floors up (+) or down (-) from the one shown. */
export function stepFloor(step: number): void {
  const floors = snap.building?.floors ?? [];
  const k = floors.findIndex((f) => f.id === (snap.doors?.target ?? snap.current));
  const next = floors[Math.max(0, Math.min(floors.length - 1, k + step))];
  if (next) goToFloor(next.id);
}

export const setFloorEditing = (editing: boolean) => set({ editing });

/** The name character `id` goes by in the building when this client may put
 *  it on another floor (a project's), else null. */
export function floorMovable(id: number): string | null {
  const { officeSnapshot: officeState, officeReadOnly } = cldGetSnapshot();
  if (!officeState || officeReadOnly || (snap.building?.floors.length ?? 0) < 2) return null;
  const orch = officeState.orchestrators.find(
    (o) => (o.agentId ?? virtualAgentId(`orch:${o.name}`)) === id,
  );
  return orch ? orch.name : null;
}

/** A character pressed on the canvas and dragged: the floor buttons can take it. */
export function startFloorDrag(id: number): void {
  const name = floorMovable(id);
  if (name && snap.dragging?.id !== id) set({ dragging: { id, name } });
}
export function endFloorDrag(): void {
  if (snap.dragging) set({ dragging: null });
}

// ── Per frame (the game loop calls it) ──────────────────────

/** Characters seen working since this page loaded: only their turn's end is news. */
const seenActive = new Set<number>();
const waitingSince = new Map<number, number>();
const viewedAt = new Map<string, number>();
let sinceBadges = BADGE_EVERY_S;

/** Track turn ends and work out the floor badges (a few times a second). */
export function sampleFloors(
  officeCharacters: Iterable<Character>,
  layout: object,
  dt: number,
  now = Date.now(),
): void {
  sinceBadges += dt;
  if (sinceBadges < BADGE_EVERY_S) return;
  sinceBadges = 0;
  const rects = floorRects(layout);
  if (!rects || !snap.building) {
    if (Object.keys(snap.badges).length) set({ badges: {} });
    return;
  }
  const current = rects.findIndex((r) => r.id === snap.current);
  viewedAt.set(rects[Math.max(0, current)].id, now);
  const items: BadgeInput[] = [];
  for (const ch of officeCharacters) {
    if (ch.isActive) {
      seenActive.add(ch.id);
      waitingSince.delete(ch.id);
    } else if (ch.bubbleType === 'waiting' && seenActive.delete(ch.id)) {
      waitingSince.set(ch.id, now);
    }
    items.push({
      floor: floorIndexAt(rects, ch.tileRow),
      permission: ch.bubbleType === 'permission',
      blocked: ch.isActive && ch.currentTool === 'AskUserQuestion',
      waitingSince: waitingSince.get(ch.id) ?? null,
    });
  }
  const list = floorBadges(
    rects.length,
    items,
    rects.map((r) => viewedAt.get(r.id) ?? 0),
    Math.max(0, current),
  );
  const badges: Record<string, FloorBadge> = {};
  list.forEach((b, k) => {
    if (b) badges[rects[k].id] = b;
  });
  if (JSON.stringify(badges) !== JSON.stringify(snap.badges)) set({ badges });
}

/** Idle characters wander on their own floor (a tile elsewhere has no path). */
let wanderCache: {
  tiles: Array<{ col: number; row: number }>;
  rects: FloorRect[];
  byFloor: Array<Array<{ col: number; row: number }>>;
} | null = null;
export function wanderTiles(
  walkable: Array<{ col: number; row: number }>,
  layout: object,
  ch: Character,
): Array<{ col: number; row: number }> {
  const rects = floorRects(layout);
  if (!rects) return walkable;
  if (wanderCache?.tiles !== walkable || wanderCache.rects !== rects) {
    wanderCache = {
      tiles: walkable,
      rects,
      byFloor: rects.map((r) => walkable.filter((t) => t.row >= r.row && t.row < r.row + r.rows)),
    };
  }
  const k = floorIndexAt(rects, ch.tileRow);
  return k >= 0 ? wanderCache.byFloor[k] : walkable;
}

/** Test helper. */
export function floorsResetForTests(): void {
  if (doorTimer) clearTimeout(doorTimer);
  doorTimer = null;
  queued = null;
  seenActive.clear();
  waitingSince.clear();
  viewedAt.clear();
  sinceBadges = BADGE_EVERY_S;
  snap = {
    building: null,
    current: '1',
    stacked: true,
    doors: null,
    badges: {},
    dragging: null,
    editing: false,
  };
}
