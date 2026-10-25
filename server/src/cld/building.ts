/**
 * The building (T-0027): the office's floors, kept by cld-gui in
 * ~/.config/cld-gui/building.json. The office is generated plus decor
 * (decor.ts); layout.json is read once for migration. With no building.json there is one floor
 * holding every room, the office as it was.
 *
 * A room placed nowhere is on floor 1 (with 프로젝트마다 층 it first gets a
 * floor of its own); a character placed nowhere is on its room's floor.
 * Moving a project's character changes only this file, never the project's room. Every
 * change is a pure function (the new data, or why not in Korean), kept only
 * once building.json was written (tmp + rename).
 */
import * as fs from 'fs';
import * as path from 'path';

import { type Coded, koText, type Refused, refused } from '../../../core/src/cld/serverText.js';

/** The 1-9 keys reach every floor. */
export const MAX_FLOORS = 9;
export const MAX_FLOOR_NAME = 24;

export interface Floor {
  id: string;
  name: string;
  /** Rooms placed on this floor, by label. */
  rooms: string[];
  /** Characters placed here apart from their room, by name. */
  characters: string[];
  /** This floor's own office (an OfficeLayout) instead of the generated one.
   *  Floor 1 always uses the generated office plus decor. */
  layout?: Record<string, unknown>;
}

export interface BuildingData {
  version: 1;
  /** floors[0] is floor 1. */
  floors: Floor[];
  /** 프로젝트마다 층. */
  perProject: boolean;
}

/** The new data, or why the change was not made. */
export type Change = BuildingData | Refused;

export const floorName = (n: number): string => koText('floor_n', { n });
const NO_FLOOR = refused('floor_missing');

export function defaultBuilding(): BuildingData {
  return {
    version: 1,
    floors: [{ id: '1', name: floorName(1), rooms: [], characters: [] }],
    perProject: false,
  };
}

const isStrings = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === 'string');

/** Enough of an OfficeLayout to stack it with the others. */
export function isLayout(v: unknown): v is Record<string, unknown> {
  const l = v as Record<string, unknown> | null;
  if (!l || typeof l !== 'object' || l.version !== 1) return false;
  const { cols, rows, tiles } = l;
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    (cols as number) > 0 &&
    (rows as number) > 0 &&
    Array.isArray(tiles) &&
    tiles.length === (cols as number) * (rows as number) &&
    Array.isArray(l.furniture)
  );
}

/** building.json's text, or null when it is not a building. */
export function parseBuilding(text: string): BuildingData | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const b = raw as Record<string, unknown> | null;
  if (!b || typeof b !== 'object' || b.version !== 1 || !Array.isArray(b.floors)) return null;
  if (b.floors.length < 1 || b.floors.length > MAX_FLOORS) return null;
  const floors: Floor[] = [];
  for (const f of b.floors as Array<Record<string, unknown> | null>) {
    if (!f || typeof f !== 'object' || typeof f.id !== 'string' || !f.id) return null;
    if (typeof f.name !== 'string' || !isStrings(f.rooms)) return null;
    if (f.characters !== undefined && !isStrings(f.characters)) return null;
    if (floors.some((x) => x.id === f.id)) return null;
    floors.push({
      id: f.id,
      name: f.name,
      rooms: [...f.rooms],
      characters: [...(f.characters ?? [])],
      ...(floors.length > 0 && isLayout(f.layout) && { layout: f.layout }),
    });
  }
  return { version: 1, floors, perProject: b.perProject === true };
}

/** A typed floor name: trimmed, 1-24 characters, no control characters. */
export function cleanFloorName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const clean = name.trim();
  if (!clean || [...clean].length > MAX_FLOOR_NAME || /[\u0000-\u001f\u007f]/.test(clean))
    return null;
  return clean;
}
const BAD_NAME = refused('floor_name_bad', { max: MAX_FLOOR_NAME });

export function floorOfRoom(b: BuildingData, room: string): Floor {
  return b.floors.find((f) => f.rooms.includes(room)) ?? b.floors[0];
}

export function floorOfCharacter(b: BuildingData, name: string, room: string): Floor {
  return b.floors.find((f) => f.characters.includes(name)) ?? floorOfRoom(b, room);
}

const nextId = (b: BuildingData): string =>
  String(Math.max(0, ...b.floors.map((f) => Number(f.id)).filter(Number.isFinite)) + 1);

export function addFloor(b: BuildingData, name?: unknown): Change {
  if (b.floors.length >= MAX_FLOORS) return refused('floor_limit', { max: MAX_FLOORS });
  const clean =
    name === undefined || name === '' ? floorName(b.floors.length + 1) : cleanFloorName(name);
  if (!clean) return BAD_NAME;
  return { ...b, floors: [...b.floors, { id: nextId(b), name: clean, rooms: [], characters: [] }] };
}

export function renameFloor(b: BuildingData, id: string, name: unknown): Change {
  const clean = cleanFloorName(name);
  if (!clean) return BAD_NAME;
  if (!b.floors.some((f) => f.id === id)) return NO_FLOOR;
  return { ...b, floors: b.floors.map((f) => (f.id === id ? { ...f, name: clean } : f)) };
}

const union = (a: string[], more: string[]) => [...a, ...more.filter((x) => !a.includes(x))];

/** Remove a floor other than floor 1; its rooms and characters go to floor 1. */
export function removeFloor(b: BuildingData, id: string): Change {
  const k = b.floors.findIndex((f) => f.id === id);
  if (k < 0) return NO_FLOOR;
  if (k === 0) return refused('floor_first');
  const gone = b.floors[k];
  const [first, ...rest] = b.floors.filter((f) => f.id !== id);
  return {
    ...b,
    floors: [
      {
        ...first,
        rooms: union(first.rooms, gone.rooms),
        characters: union(first.characters, gone.characters),
      },
      ...rest,
    ],
  };
}

/** Put a room on a floor. `members` (names): its characters placed on that
 *  floor on their own follow the room again; the others stay where they are. */
export function moveRoom(
  b: BuildingData,
  room: string,
  floorId: string,
  members: string[] = [],
): Change {
  if (!b.floors.some((f) => f.id === floorId)) return NO_FLOOR;
  return {
    ...b,
    floors: b.floors.map((f) =>
      f.id === floorId
        ? {
            ...f,
            rooms: f.rooms.includes(room) ? f.rooms : [...f.rooms, room],
            characters: f.characters.filter((c) => !members.includes(c)),
          }
        : { ...f, rooms: f.rooms.filter((r) => r !== room) },
    ),
  };
}

/** Put a character on a floor; on its room's floor it follows the room again. */
export function moveCharacter(
  b: BuildingData,
  name: string,
  room: string,
  floorId: string,
): Change {
  if (!b.floors.some((f) => f.id === floorId)) return NO_FLOOR;
  const own = floorOfRoom(b, room).id !== floorId;
  return {
    ...b,
    floors: b.floors.map((f) => {
      const others = f.characters.filter((c) => c !== name);
      return { ...f, characters: own && f.id === floorId ? [...others, name] : others };
    }),
  };
}

/** 프로젝트마다 층: every room (in office order) placed nowhere gets a floor
 *  of its own, named after it -- floor 1 while that holds no room. Past 9
 *  floors the rest stay on floor 1. */
export function placeNewRooms(b: BuildingData, rooms: string[]): BuildingData {
  if (!b.perProject) return b;
  let next = b;
  for (const room of rooms) {
    if (next.floors.some((f) => f.rooms.includes(room))) continue;
    const [first, ...rest] = next.floors;
    if (!first.rooms.length) next = { ...next, floors: [{ ...first, rooms: [room] }, ...rest] };
    else if (next.floors.length < MAX_FLOORS) {
      const name =
        cleanFloorName([...room].slice(0, MAX_FLOOR_NAME).join('')) ??
        floorName(next.floors.length + 1);
      next = {
        ...next,
        floors: [...next.floors, { id: nextId(next), name, rooms: [room], characters: [] }],
      };
    }
  }
  return next;
}

export function setPerProject(b: BuildingData, on: boolean, rooms: string[]): BuildingData {
  return placeNewRooms({ ...b, perProject: on }, rooms);
}

// ── building.json ─────────────────────────────────────────────

/** building.json, or one floor when there is none. One that is not a
 *  building is moved aside (never overwritten) and the office starts with one floor. */
export function loadBuilding(file: string): BuildingData {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return defaultBuilding();
  }
  const b = parseBuilding(text);
  if (b) return b;
  const aside = `${file}.corrupt-${Date.now()}`;
  try {
    fs.renameSync(file, aside);
  } catch {
    /* gone already */
  }
  console.warn(`[cld] ${path.basename(file)} is not a building; moved to ${aside}, one floor`);
  return defaultBuilding();
}

export function saveBuilding(file: string, b: BuildingData): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(b, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/** The building in memory and on disk: a change is kept only once written. */
export class BuildingStore {
  data: BuildingData;

  constructor(readonly file: string) {
    this.data = loadBuilding(file);
  }

  /** Make a change; `error` says why it was not made. */
  apply(change: (b: BuildingData) => Change): ({ error?: string } & Coded) & { changed: boolean } {
    const next = change(this.data);
    if ('error' in next) return { ...next, changed: false };
    if (JSON.stringify(next) === JSON.stringify(this.data)) return { changed: false };
    try {
      saveBuilding(this.file, next);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return { ...refused('save_failed', { why }), changed: false };
    }
    this.data = next;
    return { changed: true };
  }
}
