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
import {
  cldCharacterDrawables,
  cldCharacterSprite,
  dimmedSprite,
} from '../../cld/ez/drawVisuals.js';
import { offAlpha } from '../../cld/ez/nameplate.js';
import { reducedMotion } from '../../cld/floors.js';
import { cldGetSnapshot, virtualAgentId } from '../../cld/officeStore.js';
import {
  CHARACTER_SITTING_OFFSET_PX,
  ELEVATOR_RIDE_PER_FLOOR_SEC,
  ELEVATOR_RIDE_SEC,
  HEADLESS_CHARACTER_ALPHA,
  HOVERED_OUTLINE_ALPHA,
  ISO_CAR_AT_FLOOR,
  ISO_CHARACTER_BOX,
  ISO_DIM_ALPHA,
  ISO_DIM_REFRESH_MS,
  ISO_HALF_H,
  ISO_HALF_W,
  ISO_LIFT_LEVELS_PER_S,
  ISO_SHAFT_FRAME,
  ISO_SHAFT_GLASS,
  ISO_SHAFT_POST,
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
import { drawSmooth, isSmooth, smoothSize } from '../../office/sprites/smoothSprite.js';
import { getCachedSprite, getOutlineSprite } from '../../office/sprites/spriteCache.js';
import {
  getCharacterSprites,
  isoPaletteOf,
  spritesAtZoom,
} from '../../office/sprites/spriteData.js';
import { warmCharacter } from '../../office/sprites/warm.js';
import type { Character, SpriteData } from '../../office/types.js';
import { CharacterState, TILE_SIZE } from '../../office/types.js';
import {
  artDensity,
  ISO_MANIFEST,
  type IsoArt,
  isoArt,
  type IsoImage,
  isoImages,
  type WallUse,
} from './art.js';
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
import { facingOf, seatPieceFor } from './seats.js';
import { doorFronts, frontAt, LIFT_TILES, shaftBands } from './shaft.js';
import { isoFacing, mirrorSprite, rowDirection } from './sprites.js';

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
    const stack = isoStack(layout as typeof layout & { cldFloors?: unknown }, os.tileMap);
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
  return isoAt(ch.x / TILE_SIZE, ch.y / TILE_SIZE - f.row, f.level, stack.lifts);
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

/** A master piece drawn smaller than its own pixels is averaged down (smooth); anything else
 *  keeps its pixels (nearest). */
function smooth(ctx: CanvasRenderingContext2D, on: boolean): void {
  ctx.imageSmoothingEnabled = on;
  if (on) ctx.imageSmoothingQuality = 'high';
}

function drawArt(t: Target, a: IsoArt, at: Pt, mirror: boolean): void {
  smooth(t.ctx, t.s < a.d);
  t.ctx.drawImage(
    mirror ? a.img.flipped : a.img.plain,
    Math.round(t.o.x + at.x * t.s),
    Math.round(t.o.y + at.y * t.s),
    (a.img.w * t.s) / a.d,
    (a.img.h * t.s) / a.d,
  );
  smooth(t.ctx, false);
}

/**
 * Strip `j` (one tile along the wall) of a wall piece, its base's front end on `front`. The piece
 * is stored running down to the right; `use.mirror` draws it for the wall running the other way
 * (strip 0 is then at the back, on the right of the picture), the strip as wide as a tile.
 */
function putStrip(
  t: Target,
  imgs: Map<string, IsoImage>,
  use: WallUse,
  j: number,
  front: Pt,
): void {
  const a = isoArt(imgs, use.piece, t.d);
  const wall = ISO_MANIFEST.pieces[use.piece]?.wall;
  if (!a || !wall) return;
  const tile = ISO_HALF_W * a.d;
  const drop = ISO_HALF_H * a.d;
  const w = a.img.w;
  // In the (possibly flipped) picture: where the strip's columns start and its base's front end.
  const sx = use.mirror ? w - wall.start[0] - (j + 1) * tile : wall.start[0] + j * tile;
  const ax = use.mirror ? sx : sx + tile;
  const ay = wall.start[1] + (j + 1) * drop;
  smooth(t.ctx, t.s < a.d);
  t.ctx.drawImage(
    use.mirror ? a.img.flipped : a.img.plain,
    sx,
    0,
    tile,
    a.img.h,
    Math.round(t.o.x + (front.x - (ax - sx) / a.d) * t.s),
    Math.round(t.o.y + (front.y - ay / a.d) * t.s),
    Math.round((tile * t.s) / a.d),
    Math.round((a.img.h * t.s) / a.d),
  );
  smooth(t.ctx, false);
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

/** The pavement, slab, floor and tall walls of a floor: what nothing on it stands behind. */
function drawGround(t: Target, stack: IsoStack, scene: IsoFloorScene, imgs: Map<string, IsoImage>) {
  const { level } = scene.floor;
  const front = (c: number, r: number) => isoAt(c + 1, r + 1, level, stack.lifts);
  const rows = scene.floor.rows;
  if (level === 0)
    for (let r = -PAVE; r < rows + PAVE; r++)
      for (let c = -PAVE; c < stack.cols + PAVE; c++)
        if (c < 0 || r < 0 || c >= stack.cols || r >= rows)
          put(t, imgs, 'pavement', front(c, r), -ISO_SLAB_H);
  // The plate: concrete where no room is, the slab's two outer faces under its front edges.
  const covered = new Set(scene.tiles.map((x) => `${x.col},${x.row}`));
  for (const w of scene.walls) if (!w.tall) covered.add(`${w.col},${w.row}`);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < stack.cols; c++)
      if (!covered.has(`${c},${r}`)) put(t, imgs, 'plate', front(c, r));
  for (let c = 0; c < stack.cols; c++) put(t, imgs, 'slab-row', front(c, rows - 1));
  for (let r = 0; r < rows; r++) put(t, imgs, 'slab-col', front(stack.cols - 1, r));
  for (const x of scene.tiles) put(t, imgs, x.piece, front(x.col, x.row));
  // The back walls stand on their tiles' room-side edges: the owner's wall pieces one tile at
  // a time, a window piece's strips in turn with plain wall, the corner where two meet.
  const w = ISO_MANIFEST.walls;
  const windows = ISO_MANIFEST.pieces[w.window.piece]?.wall?.n ?? 0;
  const period = windows + w.window.gap;
  const middle = (use: WallUse) => Math.floor((ISO_MANIFEST.pieces[use.piece]?.wall?.n ?? 1) / 2);
  for (const wall of scene.walls) {
    if (!wall.tall) continue;
    const at = front(wall.col, wall.row);
    if (wall.faceRow && wall.faceCol) put(t, imgs, w.corner, at);
    else if (wall.faceRow) {
      const k = wall.col % period;
      if (k < windows) putStrip(t, imgs, { piece: w.window.piece }, k, at);
      else putStrip(t, imgs, w.row, middle(w.row), at);
    } else {
      const k = wall.row % period;
      if (k < windows) putStrip(t, imgs, { piece: w.window.piece, mirror: true }, k, at);
      else putStrip(t, imgs, w.col, middle(w.col), at);
    }
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
          isoAt(w.col + 1, w.row + 1, scene.floor.level, stack.lifts),
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
      // A three-tile piece: the two tiles of the elevator and half a tile of wall each side.
      const front = isoAt(e.col + 2.5, r + 1, floor.level, stack.lifts);
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
    const front = isoAt(it.c1, it.r1, floor.level, stack.lifts);
    let name = ISO_MANIFEST.types[it.type]?.piece;
    let mirror = it.mirror;
    // A chair turns with its seat: the piece drawn for the way its sitter faces.
    const seat = os.seats.get(it.uid);
    if (it.piece && seat && name?.startsWith('o-chair')) {
      const turned = seatPieceFor(ISO_MANIFEST, 'chair', facingOf(seat.facingDir));
      if (turned) [name, mirror] = [turned.name, turned.mirror];
    }
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

/** SHEET-IMPORT, for ISO-2: where a seated character sits on its chair (iso px from its tile's
 *  feet point), or null for the default sink onto the seat. */
type SeatPoint = (ch: Character) => { x: number; y: number } | null;
let seatPointOf: SeatPoint | null = null;
export function setSeatPoint(fn: SeatPoint | null): void {
  seatPointOf = fn;
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
    const feet = isoAt(col, row, floor.level, stack.lifts);
    if (ch.state === CharacterState.TYPE) {
      // ISO-2: the chair's own seat point when it gives one (iso px from the tile's feet point)
      const seat = seatPointOf?.(ch);
      if (seat) [feet.x, feet.y] = [feet.x + seat.x, feet.y + seat.y];
      else feet.y += CHARACTER_SITTING_OFFSET_PX / 2;
    }
    // SHEET-IMPORT: a preset's own isometric sheet when it has one beside its top view
    const all = getCharacterSprites(isoPaletteOf(ch.palette), ch.hueShift);
    const sprites = spritesAtZoom(all, s);
    warmCharacter(
      sprites,
      s / sprites.density,
      (f) => [f, mirrorSprite(f), dimmedSprite(f), dimmedSprite(mirrorSprite(f))],
      ch.id,
    );
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
        // a detailed frame not built for this zoom yet draws from its master, never built here
        const cached = isSmooth(sprite) ? null : getCachedSprite(sprite, scale);
        const [cw, chh] = cached ? [cached.width, cached.height] : smoothSize(sprite, scale);
        const dx = Math.round(t.o.x + feet.x * t.s - cw / 2);
        const dy = Math.round(t.o.y + feet.y * t.s - chh);
        const ctx = t.ctx;
        if (ch.matrixEffect) {
          ctx.save();
          ctx.globalAlpha = alpha;
          renderMatrixEffect(ctx, ch, sprite, dx, dy, scale);
          ctx.restore();
          return;
        }
        // The status ring and activity props the top-down office draws, at these feet.
        const extras = cldCharacterDrawables(ch, dx + cw / 2, dy + chh, t.s, 0, alpha);
        for (const e of extras) if (e.zY < 0) e.draw(ctx);
        if (focused) {
          const ol = getCachedSprite(getOutlineSprite(sprite), scale);
          ctx.save();
          ctx.globalAlpha = ch.id === sel.selected ? SELECTED_OUTLINE_ALPHA : HOVERED_OUTLINE_ALPHA;
          ctx.drawImage(ol, dx - Math.round(scale), dy - Math.round(scale));
          ctx.restore();
        }
        const put = () =>
          cached ? ctx.drawImage(cached, dx, dy) : drawSmooth(ctx, sprite, scale, dx, dy);
        if (alpha !== 1) {
          ctx.save();
          ctx.globalAlpha = alpha;
          put();
          ctx.restore();
        } else put();
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

/** The elevator's doors as the car: the middle two tiles of the three-tile doors piece. */
function drawCar(t: Target, imgs: Map<string, IsoImage>, front: Pt): void {
  const name = ISO_MANIFEST.lift.doors;
  const a = isoArt(imgs, name, t.d);
  if (!a) return;
  const tile = ISO_HALF_W * a.d;
  // In the picture: the doors' columns, and the base under their right end (the piece's right
  // end is half a tile on, where the base is half a drop lower).
  const sx = tile / 2;
  const baseY = a.ay - (ISO_HALF_H * a.d) / 2;
  smooth(t.ctx, t.s < a.d);
  t.ctx.drawImage(
    a.img.plain,
    sx,
    0,
    LIFT_TILES * tile,
    a.img.h,
    Math.round(t.o.x + (front.x - LIFT_TILES * ISO_HALF_W) * t.s),
    Math.round(t.o.y + (front.y - baseY / a.d) * t.s),
    Math.round((LIFT_TILES * tile * t.s) / a.d),
    Math.round((a.img.h * t.s) / a.d),
  );
  smooth(t.ctx, false);
}

/** The glass of the shaft between the floors' doors, over everything, and the car riding in it. */
function drawShaft(
  t: Target,
  stack: IsoStack,
  focus: IsoFloor,
  imgs: Map<string, IsoImage>,
  os: OfficeState,
  now: number,
): void {
  const fronts = doorFronts(stack, elevatorState(os).floors);
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
  const ctx = t.ctx;
  const at = (p: Pt) => [t.o.x + p.x * t.s, t.o.y + p.y * t.s] as const;
  // The car first (the glass is in front of it); at a floor its doors are the wall's own.
  const between = Math.abs(car.level - Math.round(car.level)) > ISO_CAR_AT_FLOOR;
  const spot = between ? frontAt(fronts, car.level) : null;
  if (spot) drawCar(t, imgs, spot);
  ctx.save();
  for (const band of shaftBands(fronts)) {
    ctx.beginPath();
    band.forEach((p, i) => (i ? ctx.lineTo(...at(p)) : ctx.moveTo(...at(p))));
    ctx.closePath();
    ctx.fillStyle = ISO_SHAFT_GLASS;
    ctx.fill();
    // The frame: a post up each side.
    ctx.strokeStyle = ISO_SHAFT_FRAME;
    ctx.lineWidth = Math.max(1, ISO_SHAFT_POST * t.s);
    for (const [from, to] of [
      [band[0], band[3]],
      [band[1], band[2]],
    ]) {
      ctx.beginPath();
      ctx.moveTo(...at(from));
      ctx.lineTo(...at(to));
      ctx.stroke();
    }
  }
  ctx.restore();
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
  const lift = stack.lifts[level] ?? 0;
  return {
    x0: -(stack.depth + PAVE) * ISO_HALF_W,
    x1: (stack.cols + PAVE + 1) * ISO_HALF_W,
    y0: -lift - ISO_WALL_H - 2 * ISO_HALF_H,
    y1: (stack.cols + stack.depth + 2 * PAVE + 2) * ISO_HALF_H + ISO_SLAB_H * 2 - lift,
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

/** Device px box of a character as the last frame drew it (a test aims a press at it). */
export function isoCharacterBox(id: number): { x: number; y: number; w: number; h: number } | null {
  if (!frame) return null;
  const h = hits.find((x) => x.kind === 'character' && x.id === id);
  return h
    ? { x: frame.o.x + h.x * frame.s, y: frame.o.y + h.y * frame.s, w: h.w * frame.s, h: h.h * frame.s }
    : null;
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
    const p = isoInverse(ix, iy, f.focus.level, f.stack.lifts);
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
    const p = isoInverse(ix, iy, fl.level, f.stack.lifts);
    const onPlate = p.col >= 0 && p.row >= 0 && p.col < f.stack.cols && p.row < fl.rows;
    const up = isoInverse(ix, iy + ISO_WALL_H, fl.level, f.stack.lifts);
    const onWalls =
      up.col >= 0 &&
      up.row >= 0 &&
      up.col < f.stack.cols &&
      up.row < fl.rows &&
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
  const p = isoAt(worldX / TILE_SIZE, worldY / TILE_SIZE - f.row, f.level, frame.stack.lifts);
  return { x: frame.o.x + p.x * frame.s, y: frame.o.y + p.y * frame.s };
}

/** The floors of the last frame drawn (tests). */
export const isoFloors = (): IsoFloor[] => frame?.stack.floors ?? [];
