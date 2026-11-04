/**
 * ISO-PILOT renderer: the office as an isometric building, floors stacked from floor 1 up.
 *
 * The floor in focus is drawn live every frame: its static ground (pavement, slab, floor
 * tiles, the tall back walls) from a cache, then in depth order the cut walls, the furniture
 * and the characters, at the camera's zoom. Every floor has the deepest floor's plate and they
 * stack a storey apart (projection.ts): the floors below the focus are closed storeys (their
 * facade, facade.ts, one cached picture each, redrawn only when the building changes), the ones
 * above it are lifted off and drawn as a labelled outline, so nothing covers the floor in focus.
 * The lobby board stands outside as a billboard (billboard.ts), its text laid over by the
 * webview (LobbyBoard).
 *
 * Pieces come at densities 4, 2 and 1 (art.ts); each target draws the one that divides its
 * zoom into whole device px, nearest-neighbour: the same pixels, never blurred.
 *
 * Hit testing reads what this frame drew (`isoPick`): characters first, then furniture, by
 * their opaque pixels, then the floor tile under the point, then another floor as drawn.
 */
import type { BackgroundSettings } from '../../../../core/src/cld/background.js';
import { elevatorState } from '../../cld/elevator.js';
import {
  animationClock,
  cldCharacterDrawables,
  cldCharacterSprite,
  dimmedSprite,
  drinkingNow,
  idleDimmed,
} from '../../cld/ez/drawVisuals.js';
import { offAlpha } from '../../cld/ez/nameplate.js';
import { cldGetSnapshot, virtualAgentId } from '../../cld/officeStore.js';
import {
  BOARD_COLORS,
  CHARACTER_SITTING_OFFSET_PX,
  HEADLESS_CHARACTER_ALPHA,
  HOVERED_OUTLINE_ALPHA,
  IMPORT_DENSITY,
  IMPORT_WORLD_W,
  ISO_BILLBOARD,
  ISO_BILLBOARD_BODY,
  ISO_BILLBOARD_INK,
  ISO_CHARACTER_BOX,
  ISO_HALF_H,
  ISO_HALF_W,
  ISO_OCCLUSION_ALPHA,
  ISO_ROOF_H,
  ISO_SLAB_H,
  ISO_WALL_H,
  SELECTED_OUTLINE_ALPHA,
  STEAM_HELD_LEAN_PX,
} from '../../constants.js';
import { t as tr } from '../../i18n/index.js';
import { getCharacterSprite } from '../../office/engine/characters.js';
import { renderMatrixEffect } from '../../office/engine/matrixEffect.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import { isGhostHeadlessAgentsEnabled } from '../../office/engine/renderer.js';
import {
  getAnimationFrames,
  getCatalogEntry,
  getOnStateType,
} from '../../office/layout/furnitureCatalog.js';
import type { OverlayProjection } from '../../office/projection.js';
import { drawSmooth, isSmooth, smoothSize } from '../../office/sprites/smoothSprite.js';
import { getCachedSprite, getOutlineSprite } from '../../office/sprites/spriteCache.js';
import {
  getCharacterSprites,
  spritesAtZoom,
} from '../../office/sprites/spriteData.js';
import { warmCharacter } from '../../office/sprites/warm.js';
import type { Character, SpriteData } from '../../office/types.js';
import { CharacterState, Direction, TILE_SIZE } from '../../office/types.js';
import { drawIsoBackground } from '../gfx/bg/draw.js';
import { drinkCell, drinkCellsOf } from '../rest.js';
import { drawSteam } from '../steam.js';
import {
  artDensity,
  ISO_MANIFEST,
  type IsoArt,
  isoArt,
  type IsoImage,
  isoImages,
  playingFrame,
  type WallUse,
} from './art.js';
import { type BillboardBox, billboardBox } from './billboard.js';
import { drawClosedStorey, drawFocusBand, drawOutlines, inStorey, onFaces, onRoof } from './facade.js';
import { fadesForCharacter, type IsoScreenBox } from './occlusion.js';
import {
  type DepthBox,
  depthOrder,
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
import { drawnView, mirrorSprite } from './sprites.js';

/** Read-only counters for the runner: cache redraws, frames and the time they took. */
export const isoStats = { groundRenders: 0, storeyRenders: 0, frames: 0, ms: 0 };

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
    storeys.clear();
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
  const [x0, y0] = [wall.start[0] / a.k, wall.start[1] / a.k];
  const sx = use.mirror ? w - x0 - (j + 1) * tile : x0 + j * tile;
  const ax = use.mirror ? sx : sx + tile;
  const ay = y0 + (j + 1) * drop;
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

/** The pavement round floor 1, a little under its slab. */
function drawPavement(t: Target, stack: IsoStack, imgs: Map<string, IsoImage>) {
  const rows = stack.depth;
  for (let r = -PAVE; r < rows + PAVE; r++)
    for (let c = -PAVE; c < stack.cols + PAVE; c++)
      if (c < 0 || r < 0 || c >= stack.cols || r >= rows)
        put(t, imgs, 'pavement', isoAt(c + 1, r + 1, 0, stack.lifts), -ISO_SLAB_H);
}

/** The pavement, slab, floor and tall walls of a floor: what nothing on it stands behind. */
function drawGround(t: Target, stack: IsoStack, scene: IsoFloorScene, imgs: Map<string, IsoImage>) {
  const { level } = scene.floor;
  const front = (c: number, r: number) => isoAt(c + 1, r + 1, level, stack.lifts);
  // Every floor has the building's plate: a shallower one's extra rows are bare floor.
  const rows = stack.depth;
  if (level === 0) drawPavement(t, stack, imgs);
  // The plate: bare floor where no room is (never walked: the layout has no tile there), the
  // slab's two outer faces under its front edges.
  const covered = new Set(scene.tiles.map((x) => `${x.col},${x.row}`));
  for (const w of scene.walls) if (!w.tall) covered.add(`${w.col},${w.row}`);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < stack.cols; c++)
      if (!covered.has(`${c},${r}`)) put(t, imgs, ISO_MANIFEST.floors.default, front(c, r));
  for (let c = 0; c < stack.cols; c++) put(t, imgs, 'slab-row', front(c, rows - 1));
  for (let r = 0; r < rows; r++) put(t, imgs, 'slab-col', front(stack.cols - 1, r));
  for (const x of scene.tiles) put(t, imgs, x.piece, front(x.col, x.row));
  // iso-prep-1104: a rug lies on the floor, under whoever walks over it.
  for (const it of scene.items)
    if (it.piece?.flat)
      put(
        t,
        imgs,
        ISO_MANIFEST.types[it.type].piece,
        isoAt(it.c1, it.r1, level, stack.lifts),
        0,
        it.mirror,
      );
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
interface Drawn extends DepthBox, IsoScreenBox {
  draw: (t: Target) => void;
  /** The art geometry for the overlap pass (top-down fallback sprites have none). */
  artName?: string;
  artFront?: Pt;
  artLift?: number;
  artMirror?: boolean;
  /** A character never fades another character. */
  character?: boolean;
  faded: boolean;
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

/** Refresh a piece's iso-pixel box at the target's selected art density, without allocating. */
function measureDrawn(d: Drawn, t: Target, imgs: Map<string, IsoImage>): void {
  if (!d.artName || !d.artFront) return;
  const a = isoArt(imgs, d.artName, t.d);
  if (!a) return;
  const ax = d.artMirror ? a.img.w - a.ax : a.ax;
  d.x = d.artFront.x - ax / a.d;
  d.y = d.artFront.y - a.ay / a.d - (d.artLift ?? 0);
  d.w = a.img.w / a.d;
  d.h = a.img.h / a.d;
}

function wallDrawns(scene: IsoFloorScene, stack: IsoStack, imgs: Map<string, IsoImage>): Drawn[] {
  return scene.walls
    .filter((w) => !w.tall)
    .map((w) => {
      const front = isoAt(w.col + 1, w.row + 1, scene.floor.level, stack.lifts);
      const d: Drawn = {
        c0: w.col,
        r0: w.row,
        c1: w.col + 1,
        r1: w.row + 1,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        faded: false,
        artName: ISO_MANIFEST.walls.low,
        artFront: front,
        draw: (t) => put(t, imgs, ISO_MANIFEST.walls.low, front),
      };
      return d;
    });
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
      const d: Drawn = {
        c0: e.col,
        r0: r,
        c1: e.col + 2,
        r1: r + 1,
        lift: 1,
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        faded: false,
        artName: name,
        artFront: front,
        draw: (t: Target) => put(t, imgs, name, front),
      };
      return d;
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
    if (it.piece?.flat) continue; // drawn with the ground
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
        x: 0,
        y: 0,
        w: 0,
        h: 0,
        faded: false,
        artName: piece,
        artFront: front,
        artLift: lift,
        artMirror: mirror,
        draw: (t) => {
          // C1: a machine in use plays its frames (the states the top-down office shows)
          const def = ISO_MANIFEST.pieces[piece];
          const n = def?.frames?.length ?? 0;
          const k = n
            ? playingFrame(os.cldPantry.get(it.uid), getAnimationFrames(getOnStateType(it.type)), n)
            : 0;
          const a = isoArt(imgs, piece, t.d, k);
          if (!a) return;
          const at = artAt(a, front, lift, mirror);
          drawArt(t, a, at, mirror);
          // its full cup steams (the last frame)
          if (def?.steam && k === n - 1) {
            const [stx, sty] = [def.steam[0] / a.k, def.steam[1] / a.k];
            const sx = mirror ? a.img.w - stx : stx;
            drawSteam(
              t.ctx,
              t.o.x + (at.x + sx / a.d) * t.s,
              t.o.y + (at.y + sty / a.d) * t.s,
              t.s,
              animationClock(),
            );
          }
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
      x,
      y,
      w,
      h,
      faded: false,
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
    // SHEET-IMPORT: a preset's own isometric sheet when it has one beside its top view; CHAR-8DIR:
    // with both, the top view's front, back and sides for the screen's straight directions;
    // DIAG-1104: a walk-only one (a built-in person, a mascot) seated or drinking keeps its four
    const drinking = drinkingNow(ch);
    const view = drawnView(ch, true, !!drinking);
    const all = getCharacterSprites(view.palette, ch.hueShift);
    const sprites = spritesAtZoom(all, s);
    // PAGE-MEM: only the variants it draws as now (dimmed while idle, or not), both facings
    const dim = idleDimmed(ch.id);
    warmCharacter(
      sprites,
      s / sprites.density,
      (f) => (dim ? [dimmedSprite(f), dimmedSprite(mirrorSprite(f))] : [f, mirrorSprite(f)]),
      ch.id,
      dim ? 'dim' : '',
    );
    // C1: drinking in the three-quarter front view, a sheet with a drink row shows its own pose
    const cells = drinking && view.dir === Direction.DOWN ? drinkCellsOf(view.palette) : undefined;
    const cell = cells && drinking ? drinkCell(drinking.drink, drinking.sec, drinking.total) : -1;
    const steam = cells?.steam[cell] ?? null;
    // The row the facing asks, mirrored for the other diagonal (sprites.ts).
    const frame = cells ? cells.cells[cell] : getCharacterSprite({ ...ch, dir: view.dir }, sprites);
    const sprite: SpriteData = cldCharacterSprite(ch.id, view.mirror ? mirrorSprite(frame) : frame);
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
      x: feet.x - w / 2,
      y: feet.y - h,
      w,
      h,
      character: true,
      faded: false,
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
        // INHERIT: the 계승's ghost is this frame again, shifted
        const figure = (c: CanvasRenderingContext2D, ox: number, oy: number) =>
          cached ? c.drawImage(cached, dx + ox, dy + oy) : drawSmooth(c, sprite, scale, dx + ox, dy + oy);
        const extras = cldCharacterDrawables(ch, dx + cw / 2, dy + chh, t.s, 0, alpha, !!cells, figure);
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
        if (steam) {
          // the held cup's steam (cell px at the imported sheet's density)
          const k = t.s / IMPORT_DENSITY;
          const cellW = IMPORT_WORLD_W * IMPORT_DENSITY;
          const sx = view.mirror ? cellW - steam[0] : steam[0];
          const lean = Math.sign(sx - cellW / 2) * STEAM_HELD_LEAN_PX; // away from the face
          drawSteam(ctx, dx + sx * k, dy + steam[1] * k, t.s, animationClock(), lean);
        }
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

/** Measure once, then fade only pictures painted over a character they cover. */
function drawDepthList(
  list: Drawn[],
  t: Target,
  imgs: Map<string, IsoImage>,
  recordHits: boolean,
): void {
  for (const item of list) measureDrawn(item, t, imgs);
  for (let i = 0; i < list.length; i++) {
    const character = list[i];
    if (!character.character || character.w <= 0 || character.h <= 0) continue;
    for (let j = i + 1; j < list.length; j++) {
      const object = list[j];
      if (
        !object.character &&
        !object.faded &&
        object.w > 0 &&
        object.h > 0 &&
        fadesForCharacter(i, j, character, object)
      )
        object.faded = true;
    }
  }
  for (const item of list) {
    if (item.faded) {
      t.ctx.save();
      t.ctx.globalAlpha = ISO_OCCLUSION_ALPHA;
      item.draw(t);
      t.ctx.restore();
    } else item.draw(t);
    if (recordHits && item.hit) hits.push(item.hit);
  }
}

// ── Caches ───────────────────────────────────────────────────

interface FloorCache {
  canvas: HTMLCanvasElement;
  key: string;
}
const ground = new Map<string, FloorCache>();
/** Floor 1's pavement while another floor is in focus, at the density drawn. */
const pavement = new Map<string, FloorCache>();
/** The closed storeys, at density 1 (their facade is drawn in iso px). */
const storeys = new Map<string, FloorCache>();

/** A floor's cache bounds (iso px): its plate and walls (and a roof), the pavement for floor 1. */
function cacheBox(stack: IsoStack, level: number): IsoStack['box'] {
  const lift = stack.lifts[level] ?? 0;
  return {
    x0: -(stack.depth + PAVE) * ISO_HALF_W,
    x1: (stack.cols + PAVE + 1) * ISO_HALF_W,
    y0: -lift - ISO_WALL_H - ISO_ROOF_H - 2 * ISO_HALF_H,
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
    c = { canvas: document.createElement('canvas'), key: '' };
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

/** Draw into a cache once per `key` (the art density, the palette...). */
function filled(c: FloorCache, key: string, paint: (ctx: CanvasRenderingContext2D) => void): FloorCache {
  if (c.key === key) return c;
  const ctx = c.canvas.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.canvas.width, c.canvas.height);
  ctx.imageSmoothingEnabled = false;
  paint(ctx);
  c.key = key;
  return c;
}

// ── The frame ────────────────────────────────────────────────

let hits: Hit[] = [];
let frame: {
  o: Pt;
  s: number;
  stack: IsoStack;
  focus: IsoFloor;
  scenes: IsoFloorScene[];
  billboard: BillboardBox;
} | null = null;

export interface IsoSelection {
  selected: number | null;
  hovered: number | null;
  follow: number | null;
}

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
  /** BACKGROUND: the surroundings drawn under the building (null: the plain void). */
  background: { settings: BackgroundSettings; night: boolean } | null = null,
): boolean {
  const imgs = isoImages();
  ctx.clearRect(0, 0, w, h);
  if (!imgs) return false;
  const started = performance.now();
  const { stack, scenes } = isoScene(os);
  const focus = stack.floors.find((f) => f.id === focusId) ?? stack.floors[0];
  const o = isoOrigin({ w, h }, centre, zoom, pan);
  if (background)
    drawIsoBackground(ctx, w, h, o, zoom, stack, background.settings, background.night);
  const chars = os.getCharacters();
  const live = target(ctx, o, zoom);
  const night = background?.night ?? false;
  hits = [];
  ctx.imageSmoothingEnabled = false;
  const blit = (c: FloorCache, box: IsoStack['box'], d: number) =>
    ctx.drawImage(
      c.canvas,
      o.x + box.x0 * zoom,
      o.y + box.y0 * zoom,
      (c.canvas.width * zoom) / d,
      (c.canvas.height * zoom) / d,
    );
  const top = stack.floors.length - 1;
  const above: Array<{ lift: number; top: boolean; label: string }> = [];
  for (const scene of scenes) {
    const { floor } = scene;
    const box = cacheBox(stack, floor.level);
    const lift = stack.lifts[floor.level] ?? 0;
    if (floor.level > focus.level) {
      // Lifted off: drawn as an outline after the floors, labelled, so they can be counted.
      above.push({ lift, top: floor.level === top, label: tr('iso.floorLabel', { n: floor.level + 1 }) });
      continue;
    }
    if (floor.level < focus.level) {
      if (floor.level === 0) {
        const d = live.d;
        const pc = cacheCanvas(pavement, floor.id, box, d);
        blit(filled(pc, String(d), (c) => drawPavement(target(c, { x: -box.x0 * d, y: -box.y0 * d }, d), stack, imgs)), box, d);
      }
      const sc = cacheCanvas(storeys, floor.id, box, 1);
      const key = `${night}`;
      if (sc.key !== key) isoStats.storeyRenders++;
      filled(sc, key, (c) => {
        c.setTransform(1, 0, 0, 1, -box.x0, -box.y0);
        drawClosedStorey(c, stack.cols, stack.depth, lift, {
          lobby: floor.level === 0,
          roof: false,
          focus: false,
          night,
          seed: floor.level,
        });
      });
      blit(sc, box, 1);
      continue;
    }
    // The ground at the density this zoom draws (its cache is redrawn when that changes).
    const d = live.d;
    const g = cacheCanvas(ground, floor.id, box, d);
    if (g.key !== `${d}|${night}`) isoStats.groundRenders++;
    filled(g, `${d}|${night}`, (c) => {
      drawGround({ ctx: c, o: { x: -box.x0 * d, y: -box.y0 * d }, s: d, d }, stack, scene, imgs);
      // The floor in focus wears its slab band in the accent.
      c.setTransform(d, 0, 0, d, -box.x0 * d, -box.y0 * d);
      drawFocusBand(c, stack.cols, stack.depth, lift, night);
    });
    blit(g, box, d);
    const pieces = [...wallDrawns(scene, stack, imgs), ...itemDrawns(scene, stack, imgs, os)];
    const list = depthOrder([...pieces, ...characterDrawns(chars, stack, floor, sel, zoom)], pieces.length);
    drawDepthList(list, live, imgs, true);
  }
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
  drawOutlines(ctx, o, zoom, dpr, stack.cols, stack.depth, stack.lifts[focus.level] ?? 0, above, night);
  const billboard = billboardBox(stack);
  drawBillboard(live, billboard, dpr, night);
  frame = { o, s: zoom, stack, focus, scenes, billboard };
  isoStats.frames++;
  isoStats.ms += performance.now() - started;
  return true;
}

/**
 * The billboard (owner 11-04 21:04: more 3D, the screen still level so it reads): its shadow on
 * the ground, the posts (a lit and a shaded side, a cap), the case's top and right side at the
 * iso angle, the screen's glow, then the frame with a light upper and a dark lower edge. The
 * screen inside the frame is the webview's (LobbyBoard lays the old board's own screen there);
 * dark here until it does.
 */
function drawBillboard(t: Target, b: BillboardBox, dpr: number, night: boolean): void {
  const { ctx, o, s } = t;
  const B = ISO_BILLBOARD_BODY;
  const K = ISO_BILLBOARD_INK;
  const X = (x: number) => Math.round(o.x + x * s);
  const Y = (y: number) => Math.round(o.y + y * s);
  const poly = (pts: Array<[number, number]>, fill: string) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))));
    ctx.closePath();
    ctx.fill();
  };
  const { dx, dy } = B.shadow;
  poly(
    [
      [b.x0, b.ground],
      [b.x1, b.ground],
      [b.x1 + dx, b.ground + dy],
      [b.x0 + dx, b.ground + dy],
    ],
    K.shadow,
  );
  const half = B.post / 2;
  for (const px of b.posts) {
    ctx.fillStyle = K.post;
    ctx.fillRect(X(px - half), Y(b.y1), X(px) - X(px - half), Y(b.ground) - Y(b.y1));
    ctx.fillStyle = K.postShade;
    ctx.fillRect(X(px), Y(b.y1), X(px + half) - X(px), Y(b.ground) - Y(b.y1));
    ctx.fillStyle = K.postCap;
    ctx.fillRect(X(px - half), Y(b.ground) - Math.max(1, Math.round(s)), X(px + half) - X(px - half), Math.max(1, Math.round(s)));
  }
  const d = B.depth;
  poly(
    [
      [b.x0, b.y0],
      [b.x1, b.y0],
      [b.x1 + d, b.y0 - d / 2],
      [b.x0 + d, b.y0 - d / 2],
    ],
    K.top,
  );
  poly(
    [
      [b.x1, b.y0],
      [b.x1 + d, b.y0 - d / 2],
      [b.x1 + d, b.y1 - d / 2],
      [b.x1, b.y1],
    ],
    K.side,
  );
  // The glow, outermost ring faintest, then the frame and its bevel.
  const [x0, y0, x1, y1] = [X(b.x0), Y(b.y0), X(b.x1), Y(b.y1)];
  const glow = night ? K.glowNight : K.glowDay;
  const ring = Math.max(1, Math.round(B.glow * dpr));
  glow.forEach((c, i) => {
    const g = (glow.length - i) * ring;
    ctx.fillStyle = c;
    ctx.fillRect(x0 - g, y1, x1 - x0 + 2 * g, g);
    ctx.fillRect(x0 - g, y0, g, y1 - y0);
  });
  ctx.fillStyle = K.frame;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  const e = Math.max(1, Math.round(dpr));
  ctx.fillStyle = K.frameLight;
  ctx.fillRect(x0, y0, x1 - x0, e);
  ctx.fillRect(x0, y0, e, y1 - y0);
  ctx.fillStyle = K.frameDark;
  ctx.fillRect(x0, y1 - e, x1 - x0, e);
  ctx.fillRect(x1 - e, y0, e, y1 - y0);
  const f = Math.round(ISO_BILLBOARD.frame * s);
  ctx.fillStyle = BOARD_COLORS.screen;
  ctx.fillRect(x0 + f, y0 + f, x1 - x0 - 2 * f, y1 - y0 - 2 * f);
}

/** Device px box of a character as the last frame drew it (a test aims a press at it). */
export function isoCharacterBox(id: number): { x: number; y: number; w: number; h: number } | null {
  if (!frame) return null;
  const h = hits.find((x) => x.kind === 'character' && x.id === id);
  return h
    ? {
        x: frame.o.x + h.x * frame.s,
        y: frame.o.y + h.y * frame.s,
        w: h.w * frame.s,
        h: h.h * frame.s,
      }
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
  // The floor in focus as drawn (its plate and back walls) keeps the click; elsewhere a floor is
  // where the building would show it closed: a storey's front faces, the roof on the top one.
  const { cols, depth, lifts } = f.stack;
  if (inStorey(cols, depth, lifts[f.focus.level] ?? 0, ix, iy)) return null;
  const floors = f.stack.floors;
  const top = floors.length - 1;
  if (top > f.focus.level && onRoof(cols, depth, lifts[top] ?? 0, ix, iy))
    return { kind: 'floor', id: floors[top].id };
  for (const fl of floors)
    if (fl !== f.focus && onFaces(cols, depth, lifts[fl.level] ?? 0, ix, iy))
      return { kind: 'floor', id: fl.id };
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

/** The billboard's screen in the last frame (inside its frame; CSS px of the canvas), where the
 *  webview lays the old board's screen; null when no frame is drawn. */
export function isoBillboard(dpr: number): { left: number; top: number; width: number; height: number } | null {
  if (!frame) return null;
  const { o, s, billboard: b } = frame;
  const f = ISO_BILLBOARD.frame;
  const x = Math.round(o.x + (b.x0 + f) * s);
  const y = Math.round(o.y + (b.y0 + f) * s);
  return {
    left: x / dpr,
    top: y / dpr,
    width: (Math.round(o.x + (b.x1 - f) * s) - x) / dpr,
    height: (Math.round(o.y + (b.y1 - f) * s) - y) / dpr,
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
