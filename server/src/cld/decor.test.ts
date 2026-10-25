import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import type { BaseFloor, Decor, DecorItem, FloorLayout, Footprints } from './decor.js';
import { composeOffice, decorFromSave, DecorStore, parseDecor, resetDecorRoom } from './decor.js';
import { floorPrefix, generateLayout, stackFloors } from './layout.js';

const catalog: Footprints = [
  {
    id: 'DESK_FRONT',
    category: 'desks',
    footprintW: 3,
    footprintH: 2,
    isDesk: true,
    canPlaceOnWalls: false,
    backgroundTiles: 1,
  },
  {
    id: 'PC_FRONT_OFF',
    category: 'electronics',
    footprintW: 1,
    footprintH: 2,
    isDesk: false,
    canPlaceOnWalls: false,
    canPlaceOnSurfaces: true,
    backgroundTiles: 1,
  },
  {
    id: 'CUSHIONED_BENCH',
    category: 'chairs',
    footprintW: 1,
    footprintH: 1,
    isDesk: false,
    canPlaceOnWalls: false,
  },
  {
    id: 'PLANT',
    category: 'decor',
    footprintW: 1,
    footprintH: 2,
    isDesk: false,
    canPlaceOnWalls: false,
    backgroundTiles: 1,
  },
  {
    id: 'LED_BOARD',
    category: 'misc',
    footprintW: 28,
    footprintH: 11,
    isDesk: false,
    canPlaceOnWalls: false,
    backgroundTiles: 2,
  },
  {
    id: 'PAINTING',
    category: 'wall',
    footprintW: 1,
    footprintH: 2,
    isDesk: false,
    canPlaceOnWalls: true,
  },
];
const floor = (label: string, members: string[], id = '1', lounge = '라운지'): BaseFloor => {
  const g = generateLayout([{ label, members }], lounge, id === '1');
  return { id, own: false, layout: g.layout as FloorLayout, rooms: g.rooms };
};
const empty: Decor = { version: 1, rooms: {} };
const paint = { tile: 2, color: { h: 120, s: 60, b: 0, c: 0 } };
const wallColor = { h: 214, s: 30, b: -60, c: -55 };
const saveOf = (floors: BaseFloor[], decor: Decor) => {
  const layouts = composeOffice(floors, decor, catalog).layouts;
  return (
    floors.length === 1
      ? layouts[0]
      : stackFloors(
          floors.map((f, k) => ({ id: f.id, prefix: floorPrefix(f.id, k), layout: layouts[k] })),
        )
  ) as Record<string, unknown>;
};
const at = (f: BaseFloor, label: string, x: number, y: number) => {
  const r = f.rooms.find((r) => r.label === label)!;
  return { col: r.x + x, row: r.y + y };
};

describe('room decor', () => {
  it('round trips floor and carpet edits, furniture, removals and wall colour on one and two floors', () => {
    const one = floor('a', ['a1', 'a2']);
    const two = floor('b', ['b1'], '2', '2층 라운지');
    for (const floors of [[one], [one, two]]) {
      const label = floors.length === 1 ? 'a' : 'b';
      const d: Decor = {
        version: 1,
        wallColor,
        rooms: {
          [label]: {
            tiles: [
              { x: 1, y: 1, floor: paint },
              { x: 2, y: 1, carpet: { variant: 0, order: 1 } },
            ],
            furniture: [{ uid: 'user-plant', type: 'PLANT', x: 1, y: 2 }],
            removed: [`plant:${label}`],
          },
        },
      };
      expect(decorFromSave(saveOf(floors, d), floors, empty, catalog)).toEqual(d);
    }
  });

  it('follows its room when another room grows and the packing changes', () => {
    const before = generateLayout([
      { label: 'a', members: ['a1'] },
      { label: 'b', members: ['b1'] },
    ]);
    const after = generateLayout([
      { label: 'a', members: Array.from({ length: 7 }, (_, i) => `a${i}`) },
      { label: 'b', members: ['b1'] },
    ]);
    const old: BaseFloor = {
      id: '1',
      own: false,
      layout: before.layout as FloorLayout,
      rooms: before.rooms,
    };
    const next: BaseFloor = {
      id: '1',
      own: false,
      layout: after.layout as FloorLayout,
      rooms: after.rooms,
    };
    const d: Decor = {
      version: 1,
      rooms: {
        b: {
          tiles: [{ x: 1, y: 1, floor: paint }],
          furniture: [{ uid: 'p', type: 'PLANT', x: 1, y: 2 }],
          removed: [],
        },
      },
    };
    const oldPos = at(old, 'b', 1, 1),
      newPos = at(next, 'b', 1, 1);
    expect(newPos).not.toEqual(oldPos);
    const l = composeOffice([next], d, catalog).layouts[0];
    expect(l.tiles[newPos.row * l.cols + newPos.col]).toBe(2);
    expect(l.furniture).toContainEqual(
      expect.objectContaining({ uid: 'p', ...at(next, 'b', 1, 2) }),
    );
    expect(l.furniture).not.toContainEqual(
      expect.objectContaining({ uid: 'p', ...at(old, 'b', 1, 2) }),
    );
  });

  it('places user decor first and moves the blocked generator unit as one', () => {
    const f = floor('a', ['a1']);
    const desk = f.layout.furniture.find((v) => v.uid === 'desk:a1')!;
    const room = f.rooms.find((r) => r.label === 'a')!;
    const d: Decor = {
      version: 1,
      rooms: {
        a: {
          tiles: [],
          removed: [],
          furniture: [
            { uid: 'blocked', type: 'PLANT', x: desk.col - room.x, y: desk.row - room.y },
            { uid: 'wall', type: 'PAINTING', x: 1, y: -1 },
            { uid: 'bad-wall', type: 'PAINTING', x: 1, y: 1 },
          ],
        },
      },
    };
    const { layouts, stored, held } = composeOffice([f], d, catalog);
    const uids = layouts[0].furniture.map((v) => v.uid);
    expect(uids).toContain('blocked');
    expect(uids).toContain('wall');
    expect(stored.a.furniture.map((v) => v.uid)).toEqual(['bad-wall']);
    expect(held.a).toBeUndefined();
    const unit = (l: FloorLayout) =>
      ['desk:a1', 'pc:a1', 'seat:a1'].map((uid) => l.furniture.find((v) => v.uid === uid)!);
    const [d0, p0, s0] = unit(f.layout);
    const [d1, p1, s1] = unit(layouts[0]);
    expect(d1.col !== d0.col || d1.row !== d0.row).toBe(true);
    // Moved together: the same shape at the new spot.
    expect([p1.col - d1.col, p1.row - d1.row, s1.col - d1.col, s1.row - d1.row]).toEqual([
      p0.col - d0.col,
      p0.row - d0.row,
      s0.col - d0.col,
      s0.row - d0.row,
    ]);
    // A save of what the user saw records only the user's own items, not the move.
    expect(decorFromSave(saveOf([f], d), [f], d, catalog)).toEqual(d);
    // A second painting on the same wall tile does not fit.
    d.rooms.a.furniture.push({ uid: 'wall-2', type: 'PAINTING', x: 1, y: -1 });
    expect(composeOffice([f], d, catalog).stored.a.furniture.map((v) => v.uid)).toContain('wall-2');
  });

  it('keeps a moved desk unit at the user spot after the room grows; the member keeps its chair', () => {
    const small = floor('a', ['a1', 'a2']);
    const moved = structuredClone(saveOf([small], empty)) as FloorLayout;
    for (const v of moved.furniture) if (['desk:a1', 'pc:a1', 'seat:a1'].includes(v.uid)) v.row++;
    const d = decorFromSave(moved, [small], empty, catalog) as Decor;
    expect(d.rooms.a.removed.sort()).toEqual(['desk:a1', 'pc:a1', 'seat:a1']);
    const big = floor('a', ['a1', 'a2', 'a3', 'a4']);
    const { layouts, seats } = composeOffice([big], d, catalog);
    for (const uid of ['desk:a1', 'pc:a1', 'seat:a1']) {
      const was = small.layout.furniture.find((v) => v.uid === uid)!;
      expect(layouts[0].furniture.filter((v) => v.uid === uid)).toEqual([
        expect.objectContaining(
          at(big, 'a', was.col - small.rooms[0].x, was.row + 1 - small.rooms[0].y),
        ),
      ]);
    }
    expect(seats['seat:a1']).toBeUndefined();
    expect(layouts[0].furniture.map((v) => v.uid)).toEqual(
      expect.arrayContaining(['seat:a2', 'seat:a3', 'seat:a4']),
    );
  });

  it('gives a member without its chair the nearest free chair, else none, never a shared one', () => {
    const f = floor('a', ['a1', 'a2', 'a3']);
    const chair = (uid: string, x: number) => ({ uid, type: 'CUSHIONED_BENCH', x, y: 6 });
    const d = (removed: string[], furniture: DecorItem[]): Decor => ({
      version: 1,
      rooms: { a: { tiles: [], removed, furniture } },
    });
    // seat:a1 is at x 4, seat:a3 at x 14 of room a.
    expect(
      composeOffice([f], d(['seat:a1'], [chair('far', 12), chair('near', 2)]), catalog).seats,
    ).toEqual({
      'seat:a1': 'near',
    });
    const both = composeOffice([f], d(['seat:a1', 'seat:a3'], [chair('one', 9)]), catalog).seats;
    expect(Object.values(both).filter((v) => v === 'one')).toHaveLength(1);
    expect(Object.values(both)).toContain(null);
    expect(composeOffice([f], d(['seat:a1'], []), catalog).seats).toEqual({ 'seat:a1': null });
  });

  it('stores a generator unit with no room left and brings it back when the room grows', () => {
    const small = floor('a', ['a1']);
    const room = small.rooms[0];
    const plants: DecorItem[] = [];
    for (let y = 0; y < room.h; y++)
      for (let x = 1; x < room.w - 1; x++) plants.push({ uid: `p${x},${y}`, type: 'PLANT', x, y });
    const d: Decor = { version: 1, rooms: { a: { tiles: [], removed: [], furniture: plants } } };
    const full = composeOffice([small], d, catalog);
    expect(full.held.a?.sort()).toEqual(['desk:a1', 'pc:a1', 'plant:a', 'seat:a1']);
    expect(full.seats['seat:a1']).toBeNull();
    // The user saw no unit there: saving that view does not delete it.
    const saved = decorFromSave(saveOf([small], d), [small], d, catalog) as Decor;
    expect(saved.rooms.a.removed).toEqual([]);
    const grown = composeOffice([floor('a', ['a1', 'a2', 'a3', 'a4'])], saved, catalog);
    expect(grown.held.a).toBeUndefined();
    expect(grown.layouts[0].furniture.map((v) => v.uid)).toContain('seat:a1');
  });

  it('moves and removes the lobby board; a reset restores only its own room', () => {
    const f = floor('a', ['a1']);
    const board = f.layout.furniture.find((v) => v.uid === 'lobby:board')!;
    const moved = structuredClone(saveOf([f], empty)) as FloorLayout;
    moved.furniture.find((v) => v.uid === 'lobby:board')!.row++;
    moved.furniture.find((v) => v.uid === 'desk:a1')!.col--;
    const d = decorFromSave(moved, [f], empty, catalog) as Decor;
    expect(d.rooms['로비'].removed).toEqual(['lobby:board']);
    const shownBoard = (dec: Decor) =>
      composeOffice([f], dec, catalog).layouts[0].furniture.filter((v) => v.uid === 'lobby:board');
    expect(shownBoard(d)).toEqual([{ ...board, row: board.row + 1 }]);
    const reset = resetDecorRoom(d, '로비');
    expect(shownBoard(reset)).toEqual([board]);
    expect(reset.rooms.a).toEqual(d.rooms.a);
    const removed = structuredClone(saveOf([f], empty)) as FloorLayout;
    removed.furniture = removed.furniture.filter((v) => v.uid !== 'lobby:board');
    expect(shownBoard(decorFromSave(removed, [f], empty, catalog) as Decor)).toEqual([]);
  });

  it('keeps an item added on floor 2 (editor uids carry no floor prefix)', () => {
    const floors = [floor('a', ['a1']), floor('b', ['b1'], '2', '2층 라운지')];
    const office = saveOf(floors, empty) as FloorLayout & { cldFloors: Array<{ row: number }> };
    const b = floors[1].rooms.find((r) => r.label === 'b')!;
    const row = office.cldFloors[1].row + b.y + 2;
    office.furniture.push({ uid: 'f-123-abcd', type: 'PLANT', col: b.x + 1, row });
    const d = decorFromSave(office, floors, empty, catalog) as Decor;
    expect(d.rooms.b?.furniture.map((v) => v.uid)).toEqual(['f-123-abcd']);
  });

  it('treats built-in names as plain room labels', () => {
    for (const label of ['constructor', 'toString', '__proto__']) {
      const f = floor(label, ['m1']);
      expect(() => composeOffice([f], empty, catalog)).not.toThrow();
      const edited = structuredClone(saveOf([f], empty)) as FloorLayout;
      const room = f.rooms[0];
      edited.furniture.push({ uid: 't-plant', type: 'PLANT', col: room.x + 1, row: room.y + 2 });
      const d = decorFromSave(edited, [f], empty, catalog) as Decor;
      expect(Object.keys(d.rooms)).toEqual([label]);
      expect(Object.getPrototypeOf(d.rooms)).toBeNull();
    }
  });

  it('protects the inward tile of a door', () => {
    const g = generateLayout([
      { label: 'a', members: ['a1'] },
      { label: 'b', members: ['b1'] },
    ]);
    const f: BaseFloor = { id: '1', own: false, layout: g.layout as FloorLayout, rooms: g.rooms };
    const b = g.rooms.find((r) => r.label === 'b')!;
    const edge = Array.from({ length: b.h }, (_, y) => y).find(
      (y) => g.layout.tiles[(b.y + y) * g.layout.cols + b.x] !== 0,
    );
    expect(edge).toBeDefined();
    const d: Decor = {
      version: 1,
      rooms: {
        b: {
          tiles: [],
          removed: [],
          furniture: [{ uid: 'door-plant', type: 'PLANT', x: 1, y: edge! - 1 }],
        },
      },
    };
    expect(composeOffice([f], d, catalog).stored.b.furniture.map((v) => v.uid)).toContain(
      'door-plant',
    );
  });

  it('carries a stored item through a save and restores it after room growth', () => {
    const large = floor('a', ['a1', 'a2', 'a3', 'a4']);
    const small = floor('a', ['a1']);
    const y = large.rooms[0].h - 3;
    const d: Decor = {
      version: 1,
      rooms: {
        a: { tiles: [], removed: [], furniture: [{ uid: 'late', type: 'PLANT', x: 1, y }] },
      },
    };
    expect(composeOffice([small], d, catalog).stored.a.furniture).toEqual(d.rooms.a.furniture);
    const saved = decorFromSave(saveOf([small], d), [small], d, catalog);
    expect(saved).toEqual(d);
    expect(
      composeOffice([large], d, catalog).layouts[0].furniture.some((v) => v.uid === 'late'),
    ).toBe(true);
  });

  it('records removed and moved generator furniture', () => {
    const f = floor('a', ['a1']);
    const deleted = structuredClone(f.layout);
    deleted.furniture = deleted.furniture.filter((v) => v.uid !== 'plant:a');
    expect((decorFromSave(deleted, [f], empty, catalog) as Decor).rooms.a.removed).toContain(
      'plant:a',
    );
    const table = f.layout.furniture.find((v) => v.uid === 'lounge:table')!;
    const moved = structuredClone(f.layout);
    moved.furniture.find((v) => v.uid === table.uid)!.col++;
    const d = decorFromSave(moved, [f], empty, catalog) as Decor;
    expect(d.rooms['라운지'].removed).toContain('lounge:table');
    expect(d.rooms['라운지'].furniture).toContainEqual(
      expect.objectContaining({ uid: 'lounge:table' }),
    );
    const shown = composeOffice([f], d, catalog).layouts[0].furniture.filter(
      (v) => v.uid === table.uid,
    );
    expect(shown).toHaveLength(1);
    expect(shown[0].col).toBe(table.col + 1);
  });

  it('refuses unrelated saves and undoes a left grid expansion', () => {
    const f = floor('a', ['a1']);
    expect(decorFromSave({ ...f.layout, furniture: [] }, [f], empty, catalog)).toBe(
      'not this office',
    );
    const d: Decor = {
      version: 1,
      rooms: { a: { tiles: [{ x: 1, y: 1, floor: paint }], furniture: [], removed: [] } },
    };
    const original = saveOf([f], d) as FloorLayout;
    const expanded: FloorLayout = {
      ...original,
      cols: original.cols + 1,
      tiles: new Array((original.cols + 1) * original.rows).fill(255),
      tileColors: new Array((original.cols + 1) * original.rows).fill(null),
      areaTiles: new Array((original.cols + 1) * original.rows).fill(null),
      furniture: original.furniture.map((v) => ({ ...v, col: v.col + 1 })),
    };
    for (let row = 0; row < original.rows; row++)
      for (let col = 0; col < original.cols; col++) {
        const src = row * original.cols + col,
          dst = row * expanded.cols + col + 1;
        expanded.tiles[dst] = original.tiles[src];
        expanded.tileColors[dst] = original.tileColors[src];
      }
    expect(decorFromSave(expanded, [f], empty, catalog)).toEqual(
      decorFromSave(original, [f], empty, catalog),
    );
  });

  it('resets just one room', () => {
    const room = { tiles: [], furniture: [], removed: ['plant:x'] };
    const d: Decor = { version: 1, rooms: { y: room, '2층 y': room, other: room } };
    expect(Object.keys(resetDecorRoom(d, 'y').rooms)).toEqual(['2층 y', 'other']);
  });

  it('writes 0600 atomically and moves a corrupt file aside', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-decor-'));
    const file = path.join(dir, 'decor.json');
    const store = new DecorStore(file);
    expect(store.save(empty)).toBeNull();
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(['decor.json']);
    fs.writeFileSync(file, '{bad');
    expect(new DecorStore(file).data).toEqual(empty);
    expect(fs.readdirSync(dir).some((name) => name.startsWith('decor.json.corrupt-'))).toBe(true);
  });

  it('never saves over a decor.json from a newer version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decor-'));
    const file = path.join(dir, 'decor.json');
    fs.writeFileSync(file, JSON.stringify({ version: 2, rooms: { a: { future: true } } }));
    const store = new DecorStore(file);
    expect(store.data).toEqual(empty);
    expect(store.save(empty)).toMatch(/덮어쓰지 않았어요/);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).version).toBe(2);
  });

  it('drops malformed entries while keeping valid decor', () => {
    expect(parseDecor({ version: 2, rooms: {} })).toBeNull();
    expect(
      parseDecor({
        version: 1,
        rooms: {
          a: {
            tiles: [
              { x: 1, y: 2, floor: paint },
              { x: 'bad', y: 2, carpet: {} },
            ],
            furniture: [
              { uid: 'ok', type: 'PLANT', x: 1, y: 2 },
              { uid: 3, type: 'PLANT', x: 1, y: 2 },
            ],
            removed: ['plant:a', 2],
          },
        },
      })?.rooms.a,
    ).toEqual({
      tiles: [{ x: 1, y: 2, floor: paint }],
      furniture: [{ uid: 'ok', type: 'PLANT', x: 1, y: 2 }],
      removed: ['plant:a'],
    });
  });
});
