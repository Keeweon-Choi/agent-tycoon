/**
 * T-0077: where the floating icons, widgets and windows sit, and how that is
 * remembered. DOM-free (like components/cardBar.ts): the components measure,
 * these functions decide.
 *
 * A thing's place is stored against the NEAREST screen corner: the distance
 * from that corner of the viewport to the same corner of the thing. After a
 * resize or a phone rotation a thing near the right edge stays near the right
 * edge, and anything that would leave the screen is pulled back inside.
 */

import { TERMINAL_SIDEBAR_WIDTH_PX } from '../../constants.js';

export type Corner = 'tl' | 'tr' | 'bl' | 'br';
export interface Size {
  w: number;
  h: number;
}
export interface Rect extends Size {
  x: number;
  y: number;
}
/** `w`/`h` only for windows (resizable); icons and widgets keep their own size. */
export interface Place {
  corner: Corner;
  dx: number;
  dy: number;
  w?: number;
  h?: number;
}

/** 작게 / 보통 / 크게. */
export type ScaleStep = 0 | 1 | 2;
export const SCALE_FACTORS: readonly number[] = [0.75, 1, 1.5];
export const SCALE_LABELS: readonly string[] = ['hud.small', 'hud.medium', 'hud.large'];
export const DEFAULT_SCALE: ScaleStep = 1;

export interface Entry {
  place?: Place;
  scale?: ScaleStep;
  /** A window filling the office area; `place` stays the rect it returns to. */
  max?: boolean;
}
export interface Layout {
  v: 1;
  items: Record<string, Entry>;
  /** The preset these places came from (U-29): a saved layout without one is an old free placement and is ignored. */
  preset?: Preset;
}

/**
 * U-29: the default UI stays fixed except the layout presets. Free dragging, resizing and the
 * size menu of icons and widgets are off for the MVP (post-MVP); the code stays, unreachable
 * from the UI, behind this one switch. The windows are the exception (U-38, below).
 */
export const FREE_PLACEMENT = false;

/**
 * U-38: the windows that may be moved and resized again. Whatever the place, `clampRect`
 * keeps the whole window inside the room (so its title bar and its _ / □ / × always are),
 * on a drag, a resize, a smaller browser window and a saved place loaded from storage.
 */
const FREE_WINDOWS: ReadonlySet<string> = new Set<WindowId>([
  'messenger',
  'terminal',
  'office',
  'notices',
  'workbench',
  'looks',
]);
export const windowIsFree = (id: string): boolean => FREE_WINDOWS.has(id);

/** The one localStorage key; the version rides in the name and in the value. */
export const LAYOUT_KEY = 'cld.hud.layout.v1';
const LEGACY_OFFICE_ID = 'h' + 'ub';
const renameSavedWindowId = (text: string) =>
  text.replace(new RegExp(`(?<![A-Za-z])${LEGACY_OFFICE_ID}`, 'gi'), 'office');

/** Rewrite old window ids anywhere in the saved HUD value, keeping an existing office entry. */
export function migrateSavedWindowIds(value: unknown): unknown {
  if (typeof value === 'string') return renameSavedWindowId(value);
  if (Array.isArray(value)) return value.map(migrateSavedWindowIds);
  if (typeof value !== 'object' || value === null) return value;
  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  // Insert current names first, so a saved office value always wins a legacy collision.
  for (const [key, entry] of Object.entries(source))
    if (renameSavedWindowId(key) === key) result[key] = migrateSavedWindowIds(entry);
  for (const [key, entry] of Object.entries(source))
    if (renameSavedWindowId(key) !== key) {
      const current = renameSavedWindowId(key);
      if (!Object.hasOwn(result, current)) result[current] = migrateSavedWindowIds(entry);
    }
  return result;
}
/** A mouse press moves the thing only after it travelled this far: a click stays a click. */
export const DRAG_THRESHOLD_PX = 6;
/** A window never gets smaller than this (when the viewport has room). */
export const WINDOW_MIN: Size = { w: 280, h: 180 };
/** Gap between a window or the icon column and the viewport edge. */
export const EDGE_GAP_PX = 8;
/** A default window keeps these gaps to the top and bottom edges (a tall list wants every pixel). */
const BOTTOM_GAP_PX = 4;
const TOP_GAP_PX = 4;
/** The desktop's agent card bar floats over the office's right edge: the HUD keeps clear of it. */
export const RAIL_PX = TERMINAL_SIDEBAR_WIDTH_PX;
const MAX_ENTRIES = 32;
const MAX_COORD = 100_000;

export const exceedsDragThreshold = (dx: number, dy: number, threshold = DRAG_THRESHOLD_PX) =>
  Math.hypot(dx, dy) > threshold;

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));

/** The corner of `bounds` nearest to the middle of `rect`. */
export function nearestCorner(rect: Rect, bounds: Size): Corner {
  const right = rect.x + rect.w / 2 > bounds.w / 2;
  const bottom = rect.y + rect.h / 2 > bounds.h / 2;
  return `${bottom ? 'b' : 't'}${right ? 'r' : 'l'}`;
}

/** Store `rect` against its nearest corner. `withSize` keeps w/h (windows). */
export function placeFromRect(rect: Rect, bounds: Size, withSize = false): Place {
  const corner = nearestCorner(rect, bounds);
  const place: Place = {
    corner,
    dx: Math.round(corner[1] === 'r' ? bounds.w - rect.x - rect.w : rect.x),
    dy: Math.round(corner[0] === 'b' ? bounds.h - rect.y - rect.h : rect.y),
  };
  if (withSize) {
    place.w = Math.round(rect.w);
    place.h = Math.round(rect.h);
  }
  return place;
}

/** The rectangle a place makes in `bounds` for a thing of `size` (a place's own w/h win). */
export function rectFromPlace(place: Place, size: Size, bounds: Size): Rect {
  const w = place.w ?? size.w;
  const h = place.h ?? size.h;
  return {
    x: place.corner[1] === 'r' ? bounds.w - place.dx - w : place.dx,
    y: place.corner[0] === 'b' ? bounds.h - place.dy - h : place.dy,
    w,
    h,
  };
}

/** A size inside `bounds`: at least `min`, at most the bounds (the bounds win when smaller than `min`). */
export function clampSize(size: Size, bounds: Size, min: Size = { w: 0, h: 0 }): Size {
  return {
    w: Math.min(Math.max(size.w, min.w), bounds.w),
    h: Math.min(Math.max(size.h, min.h), bounds.h),
  };
}

/** Pull `rect` inside `bounds` (shrinking it first when it is bigger than the room). */
export function clampRect(rect: Rect, bounds: Size, min?: Size): Rect {
  const { w, h } = clampSize(rect, bounds, min);
  return { x: clamp(rect.x, 0, bounds.w - w), y: clamp(rect.y, 0, bounds.h - h), w, h };
}

/**
 * A stored place made safe for the current viewport: same corner, offsets and size pulled inside.
 * `room` (default `bounds`) is the part of the bounds the rect may fill; offsets stay measured
 * against `bounds`.
 */
export function clampPlace(
  place: Place,
  size: Size,
  bounds: Size,
  min?: Size,
  room: Size = bounds,
): Place {
  const rect = clampRect(rectFromPlace(place, size, bounds), room, min);
  const out: Place = {
    corner: place.corner, // a rotation must not flip a thing to the other side
    dx: Math.round(place.corner[1] === 'r' ? bounds.w - rect.x - rect.w : rect.x),
    dy: Math.round(place.corner[0] === 'b' ? bounds.h - rect.y - rect.h : rect.y),
  };
  if (place.w !== undefined) out.w = Math.round(rect.w);
  if (place.h !== undefined) out.h = Math.round(rect.h);
  return out;
}

/** CSS offsets of a place: the two sides of its corner. */
export function cssAnchor(place: Place): {
  left?: number;
  right?: number;
  top?: number;
  bottom?: number;
  width?: number;
  height?: number;
} {
  return {
    ...(place.corner[1] === 'r' ? { right: place.dx } : { left: place.dx }),
    ...(place.corner[0] === 'b' ? { bottom: place.dy } : { top: place.dy }),
    ...(place.w !== undefined && { width: place.w }),
    ...(place.h !== undefined && { height: place.h }),
  };
}

/** `rect` moved by (dx, dy), kept on screen. */
export const moveRect = (rect: Rect, dx: number, dy: number, bounds: Size): Rect =>
  clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, bounds);

/** Which sides a resize handle drags: 'e' the right edge, 'se' the bottom-right corner, … */
export type Handle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export const HANDLES: readonly Handle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/** `rect` resized by dragging `handle` by (dx, dy): the opposite side stays, the minimum size and the screen hold. */
export function resizeRect(
  rect: Rect,
  handle: Handle,
  dx: number,
  dy: number,
  bounds: Size,
  min: Size = WINDOW_MIN,
): Rect {
  const lo = { w: Math.min(min.w, bounds.w), h: Math.min(min.h, bounds.h) };
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;
  if (handle.includes('e')) right = clamp(right + dx, left + lo.w, bounds.w);
  if (handle.includes('w')) left = clamp(left + dx, 0, right - lo.w);
  if (handle.includes('s')) bottom = clamp(bottom + dy, top + lo.h, bounds.h);
  if (handle.includes('n')) top = clamp(top + dy, 0, bottom - lo.h);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// ── Grid and edge snapping (T-0111) ───────────────────────────

/** Moving and resizing land on this grid (px, from the top-left of the room). */
export const GRID_PX = 8;
/** An edge within this distance of the screen's or another window's edge sticks to it. */
export const SNAP_EDGE_PX = 12;

export const snapToGrid = (n: number, grid = GRID_PX) => Math.round(n / grid) * grid;

/** How far to shift to put one of `edges` on one of `targets` (within SNAP_EDGE_PX), or null. */
function edgeShift(edges: number[], targets: number[]): number | null {
  let best: number | null = null;
  for (const e of edges)
    for (const t of targets) {
      const d = t - e;
      if (Math.abs(d) <= SNAP_EDGE_PX && (best === null || Math.abs(d) < Math.abs(best))) best = d;
    }
  return best;
}

/** The edge positions `rect`s and the room offer to stick to: [x targets, y targets]. */
function edgeTargets(bounds: Size, others: readonly Rect[]): [number[], number[]] {
  return [
    [0, bounds.w, ...others.flatMap((o) => [o.x, o.x + o.w])],
    [0, bounds.h, ...others.flatMap((o) => [o.y, o.y + o.h])],
  ];
}

/** One edge at `v`: stuck to a nearby target, otherwise on the grid. */
const snapEdge = (v: number, targets: number[]) =>
  v + (edgeShift([v], targets) ?? snapToGrid(v) - v);

/**
 * `rect` (already moved) snapped: an edge within SNAP_EDGE_PX of the room's or of
 * `others`' edges sticks to it, else the top-left lands on the grid. Kept on screen.
 */
export function snapMoveRect(rect: Rect, bounds: Size, others: readonly Rect[] = []): Rect {
  const [xt, yt] = edgeTargets(bounds, others);
  const dx = edgeShift([rect.x, rect.x + rect.w], xt) ?? snapToGrid(rect.x) - rect.x;
  const dy = edgeShift([rect.y, rect.y + rect.h], yt) ?? snapToGrid(rect.y) - rect.y;
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, bounds);
}

/**
 * `rect` (already resized by `handle`) with the edges the handle moves snapped the same way.
 * The minimum size wins over the grid.
 */
export function snapResizeRect(
  rect: Rect,
  handle: Handle,
  bounds: Size,
  others: readonly Rect[] = [],
  min: Size = WINDOW_MIN,
): Rect {
  const [xt, yt] = edgeTargets(bounds, others);
  const lo = { w: Math.min(min.w, bounds.w), h: Math.min(min.h, bounds.h) };
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.w;
  let bottom = rect.y + rect.h;
  if (handle.includes('e')) right = clamp(snapEdge(right, xt), left + lo.w, bounds.w);
  if (handle.includes('w')) left = clamp(snapEdge(left, xt), 0, right - lo.w);
  if (handle.includes('s')) bottom = clamp(snapEdge(bottom, yt), top + lo.h, bounds.h);
  if (handle.includes('n')) top = clamp(snapEdge(top, yt), 0, bottom - lo.h);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

// ── Defaults ──────────────────────────────────────────────────

export type WindowId = 'office' | 'messenger' | 'notices' | 'terminal' | 'workbench' | 'looks';
/** Icon column: one icon (40 px at 보통) plus its gap, so a window opens beside it. */
export const ICON_COLUMN_PX = 56;

const DEFAULT_WIDTH: Record<WindowId, number> = {
  office: 360,
  messenger: 680,
  notices: 420,
  terminal: 900,
  workbench: 560,
  looks: 480, // the pixel editor: a 192 px canvas and its 224 px tool column side by side
};
/** The 파일 tab is a two-pane explorer: it opens wide. */
export const WIDE_OFFICE_WIDTH = 1050;

/** Each window opens this far down-left of the one before it, so they do not hide each other's title bars. */
export const CASCADE_PX = 28;
const CASCADE_ORDER: readonly WindowId[] = [
  'office',
  'messenger',
  'notices',
  'terminal',
  'workbench',
  'looks',
];

/** Where a window opens before the user moved it: tall, against the right edge beside the icon column. */
export function defaultWindowPlace(id: WindowId, bounds: Size, wide = false): Place {
  const want = id === 'office' && wide ? WIDE_OFFICE_WIDTH : DEFAULT_WIDTH[id];
  const w = Math.min(want, Math.round(bounds.w * (wide || id === 'terminal' ? 0.85 : 0.7)));
  const step = CASCADE_ORDER.indexOf(id) * CASCADE_PX;
  const dy = TOP_GAP_PX + step;
  return {
    corner: 'tr',
    dx: RAIL_PX + ICON_COLUMN_PX + EDGE_GAP_PX + step,
    dy,
    w,
    h: Math.max(0, bounds.h - dy - BOTTOM_GAP_PX),
  };
}

/**
 * WINDOW-LAYERS (owner 10-25): a free window may be anywhere in the HUD room, which is the whole
 * area under the top bar (the room's top is the bar's bottom edge, so no window ever reaches the
 * bar; nothing at the bottom is reserved either). The card bar, the icon dock and the elevator
 * panel draw OVER normal windows and a window may go under any of them. The one guard,
 * `keepTitleGrabbable`: some part of its title bar always stays out from under them.
 */
export const TITLE_BAR_PX = 40;
/** At least this much of a title bar's width stays free of the fixed panels (so it can be grabbed). */
export const TITLE_GRAB_PX = 48;

/** The widest stretch of `rect`'s title bar that no panel covers (px). */
function freeTitleWidth(rect: Rect, panels: readonly Rect[]): number {
  const left = rect.x;
  const right = rect.x + rect.w;
  const covers = panels
    .filter((p) => p.y < rect.y + TITLE_BAR_PX && p.y + p.h > rect.y)
    .map((p) => [Math.max(left, p.x), Math.min(right, p.x + p.w)] as const)
    .filter(([a, b]) => a < b)
    .sort((m, n) => m[0] - n[0]);
  let best = 0;
  let at = left;
  for (const [a, b] of covers) {
    best = Math.max(best, a - at);
    at = Math.max(at, b);
  }
  return Math.max(best, right - at);
}

/**
 * `rect`, moved sideways to the nearest place where at least TITLE_GRAB_PX of its title bar is free of
 * `panels` (a window may sit under any panel; it just may not hide its whole title bar). Unchanged when
 * it already is, or when no such place exists.
 */
export function keepTitleGrabbable(rect: Rect, panels: readonly Rect[], room: Size): Rect {
  const need = Math.min(TITLE_GRAB_PX, rect.w);
  if (freeTitleWidth(rect, panels) >= need) return rect;
  const lo = 0;
  const hi = Math.max(0, room.w - rect.w);
  const candidates = panels.flatMap((p) => [p.x - need, p.x + p.w + need - rect.w]);
  const best = candidates
    .map((x) => clamp(x, lo, hi))
    .filter((x) => freeTitleWidth({ ...rect, x }, panels) >= need)
    .sort((m, n) => Math.abs(m - rect.x) - Math.abs(n - rect.x))[0];
  return best === undefined ? rect : { ...rect, x: best };
}

// ── Maximize (T-0111) ─────────────────────────────────────────

/** The strip along the bottom edge: windows live above it, the 아래 가로 icon row sits in it. */
export const ICON_ROW_PX = 48;

/** Where a maximized window sits: the whole room, right under the top bar, in front of the panels. */
export const maximizedPlace = (bounds: Size): Place => ({
  corner: 'tl',
  dx: 0,
  dy: 0,
  w: bounds.w,
  h: bounds.h,
});

// ── Presets (T-0111) ──────────────────────────────────────────

export type Preset = 'right' | 'bottom' | 'work';
export const PRESETS: readonly { id: Preset }[] = [
  { id: 'right' },
  { id: 'bottom' },
  { id: 'work' },
];

/** A square icon button at 보통, and the gap between two. */
export const ICON_PX = 40;
const ICON_GAP_PX = 8;

export interface PresetResult {
  layout: Layout;
  /** Windows the preset opens or closes; the others stay as they are. */
  open: Partial<Record<WindowId, boolean>>;
}

/**
 * The layout `preset` says: every icon and window put where it says, nothing else placed. `bounds` is the HUD layer, `icons` the ids of the icons that exist, in order.
 */
export function applyPreset(
  _layout: Layout,
  preset: Preset,
  bounds: Size,
  icons: readonly string[],
): PresetResult {
  // U-29: only the preset's own places remain; an old free placement of any widget goes.
  const items: Record<string, Entry> = {};
  const open: PresetResult['open'] = {};
  if (preset === 'bottom') {
    const row = icons.length * ICON_PX + Math.max(0, icons.length - 1) * ICON_GAP_PX;
    const x0 = snapToGrid((bounds.w - row) / 2);
    icons.forEach((id, i) => {
      items[`icon:${id}`] = {
        place: {
          corner: 'bl',
          dx: x0 + i * (ICON_PX + ICON_GAP_PX),
          dy: (ICON_ROW_PX - ICON_PX) / 2,
        },
      };
    });
  } else if (preset === 'work') {
    const room = Math.max(0, bounds.w - RAIL_PX - ICON_COLUMN_PX - EDGE_GAP_PX);
    const h = Math.max(0, bounds.h - ICON_ROW_PX - 2 * EDGE_GAP_PX);
    items.messenger = {
      place: {
        corner: 'tl',
        dx: EDGE_GAP_PX,
        dy: EDGE_GAP_PX,
        w: snapToGrid(room / 3) - EDGE_GAP_PX,
        h,
      },
    };
    items.terminal = {
      place: {
        corner: 'tr',
        dx: RAIL_PX + ICON_COLUMN_PX + EDGE_GAP_PX,
        dy: EDGE_GAP_PX,
        w: snapToGrid(room / 2),
        h,
      },
    };
    open.office = false;
    if (icons.includes('messenger')) open.messenger = true;
    if (icons.includes('terminal')) open.terminal = true;
  }
  return { layout: { v: 1, items, preset }, open };
}

/** Icons added after layouts were saved (owner 10-24: 파일). */
export const NEW_ICONS: readonly string[] = ['files', 'workbench'];

/**
 * A saved 아래 가로 row predates `ids`: each missing one takes the next slot after the
 * row's last icon. Elsewhere (오른쪽 세로, no preset) an unplaced icon already flows in
 * the column, its default place, so nothing changes.
 */
export function withNewIcons(layout: Layout, ids: readonly string[] = NEW_ICONS): Layout {
  if (layout.preset !== 'bottom') return layout;
  const row = Object.entries(layout.items)
    .filter(([id, e]) => id.startsWith('icon:') && e.place?.corner === 'bl')
    .map(([, e]) => e.place!);
  if (!row.length) return layout;
  let dx = Math.max(...row.map((p) => p.dx));
  const items = { ...layout.items };
  for (const id of ids) {
    if (items[`icon:${id}`]) continue;
    dx += ICON_PX + ICON_GAP_PX;
    items[`icon:${id}`] = { place: { corner: 'bl', dx, dy: row[0].dy } };
  }
  return { ...layout, items };
}

// ── Persistence ───────────────────────────────────────────────

export const emptyLayout = (): Layout => ({ v: 1, items: {} });

const isNum = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const isCorner = (v: unknown): v is Corner => v === 'tl' || v === 'tr' || v === 'bl' || v === 'br';

function parseEntry(raw: unknown): Entry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { place, scale, max } = raw as { place?: unknown; scale?: unknown; max?: unknown };
  const entry: Entry = {};
  if (typeof place === 'object' && place !== null) {
    const p = place as Record<string, unknown>;
    if (
      isCorner(p.corner) &&
      isNum(p.dx, -MAX_COORD, MAX_COORD) &&
      isNum(p.dy, -MAX_COORD, MAX_COORD)
    ) {
      entry.place = { corner: p.corner, dx: p.dx, dy: p.dy };
      if (isNum(p.w, 1, MAX_COORD)) entry.place.w = p.w;
      if (isNum(p.h, 1, MAX_COORD)) entry.place.h = p.h;
    }
  }
  if (scale === 0 || scale === 1 || scale === 2) entry.scale = scale;
  if (max === true) entry.max = true;
  return entry.place || entry.scale !== undefined || entry.max ? entry : null;
}

/** The stored layout, or the defaults (nothing stored) when the value is missing or broken. A bad entry is dropped, the rest stays. */
export function parseLayout(raw: string | null | undefined): Layout {
  if (!raw) return emptyLayout();
  try {
    const data = migrateSavedWindowIds(JSON.parse(raw));
    if (typeof data !== 'object' || data === null) return emptyLayout();
    const { v, items } = data as { v?: unknown; items?: unknown };
    if (v !== 1 || typeof items !== 'object' || items === null || Array.isArray(items))
      return emptyLayout();
    const out = emptyLayout();
    const preset = (data as { preset?: unknown }).preset;
    if (PRESETS.some((p) => p.id === preset)) out.preset = preset as Preset;
    for (const [savedId, value] of Object.entries(items).slice(0, MAX_ENTRIES)) {
      const id = savedId === LEGACY_OFFICE_ID ? 'office' : savedId;
      if (savedId === LEGACY_OFFICE_ID && Object.hasOwn(items, 'office')) continue;
      const entry = parseEntry(value);
      if (entry) out.items[id] = entry;
    }
    return out;
  } catch {
    return emptyLayout();
  }
}

export const serializeLayout = (layout: Layout): string => JSON.stringify(layout);

/** `layout` with `id`'s entry changed; an entry left empty is removed (back to the default). */
export function withEntry(layout: Layout, id: string, change: Partial<Entry>): Layout {
  const next: Entry = { ...layout.items[id], ...change };
  const items = { ...layout.items };
  if (next.place === undefined) delete next.place;
  if (next.scale === undefined || next.scale === DEFAULT_SCALE) delete next.scale;
  if (!next.max) delete next.max;
  if (next.place || next.scale !== undefined || next.max) items[id] = next;
  else delete items[id];
  return { v: 1, items, ...(layout.preset && { preset: layout.preset }) };
}

/**
 * What a stored layout may place on screen (U-29, U-38): a free window keeps its place and
 * maximize flag; everything else only as a preset's result, never a free placement. Without
 * a preset a non-window keeps nothing (a maximize flag is no placement, but it survives).
 */
export function presetLayoutOnly(layout: Layout): Layout {
  const out = emptyLayout();
  if (layout.preset) out.preset = layout.preset;
  for (const [id, entry] of Object.entries(layout.items)) {
    if (windowIsFree(id)) {
      const kept: Entry = {};
      if (entry.place) kept.place = entry.place;
      if (entry.max) kept.max = true;
      if (kept.place || kept.max) out.items[id] = kept;
    } else if (layout.preset) out.items[id] = entry;
    else if (entry.max) out.items[id] = { max: true };
  }
  return out;
}
