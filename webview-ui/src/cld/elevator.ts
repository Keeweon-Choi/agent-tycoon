/**
 * ELEVATOR (owner 10-25 22:40): characters really move between floors. Each floor of a
 * stacked office has an elevator set in a wall (its lounge's top wall, else the highest two
 * free wall tiles with floor in front), drawn as furniture so every view shows it. The
 * pathfinder links the tiles in front of the elevators (findPath `links`), so a walk to
 * another floor has one step that is a ride; OfficeState hands that step here: the rider
 * waits for the doors, steps in, the doors shut, it rides, the doors open on the other
 * floor, it steps out and walks on. No path ever crosses the void between floors.
 *
 * A visit (step 3): a character dropped on another floor rides there and stays (it wanders
 * there, or sits at a free seat there while it works) until it is dropped back on its own
 * floor or its next work starts; its own seat, room and floor stay. Per browser, like the
 * walk itself: nothing is sent.
 *
 * DOM-free on purpose: upstream officeState.ts imports it (the Node build of webview-ui/test).
 */
import {
  ELEVATOR_COLORS,
  ELEVATOR_DOOR_SEC,
  ELEVATOR_DOOR_WAIT_SEC,
  ELEVATOR_RIDE_PER_FLOOR_SEC,
  ELEVATOR_RIDE_SEC,
  ELEVATOR_STEP_SEC,
  ELEVATOR_VISIT_NEAR_TILES,
  WALK_FRAME_DURATION_SEC,
} from '../constants.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { isWalkable } from '../office/layout/tileMap.js';
import type {
  Character,
  FurnitureInstance,
  SpriteData,
  TileType as TileTypeVal,
} from '../office/types.js';
import { CharacterState, Direction, TILE_SIZE, TileType } from '../office/types.js';
import { floorIndexAt, floorRects } from './walk.js';

type Tile = { col: number; row: number };

export interface Elevator {
  /** Its floor's id (the layout's `cldFloors`). */
  floor: string;
  /** The left of the two wall tiles it is set in. */
  col: number;
  row: number;
  /** Where a rider waits and comes out: the floor tile in front of its left half. */
  front: Tile;
  /** The doors: 0 shut, 1 open. */
  open: number;
  /** What the renderer draws; its sprite follows the doors. */
  instance: FurnitureInstance;
}

export interface Ride {
  phase: 'call' | 'in' | 'close' | 'travel' | 'open' | 'out';
  /** Seconds in this phase. */
  t: number;
  /** Elevator indexes (OfficeState.cldElevators). */
  from: number;
  to: number;
  /** In the car with the doors shutting or shut: not drawn, not hit. */
  hidden: boolean;
}

export interface Visit {
  floor: string;
  /** The seat it goes back to. */
  homeSeat: string | null;
  /** isActive last frame: the next work (false to true) ends the visit. */
  active: boolean;
  /** It reached the floor it visits; back on another floor after that, the visit is over. */
  arrived: boolean;
}

/** "col,row" of an elevator's front tile -> the front tiles of the others. */
export type FloorLinks = Map<string, Tile[]>;

/** The generated lounge's label ends so on every floor (server/src/cld/layout.ts LOUNGE_ROOM). */
export const LOUNGE_SUFFIX = '\uB77C\uC6B4\uC9C0';
const SPRITE_W = 2 * TILE_SIZE;
const SPRITE_H = 30;
/** Door positions drawn between shut and open. */
const DOOR_STEPS = 4;

const tileKey = (t: Tile) => `${t.col},${t.row}`;
const same = (a: Tile | undefined, b: Tile) => !!a && a.col === b.col && a.row === b.row;
const centre = (t: Tile) => ({
  x: t.col * TILE_SIZE + TILE_SIZE / 2,
  y: t.row * TILE_SIZE + TILE_SIZE / 2,
});
/** Where a rider stands inside the car (world px, its feet). */
const inCar = (e: Elevator) => ({ x: (e.col + 1) * TILE_SIZE, y: e.front.row * TILE_SIZE + 1 });

// ── The picture ──────────────────────────────────────────────

let frames: SpriteData[] | null = null;
/** The elevator from shut (0) to open (DOOR_STEPS): a steel frame, the call lamp lit while
 *  the doors move or stand open, two doors sliding apart over the dark car. */
export function elevatorFrames(): SpriteData[] {
  if (frames) return frames;
  const C = ELEVATOR_COLORS;
  const half = (SPRITE_W - 6) / 2;
  frames = Array.from({ length: DOOR_STEPS + 1 }, (_, k) => {
    const shut = Math.round(half * (1 - k / DOOR_STEPS));
    return Array.from({ length: SPRITE_H }, (_, y) =>
      Array.from({ length: SPRITE_W }, (_, x) => {
        if (x < 2 || x >= SPRITE_W - 2 || y < 2) return C.frame;
        if (y < 7)
          return y >= 3 && y <= 4 && x >= half + 1 && x <= half + 4
            ? k
              ? C.lampOn
              : C.lampOff
            : C.frame;
        if (y === 7 || x === 2 || x === SPRITE_W - 3) return C.trim;
        const left = x - 3;
        const right = SPRITE_W - 4 - x;
        if (left < shut) return left === shut - 1 ? C.seam : C.door;
        if (right < shut) return right === shut - 1 ? C.seam : C.door;
        return C.car;
      }),
    );
  });
  return frames;
}

// ── Where ────────────────────────────────────────────────────

/** Each floor's elevator, or null in an office of one floor. The elevators are all at the same
 *  tile of their floors (the building's core: the isometric view's doors line up in one shaft);
 *  when no tile suits every floor, each floor takes its own best (and its doors do not line up).
 *  A floor with no two free wall tiles over free floor has none (and no way in or out). */
export function findElevators(
  layout: { cols: number; areaTiles?: Array<string | null> },
  tileMap: TileTypeVal[][],
  blocked: Set<string>,
): Elevator[] | null {
  const rects = floorRects(layout);
  if (!rects) return null;
  const cols = tileMap[0]?.length ?? 0;
  const wall = (c: number, r: number) =>
    tileMap[r]?.[c] === TileType.WALL && !blocked.has(`${c},${r}`);
  const free = (c: number, r: number) => isWalkable(c, r, tileMap, blocked);
  const lounge = (c: number, r: number) =>
    !!layout.areaTiles?.[r * layout.cols + c]?.endsWith(LOUNGE_SUFFIX);
  /** Per floor: the tiles (local row, left col) two free wall tiles over free floor allow. */
  const spots = rects.map((rect) => {
    const out: Tile[] = [];
    for (let r = rect.row; r < rect.row + rect.rows - 1; r++)
      for (let c = 0; c + 1 < cols; c++)
        if (wall(c, r) && wall(c + 1, r) && free(c, r + 1) && free(c + 1, r + 1))
          out.push({ col: c, row: r - rect.row });
    return out;
  });
  // The tile that suits the most floors, then the highest (the back wall), then a lounge in
  // front of it on the most floors, then the leftmost.
  const count = new Map<string, number>();
  const loungeFloors = new Map<string, number>();
  for (const [k, list] of spots.entries())
    for (const t of list) {
      const key = tileKey(t);
      count.set(key, (count.get(key) ?? 0) + 1);
      if (lounge(t.col, rects[k].row + t.row + 1))
        loungeFloors.set(key, (loungeFloors.get(key) ?? 0) + 1);
    }
  let core: Tile | null = null;
  let coreScore = -Infinity;
  for (const list of spots)
    for (const t of list) {
      const key = tileKey(t);
      const score =
        (count.get(key) ?? 0) * 1e9 - t.row * 1e5 + (loungeFloors.get(key) ?? 0) * 1e3 - t.col;
      if (score > coreScore) [core, coreScore] = [t, score];
    }
  const out: Elevator[] = [];
  for (const [k, rect] of rects.entries()) {
    const own = (): Tile | null => {
      // This floor's own best: its lounge's top wall, else the highest free wall tiles.
      const mid = (() => {
        let sum = 0;
        let n = 0;
        for (let r = rect.row; r < rect.row + rect.rows; r++)
          for (let c = 0; c < cols; c++) if (lounge(c, r)) [sum, n] = [sum + c, n + 1];
        return n ? sum / n : cols / 2;
      })();
      let best: Tile | null = null;
      let bestScore = Infinity;
      for (const t of spots[k]) {
        const score =
          (lounge(t.col, rect.row + t.row + 1) ? 0 : 1e6) + t.row * 1e3 + Math.abs(t.col + 1 - mid);
        if (score < bestScore) [best, bestScore] = [t, score];
      }
      return best;
    };
    const at = core && spots[k].some((t) => same(t, core!)) ? core : own();
    if (!at) continue;
    const row = rect.row + at.row;
    out.push({
      floor: rect.id ?? String(k + 1),
      col: at.col,
      row,
      front: { col: at.col, row: row + 1 },
      open: 0,
      instance: {
        sprite: elevatorFrames()[0],
        x: at.col * TILE_SIZE,
        y: (row + 1) * TILE_SIZE - SPRITE_H,
        // Over its wall, under whoever stands in front of it.
        zY: (row + 1) * TILE_SIZE + 0.5,
      },
    });
  }
  return out;
}

/** The pathfinder's links: every elevator's front to every other's. */
export function elevatorLinks(els: Elevator[] | null): FloorLinks | null {
  if (!els || els.length < 2) return null;
  return new Map(
    els.map((a) => [tileKey(a.front), els.filter((b) => b !== a).map((b) => b.front)]),
  );
}

// ── Riding ───────────────────────────────────────────────────

/** A path step that is not to a neighbour. */
const jumps = (from: Tile, to: Tile) =>
  Math.abs(to.col - from.col) + Math.abs(to.row - from.row) > 1;

function callOff(ch: Character, at?: Tile): void {
  ch.cldRide = undefined;
  ch.path = [];
  ch.moveProgress = 0;
  if (at) Object.assign(ch, { tileCol: at.col, tileRow: at.row });
  Object.assign(ch, centre({ col: ch.tileCol, row: ch.tileRow }));
}

/**
 * One frame of a character's ride, started when its next path step is the link from the
 * elevator it stands at to another; true while the ride holds it (the FSM waits). A walk
 * redirected before the car leaves (its next step is no longer that floor) calls it off.
 */
export function rideStep(ch: Character, dt: number, els: Elevator[] | null): boolean {
  let ride = ch.cldRide;
  if (!ride) {
    const next = ch.path[0];
    if (ch.state !== CharacterState.WALK || !next) return false;
    const at = { col: ch.tileCol, row: ch.tileRow };
    if (!jumps(at, next)) return false;
    const from = els?.findIndex((e) => same(at, e.front)) ?? -1;
    const to = els?.findIndex((e) => same(next, e.front)) ?? -1;
    if (from < 0 || to < 0) {
      callOff(ch); // a stale path (the office changed): never walk across the void
      return false;
    }
    ride = ch.cldRide = { phase: 'call', t: 0, from, to, hidden: false };
    ch.moveProgress = 0;
    Object.assign(ch, centre(at));
  }
  const a = els?.[ride.from];
  const b = els?.[ride.to];
  if (!a || !b) {
    callOff(ch);
    return false;
  }
  const goesOn = same(ch.path[0], b.front);
  const leaving = ride.phase === 'call' || ride.phase === 'in' || ride.phase === 'close';
  if (leaving && !goesOn) {
    // Told to go elsewhere before the car left: out again, on with the new walk.
    ch.cldRide = undefined;
    Object.assign(ch, centre(a.front));
    return false;
  }
  ride.t += dt;
  const step = Math.min(1, ride.t / ELEVATOR_STEP_SEC);
  const next = (phase: Ride['phase']) => {
    ride.phase = phase;
    ride.t = 0;
  };
  const stepping = (from: { x: number; y: number }, to: { x: number; y: number }) => {
    ch.x = from.x + (to.x - from.x) * step;
    ch.y = from.y + (to.y - from.y) * step;
    ch.frame = Math.floor(ride.t / WALK_FRAME_DURATION_SEC) % 4;
  };
  switch (ride.phase) {
    case 'call':
      ch.dir = Direction.UP;
      ch.frame = 1;
      if (a.open >= 1) next('in');
      else if (ride.t >= ELEVATOR_DOOR_WAIT_SEC) {
        callOff(ch, a.front);
        return false;
      }
      break;
    case 'in':
      stepping(centre(a.front), inCar(a));
      if (step >= 1) {
        ride.hidden = true;
        next('close');
      }
      break;
    case 'close':
      if (a.open <= 0) {
        ch.tileCol = b.front.col;
        ch.tileRow = b.front.row;
        Object.assign(ch, inCar(b));
        next('travel');
      } else if (ride.t >= ELEVATOR_DOOR_WAIT_SEC) {
        callOff(ch, a.front);
        return false;
      }
      break;
    case 'travel':
      if (ride.t >= ELEVATOR_RIDE_SEC + ELEVATOR_RIDE_PER_FLOOR_SEC * Math.abs(ride.to - ride.from))
        next('open');
      break;
    case 'open':
      if (b.open >= 1) {
        ride.hidden = false;
        ch.dir = Direction.DOWN;
        next('out');
      } else if (ride.t >= ELEVATOR_DOOR_WAIT_SEC) {
        callOff(ch, b.front);
        return false;
      }
      break;
    case 'out':
      stepping(inCar(b), centre(b.front));
      if (step >= 1) {
        ch.cldRide = undefined;
        ch.frame = 0;
        if (goesOn) ch.path.shift(); // else a new walk from here replaced it
      }
      break;
  }
  return true;
}

/** The doors, each frame: open while a rider waits or comes out, else shut. True while any moves. */
export function doorsStep(els: Elevator[] | null, chars: Iterable<Character>, dt: number): boolean {
  if (!els) return false;
  const want = new Set<number>();
  for (const ch of chars) {
    const r = ch.cldRide;
    if (r && (r.phase === 'call' || r.phase === 'in')) want.add(r.from);
    if (r && (r.phase === 'open' || r.phase === 'out')) want.add(r.to);
  }
  let moving = false;
  els.forEach((e, k) => {
    const target = want.has(k) ? 1 : 0;
    if (e.open === target) return;
    moving = true;
    const d = dt / ELEVATOR_DOOR_SEC;
    e.open = target ? Math.min(1, e.open + d) : Math.max(0, e.open - d);
  });
  return moving;
}

/** The top-down picture, one reader of the state above: each elevator's sprite shows its doors. */
export function drawElevators(els: Elevator[] | null): void {
  for (const e of els ?? []) e.instance.sprite = elevatorFrames()[Math.round(e.open * DOOR_STEPS)];
}

/**
 * The elevators as any renderer reads them (ELEVATOR; the top-down sprites are one reader, an
 * isometric view can be another): per floor, where its elevator stands and how open its doors
 * are; per rider, its ride's phase and seconds in it, the floors it rides from and to, and
 * whether the car holds it now. There is no shared car: each ride is its own trip, so "where
 * the car is" is the floor of a rider in 'travel' (from -> to over the phase's time) or, with
 * none, the floor whose doors are open. The queue at a floor: its riders in 'call'.
 */
export function elevatorState(os: Pick<OfficeState, 'cldElevators' | 'characters'>): {
  floors: Array<{ floor: string; col: number; row: number; front: Tile; open: number }>;
  riders: Array<{
    id: number;
    phase: Ride['phase'];
    t: number;
    from: string;
    to: string;
    inside: boolean;
  }>;
} {
  const els = os.cldElevators ?? [];
  return {
    floors: els.map(({ floor, col, row, front, open }) => ({ floor, col, row, front, open })),
    riders: [...os.characters.values()].flatMap((ch) => {
      const r = ch.cldRide;
      const [a, b] = [els[r?.from ?? -1], els[r?.to ?? -1]];
      return r && a && b
        ? [{ id: ch.id, phase: r.phase, t: r.t, from: a.floor, to: b.floor, inside: r.hidden }]
        : [];
    }),
  };
}

/**
 * A new office (a room moved, a floor added, or the same one again): everyone stays where it
 * stood on its floor, shifted with the floor's rows. While no floor moved, a ride under way
 * goes on (its elevators found again by where they stand, the doors as they were); once one
 * did, a ride and a walk that would cross floors on the old rows are called off.
 */
export function carryAcrossFloors(
  before: object,
  after: object,
  chars: Iterable<Character>,
  oldEls: Elevator[] | null,
  newEls: Elevator[] | null,
): void {
  const was = floorRects(before);
  const now = floorRects(after);
  if (!was) return;
  // A stacked office becoming one floor has no rects or elevators to map a ride through.
  // Cancel every cross-floor walk before OfficeState seats or relocates the visible character.
  if (!now) {
    for (const ch of chars) {
      let from = { col: ch.tileCol, row: ch.tileRow };
      const crosses = ch.path.some((t) => {
        const jump = jumps(from, t);
        from = t;
        return jump;
      });
      if (ch.cldRide || crosses) callOff(ch);
    }
    return;
  }
  const sameAt = (e: Elevator | undefined) =>
    newEls?.findIndex((n) => !!e && n.floor === e.floor && same(n.front, e.front)) ?? -1;
  newEls?.forEach((n) => {
    const old = oldEls?.find((o) => o.floor === n.floor && same(o.front, n.front));
    if (!old) return;
    n.open = old.open;
  });
  const moved =
    was.length !== now.length || was.some((r, k) => r.id !== now[k].id || r.row !== now[k].row);
  for (const ch of chars) {
    const k = floorIndexAt(was, ch.tileRow);
    const to = k >= 0 ? now.find((r) => r.id === was[k].id) : undefined;
    const d = to ? to.row - was[k].row : 0;
    let from = { col: ch.tileCol, row: ch.tileRow };
    const crosses = ch.path.some((t) => {
      const j = jumps(from, t);
      from = t;
      return j;
    });
    const ride = ch.cldRide;
    if (ride && !moved) {
      const [a, b] = [sameAt(oldEls?.[ride.from]), sameAt(oldEls?.[ride.to])];
      if (a >= 0 && b >= 0) [ride.from, ride.to] = [a, b];
      else callOff(ch);
    }
    // Its floor shrank under it: the nearest row still on it (OfficeState finds floor there).
    const row = to ? Math.min(Math.max(ch.tileRow + d, to.row), to.row + to.rows - 1) : ch.tileRow;
    if ((moved && (ch.cldRide || crosses)) || row !== ch.tileRow) callOff(ch);
    if (row === ch.tileRow) continue;
    ch.y += (row - ch.tileRow) * TILE_SIZE;
    ch.tileRow = row;
  }
}

/** The walkable tile nearest `ch` on the floor it stands on (anywhere, with one floor). */
export function nearestOnFloor(layout: object, walkable: Tile[], ch: Character): Tile | null {
  const rects = floorRects(layout);
  const k = rects ? floorIndexAt(rects, ch.tileRow) : -1;
  let best: Tile | null = null;
  let bestD = Infinity;
  for (const t of walkable) {
    if (rects && floorIndexAt(rects, t.row) !== k) continue;
    const d = Math.abs(t.col - ch.tileCol) + Math.abs(t.row - ch.tileRow);
    if (d < bestD) [best, bestD] = [t, d];
  }
  return best;
}

/** Whether the seat is on another floor than the character stands on (both known). */
export function seatOffFloor(layout: object, ch: Character, seatRow: number): boolean {
  const rects = floorRects(layout);
  if (!rects) return false;
  const here = floorIndexAt(rects, ch.tileRow);
  const there = floorIndexAt(rects, seatRow);
  return here >= 0 && there >= 0 && here !== there;
}

// ── Visits ───────────────────────────────────────────────────

function endVisit(os: OfficeState, ch: Character): void {
  const v = ch.cldVisit;
  ch.cldVisit = undefined;
  const home = v?.homeSeat ? os.seats.get(v.homeSeat) : undefined;
  if (v?.homeSeat && home && v.homeSeat !== ch.seatId && !home.assigned)
    os.reassignSeat(ch.id, v.homeSeat);
  else os.sendToSeat(ch.id);
}

/**
 * Drop character `id` on floor `floorId`: it rides there and visits, or, visiting, on its
 * own floor, it goes back to its seat. False when nothing changed (its own floor, not
 * visiting; no elevator there; nobody to move).
 */
export function visitFloor(os: OfficeState, id: number, floorId: string): boolean {
  const ch = os.characters.get(id);
  const rects = floorRects(os.layout);
  const el = os.cldElevators?.find((e) => e.floor === floorId);
  if (!ch || !rects || !el || ch.cldAway || ch.isSubagent || ch.matrixEffect) return false;
  const k = rects.findIndex((r) => r.id === floorId);
  const homeSeat = ch.cldVisit ? ch.cldVisit.homeSeat : ch.seatId;
  const home = homeSeat ? os.seats.get(homeSeat) : undefined;
  if (home && floorIndexAt(rects, home.seatRow) === k) {
    if (!ch.cldVisit) return false;
    endVisit(os, ch);
    return true;
  }
  const near = (t: Tile) => Math.abs(t.col - el.front.col) + Math.abs(t.row - el.front.row);
  const onFloor = (row: number) => floorIndexAt(rects, row) === k;
  ch.cldVisit = { floor: floorId, homeSeat, active: ch.isActive, arrived: false };
  if (ch.isActive) {
    let seat: string | null = null;
    let best = Infinity;
    for (const [uid, s] of os.seats) {
      const d = near({ col: s.seatCol, row: s.seatRow });
      if (!s.assigned && onFloor(s.seatRow) && d < best) [seat, best] = [uid, d];
    }
    if (seat) {
      os.reassignSeat(id, seat);
      return true;
    }
  } else if (homeSeat && ch.seatId !== homeSeat) {
    // An idle visitor keeps no desk on the floor it left: its own one is its seat again.
    const visitSeat = ch.seatId ? os.seats.get(ch.seatId) : undefined;
    if (visitSeat) visitSeat.assigned = false;
    ch.seatId = homeSeat;
    if (home) home.assigned = true;
  }
  const taken = new Set([...os.characters.values()].map((c) => `${c.tileCol},${c.tileRow}`));
  const spots = os.walkableTiles.filter(
    (t) =>
      onFloor(t.row) &&
      !taken.has(tileKey(t)) &&
      near(t) >= 2 &&
      near(t) <= ELEVATOR_VISIT_NEAR_TILES,
  );
  const spot = spots[Math.floor(Math.random() * spots.length)] ?? el.front;
  if (os.walkToTile(id, spot.col, spot.row)) return true;
  ch.cldVisit = undefined;
  return false;
}

/** A visitor each frame, before its FSM: its next work, or a floor gone, ends the visit. */
export function visitStep(os: OfficeState, ch: Character): void {
  const v = ch.cldVisit;
  if (!v) return;
  const rects = floorRects(os.layout);
  const there = rects?.findIndex((r) => r.id === v.floor) ?? -1;
  if (!rects || there < 0) return endVisit(os, ch);
  if (!ch.cldRide) {
    const here = floorIndexAt(rects, ch.tileRow);
    if (here === there) v.arrived = true;
    else if (v.arrived) {
      ch.cldVisit = undefined; // it went back by itself (home and in again)
      return;
    }
  }
  if (!v.active && ch.isActive) return endVisit(os, ch);
  v.active = ch.isActive;
}
