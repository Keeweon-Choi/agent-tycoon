/** Room-relative decorations layered over the generated office (T-0053). */
import * as fs from 'fs';

import type { FurnitureAsset } from '../../../core/src/assets/manifestUtils.js';
import { writeJsonAtomic } from './jsonFile.js';
import type { RoomRect } from './layout.js';
import {
  currentLabel,
  floorPrefix,
  floorRowOffsets,
  VOID_TILE,
  WALL_TILE,
} from './layout.js';

export type { RoomRect } from './layout.js';
export interface DecorTile {
  x: number;
  y: number;
  floor?: { tile: number; color: unknown };
  carpet?: unknown;
}
export interface DecorItem {
  uid: string;
  type: string;
  x: number;
  y: number;
  color?: unknown;
}
export interface RoomDecor {
  tiles: DecorTile[];
  furniture: DecorItem[];
  removed: string[];
}
export interface Decor {
  version: 1;
  wallColor?: unknown;
  pets?: unknown[];
  rooms: Record<string, RoomDecor>;
}
export interface FloorLayout extends Record<string, unknown> {
  cols: number;
  rows: number;
  tiles: number[];
  tileColors: unknown[];
  furniture: Array<{ uid: string; type: string; col: number; row: number; color?: unknown }>;
  areas: Array<{ label: string; color: string }>;
  areaTiles: Array<string | null>;
  carpetTiles?: unknown[];
  pets?: unknown[];
}
/** One floor of a plan, as it was sent: the generated (or the floor's own) layout and its rooms. */
export interface BaseFloor {
  id: string;
  own: boolean;
  layout: FloorLayout;
  rooms: RoomRect[];
}
/** The footprint fields decor needs. */
export type Footprints = ReadonlyArray<
  Pick<
    FurnitureAsset,
    | 'id'
    | 'category'
    | 'footprintW'
    | 'footprintH'
    | 'isDesk'
    | 'canPlaceOnWalls'
    | 'canPlaceOnSurfaces'
    | 'backgroundTiles'
  >
>;
/** Room-keyed records without a prototype: a label such as `constructor` or `__proto__` is only a key. */
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;
const empty = (): Decor => ({ version: 1, rooms: dict() });
const roomEmpty = (): RoomDecor => ({ tiles: [], furniture: [], removed: [] });
const equal = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isInteger(v);
const floorTile = (tile: unknown): boolean =>
  typeof tile === 'number' && tile !== WALL_TILE && tile !== VOID_TILE;
const hasContent = (r: RoomDecor): boolean =>
  !!(r.tiles.length || r.furniture.length || r.removed.length);
const ensure = (d: Decor, label: string): RoomDecor =>
  Object.hasOwn(d.rooms, label) ? d.rooms[label] : (d.rooms[label] = roomEmpty());

export function parseDecor(raw: unknown): Decor | null {
  if (!obj(raw) || raw.version !== 1 || !obj(raw.rooms)) return null;
  const out = empty();
  if ('wallColor' in raw) out.wallColor = raw.wallColor;
  if (Array.isArray(raw.pets)) out.pets = raw.pets;
  for (const [key, value] of Object.entries(raw.rooms)) {
    if (!obj(value)) continue;
    // LOUNGE: the lounge was 라운지 (and "2층 라운지"): a decor saved then follows the new name.
    const label = currentLabel(key);
    const room = roomEmpty();
    if (Array.isArray(value.tiles))
      for (const v of value.tiles) {
        if (!obj(v) || !integer(v.x) || !integer(v.y)) continue;
        const tile: DecorTile = { x: v.x, y: v.y };
        if (obj(v.floor) && integer(v.floor.tile) && 'color' in v.floor)
          tile.floor = { tile: v.floor.tile, color: v.floor.color };
        if ('carpet' in v) tile.carpet = v.carpet;
        if ('floor' in tile || 'carpet' in tile) room.tiles.push(tile);
      }
    if (Array.isArray(value.furniture))
      for (const v of value.furniture) {
        if (!obj(v) || !integer(v.x) || !integer(v.y)) continue;
        if (typeof v.uid !== 'string' || typeof v.type !== 'string') continue;
        room.furniture.push({
          uid: v.uid,
          type: v.type,
          x: v.x,
          y: v.y,
          ...('color' in v && { color: v.color }),
        });
      }
    if (Array.isArray(value.removed))
      room.removed = value.removed.filter((v): v is string => typeof v === 'string');
    if (hasContent(room) && !Object.hasOwn(out.rooms, label)) out.rooms[label] = room;
  }
  return out;
}

/** A work unit moves as one: `desk:<k>`, `pc:<k>` and the chair `seat:<k>`; anything else alone. */
export const unitOf = (uid: string): string =>
  uid.match(/^(?:desk|pc|seat):(.+)$/)?.[1] ?? `#${uid}`;
/** A member's or contractor's chair (a spare desk's chair is anyone's). */
const ownedChair = (uid: string): boolean =>
  uid.startsWith('seat:') && !uid.startsWith('seat:spare@');
export function footprint(type: string, catalog: Footprints) {
  const found = catalog.find((f) => f.id === type.replace(/:left$/, ''));
  return {
    w: found?.footprintW ?? 1,
    h: found?.footprintH ?? 1,
    bg: found?.backgroundTiles ?? 0,
    isDesk: found?.isDesk ?? false,
    isChair: found?.category === 'chairs',
    canPlaceOnWalls: found?.canPlaceOnWalls ?? false,
    canPlaceOnSurfaces: found?.canPlaceOnSurfaces ?? false,
  };
}
export function ownerRoom(rooms: RoomRect[], col: number, row: number): RoomRect | undefined {
  return rooms.find((r) => col >= r.x && col < r.x + r.w && row >= r.y && row < r.y + r.h);
}
const positionRoom = (
  rooms: RoomRect[],
  item: { col: number; row: number; type: string },
  catalog: Footprints,
) => ownerRoom(rooms, item.col, item.row + footprint(item.type, catalog).h - 1);
const key = (c: number, r: number) => `${c},${r}`;
function considered(
  item: { col: number; row: number; type: string },
  catalog: Footprints,
): string[] {
  const f = footprint(item.type, catalog);
  const cells: string[] = [];
  for (let dr = f.canPlaceOnWalls ? f.h - 1 : f.bg; dr < f.h; dr++)
    for (let dc = 0; dc < f.w; dc++) cells.push(key(item.col + dc, item.row + dr));
  return cells;
}

type Placed = FloorLayout['furniture'][number];
/** What is placed so far: every non-surface cell, and those of anything but a desk. */
interface Taken {
  solid: Set<string>;
  notDesk: Set<string>;
}

/**
 * The office as the user arranged it (T-0066): every item the user placed or
 * moved first, then the generator's remaining items. A generator item (a work
 * unit `desk:`/`pc:`/`seat:` together) that would overlap something already
 * placed moves, keeping its shape, to the nearest free valid spot in its room
 * (breadth-first); with none it is `held` (the room's 보관함) until the room
 * grows. A member's chair that is not placed gives its member the nearest
 * free chair in the room (`seats`, null: none).
 */
export function composeOffice(
  floors: BaseFloor[],
  decor: Decor,
  catalog: Footprints,
): {
  layouts: FloorLayout[];
  stored: Record<string, RoomDecor>;
  held: Record<string, string[]>;
  seats: Record<string, string | null>;
} {
  const stored = dict<RoomDecor>();
  const held = dict<string[]>();
  const seats: Record<string, string | null> = {};
  const seen = new Set<string>();
  const layouts = floors.map((base) => {
    if (base.own) return base.layout;
    const src = base.layout;
    const layout: FloorLayout = {
      ...src,
      tiles: [...src.tiles],
      tileColors: [...src.tileColors],
      furniture: [],
      ...(src.carpetTiles && { carpetTiles: [...src.carpetTiles] }),
    };
    const roomEntries = base.rooms.filter((r) => Object.hasOwn(decor.rooms, r.label));
    const removed = new Set<string>();
    for (const room of roomEntries) {
      seen.add(room.label);
      for (const uid of decor.rooms[room.label].removed) {
        removed.add(uid);
        if (!src.furniture.some((f) => f.uid === uid))
          (stored[room.label] ??= roomEmpty()).removed.push(uid);
      }
    }
    const doors = new Set<string>();
    for (const room of base.rooms)
      for (let row = room.y; row < room.y + room.h; row++)
        for (let col = room.x; col < room.x + room.w; col++) {
          const edge =
            row === room.y ||
            row === room.y + room.h - 1 ||
            col === room.x ||
            col === room.x + room.w - 1;
          if (!edge || !floorTile(src.tiles[row * src.cols + col])) continue;
          for (const [dc, dr] of [
            [0, 1],
            [0, -1],
            [1, 0],
            [-1, 0],
          ]) {
            const c = col + dc,
              r = row + dr;
            if (c > room.x && c < room.x + room.w - 1 && r > room.y && r < room.y + room.h - 1)
              doors.add(key(c, r));
          }
        }
    const taken: Taken = { solid: new Set(), notDesk: new Set() };
    /** Free of what is placed; with a room, also a valid spot in it (floor, wall, doors). */
    const fits = (item: Placed, room: RoomRect | undefined, into: Taken): boolean => {
      const shape = footprint(item.type, catalog);
      return considered(item, catalog).every((cell) => {
        if ((shape.canPlaceOnSurfaces ? into.notDesk : into.solid).has(cell)) return false;
        if (!room) return true;
        const [c, r] = cell.split(',').map(Number);
        if (c < room.x || c >= room.x + room.w || r < room.y || r >= room.y + room.h) return false;
        const tile = src.tiles[r * src.cols + c];
        if (shape.canPlaceOnWalls) return tile === WALL_TILE;
        const edge =
          c === room.x || c === room.x + room.w - 1 || r === room.y || r === room.y + room.h - 1;
        return !edge && floorTile(tile) && !doors.has(cell);
      });
    };
    const take = (item: Placed, into: Taken) => {
      const shape = footprint(item.type, catalog);
      if (shape.canPlaceOnSurfaces) return;
      for (const cell of considered(item, catalog)) {
        into.solid.add(cell);
        if (!shape.isDesk) into.notDesk.add(cell);
      }
    };
    /** The group at (dx, dy), its items checked in order (a PC needs its desk), or null. */
    const tryGroup = (group: Placed[], dx: number, dy: number, room: RoomRect | undefined) => {
      const into: Taken = { solid: new Set(taken.solid), notDesk: new Set(taken.notDesk) };
      const out: Placed[] = [];
      for (const f of group) {
        const at = { ...f, col: f.col + dx, row: f.row + dy };
        if (!fits(at, room, into)) return null;
        take(at, into);
        out.push(at);
      }
      return out;
    };
    const user: Placed[] = [];
    for (const room of roomEntries)
      for (const item of decor.rooms[room.label].furniture) {
        const placed: Placed = {
          uid: item.uid,
          type: item.type,
          col: room.x + item.x,
          row: room.y + item.y,
          ...('color' in item && { color: item.color }),
        };
        if (user.some((f) => f.uid === item.uid) || !fits(placed, room, taken)) {
          (stored[room.label] ??= roomEmpty()).furniture.push(item);
          continue;
        }
        take(placed, taken);
        user.push(placed);
      }
    const groups = new Map<string, Placed[]>();
    for (const f of src.furniture) {
      if (removed.has(f.uid) || user.some((u) => u.uid === f.uid)) continue;
      const unit = unitOf(f.uid);
      groups.set(unit, [...(groups.get(unit) ?? []), f]);
    }
    const generated = new Map<string, Placed>();
    for (const group of groups.values()) {
      const room = positionRoom(base.rooms, group[0], catalog);
      let found = tryGroup(group, 0, 0, undefined);
      // ponytail: tries every offset in the room, O(room area x unit cells) per moved unit.
      if (!found && room) {
        const visited = new Set([key(0, 0)]);
        const queue: Array<[number, number]> = [[0, 0]];
        while (!found && queue.length) {
          const [x, y] = queue.shift()!;
          for (const [dx, dy] of [
            [x + 1, y],
            [x - 1, y],
            [x, y + 1],
            [x, y - 1],
          ]) {
            if (Math.abs(dx) >= room.w || Math.abs(dy) >= room.h || visited.has(key(dx, dy)))
              continue;
            visited.add(key(dx, dy));
            queue.push([dx, dy]);
            found = tryGroup(group, dx, dy, room);
            if (found) break;
          }
        }
      }
      if (!found) {
        if (room) (held[room.label] ??= []).push(...group.map((f) => f.uid));
        continue;
      }
      for (const f of found) {
        take(f, taken);
        generated.set(f.uid, f);
      }
    }
    layout.furniture = [...src.furniture.flatMap((f) => generated.get(f.uid) ?? []), ...user];
    // Seats follow chairs; a member without its chair takes the nearest free one in its room.
    const claimed = new Set(layout.furniture.map((f) => f.uid).filter(ownedChair));
    const chairRoom = (f: Placed) => positionRoom(base.rooms, f, catalog)?.label;
    for (const chair of src.furniture) {
      if (!ownedChair(chair.uid) || claimed.has(chair.uid)) continue;
      const room = chairRoom(chair);
      const free = layout.furniture
        .filter(
          (f) => footprint(f.type, catalog).isChair && !claimed.has(f.uid) && chairRoom(f) === room,
        )
        .sort(
          (a, b) =>
            Math.abs(a.col - chair.col) +
            Math.abs(a.row - chair.row) -
            (Math.abs(b.col - chair.col) + Math.abs(b.row - chair.row)),
        )[0];
      seats[chair.uid] = free?.uid ?? null;
      if (free) claimed.add(free.uid);
    }
    for (const room of roomEntries)
      for (const tile of decor.rooms[room.label].tiles) {
        const c = room.x + tile.x,
          r = room.y + tile.y;
        if (
          c < room.x ||
          c >= room.x + room.w ||
          r < room.y ||
          r >= room.y + room.h ||
          !floorTile(src.tiles[r * src.cols + c])
        ) {
          (stored[room.label] ??= roomEmpty()).tiles.push(tile);
          continue;
        }
        const i = r * src.cols + c;
        if (tile.floor) {
          layout.tiles[i] = tile.floor.tile;
          layout.tileColors[i] = tile.floor.color;
        }
        if ('carpet' in tile) {
          layout.carpetTiles ??= new Array(src.cols * src.rows).fill(null);
          layout.carpetTiles[i] = tile.carpet;
        }
      }
    if ('wallColor' in decor)
      for (let i = 0; i < src.tiles.length; i++)
        if (src.tiles[i] === WALL_TILE) layout.tileColors[i] = decor.wallColor;
    return layout;
  });
  if (decor.pets && layouts[0]) layouts[0] = { ...layouts[0], pets: decor.pets };
  for (const [label, data] of Object.entries(decor.rooms))
    if (!seen.has(label)) stored[label] = data;
  return { layouts, stored, held, seats };
}

export function decorFromSave(
  saved: Record<string, unknown>,
  floors: BaseFloor[],
  old: Decor,
  catalog: Footprints,
): Decor | string {
  if (
    !Array.isArray(saved.furniture) ||
    !Array.isArray(saved.tiles) ||
    !integer(saved.cols) ||
    !integer(saved.rows)
  )
    return 'invalid layout';
  const savedItems = saved.furniture.filter(
    (v): v is FloorLayout['furniture'][number] =>
      obj(v) &&
      typeof v.uid === 'string' &&
      typeof v.type === 'string' &&
      integer(v.col) &&
      integer(v.row),
  );
  const offsets = floorRowOffsets(floors.map((f) => f.layout));
  const baseItems = floors.flatMap((floor, k) =>
    floor.layout.furniture.map((f) => ({
      ...f,
      uid: f.uid.startsWith('seat:') ? f.uid : floorPrefix(floor.id, k) + f.uid,
      row: f.row + offsets[k],
    })),
  );
  const byUid = new Map(baseItems.map((f) => [f.uid, f]));
  if (!savedItems.some((f) => byUid.has(f.uid))) return 'not this office';
  // A left or top grid expansion shifts everything; most items are where they were.
  const shifts = new Map<string, number>();
  for (const f of savedItems) {
    const base = byUid.get(f.uid);
    if (!base) continue;
    const shift = key(f.col - base.col, f.row - base.row);
    shifts.set(shift, (shifts.get(shift) ?? 0) + 1);
  }
  const [dx, dy] = [...(shifts.size ? shifts : new Map([['0,0', 1]])).entries()]
    .sort((a, b) => b[1] - a[1])[0][0]
    .split(',')
    .map(Number);
  const result = empty();
  // What the user saw: generator items the composition moved or held are not the user's edits.
  const shown = composeOffice(floors, old, catalog);
  const colors = Array.isArray(saved.tileColors) ? saved.tileColors : [];
  const carpets = Array.isArray(saved.carpetTiles) ? saved.carpetTiles : [];
  const wallCounts = new Map<string, { color: unknown; n: number }>();
  for (const [k, floor] of floors.entries()) {
    if (floor.own) continue;
    const base = floor.layout;
    for (let row = 0; row < base.rows; row++)
      for (let col = 0; col < base.cols; col++) {
        const bi = row * base.cols + col;
        const si = (offsets[k] + row + dy) * saved.cols + col + dx;
        if (si < 0 || si >= saved.tiles.length) continue;
        const st = saved.tiles[si];
        if (base.tiles[bi] === WALL_TILE && st === WALL_TILE) {
          const color = colors[si] ?? null;
          const label = JSON.stringify(color);
          const count = wallCounts.get(label) ?? { color, n: 0 };
          count.n++;
          wallCounts.set(label, count);
        }
        if (!floorTile(base.tiles[bi]) || !floorTile(st)) continue;
        const room = ownerRoom(floor.rooms, col, row);
        if (!room) continue;
        const tile: DecorTile = { x: col - room.x, y: row - room.y };
        if (base.tiles[bi] !== st || !equal(base.tileColors[bi], colors[si]))
          tile.floor = { tile: st, color: colors[si] ?? null };
        if (!equal(base.carpetTiles?.[bi], carpets[si])) tile.carpet = carpets[si] ?? null;
        if ('floor' in tile || 'carpet' in tile) ensure(result, room.label).tiles.push(tile);
      }
    const prefix = floorPrefix(floor.id, k);
    const savedFloor = savedItems.filter(
      (f) => f.row - dy >= offsets[k] && f.row - dy < offsets[k] + base.rows,
    );
    const local = savedFloor.map((f) => ({
      ...f,
      uid: prefix && f.uid.startsWith(prefix) ? f.uid.slice(prefix.length) : f.uid,
      col: f.col - dx,
      row: f.row - dy - offsets[k],
    }));
    const baseByUid = new Map(base.furniture.map((f) => [f.uid, f]));
    const shownByUid = new Map(shown.layouts[k].furniture.map((f) => [f.uid, f]));
    const oldRooms = floor.rooms.flatMap((r) =>
      Object.hasOwn(old.rooms, r.label) ? [old.rooms[r.label]] : [],
    );
    const userTouched = new Set(
      oldRooms.flatMap((r) => [...r.removed, ...r.furniture.map((f) => f.uid)]),
    );
    const same = (a: FloorLayout['furniture'][number] | undefined, b: typeof a) =>
      !!a &&
      !!b &&
      equal(
        { type: a.type, col: a.col, row: a.row, color: a.color },
        { type: b.type, col: b.col, row: b.row, color: b.color },
      );
    for (const item of local) {
      const previous = baseByUid.get(item.uid);
      if (
        same(previous, item) ||
        (previous && !userTouched.has(item.uid) && same(shownByUid.get(item.uid), item))
      )
        continue;
      if (previous) {
        const home = positionRoom(floor.rooms, previous, catalog);
        if (home) ensure(result, home.label).removed.push(item.uid);
      }
      const room = positionRoom(floor.rooms, item, catalog);
      if (room)
        ensure(result, room.label).furniture.push({
          uid: item.uid,
          type: item.type,
          x: item.col - room.x,
          y: item.row - room.y,
          ...('color' in item && { color: item.color }),
        });
      else console.warn(`[cld] decor: furniture ${item.uid} has no room; dropped`);
    }
    for (const item of base.furniture) {
      if (local.some((f) => f.uid === item.uid)) continue;
      if (!userTouched.has(item.uid) && !shownByUid.has(item.uid)) continue; // held: not deleted
      const room = positionRoom(floor.rooms, item, catalog);
      if (room) ensure(result, room.label).removed.push(item.uid);
    }
  }
  const wall = [...wallCounts.values()].sort((a, b) => b.n - a.n)[0];
  const baseWall = floors
    .flatMap((f) =>
      f.layout.tiles.map((t, i) => (t === WALL_TILE ? f.layout.tileColors[i] : undefined)),
    )
    .find((v) => v !== undefined);
  if (wall && !equal(wall.color, baseWall)) result.wallColor = wall.color;
  if (Array.isArray(saved.pets)) result.pets = saved.pets;
  for (const [label, carry] of Object.entries(shown.stored)) {
    const room = ensure(result, label);
    for (const tile of carry.tiles)
      if (!room.tiles.some((t) => t.x === tile.x && t.y === tile.y)) room.tiles.push(tile);
    for (const item of carry.furniture)
      if (!room.furniture.some((f) => f.uid === item.uid)) room.furniture.push(item);
    room.removed = [...new Set([...room.removed, ...carry.removed])];
  }
  for (const [label, room] of Object.entries(result.rooms))
    if (!hasContent(room)) delete result.rooms[label];
  return result;
}

export function resetDecorRoom(decor: Decor, room: string): Decor {
  const rooms = Object.assign(dict<RoomDecor>(), decor.rooms);
  delete rooms[room];
  return { ...decor, rooms };
}
export class DecorStore {
  data: Decor;
  private foreign = false;
  constructor(readonly file: string) {
    this.data = empty();
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf-8');
    } catch {
      return;
    }
    try {
      const parsed = parseDecor(JSON.parse(raw));
      if (parsed) this.data = parsed;
      else {
        // A decor.json this build cannot read (a newer version): kept as it is, never saved over.
        this.foreign = true;
        console.warn(`[cld] decor: ${file} is not a version this build reads; left untouched`);
      }
    } catch {
      const aside = `${file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(file, aside);
      } catch {
        /* file disappeared */
      }
      console.warn(`[cld] decor: invalid JSON moved to ${aside}`);
    }
  }
  exists(): boolean {
    return fs.existsSync(this.file);
  }
  save(next: Decor): string | null {
    if (this.foreign) return 'decor.json을 이 판이 읽지 못해 덮어쓰지 않았어요';
    try {
      writeJsonAtomic(this.file, next);
    } catch (err) {
      return String(err);
    }
    this.data = next;
    return null;
  }
}
