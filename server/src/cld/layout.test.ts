import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  BOARD_SIZE,
  BOARD_TYPE,
  contractorSeatUid,
  generateLayout,
  LOBBY_ROOM,
  LOUNGE_ROOM,
  MAX_COLS,
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
    expect(rooms.map((r) => r.label)).toEqual(layout.areas.map((a) => a.label));
    for (const room of rooms)
      for (let y = room.y + 1; y < room.y + room.h - 1; y++)
        for (let x = room.x + 1; x < room.x + room.w - 1; x++)
          expect(layout.areaTiles[y * layout.cols + x]).toBe(room.label);
    expect(layout.areas.map((a) => a.label)).toEqual([
      ...S8.map((r) => r.label),
      LOUNGE_ROOM,
      LOBBY_ROOM,
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
    expect(g.layout.areas).toHaveLength(11); // and the lounge and the lobby
  });

  it('works for project rooms without the engine (no contractor desks)', () => {
    const g = generateLayout([
      { label: 'alpha', members: ['name:a', 'sid:b'] },
      { label: 'beta', members: ['name:c'] },
    ]);
    expect(g.layout.furniture.filter((f) => f.type === 'DESK_FRONT')).toHaveLength(3);
  });

  it('the lobby (T-0046): the board on its top wall, benches facing it, the door, a clear way in', () => {
    const cell = (c: number, r: number) => r * layout.cols + c;
    const lobby = layout.areaTiles.flatMap((a, i) => (a === LOBBY_ROOM ? [i] : []));
    const cols = lobby.map((i) => i % layout.cols);
    const rows = lobby.map((i) => Math.floor(i / layout.cols));
    const [x0, x1, y0, y1] = [
      Math.min(...cols),
      Math.max(...cols),
      Math.min(...rows),
      Math.max(...rows),
    ];
    const board = layout.furniture.find((f) => f.type === BOARD_TYPE)!;
    expect(board).toBeDefined();
    // About two office rooms wide, inside the room, its screen up on the top wall (rows y0-2, y0-1).
    expect(BOARD_SIZE.w).toBeGreaterThanOrEqual(2 * 14);
    expect(board.col).toBeGreaterThanOrEqual(x0);
    expect(board.col + BOARD_SIZE.w - 1).toBeLessThanOrEqual(x1);
    expect(board.row).toBe(y0 - 2);
    expect(at(board.col, y0 - 1)).toBe(0); // the wall behind it
    const benches = layout.furniture.filter((f) => f.type === 'LOBBY_BENCH');
    expect(benches.length).toBeGreaterThanOrEqual(2);
    for (const b of benches) expect(b.row).toBeGreaterThan(board.row + BOARD_SIZE.h - 1); // in front of it
    // The office door: a floor gap in the lobby's bottom wall, the floor's last row.
    const door = layout.areaTiles.findIndex(
      (a, i) => a === LOBBY_ROOM && Math.floor(i / layout.cols) === y1,
    );
    expect(Math.floor(door / layout.cols)).toBe(layout.rows - 1);
    // Every floor tile of the lobby not under furniture reaches the door.
    const blocked = new Set<number>();
    for (const f of layout.furniture.filter(
      (f) => layout.areaTiles[cell(f.col, f.row + 1)] === LOBBY_ROOM || f.row >= y0,
    )) {
      const [w, h, bg] =
        f.type === BOARD_TYPE
          ? [BOARD_SIZE.w, BOARD_SIZE.h, 2]
          : f.type === 'LOBBY_BENCH'
            ? [2, 1, 0]
            : [1, 1, 0];
      for (let r = f.row + bg; r < f.row + h; r++)
        for (let c = f.col; c < f.col + w; c++) blocked.add(cell(c, r));
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
    // The benches' fronts and the walkway under the board are reachable.
    for (const b of benches) expect(seen.has(cell(b.col, b.row + 1))).toBe(true);
    expect(seen.has(cell(board.col, board.row + BOARD_SIZE.h))).toBe(true);
  });

  it('the lounge stays its own room (T-0041), without the door when the lobby has it', () => {
    const lounge = layout.furniture.filter((f) => f.uid.startsWith('lounge:'));
    expect(lounge.map((f) => f.type)).toContain('COFFEE_TABLE');
    expect(lounge.every((f) => layout.areaTiles[f.row * layout.cols + f.col] === LOUNGE_ROOM)).toBe(
      true,
    );
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
    const g = generateLayout(S8, `2층 ${LOUNGE_ROOM}`).layout;
    expect(g.areas.at(-1)!.label).toBe(`2층 ${LOUNGE_ROOM}`);
    expect(g.areas.some((a) => a.label === LOBBY_ROOM)).toBe(false);
    expect(g.furniture.some((f) => f.type === BOARD_TYPE)).toBe(false);
    const last = g.rows - 1;
    const gap = g.tiles.findIndex(
      (t, i) => Math.floor(i / g.cols) === last && t !== 0 && t !== 255,
    );
    expect(g.areaTiles[gap]).toBe(`2층 ${LOUNGE_ROOM}`);
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
