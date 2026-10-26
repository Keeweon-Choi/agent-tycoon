/**
 * LOUNGE (owner 10-25 23:16-23:20, 10-26 11:36): off duty, an orchestrator does not leave the
 * building: it rests in the 휴게실 (a sofa or bench seat, else a free tile, else its own desk), mostly
 * still and dozing, and now and then walks to the pantry's coffee machine, vending machine or
 * water cooler for a drink. It stays 퇴근 (cards, messenger, nameplate); back on duty it walks
 * from where it is to its desk. The owner can drag it anywhere (a seat, another room, another
 * floor by elevator); its desk never changes. Temps leave through the door as before.
 *
 * `ch.cldRest` is the state; OfficeState.update hands a resting character to `restStep` every
 * frame (cheap: one timer) except while it walks, which is the FSM's (and the elevator's). The
 * seat the character rests on is NOT its `seatId` (that stays its desk: nothing here is ever
 * saved as its seat); a rest spot is claimed by `spot.seat`/`spot.tile` of its Rest.
 *
 * DOM-free on purpose: upstream officeState.ts imports it (the Node build of webview-ui/test).
 */
import {
  ELEVATOR_VISIT_NEAR_TILES,
  LOUNGE_DRINK_MAX_SEC,
  LOUNGE_DRINK_MIN_SEC,
  LOUNGE_DRINK_STEP_SEC,
  LOUNGE_DRINK_STEPS,
  LOUNGE_DROP_NEAR_TILES,
  LOUNGE_USE_SEC,
} from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import {
  getAnimationFrames,
  getCatalogEntry,
  getOnStateType,
} from '../office/layout/furnitureCatalog.js';
import { findPath, isWalkable } from '../office/layout/tileMap.js';
import type { PlacedFurniture } from '../office/types.js';
import { type Character, CharacterState, Direction, TILE_SIZE, TileType } from '../office/types.js';
import { floorIndexAt, floorRects } from './walk.js';

type Tile = { col: number; row: number };

// ── Zones ────────────────────────────────────────────────────

/** The lounge's label ends so on every floor (server/src/cld/layout.ts LOUNGE_ROOM). */
export const LOUNGE_SUFFIX = '\uD734\uAC8C\uC2E4';
/** What it was called before LOUNGE (a floor's own saved layout may still say so), and the pantry corner. */
const LOUNGE_ZONES = [LOUNGE_SUFFIX, '\uB77C\uC6B4\uC9C0', '\uD0D5\uBE44\uC2E4'];
/** The lobby's label ends so (LOBBY_ROOM). Its benches count as rest seats on floor 1. */
const LOBBY_SUFFIX = '\uB85C\uBE44';
/** Whether an area label is the lounge's (or its pantry corner's), on any floor. */
export const isLoungeZone = (zone: string | null | undefined): boolean =>
  !!zone && LOUNGE_ZONES.some((z) => zone.endsWith(z));
const isRestZone = (zone: string | null | undefined): boolean =>
  isLoungeZone(zone) || (!!zone && zone.endsWith(LOBBY_SUFFIX));

// ── The pantry ───────────────────────────────────────────────

export type PantryKind = 'coffee' | 'vending' | 'water';
/** The catalog type of each machine (webview-ui/public/assets/furniture/<TYPE>/). */
export const PANTRY_TYPE: Record<PantryKind, string> = {
  coffee: 'COFFEE_MACHINE',
  vending: 'VENDING_MACHINE',
  water: 'WATER_COOLER',
};
const KIND_OF = new Map(Object.entries(PANTRY_TYPE).map(([k, t]) => [t, k as PantryKind]));

/** Seconds a machine plays its states while someone gets a drink. */
export const playSec = (kind: PantryKind): number =>
  LOUNGE_USE_SEC[kind].reduce((a, b) => a + b, 0);
/** The state (0, 1, 2) a machine shows `t` seconds into its use. */
export function playState(kind: PantryKind, t: number): number {
  let end = 0;
  const steps = LOUNGE_USE_SEC[kind];
  for (const [i, sec] of steps.entries()) {
    end += sec;
    if (t < end) return i;
  }
  return steps.length - 1;
}

/** Seconds the drinking sequence takes. */
export const DRINK_SEC = LOUNGE_DRINK_STEPS * LOUNGE_DRINK_STEP_SEC;

export type PropName = 'can' | 'canTilt' | 'mug' | 'paperCup';
export interface DrinkPose {
  /** 0-6, the owner's reference frames: stand, hold, open (can) or raise (mug), drink, drink
   *  tilted back, hold, smile. */
  step: number;
  /** What is in hand, and its centre: x from the figure's centre, y from the top of its drawn box,
   *  both in classic figure px (26 px tall; the drawing scales them to the figure). */
  prop: { name: PropName; at: [number, number] } | null;
  /** The hiss of an opening can, and the steam of hot coffee (over the head, drifting). */
  hiss: [number, number] | null;
  steam: [number, number] | null;
}

/** Where the prop is at each step of the drinking sequence (the owner's references, front view). */
export function drinkPose(kind: PantryKind, t: number): DrinkPose {
  const step = Math.min(LOUNGE_DRINK_STEPS - 1, Math.max(0, Math.floor(t / LOUNGE_DRINK_STEP_SEC)));
  if (kind === 'vending') {
    const hold: [number, number] = [6, 17];
    const prop = (name: PropName, at: [number, number]) => ({ name, at });
    return {
      step,
      prop:
        step === 0
          ? null
          : step === 3
            ? prop('canTilt', [2, 11])
            : step === 4
              ? prop('canTilt', [2, 10])
              : prop('can', step === 2 ? [4, 15] : hold),
      hiss: step === 2 ? [7, 9] : null,
      steam: null,
    };
  }
  const name: PropName = kind === 'water' ? 'paperCup' : 'mug';
  const low: [number, number] = [2, 18];
  const at: [number, number] = step === 2 ? [3, 14] : step === 3 ? [3, 11] : low;
  return {
    step,
    prop: step === 0 ? null : { name, at },
    hiss: null,
    steam: kind === 'coffee' && step === 3 ? [3, -4] : null,
  };
}

// ── State ────────────────────────────────────────────────────

export interface RestSpot {
  tile: Tile;
  /** The seat it sits on (a sofa, a bench, its own desk), or null: it stands. */
  seat: string | null;
}
export interface Rest {
  /** go: on its way (or just arrived) to its spot; rest: at it; fetch: on its way to a machine;
   *  use: at the machine, which plays its states; drink: the drinking sequence. */
  phase: 'go' | 'rest' | 'fetch' | 'use' | 'drink';
  /** Seconds in this phase. */
  t: number;
  spot: RestSpot;
  /** Resting: seconds to its next drink. */
  next: number;
  kind?: PantryKind;
  machine?: { uid: string; stand: Tile };
}

export const nextDrinkIn = (rand: () => number = Math.random): number =>
  LOUNGE_DRINK_MIN_SEC + rand() * (LOUNGE_DRINK_MAX_SEC - LOUNGE_DRINK_MIN_SEC);

const key = (t: Tile) => `${t.col},${t.row}`;
const here = (ch: Character): Tile => ({ col: ch.tileCol, row: ch.tileRow });
const same = (a: Tile, b: Tile) => a.col === b.col && a.row === b.row;
const dist = (a: Tile, b: Tile) => Math.abs(a.col - b.col) + Math.abs(a.row - b.row);

/** The rows of the floor `row` is on (the whole map with one floor). */
function band(os: OfficeState, row: number): { top: number; bottom: number } {
  const rects = floorRects(os.layout);
  const k = rects ? floorIndexAt(rects, row) : -1;
  return rects && k >= 0
    ? { top: rects[k].row, bottom: rects[k].row + rects[k].rows }
    : { top: 0, bottom: os.tileMap.length };
}
const zoneAt = (os: OfficeState, t: Tile): string | null =>
  os.layout.areaTiles?.[t.row * os.layout.cols + t.col] ?? null;
/** On the floor's outer edge (next to the void): where the office door is, never a place to rest. */
function onEdge(os: OfficeState, t: Tile, b: { top: number; bottom: number }): boolean {
  return [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ].some(([dc, dr]) => {
    const [c, r] = [t.col + dc, t.row + dr];
    return (
      r < b.top ||
      r >= b.bottom ||
      os.tileMap[r]?.[c] === undefined ||
      os.tileMap[r][c] === TileType.VOID
    );
  });
}

/** What other characters hold: the seats and tiles they rest on, stand on or head for. */
function claimedBy(os: OfficeState, self: number): { seats: Set<string>; tiles: Set<string> } {
  const seats = new Set<string>();
  const tiles = new Set<string>();
  for (const c of os.characters.values()) {
    if (c.id === self || c.cldAway) continue;
    tiles.add(key(here(c)));
    const r = c.cldRest;
    if (!r) continue;
    if (r.spot.seat) seats.add(r.spot.seat);
    tiles.add(key(r.spot.tile));
    if (r.machine) tiles.add(key(r.machine.stand));
  }
  return { seats, tiles };
}

/** Path to a tile, which may be a seat (blocked to all but its sitter); elevators included. */
function pathTo(os: OfficeState, from: Tile, to: Tile): Tile[] {
  const blocked = new Set(os.blockedTiles);
  blocked.delete(key(to));
  return findPath(from.col, from.row, to.col, to.row, os.tileMap, blocked, os.cldLinks);
}
const reachable = (os: OfficeState, from: Tile, to: Tile) =>
  same(from, to) || pathTo(os, from, to).length > 0;

function walkTo(os: OfficeState, ch: Character, to: Tile): boolean {
  const path = pathTo(os, here(ch), to);
  if (!path.length) return false;
  ch.path = path;
  ch.moveProgress = 0;
  ch.state = CharacterState.WALK;
  ch.frame = 0;
  ch.frameTimer = 0;
  return true;
}

// ── Where to rest ────────────────────────────────────────────

/**
 * Where an off-duty character rests: a free sofa or bench seat on its floor (the lounge's, and
 * on floor 1 the lobby's), else a free tile in the lounge, else its own desk. The nearest one it
 * can walk to (by elevator when it stands on another floor). Never a spot another character
 * rests on or heads for.
 */
export function restSpotFor(os: OfficeState, ch: Character): RestSpot {
  const desk = ch.seatId ? os.seats.get(ch.seatId) : undefined;
  const b = band(os, desk?.seatRow ?? ch.tileRow);
  const from = here(ch);
  const taken = claimedBy(os, ch.id);
  const onFloor = (t: Tile) => t.row >= b.top && t.row < b.bottom;
  const seats = [...os.seats]
    .filter(
      ([uid, s]) =>
        !s.assigned &&
        !taken.seats.has(uid) &&
        !taken.tiles.has(key({ col: s.seatCol, row: s.seatRow })) &&
        onFloor({ col: s.seatCol, row: s.seatRow }) &&
        isRestZone(os.seatZone(uid)),
    )
    .map(([uid, s]) => ({ uid, tile: { col: s.seatCol, row: s.seatRow } }))
    .sort((a, c) => dist(from, a.tile) - dist(from, c.tile));
  for (const s of seats) if (reachable(os, from, s.tile)) return { tile: s.tile, seat: s.uid };
  const used = new Set(machinesOn(os, b).map((m) => key(m.stand)));
  const tiles = os.walkableTiles
    .filter(
      (t) =>
        onFloor(t) &&
        isLoungeZone(zoneAt(os, t)) &&
        !taken.tiles.has(key(t)) &&
        !used.has(key(t)) &&
        !onEdge(os, t, b),
    )
    .sort((a, c) => dist(from, a) - dist(from, c));
  for (const t of tiles) if (reachable(os, from, t)) return { tile: t, seat: null };
  if (desk && ch.seatId) return { tile: { col: desk.seatCol, row: desk.seatRow }, seat: ch.seatId };
  return { tile: from, seat: null };
}

interface Machine {
  kind: PantryKind;
  uid: string;
  /** The tile it is used from: the one below it. */
  stand: Tile;
}
/** The pantry machines on a floor that can be used (a free walkable tile in front). */
export function machinesOn(os: OfficeState, b: { top: number; bottom: number }): Machine[] {
  const out: Machine[] = [];
  for (const f of os.layout.furniture) {
    const kind = KIND_OF.get(f.type);
    if (!kind || f.row < b.top || f.row >= b.bottom) continue;
    const stand = { col: f.col, row: f.row + (getCatalogEntry(f.type)?.footprintH ?? 2) };
    if (isWalkable(stand.col, stand.row, os.tileMap, os.blockedTiles))
      out.push({ kind, uid: f.uid, stand });
  }
  return out;
}

// ── Start, end, move ─────────────────────────────────────────

/** A seated character sits (facing its seat's way), a standing one stands facing front. */
function settle(os: OfficeState, ch: Character, spot: RestSpot): void {
  const seat = spot.seat ? os.seats.get(spot.seat) : undefined;
  ch.path = [];
  ch.moveProgress = 0;
  ch.frame = 0;
  ch.frameTimer = 0;
  if (seat) {
    ch.state = CharacterState.TYPE;
    ch.dir = seat.facingDir;
  } else {
    ch.state = CharacterState.IDLE;
    ch.dir = Direction.DOWN;
  }
}

function put(ch: Character, t: Tile): void {
  ch.tileCol = t.col;
  ch.tileRow = t.row;
  ch.x = t.col * TILE_SIZE + TILE_SIZE / 2;
  ch.y = t.row * TILE_SIZE + TILE_SIZE / 2;
}

/** Off duty: the character goes to its rest spot (`instant`: it is already there, at a page's load). */
export function beginRest(os: OfficeState, ch: Character, opts: { instant?: boolean } = {}): void {
  const spot = restSpotFor(os, ch);
  const rest: Rest = { phase: 'go', t: 0, spot, next: nextDrinkIn() };
  ch.cldRest = rest;
  ch.isActive = false;
  if (opts.instant) {
    put(ch, spot.tile);
    settle(os, ch, spot);
    rest.phase = 'rest';
  } else if (!same(here(ch), spot.tile) && !walkTo(os, ch, spot.tile)) {
    rest.spot = { tile: here(ch), seat: null }; // no way there: where it stands
  }
}

/** Back on duty: the machine it was at is idle again; the caller sends it to its desk. */
export function endRest(os: OfficeState, ch: Character): void {
  const r = ch.cldRest;
  ch.cldRest = undefined;
  if (r) showMachine(os, r, null);
}

/** A machine's picture for state `state` (0-2), or its idle one (null). */
function showMachine(os: OfficeState, r: Rest, state: number | null): void {
  const m = r.machine;
  if (!m) return;
  const type = os.layout.furniture.find((f: PlacedFurniture) => f.uid === m.uid)?.type;
  const frames = type ? getAnimationFrames(getOnStateType(type)) : null;
  os.setPantryType(m.uid, state === null ? null : (frames?.[state] ?? null));
}

/** Pick a drink: a machine on its floor with a free tile in front it can walk to. */
function startDrink(os: OfficeState, ch: Character, r: Rest, rand: () => number): void {
  const taken = claimedBy(os, ch.id);
  const list = machinesOn(os, band(os, r.spot.tile.row))
    .filter((m) => !taken.tiles.has(key(m.stand)))
    .sort(() => rand() - 0.5);
  for (const m of list) {
    if (!same(here(ch), m.stand) && !walkTo(os, ch, m.stand)) continue;
    Object.assign(r, {
      phase: 'fetch',
      t: 0,
      kind: m.kind,
      machine: { uid: m.uid, stand: m.stand },
    });
    return;
  }
  r.next = nextDrinkIn(rand); // none free now: another time
}

/** Back to its spot (or, with no way, where it stands). */
function goBack(os: OfficeState, ch: Character, r: Rest): void {
  r.phase = 'go';
  r.t = 0;
  r.next = nextDrinkIn();
  r.machine = undefined;
  r.kind = undefined;
  if (!same(here(ch), r.spot.tile) && !walkTo(os, ch, r.spot.tile))
    r.spot = { tile: here(ch), seat: null };
}

/**
 * One frame of a resting character that is not walking (OfficeState.update). True: the frame is
 * done (the FSM must not stand it up and wander it off).
 */
export function restStep(
  os: OfficeState,
  ch: Character,
  dt: number,
  rand: () => number = Math.random,
): boolean {
  const r = ch.cldRest;
  if (!r) return false;
  if (ch.state === CharacterState.WALK && ch.path.length > 0) return false;
  r.t += dt;
  switch (r.phase) {
    case 'go':
      if (!same(here(ch), r.spot.tile)) {
        // Stopped short (a blocked path, a seat taken): try once more, else rest where it stands.
        if (r.t > 0 && !walkTo(os, ch, r.spot.tile)) r.spot = { tile: here(ch), seat: null };
        else return false;
      }
      settle(os, ch, r.spot);
      Object.assign(r, { phase: 'rest', t: 0, next: nextDrinkIn(rand) });
      break;
    case 'rest':
      if (r.spot.seat && !os.seats.has(r.spot.seat)) {
        // Its seat is gone (the layout changed): a new spot.
        r.spot = restSpotFor(os, ch);
        r.phase = 'go';
        r.t = 0;
        if (!same(here(ch), r.spot.tile) && !walkTo(os, ch, r.spot.tile))
          r.spot = { tile: here(ch), seat: null };
        break;
      }
      if (!same(here(ch), r.spot.tile)) {
        // Walked by hand (the arrow keys): it rests where it was left.
        r.spot = { tile: here(ch), seat: null };
        settle(os, ch, r.spot);
      }
      r.next -= dt;
      if (r.next <= 0) startDrink(os, ch, r, rand);
      break;
    case 'fetch':
      if (!r.machine || !same(here(ch), r.machine.stand)) {
        goBack(os, ch, r);
        return ch.state !== CharacterState.WALK;
      }
      ch.dir = Direction.UP; // the machine is above it
      ch.state = CharacterState.IDLE;
      ch.frame = 0;
      r.phase = 'use';
      r.t = 0;
      if (r.kind) showMachine(os, r, 0);
      break;
    case 'use':
      if (!r.kind) {
        goBack(os, ch, r);
        return ch.state !== CharacterState.WALK;
      }
      showMachine(os, r, r.t < playSec(r.kind) ? playState(r.kind, r.t) : null);
      if (r.t >= playSec(r.kind)) {
        ch.dir = Direction.DOWN; // the drink is taken facing front
        r.phase = 'drink';
        r.t = 0;
      }
      break;
    case 'drink':
      if (r.t >= DRINK_SEC) {
        goBack(os, ch, r);
        return ch.state !== CharacterState.WALK;
      }
      break;
  }
  return true;
}

// ── Dropping a resting character ─────────────────────────────

/** A new spot for a character the owner dropped on tile (col, row); false: nowhere to put it. */
export function restDropAt(os: OfficeState, ch: Character, col: number, row: number): boolean {
  const r = ch.cldRest;
  if (!r) return false;
  const taken = claimedBy(os, ch.id);
  const at = { col, row };
  const b = band(os, row);
  // A free seat: it sits there (its own desk counts, whoever else holds a seat does not).
  const seatUid = os.getSeatAtTile(col, row);
  const seat = seatUid ? os.seats.get(seatUid) : undefined;
  const mine = seatUid !== null && seatUid === ch.seatId;
  const seatFree =
    !!seat && !taken.seats.has(seatUid!) && !taken.tiles.has(key(at)) && (mine || !seat.assigned);
  let spot: RestSpot | null = seatFree ? { tile: at, seat: seatUid } : null;
  if (!spot) {
    const free = os.walkableTiles
      .filter((t) => t.row >= b.top && t.row < b.bottom && !taken.tiles.has(key(t)))
      .map((t) => ({ t, d: dist(t, at) }))
      .filter((x) => x.d <= LOUNGE_DROP_NEAR_TILES)
      .sort((p, q) => p.d - q.d);
    for (const { t } of free)
      if (reachable(os, here(ch), t)) {
        spot = { tile: t, seat: null };
        break;
      }
  }
  if (!spot) return false;
  showMachine(os, r, null);
  Object.assign(r, {
    phase: 'go',
    t: 0,
    next: nextDrinkIn(),
    machine: undefined,
    kind: undefined,
    spot,
  });
  if (!same(here(ch), spot.tile) && !walkTo(os, ch, spot.tile)) return false;
  if (same(here(ch), spot.tile)) {
    settle(os, ch, spot);
    r.phase = 'rest';
  }
  return true;
}

/** Dropped on another floor (a floor button, a click on the floor in the isometric view): near its elevator there. */
export function restDropFloor(os: OfficeState, ch: Character, floorId: string): boolean {
  const rects = floorRects(os.layout);
  const el = os.cldElevators?.find((e) => e.floor === floorId);
  const k = rects?.findIndex((x) => x.id === floorId) ?? -1;
  if (!ch.cldRest || !rects || !el || k < 0) return false;
  const taken = claimedBy(os, ch.id);
  const near = (t: Tile) => dist(t, el.front);
  const spots = os.walkableTiles.filter(
    (t) =>
      floorIndexAt(rects, t.row) === k &&
      !taken.tiles.has(key(t)) &&
      near(t) >= 2 &&
      near(t) <= ELEVATOR_VISIT_NEAR_TILES,
  );
  const spot = spots[Math.floor(Math.random() * spots.length)] ?? el.front;
  return restDropAt(os, ch, spot.col, spot.row);
}
