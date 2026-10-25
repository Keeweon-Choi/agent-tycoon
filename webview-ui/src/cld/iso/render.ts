/**
 * ISO-PILOT renderer: the office as an isometric building, floors stacked from floor 1 up.
 *
 * The floor in focus is drawn live every frame: its static ground (pavement, slab, floor
 * tiles, the tall back walls) from a cache, then in depth order the cut walls, the furniture
 * and the characters, at the camera's zoom. Every other floor is one cached picture,
 * darkened and desaturated once when it is drawn and redrawn only when that floor changes
 * (its layout, or a character there moving to another tile, checked once a second): the
 * floors out of focus cost one scaled image each per frame and never animate (their
 * characters still work and walk: the simulation is not this module's). The glass elevator
 * shaft, its doors and its car are drawn last, live.
 *
 * Pieces come at densities 4, 2 and 1 (art.ts); each target draws the one that divides its
 * zoom into whole device px, nearest-neighbour: the same pixels, never blurred.
 *
 * Hit testing reads what this frame drew (`isoPick`): characters first, then furniture, by
 * their opaque pixels, then the floor tile under the point, then another floor's plate.
 */
import { elevatorState } from '../../cld/elevator.js';
import { cldCharacterDrawables, cldCharacterSprite } from '../../cld/ez/drawVisuals.js';
import { offAlpha } from '../../cld/ez/nameplate.js';
import { reducedMotion } from '../../cld/floors.js';
import { cldGetSnapshot, virtualAgentId } from '../../cld/officeStore.js';
import {
  CHARACTER_SITTING_OFFSET_PX,
  ELEVATOR_RIDE_PER_FLOOR_SEC,
  ELEVATOR_RIDE_SEC,
  HEADLESS_CHARACTER_ALPHA,
  HOVERED_OUTLINE_ALPHA,
  ISO_CHARACTER_BOX,
  ISO_DIM_ALPHA,
  ISO_DIM_REFRESH_MS,
  ISO_HALF_H,
  ISO_HALF_W,
  ISO_LIFT_LEVELS_PER_S,
  ISO_SLAB_H,
  ISO_WALL_H,
  SELECTED_OUTLINE_ALPHA,
} from '../../constants.js';
import { getCharacterSprite } from '../../office/engine/characters.js';
import { renderMatrixEffect } from '../../office/engine/matrixEffect.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { isGhostHeadlessAgentsEnabled } from '../../office/engine/renderer.js';
import { getCatalogEntry } from '../../office/layout/furnitureCatalog.js';
import type { OverlayProjection } from '../../office/projection.js';
import { getCachedSprite, getOutlineSprite } from '../../office/sprites/spriteCache.js';
import { getCharacterSprites } from '../../office/sprites/spriteData.js';
import type { Character, SpriteData } from '../../office/types.js';
import { CharacterState, Direction, TILE_SIZE } from '../../office/types.js';
import { artDensity, ISO_MANIFEST, type IsoArt, isoArt, type IsoImage, isoImages } from './art.js';
import {
  type DepthBox,
  depthOrder,
  floorBox,
  isoAt,
  type IsoFloor,
  isoInverse,
  isoOrigin,
  type IsoStack,
  isoStack,
  type Pt,
} from './projection.js';
import { buildScene, type IsoFloorScene, type IsoItem } from './scene.js';
import { isoFacing, isoSprites, mirrorSprite, rowDirection } from './sprites.js';

/** Read-only counters for the runner: cache redraws, frames and the time they took. */
export const isoStats = { groundRenders: 0, dimRenders: 0, frames: 0, ms: 0 };

// ── The scene, per layout ───────────────────────────────────

let built: {
  layout: object;
  tileMap: unknown;
  stack: IsoStack;
  scenes: IsoFloorScene[];
} | null = null;

/** The building for the office as it is now (rebuilt when its layout or tile grid changes). */
export function isoScene(os: OfficeState): { stack: IsoStack; scenes: IsoFloorScene[] } {
  const layout = os.getLayout();
  if (built?.layout !== layout || built.tileMap !== os.tileMap) {
    const stack = isoStack(layout as typeof layout & { cldFloors?: unknown });
    const scenes = buildScene(stack, os.tileMap, layout.furniture, getCatalogEntry, ISO_MANIFEST);
    built = { layout, tileMap: os.tileMap, stack, scenes };
    ground.clear();
    dim.clear();
  }
  return built;
}

/** The floor character `ch` stands on, or null (between floors). */
function floorOf(stack: IsoStack, ch: Character): IsoFloor | null {
  return stack.floors.find((f) => ch.tileRow >= f.row && ch.tileRow < f.row + f.rows) ?? null;
}

/** Iso px of a character's feet. */
export function isoFeet(stack: IsoStack, ch: Character): Pt | null {
  const f = floorOf(stack, ch);
  if (!f) return null;
  return isoAt(ch.x / TILE_SIZE, ch.y / TILE_SIZE - f.row, f.level, stack.spacing);
}

// ── Drawing helpers ──────────────────────────────────────────

interface Target {
  ctx: CanvasRenderingContext2D;
  /** Device px of iso (0, 0), device px per iso px, and the art density drawn. */
  o: Pt;
  s: number;
  d: number;
}

const target = (ctx: CanvasRenderingContext2D, o: Pt, s: number): Target => ({
  ctx,
  o,
  s,
  d: artDensity(s),
});

/** Iso px of a piece's top-left: its anchor on the footprint's front corner, `lift` up. */
function artAt(a: IsoArt, front: Pt, lift: number, mirror: boolean): Pt {
  const ax = mirror ? a.img.w - a.ax : a.ax;
  return { x: front.x - ax / a.d, y: front.y - a.ay / a.d - lift };
}

function drawArt(t: Target, a: IsoArt, at: Pt, mirror: boolean): void {
  t.ctx.drawImage(
    mirror ? a.img.flipped : a.img.plain,
    Math.round(t.o.x + at.x * t.s),
    Math.round(t.o.y + at.y * t.s),
    (a.img.w * t.s) / a.d,
    (a.img.h * t.s) / a.d,
  );
}

/** Piece `name` with its footprint's front corner at iso `front`. */
function put(
  t: Target,
  imgs: Map<string, IsoImage>,
  name: string,
  front: Pt,
  lift = 0,
  mirror = false,
): void {
  const a = isoArt(imgs, name, t.d);
  if (a) drawArt(t, a, artAt(a, front, lift, mirror), mirror);
}

/** Pavement tiles around floor 1. */
const PAVE = 3;
/** The tall back walls' window rhythm: a window panel's strips, then plain wall. */
const WINDOW_PERIOD = 5;

/** The glass shaft's length along the rows, in tiles. */
const liftTiles = () => ISO_MANIFEST.pieces[ISO_MANIFEST.lift.shaft]?.footprint[1] ?? 2;

/** The pavement, slab, floor and tall walls of a floor: what nothing on it stands behind. */
function drawGround(t: Target, stack: IsoStack, scene: IsoFloorScene, imgs: Map<string, IsoImage>) {
  const { level } = scene.floor;
  const front = (c: number, r: number) => isoAt(c + 1, r + 1, level, stack.spacing);
  if (level === 0)
    for (let r = -PAVE; r < stack.depth + PAVE + liftTiles(); r++)
      for (let c = -PAVE; c < stack.cols + PAVE; c++)
        if (c < 0 || r < 0 || c >= stack.cols || r >= stack.depth)
          put(t, imgs, 'pavement', front(c, r), -ISO_SLAB_H);
  // The plate: concrete where no room is, the slab's two outer faces under its front edges.
  const covered = new Set(scene.tiles.map((x) => `${x.col},${x.row}`));
  for (const w of scene.walls) if (!w.tall) covered.add(`${w.col},${w.row}`);
  for (let r = 0; r < stack.depth; r++)
    for (let c = 0; c < stack.cols; c++)
      if (!covered.has(`${c},${r}`)) put(t, imgs, 'plate', front(c, r));
  for (let c = 0; c < stack.cols; c++) put(t, imgs, 'slab-row', front(c, stack.depth - 1));
  for (let r = 0; r < stack.depth; r++) put(t, imgs, 'slab-col', front(stack.cols - 1, r));
  for (const x of scene.tiles) put(t, imgs, x.piece, front(x.col, x.row));
  // The back walls stand on their tiles' room-side edges: a window panel's strips in turn
  // with plain wall, the corner where two meet.
  const w = ISO_MANIFEST.walls;
  for (const wall of scene.walls) {
    if (!wall.tall) continue;
    const at = front(wall.col, wall.row);
    if (wall.faceRow && wall.faceCol) put(t, imgs, w.corner, at);
    else if (wall.faceRow) put(t, imgs, w.rowWindows[wall.col % WINDOW_PERIOD] ?? w.row, at);
    else put(t, imgs, w.colWindows[wall.row % WINDOW_PERIOD] ?? w.col, at);
  }
}

/** One thing in a floor's depth order, and how it draws. */
interface Drawn extends DepthBox {
  draw: (t: Target) => void;
  /** For hit tests: what it is, and its picture in iso px (set when drawn). */
  hit?: Hit;
}
interface Hit {
  kind: 'character' | 'item';
  id?: number;
  item?: IsoItem;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Whether the picture is opaque at iso px (x, y) from its top-left. */
  opaque: (x: number, y: number) => boolean;
}

function wallDrawns(scene: IsoFloorScene, stack: IsoStack, imgs: Map<string, IsoImage>): Drawn[] {
  return scene.walls
    .filter((w) => !w.tall)
    .map((w) => ({
      c0: w.col,
      r0: w.row,
      c1: w.col + 1,
      r1: w.row + 1,
      draw: (t: Target) =>
        put(
          t,
          imgs,
          ISO_MANIFEST.walls.low,
          isoAt(w.col + 1, w.row + 1, scene.floor.level, stack.spacing),
        ),
    }));
}

/** The elevator's doors on this floor (ELEVATOR: set in a back wall, two tiles), open as far
 *  as the ride has them. */
function doorDrawns(
  scene: IsoFloorScene,
  stack: IsoStack,
  imgs: Map<string, IsoImage>,
  os: OfficeState,
): Drawn[] {
  const { floor } = scene;
  return elevatorState(os)
    .floors.filter((e) => e.floor === floor.id)
    .map((e) => {
      const r = e.row - floor.row;
      const front = isoAt(e.col + 2, r + 1, floor.level, stack.spacing);
      const name = e.open >= 0.5 ? ISO_MANIFEST.lift.doorsOpen : ISO_MANIFEST.lift.doors;
      return {
        c0: e.col,
        r0: r,
        c1: e.col + 2,
        r1: r + 1,
        lift: 1,
        draw: (t: Target) => put(t, imgs, name, front),
      };
    });
}

function itemDrawns(
  scene: IsoFloorScene,
  stack: IsoStack,
  imgs: Map<string, IsoImage>,
  os: OfficeState,
): Drawn[] {
  const out: Drawn[] = doorDrawns(scene, stack, imgs, os);
  const { floor } = scene;
  for (const it of scene.items) {
    const front = isoAt(it.c1, it.r1, floor.level, stack.spacing);
    let name = ISO_MANIFEST.types[it.type]?.piece;
    const mirror = it.mirror;
    // A chair turns with its seat (the pack has it facing the lower left and the lower right).
    const seat = os.seats.get(it.uid);
    if (it.piece && seat && name?.startsWith('chair'))
      name =
        seat.facingDir === Direction.LEFT || seat.facingDir === Direction.RIGHT
          ? 'chair-side'
          : 'chair';
    const lift = (it.lift ?? 0) - it.drop;
    if (it.piece && name) {
      const piece = name;
      const d: Drawn = {
        ...it,
        draw: (t) => {
          const a = isoArt(imgs, piece, t.d);
          if (!a) return;
          const at = artAt(a, front, lift, mirror);
          drawArt(t, a, at, mirror);
          d.hit = {
            kind: 'item',
            item: it,
            x: at.x,
            y: at.y,
            w: a.img.w / a.d,
            h: a.img.h / a.d,
            opaque: (x, y) => {
              const px = Math.floor(x * a.d);
              return a.img.opaque(mirror ? a.img.w - 1 - px : px, Math.floor(y * a.d));
            },
          };
        },
      };
      out.push(d);
      continue;
    }
    // Not converted yet: its top-down sprite stands on the footprint's front corner.
    const sprite = it.sprite;
    const w = sprite[0]?.length ?? 0;
    const h = sprite.length;
    const x = front.x - w / 2;
    const y = front.y - h - lift;
    out.push({
      ...it,
      draw: (t) => {
        const c = getCachedSprite(sprite, t.s);
        t.ctx.drawImage(c, Math.round(t.o.x + x * t.s), Math.round(t.o.y + y * t.s));
      },
      hit: {
        kind: 'item',
        item: it,
        x,
        y,
        w,
        h,
        opaque: (px, py) => !!sprite[Math.floor(py)]?.[Math.floor(px)],
      },
    });
  }
  return out;
}

function characterDrawns(
  chars: Character[],
  stack: IsoStack,
  floor: IsoFloor,
  sel: IsoSelection,
  s: number,
): Drawn[] {
  const out: Drawn[] = [];
  const office = cldGetSnapshot().officeSnapshot;
  for (const ch of chars) {
    if (ch.cldAway || (ch as { cldRide?: { hidden?: boolean } }).cldRide?.hidden) continue;
    if (floorOf(stack, ch) !== floor) continue;
    const col = ch.x / TILE_SIZE;
    const row = ch.y / TILE_SIZE - floor.row;
    // Seated, it sinks a little onto the chair, as in the top-down office.
    const feet = isoAt(col, row, floor.level, stack.spacing);
    if (ch.state === CharacterState.TYPE) feet.y += CHARACTER_SITTING_OFFSET_PX / 2;
    const looked = ch.id === sel.selected || ch.id === sel.follow;
    const sprites = isoSprites(getCharacterSprites(ch.palette, ch.hueShift), s, looked);
    // The front or back row as the facing asks, mirrored for the other diagonal (sprites.ts).
    const facing = isoFacing(ch.dir);
    const frame = getCharacterSprite({ ...ch, dir: rowDirection(facing.row) }, sprites);
    const sprite: SpriteData = cldCharacterSprite(
      ch.id,
      facing.mirror ? mirrorSprite(frame) : frame,
    );
    const scale = s / sprites.density;
    const w = (sprite[0]?.length ?? 0) / sprites.density;
    const h = sprite.length / sprites.density;
    const orch = office?.orchestrators.find(
      (o) => (o.agentId ?? virtualAgentId(`orch:${o.name}`)) === ch.id,
    );
    const focused = ch.id === sel.selected || ch.id === sel.hovered;
    const alpha =
      ch.isHeadless && isGhostHeadlessAgentsEnabled()
        ? HEADLESS_CHARACTER_ALPHA
        : offAlpha(orch?.state === 'off', focused, HEADLESS_CHARACTER_ALPHA);
    out.push({
      c0: col - ISO_CHARACTER_BOX,
      r0: row - ISO_CHARACTER_BOX,
      c1: col + ISO_CHARACTER_BOX,
      r1: row + ISO_CHARACTER_BOX,
      lift: 1,
      draw: (t) => {
        const cached = getCachedSprite(sprite, scale);
        const dx = Math.round(t.o.x + feet.x * t.s - cached.width / 2);
        const dy = Math.round(t.o.y + feet.y * t.s - cached.height);
        const ctx = t.ctx;
        if (ch.matrixEffect) {
          ctx.save();
          ctx.globalAlpha = alpha;
          renderMatrixEffect(ctx, ch, sprite, dx, dy, scale);
          ctx.restore();
          return;
        }
        // The status ring and activity props the top-down office draws, at these feet.
        const extras = cldCharacterDrawables(
          ch,
          dx + cached.width / 2,
          dy + cached.height,
          t.s,
          0,
          alpha,
        );
        for (const e of extras) if (e.zY < 0) e.draw(ctx);
        if (focused) {
          const ol = getCachedSprite(getOutlineSprite(sprite), scale);
          ctx.save();
          ctx.globalAlpha = ch.id === sel.selected ? SELECTED_OUTLINE_ALPHA : HOVERED_OUTLINE_ALPHA;
          ctx.drawImage(ol, dx - Math.round(scale), dy - Math.round(scale));
          ctx.restore();
        }
        if (alpha !== 1) {
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.drawImage(cached, dx, dy);
          ctx.restore();
        } else ctx.drawImage(cached, dx, dy);
        for (const e of extras) if (e.zY >= 0) e.draw(ctx);
      },
      hit: {
        kind: 'character',
        id: ch.id,
        x: feet.x - w / 2,
        y: feet.y - h,
        w,
        h,
        opaque: (px, py) =>
          !!sprite[Math.floor(py * sprites.density)]?.[Math.floor(px * sprites.density)],
      },
    });
  }
  return out;
}

// ── The elevator ─────────────────────────────────────────────

/** The shaft's footprint (local tiles): a glass column at the building's left front corner,
 *  the same place on every floor, its doors on the face towards the viewer's right. */
export const shaftBox = (stack: IsoStack): DepthBox => ({
  c0: 0,
  r0: stack.depth,
  c1: 2,
  r1: stack.depth + liftTiles(),
});

/** Where the car is (a level, fractional while it moves) and where it goes. */
const car = { level: -1, target: 0, at: 0 };
/** Whether the car is moving (the office keeps its full frame rate). */
export const isoBusy = () => car.level !== car.target;
/** The car's level (the runner reads it). */
export const isoCarLevel = () => car.level;

/**
 * Where the car is: with a rider in 'travel', between its floors as far as the ride has gone
 * (task/elevator: each ride is its own trip); else at the floor whose doors are open, or
 * where a rider waits; else at the floor in focus. `exact`: the ride sets it, no easing.
 */
function carTarget(
  os: OfficeState,
  stack: IsoStack,
  focus: IsoFloor,
): { level: number; exact: boolean } {
  const st = elevatorState(os);
  const level = (id: string) => stack.floors.find((f) => f.id === id)?.level ?? focus.level;
  const riding = st.riders.find((r) => r.phase === 'travel');
  if (riding) {
    const [a, b] = [level(riding.from), level(riding.to)];
    const k = Math.min(
      1,
      riding.t / (ELEVATOR_RIDE_SEC + ELEVATOR_RIDE_PER_FLOOR_SEC * Math.abs(b - a)),
    );
    return { level: a + (b - a) * k, exact: true };
  }
  const open = st.floors.find((f) => f.open > 0);
  if (open) return { level: level(open.floor), exact: false };
  const waiting = st.riders.find((r) => r.phase === 'call' || r.phase === 'in');
  if (waiting) return { level: level(waiting.from), exact: false };
  return { level: focus.level, exact: false };
}

function drawShaft(
  t: Target,
  stack: IsoStack,
  focus: IsoFloor,
  imgs: Map<string, IsoImage>,
  os: OfficeState,
  now: number,
): void {
  const lift = ISO_MANIFEST.lift;
  const shaft = ISO_MANIFEST.pieces[lift.shaft];
  const art = isoArt(imgs, lift.shaft, t.d);
  if (!shaft || !art) return;
  // One segment's height (iso px): the picture less its footprint's diamond.
  const seg = art.img.h / art.d - (shaft.footprint[0] + shaft.footprint[1]) * ISO_HALF_H;
  const b = shaftBox(stack);
  const top = stack.floors.length - 1;
  // The car moves a few floors a second (at once with reduced motion).
  const goal = carTarget(os, stack, focus);
  car.target = goal.level;
  const dt = car.at ? Math.min(0.1, (now - car.at) / 1000) : 0;
  car.at = now;
  if (car.level < 0 || reducedMotion() || goal.exact) car.level = car.target;
  const step = ISO_LIFT_LEVELS_PER_S * dt;
  car.level =
    Math.abs(car.target - car.level) <= step
      ? car.target
      : car.level + Math.sign(car.target - car.level) * step;
  for (const f of stack.floors) {
    const front = isoAt(b.c1, b.r1, f.level, stack.spacing);
    const height = f.level < top ? stack.spacing : ISO_WALL_H * 2;
    for (let z = -ISO_SLAB_H; z < height - ISO_SLAB_H; z += seg) put(t, imgs, lift.shaft, front, z);
    if (f.level === Math.round(car.level))
      put(t, imgs, lift.car, isoAt(b.c1, b.r1, car.level, stack.spacing));
  }
}

// ── Caches ───────────────────────────────────────────────────

interface FloorCache {
  canvas: HTMLCanvasElement;
  key: string;
  checkedAt: number;
}
const ground = new Map<string, FloorCache>();
const dim = new Map<string, FloorCache>();

/** A floor's cache bounds (iso px): its plate and walls, the pavement for floor 1. */
function cacheBox(stack: IsoStack, level: number): IsoStack['box'] {
  const lift = level * stack.spacing;
  return {
    x0: -(stack.depth + PAVE + liftTiles()) * ISO_HALF_W,
    x1: (stack.cols + PAVE + 1) * ISO_HALF_W,
    y0: -lift - ISO_WALL_H - 2 * ISO_HALF_H,
    y1:
      (stack.cols + stack.depth + 2 * PAVE + liftTiles() + 2) * ISO_HALF_H + ISO_SLAB_H * 2 - lift,
  };
}

function cacheCanvas(
  map: Map<string, FloorCache>,
  id: string,
  box: IsoStack['box'],
  d: number,
): FloorCache {
  let c = map.get(id);
  if (!c) {
    c = { canvas: document.createElement('canvas'), key: '', checkedAt: -Infinity };
    map.set(id, c);
  }
  const w = (box.x1 - box.x0) * d;
  const h = (box.y1 - box.y0) * d;
  if (c.canvas.width !== w || c.canvas.height !== h) {
    c.canvas.width = w;
    c.canvas.height = h;
    c.key = '';
  }
  return c;
}

/** What a dimmed floor shows that can change: who stands where, facing how, working or not. */
function floorSignature(
  os: OfficeState,
  chars: Character[],
  stack: IsoStack,
  floor: IsoFloor,
): string {
  // Its elevator doors, shut or open.
  let sig = elevatorState(os)
    .floors.filter((e) => e.floor === floor.id)
    .map((e) => (e.open >= 0.5 ? 'o' : 's'))
    .join('');
  for (const ch of chars)
    if (!ch.cldAway && floorOf(stack, ch) === floor)
      sig += `${ch.id}:${ch.tileCol},${ch.tileRow},${ch.dir},${ch.state},${ch.isActive ? 1 : 0},${ch.palette};`;
  return sig || 'empty';
}

/** Darker, less saturated, a touch bluer: a floor out of focus (pixels kept, nothing blurred). */
function dimPixels(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const lum = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
    d[i] = (d[i] + (lum - d[i]) * 0.5) * 0.55;
    d[i + 1] = (d[i + 1] + (lum - d[i + 1]) * 0.5) * 0.57;
    d[i + 2] = (d[i + 2] + (lum - d[i + 2]) * 0.5) * 0.66 + 6;
  }
  ctx.putImageData(img, 0, 0);
}

// ── The frame ────────────────────────────────────────────────

let hits: Hit[] = [];
let frame: { o: Pt; s: number; stack: IsoStack; focus: IsoFloor; scenes: IsoFloorScene[] } | null =
  null;

export interface IsoSelection {
  selected: number | null;
  hovered: number | null;
  follow: number | null;
}
const NONE: IsoSelection = { selected: null, hovered: null, follow: null };

/**
 * Draw the building into `ctx` (device px `w`×`h`). `centre` is the iso px the pan is about
 * (the camera's reference), `focusId` the floor in focus. Returns false while the art loads.
 */
export function renderIso(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  os: OfficeState,
  zoom: number,
  pan: Pt,
  centre: Pt,
  focusId: string,
  sel: IsoSelection,
  now: number,
): boolean {
  const imgs = isoImages();
  ctx.clearRect(0, 0, w, h);
  if (!imgs) return false;
  const started = performance.now();
  const { stack, scenes } = isoScene(os);
  const focus = stack.floors.find((f) => f.id === focusId) ?? stack.floors[0];
  const o = isoOrigin({ w, h }, centre, zoom, pan);
  const chars = os.getCharacters();
  const live = target(ctx, o, zoom);
  hits = [];
  ctx.imageSmoothingEnabled = false;
  for (const scene of scenes) {
    const { floor } = scene;
    const box = cacheBox(stack, floor.level);
    const blit = (c: FloorCache, d: number) =>
      ctx.drawImage(
        c.canvas,
        o.x + box.x0 * zoom,
        o.y + box.y0 * zoom,
        (c.canvas.width * zoom) / d,
        (c.canvas.height * zoom) / d,
      );
    if (floor === focus) {
      // The ground at the density this zoom draws (its cache is redrawn when that changes).
      const d = live.d;
      const g = cacheCanvas(ground, floor.id, box, d);
      if (!g.key) {
        const gctx = g.canvas.getContext('2d')!;
        gctx.clearRect(0, 0, g.canvas.width, g.canvas.height);
        gctx.imageSmoothingEnabled = false;
        drawGround(
          { ctx: gctx, o: { x: -box.x0 * d, y: -box.y0 * d }, s: d, d },
          stack,
          scene,
          imgs,
        );
        g.key = 'drawn';
        isoStats.groundRenders++;
      }
      blit(g, d);
      const list = depthOrder([
        ...wallDrawns(scene, stack, imgs),
        ...itemDrawns(scene, stack, imgs, os),
        ...characterDrawns(chars, stack, floor, sel, zoom),
      ]);
      for (const item of list) {
        item.draw(live);
        if (item.hit) hits.push(item.hit);
      }
      continue;
    }
    const c = cacheCanvas(dim, floor.id, box, 1);
    if (now - c.checkedAt >= ISO_DIM_REFRESH_MS || !c.key) {
      c.checkedAt = now;
      const key = floorSignature(os, chars, stack, floor);
      if (key !== c.key) {
        c.key = key;
        const dctx = c.canvas.getContext('2d')!;
        dctx.clearRect(0, 0, c.canvas.width, c.canvas.height);
        dctx.imageSmoothingEnabled = false;
        const t = target(dctx, { x: -box.x0, y: -box.y0 }, 1);
        drawGround(t, stack, scene, imgs);
        for (const item of depthOrder([
          ...wallDrawns(scene, stack, imgs),
          ...itemDrawns(scene, stack, imgs, os),
          ...characterDrawns(chars, stack, floor, NONE, 1),
        ]))
          item.draw(t);
        dimPixels(dctx, c.canvas.width, c.canvas.height);
        isoStats.dimRenders++;
      }
    }
    ctx.globalAlpha = ISO_DIM_ALPHA;
    blit(c, 1);
    ctx.globalAlpha = 1;
  }
  drawShaft(live, stack, focus, imgs, os, now);
  frame = { o, s: zoom, stack, focus, scenes };
  isoStats.frames++;
  isoStats.ms += performance.now() - started;
  return true;
}

export type IsoPick =
  | { kind: 'character'; id: number }
  | { kind: 'item'; item: IsoItem; col: number; row: number }
  | { kind: 'tile'; col: number; row: number }
  | { kind: 'floor'; id: string }
  | null;

/** What is under device px (x, y) in the last frame drawn. */
export function isoPick(x: number, y: number): IsoPick {
  if (!frame) return null;
  const f = frame;
  const ix = (x - f.o.x) / f.s;
  const iy = (y - f.o.y) / f.s;
  const under = (h: Hit) =>
    ix >= h.x && iy >= h.y && ix < h.x + h.w && iy < h.y + h.h && h.opaque(ix - h.x, iy - h.y);
  for (let i = hits.length - 1; i >= 0; i--)
    if (hits[i].kind === 'character' && under(hits[i]))
      return { kind: 'character', id: hits[i].id! };
  const tile = () => {
    const p = isoInverse(ix, iy, f.focus.level, f.stack.spacing);
    const col = Math.floor(p.col);
    const row = Math.floor(p.row);
    return col >= 0 && row >= 0 && col < f.stack.cols && row < f.focus.rows
      ? { col, row: f.focus.row + row }
      : null;
  };
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    if (h.kind !== 'item' || !under(h)) continue;
    // The tile of its footprint under the point, else its front tile (a chair: its seat).
    const it = h.item!;
    const t = tile();
    const local = t ? t.row - f.focus.row : -1;
    const inside = t && t.col >= it.c0 && t.col < it.c1 && local >= it.r0 && local < it.r1;
    return {
      kind: 'item',
      item: it,
      col: inside ? t.col : it.c1 - 1,
      row: inside ? t.row : f.focus.row + it.r1 - 1,
    };
  }
  const own = tile();
  if (own) {
    const local = own.row - f.focus.row;
    if (f.scenes[f.focus.level].tiles.some((x) => x.col === own.col && x.row === local))
      return { kind: 'tile', ...own };
  }
  // Another floor: its plate, or its back walls above it.
  for (const fl of f.stack.floors) {
    if (fl === f.focus) continue;
    const b = floorBox(f.stack, fl.level);
    if (ix < b.x0 || ix >= b.x1 || iy < b.y0 || iy >= b.y1) continue;
    const p = isoInverse(ix, iy, fl.level, f.stack.spacing);
    const onPlate = p.col >= 0 && p.row >= 0 && p.col < f.stack.cols && p.row < f.stack.depth;
    const up = isoInverse(ix, iy + ISO_WALL_H, fl.level, f.stack.spacing);
    const onWalls =
      up.col >= 0 &&
      up.row >= 0 &&
      up.col < f.stack.cols &&
      up.row < f.stack.depth &&
      (up.col < 1 || up.row < 1);
    if (onPlate || onWalls) return { kind: 'floor', id: fl.id };
  }
  return null;
}

/** The top-down office is drawn again: the overlays stop placing things isometrically. */
export function isoFrameReset(): void {
  frame = null;
  hits = [];
}

/** Whether the last frame drawn was the isometric building. */
export const isoFrame = (): boolean => frame !== null;

/**
 * The overlay projection for one character in the isometric frame: the top-down one moved so
 * the character's feet land where the building drew them (labels and bubbles keep their
 * offsets from the feet, straight up the screen). `focused`: on the floor in focus. Null when
 * the building is not drawn, or the character is between floors.
 */
export function isoOverlayFor(
  ch: Character,
  dpr: number,
  base: OverlayProjection,
): { project: OverlayProjection; focused: boolean } | null {
  if (!frame) return null;
  const f = floorOf(frame.stack, ch);
  const feet = f && isoFeet(frame.stack, ch);
  if (!f || !feet) return null;
  const { o, s } = frame;
  const fx = o.x + feet.x * s;
  const fy = o.y + feet.y * s;
  return {
    focused: f.id === frame.focus.id,
    project: {
      ...base,
      toScreenX: (wx) => (fx + (wx - ch.x) * s) / dpr,
      toScreenY: (wy) => (fy + (wy - ch.y) * s) / dpr,
    },
  };
}

/** Device px where the last frame drew world point (x, y) on its floor's plane (tests). */
export function isoScreenAt(worldX: number, worldY: number): Pt | null {
  if (!frame) return null;
  const row = Math.floor(worldY / TILE_SIZE);
  const f = frame.stack.floors.find((fl) => row >= fl.row && row < fl.row + fl.rows);
  if (!f) return null;
  const p = isoAt(worldX / TILE_SIZE, worldY / TILE_SIZE - f.row, f.level, frame.stack.spacing);
  return { x: frame.o.x + p.x * frame.s, y: frame.o.y + p.y * frame.s };
}

/** The floors of the last frame drawn (tests). */
export const isoFloors = (): IsoFloor[] => frame?.stack.floors ?? [];
