import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import type { RoomSpec } from './layout.js';
import {
  contractorSeatUid,
  generateLayout,
  LOBBY_ROOM,
  LOUNGE_ROOM,
  MAX_COLS,
  PANTRY_ROOM,
  PANTRY_TYPES,
  PANTRY_UIDS,
  seatUid,
  WHITEBOARD_TYPE,
  whiteboardUid,
} from './layout.js';
import { REPO_ROOT } from './testHome.js';

/** Every asset id in the bundled furniture catalog (manifests), with its category. */
function bundledCatalog(): Map<string, string> {
  const root = path.join(REPO_ROOT, 'webview-ui/public/assets/furniture');
  const out = new Map<string, string>();
  const walk = (node: Record<string, unknown>, category: string) => {
    if (typeof node.id === 'string' && node.type !== 'group') out.set(node.id, category);
    for (const m of (node.members as Record<string, unknown>[] | undefined) ?? [])
      walk(m, category);
  };
  for (const d of fs.readdirSync(root)) {
    const m = JSON.parse(fs.readFileSync(path.join(root, d, 'manifest.json'), 'utf-8'));
    walk(m, m.category);
  }
  return out;
}

const S8 = [
  {
    label: 'orch-alpha',
    members: ['engine:alpha', 'engine:beta', 'engine:gamma'],
    contractorDesk: true,
  },
  {
    label: 'orch-beta',
    members: ['engine:delta', 'engine:epsilon', 'engine:zeta'],
    contractorDesk: true,
  },
  { label: 'orch-gamma', members: ['engine:eta', 'engine:theta'], contractorDesk: true },
  { label: '관리실', members: ['engine:ops-desk'] },
];

describe('layout generator', () => {
  const { layout, seats, rooms } = generateLayout(S8);
  const at = (c: number, r: number) => layout.tiles[r * layout.cols + c];

  it('one room (area) per tab in order, then the lounge and the lobby', () => {
    expect(rooms.map((r) => r.label)).toEqual(
      layout.areas.slice(0, rooms.length).map((a) => a.label),
    );
    for (const room of rooms)
      for (let y = room.y + 1; y < room.y + room.h - 1; y++)
        for (let x = room.x + 1; x < room.x + room.w - 1; x++)
          expect([room.label, PANTRY_ROOM]).toContain(layout.areaTiles[y * layout.cols + x]); // the pantry corner is the lounge's
    expect(layout.areas.map((a) => a.label)).toEqual([
      ...S8.map((r) => r.label),
      LOUNGE_ROOM,
      LOBBY_ROOM,
      PANTRY_ROOM, // LOUNGE: the pantry corner is an area, not a room
    ]);
    for (const r of S8) expect(layout.areaTiles).toContain(r.label);
    expect(layout.cols).toBeLessThanOrEqual(MAX_COLS);
    expect(layout.tiles).toHaveLength(layout.cols * layout.rows);
  });

  it('desks >= characters: a desk, PC and chair per member, plus contractor desks', () => {
    const desks = layout.furniture.filter((f) => f.type === 'DESK_FRONT');
    expect(desks.length).toBe(9 + 3);
    for (const r of S8) {
      for (const key of r.members) expect(seats[key]).toBe(seatUid(key));
    }
    const uids = new Set(layout.furniture.map((f) => f.uid));
    expect(uids.has(contractorSeatUid('orch-alpha'))).toBe(true);
    expect(uids.size).toBe(layout.furniture.length); // unique uids
  });

  it('each seat is a chair on a floor tile inside its own room, facing its desk', () => {
    for (const r of S8) {
      for (const key of r.members) {
        const chair = layout.furniture.find((f) => f.uid === seats[key])!;
        expect(at(chair.col, chair.row)).not.toBe(0);
        expect(at(chair.col, chair.row)).not.toBe(255);
        expect(layout.areaTiles[chair.row * layout.cols + chair.col]).toBe(r.label);
        const desk = layout.furniture.find(
          (f) => f.type === 'DESK_FRONT' && f.col === chair.col - 1 && f.row === chair.row - 2,
        );
        expect(desk).toBeDefined();
      }
    }
  });

  it('uses only furniture from the bundled catalog (chairs are chairs)', () => {
    const catalog = bundledCatalog();
    for (const f of layout.furniture) {
      const id = f.type.split(':')[0];
      expect(catalog.has(id), f.type).toBe(true);
    }
    for (const uid of Object.values(seats)) {
      const chair = layout.furniture.find((f) => f.uid === uid)!;
      expect(catalog.get(chair.type)).toBe('chairs');
    }
  });

  it('wraps rooms into rows before MAX_COLS and still seats everyone', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      label: `tab-${i}`,
      members: Array.from({ length: 4 }, (_, k) => `k${i}-${k}`),
      contractorDesk: true,
    }));
    const g = generateLayout(many);
    expect(g.layout.cols).toBeLessThanOrEqual(MAX_COLS);
    expect(Object.keys(g.seats)).toHaveLength(36);
    expect(g.layout.areas).toHaveLength(12); // and the lounge, the lobby and the pantry
  });

  it('works for project rooms without the engine (no contractor desks)', () => {
    const g = generateLayout([
      { label: 'alpha', members: ['name:a', 'sid:b'] },
      { label: 'beta', members: ['name:c'] },
    ]);
    expect(g.layout.furniture.filter((f) => f.type === 'DESK_FRONT')).toHaveLength(3);
  });

  it('the lobby (T-0046): benches, the door, a clear way in, no board (it stands outside)', () => {
    const cell = (c: number, r: number) => r * layout.cols + c;
    const lobby = layout.areaTiles.flatMap((a, i) => (a === LOBBY_ROOM ? [i] : []));
    const rows = lobby.map((i) => Math.floor(i / layout.cols));
    const y1 = Math.max(...rows);
    // building-a-1104: the lobby board is the billboard outside the building, never generated.
    expect(layout.furniture.some((f) => f.type === 'LED_BOARD')).toBe(false);
    const benches = layout.furniture.filter((f) => f.type === 'LOBBY_BENCH');
    expect(benches.length).toBeGreaterThanOrEqual(2);
    for (const b of benches) expect(layout.areaTiles[cell(b.col, b.row)]).toBe(LOBBY_ROOM);
    // The office door: a floor gap in the lobby's bottom wall, the floor's last row.
    const door = layout.areaTiles.findIndex(
      (a, i) => a === LOBBY_ROOM && Math.floor(i / layout.cols) === y1,
    );
    expect(Math.floor(door / layout.cols)).toBe(layout.rows - 1);
    // Every floor tile of the lobby not under furniture reaches the door.
    const blocked = new Set<number>();
    for (const f of layout.furniture.filter((f) => layout.areaTiles[cell(f.col, f.row)] === LOBBY_ROOM)) {
      const w = f.type === 'LOBBY_BENCH' ? 2 : 1;
      for (let c = f.col; c < f.col + w; c++) blocked.add(cell(c, f.row));
    }
    const seen = new Set([door]);
    const todo = [door];
    while (todo.length) {
      const i = todo.pop()!;
      for (const j of [i - 1, i + 1, i - layout.cols, i + layout.cols]) {
        if (seen.has(j) || layout.areaTiles[j] !== LOBBY_ROOM || blocked.has(j)) continue;
        seen.add(j);
        todo.push(j);
      }
    }
    for (const b of benches) expect(seen.has(cell(b.col, b.row + 1))).toBe(true);
    const open = lobby.filter((i) => !blocked.has(i) && layout.tiles[i] !== 0);
    for (const i of open) expect(seen.has(i), `lobby tile ${i}`).toBe(true);
  });

  it('the lounge stays its own room (T-0041), without the door when the lobby has it', () => {
    const lounge = layout.furniture.filter((f) => f.uid.startsWith('lounge:'));
    expect(lounge.map((f) => f.type)).toContain('COFFEE_TABLE');
    expect(
      lounge.every((f) =>
        [LOUNGE_ROOM, PANTRY_ROOM].includes(layout.areaTiles[f.row * layout.cols + f.col]!),
      ),
    ).toBe(true);
    // The floor's outer edge has a gap only in the lobby.
    const doors = new Set<string | null>();
    for (let c = 0; c < layout.cols; c++) {
      const r = layout.rows - 1;
      if (layout.tiles[r * layout.cols + c] !== 0 && layout.tiles[r * layout.cols + c] !== 255)
        doors.add(layout.areaTiles[r * layout.cols + c]);
    }
    expect([...doors]).toEqual([LOBBY_ROOM]);
  });

  it('a floor above the first keeps a lounge (with the door), no lobby and no board', () => {
    const g = generateLayout(S8, `2층 ${LOUNGE_ROOM}`, false, `2층 ${PANTRY_ROOM}`).layout;
    expect(g.areas.at(-2)!.label).toBe(`2층 ${LOUNGE_ROOM}`);
    expect(g.areas.at(-1)!.label).toBe(`2층 ${PANTRY_ROOM}`);
    expect(g.areas.some((a) => a.label === LOBBY_ROOM)).toBe(false);
    expect(g.furniture.some((f) => f.type === 'LED_BOARD')).toBe(false);
    const last = g.rows - 1;
    const gap = g.tiles.findIndex(
      (t, i) => Math.floor(i / g.cols) === last && t !== 0 && t !== 255,
    );
    expect(g.areaTiles[gap]).toBe(`2층 ${LOUNGE_ROOM}`);
  });

  it('LOUNGE: a pantry corner with a vending machine, a coffee machine and a water cooler (stable uids)', () => {
    const by = new Map(layout.furniture.map((f) => [f.uid, f]));
    const lounge = rooms.find((r) => r.label === LOUNGE_ROOM)!;
    const at = (uid: string) => by.get(uid)!;
    for (const k of ['vending', 'coffee', 'water'] as const) {
      expect(at(PANTRY_UIDS[k]).type).toBe(PANTRY_TYPES[k]);
      expect(bundledCatalog().has(PANTRY_TYPES[k])).toBe(true);
    }
    // side by side against the lounge's top wall; the pantry's own area is the row they are used from
    const row = at(PANTRY_UIDS.vending).row;
    expect(row).toBe(lounge.y + 1);
    const cols = [PANTRY_UIDS.vending, PANTRY_UIDS.coffee, PANTRY_UIDS.water].map((u) => at(u).col);
    expect(cols.map((c) => c - cols[0])).toEqual([0, 1, 2]);
    for (const c of cols) {
      expect(layout.areaTiles[row * layout.cols + c]).toBe(LOUNGE_ROOM);
      expect(layout.areaTiles[(row + 2) * layout.cols + c]).toBe(PANTRY_ROOM); // where it is used from
    }
  });

  it('a whiteboard on every work room top wall (T-0065), none in the lobby or lounges, none over a door', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      label: `tab-${i}`,
      members: Array.from({ length: i % 3 === 0 ? 1 : 4 }, (_, k) => `k${i}-${k}`),
      contractorDesk: true,
    }));
    for (const g of [generateLayout(S8), generateLayout(many)]) {
      const boards = g.layout.furniture.filter((f) => f.type === WHITEBOARD_TYPE);
      const work = g.rooms.filter((r) => ![LOUNGE_ROOM, LOBBY_ROOM].includes(r.label));
      expect(boards.map((b) => b.uid).sort()).toEqual(
        work.map((r) => whiteboardUid(r.label)).sort(),
      );
      for (const room of work) {
        const b = boards.find((f) => f.uid === whiteboardUid(room.label))!;
        // The bottom row is the room's top wall row; both tiles are wall, inside the corners.
        expect(b.row + 1).toBe(room.y);
        expect(b.col).toBeGreaterThan(room.x);
        expect(b.col + 1).toBeLessThan(room.x + room.w - 1);
        for (const c of [b.col, b.col + 1])
          expect(g.layout.tiles[room.y * g.layout.cols + c]).toBe(0);
      }
    }
  });

  it('regenerating keeps the whiteboard uids', () => {
    const again = generateLayout(S8).layout.furniture.filter((f) => f.type === WHITEBOARD_TYPE);
    expect(again.map((f) => f.uid)).toEqual(S8.map((r) => `whiteboard:${r.label}`));
    expect(again).toEqual(
      generateLayout(S8, LOUNGE_ROOM).layout.furniture.filter((f) => f.type === WHITEBOARD_TYPE),
    );
  });
});

describe('every floor fills the same plate (floors-fill-1104)', () => {
  const roomsOf = (n: number, tag: string) =>
    Array.from({ length: n }, (_, i) => ({
      label: `${tag}-${i}`,
      members: Array.from({ length: (i % 3) + 1 }, (_, k) => `engine:${tag}${i}-${k}`),
      contractorDesk: i % 2 === 0,
      spare: 2,
    }));
  const inputs: Array<[RoomSpec[], string, boolean, string]> = [
    [roomsOf(1, 'one'), LOUNGE_ROOM, true, PANTRY_ROOM],
    [roomsOf(4, 'four'), `2층 ${LOUNGE_ROOM}`, false, `2층 ${PANTRY_ROOM}`],
    [roomsOf(7, 'seven'), `3층 ${LOUNGE_ROOM}`, false, `3층 ${PANTRY_ROOM}`],
  ];
  // As floors.ts does: each floor's own size first, then all of them at the largest.
  const natural = inputs.map((args) => generateLayout(...args));
  const size = {
    cols: Math.max(...natural.map((g) => g.layout.cols)),
    rows: Math.max(...natural.map((g) => g.layout.rows)),
  };
  const floors = inputs.map((args) => generateLayout(...args, size));
  /** VOID tiles below the top row (row 0 is the headroom the top walls' sprites rise into). */
  const voids = (l: { cols: number; tiles: number[] }) =>
    l.tiles.filter((t, i) => i >= l.cols && t === 255).length;

  it('floors of 1, 4 and 7 rooms are one size, with no void left', () => {
    // The control: packed alone they differ, and the smaller ones would leave the plate bare.
    expect(new Set(natural.map((g) => `${g.layout.cols}x${g.layout.rows}`)).size).toBe(3);
    for (const { layout, rooms } of floors) {
      expect([layout.cols, layout.rows]).toEqual([size.cols, size.rows]);
      expect(voids(layout)).toBe(0);
      expect(layout.tiles.slice(0, layout.cols).every((t) => t === 255)).toBe(true);
      // The rooms tile the plate: every tile below row 0 is in a room.
      for (let r = 1; r < layout.rows; r++)
        for (let c = 0; c < layout.cols; c++)
          expect(rooms.some((m) => c >= m.x && c < m.x + m.w && r >= m.y && r < m.y + m.h)).toBe(
            true,
          );
    }
  });

  it('every seat and every room is reached on foot from the office door', () => {
    for (const { layout, rooms, seats } of floors) {
      const { cols } = layout;
      const blocked = new Set<number>();
      for (const f of layout.furniture) {
        if (f.uid.startsWith('seat:')) continue;
        const [w, h] = f.type === 'DESK_FRONT' ? [3, 2] : [1, 1];
        for (let dr = 0; dr < h; dr++)
          for (let dc = 0; dc < w; dc++) blocked.add((f.row + dr) * cols + f.col + dc);
      }
      const walk = (i: number) => layout.tiles[i] !== 0 && layout.tiles[i] !== 255 && !blocked.has(i);
      const last = (layout.rows - 1) * cols;
      const doors = Array.from({ length: cols }, (_, c) => last + c).filter(walk);
      expect(doors.length).toBe(2); // one office door
      const seen = new Set(doors);
      const todo = [...doors];
      while (todo.length) {
        const i = todo.pop()!;
        const c = i % cols;
        for (const j of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, i - cols, i + cols])
          if (j >= 0 && j < layout.tiles.length && !seen.has(j) && walk(j)) {
            seen.add(j);
            todo.push(j);
          }
      }
      for (const room of rooms)
        expect(
          [...seen].some((i) => layout.areaTiles[i] === room.label),
          room.label,
        ).toBe(true);
      const chairs = layout.furniture.filter((f) => f.uid.startsWith('seat:'));
      expect(chairs.length).toBeGreaterThan(Object.keys(seats).length);
      for (const ch of chairs) expect(seen.has(ch.row * cols + ch.col), ch.uid).toBe(true);
    }
  });

  it('seat uids stay the character names, as packed alone', () => {
    floors.forEach((g, k) => {
      expect(g.seats).toEqual(natural[k].seats);
      for (const spec of inputs[k][0])
        for (const key of spec.members) expect(g.seats[key]).toBe(seatUid(key));
      const uids = (x: typeof g) => x.layout.furniture.map((f) => f.uid).sort();
      expect(uids(g)).toEqual(uids(natural[k]));
    });
  });
});
