import { koText, matchKorean } from '../../../core/src/cld/serverText.js';
/**
 * Generated office (FR-OFC-001..003): one room per provider room (an engine project's room, or
 * the project directory of a Claude session) in order, each with a desk + PC + chair per
 * character and, with the engine's Codex, one contractor desk; then a lounge,
 * and on floor 1 the 로비 (T-0046): the entrance with the office door and the
 * big board. Rooms are packed left to right (sharing walls, with a door between
 * neighbours) and wrap to a new row at about a 1.6:1 office. Furniture ids come from
 * the bundled catalog; the desk unit copies the bundled default layout's
 * DESK_FRONT + PC_FRONT_OFF + CUSHIONED_BENCH arrangement.
 *
 * Chair uids are stable (`seat:<character key>`), and a chair's uid is its
 * seat id in the webview, so each character gets the seat for its name -- and
 * keeps it after the user edits and saves the layout.
 */

export const MAX_COLS = 64; // webview-ui/src/constants.ts
export const MAX_ROWS = 64;
export const LOUNGE_ROOM = koText('room_lounge');
/** LOUNGE: the pantry, a labelled corner of the lounge (vending machine, coffee machine, water cooler). */
export const PANTRY_ROOM = koText('room_pantry');
/** A room label as it is called now: the lounge was 라운지 ("2층 라운지") before, and a saved decor
 *  or floor layout may still key on that (decor.ts migrates it). Any other label comes back as is. */
export function currentLabel(label: string): string {
  const hit = matchKorean(label);
  if (hit?.code === 'room_lounge_old') return LOUNGE_ROOM;
  if (hit?.code === 'room_lounge_floor_old') return koText('room_lounge_floor', hit.params);
  return label;
}
/** The pantry's three machines (stable uids, ordinary catalog objects the editor can move). */
export const PANTRY_UIDS = {
  vending: 'lounge:vending',
  coffee: 'lounge:coffee',
  water: 'lounge:water',
} as const;
export const PANTRY_TYPES = {
  vending: 'VENDING_MACHINE',
  coffee: 'COFFEE_MACHINE',
  water: 'WATER_COOLER',
} as const;
/** The pantry corner: three machines side by side, two rows high; its area is the row they are
 *  used from (its label then sits below the machines, not over them). */
const PANTRY_SIZE = { w: 3 };
const PANTRY_MACHINE_ROWS = 2;
/** Floor 1's entrance (T-0046): the office door, the big board, benches. */
export const LOBBY_ROOM = koText('room_lobby');
/** The board's furniture type (webview-ui/public/assets/furniture/LED_BOARD). */
export const BOARD_TYPE = 'LED_BOARD';
/** A work room's whiteboard (T-0065): a 2x2 wall item, the memo is drawn over it by the webview. */
export const WHITEBOARD_TYPE = 'WHITEBOARD';
export const whiteboardUid = (room: string): string => `whiteboard:${room}`;
const WHITEBOARD_W = 2;

const WALL = 0;
const VOID = 255;
export const WALL_TILE = WALL;
export const VOID_TILE = VOID;
// T-0041 roomier rooms: a desk unit (desk 3x2 + chair) and the walkway around
// it, 2 tiles inside the walls and between units, 3-tile doors.
const UNIT = 3;
const WALK = 2;
const STEP = UNIT + WALK;
const DOOR = 3;
const LOUNGE_SIZE = { w: 11, h: 9 };
/** The big board's footprint (LED_BOARD, about two office rooms wide). */
export const BOARD_SIZE = { w: 28, h: 11 };
/** Its top rows hang on the wall: characters never stand behind them. */
const BOARD_BACKGROUND_ROWS = 2;
// The lobby: the board (its screen up on the top wall), a walkway, benches
// facing it, room to walk, and the office door in the outer wall.
const LOBBY_SIZE = { w: BOARD_SIZE.w + 7, h: BOARD_SIZE.h + 4 };
const unitsPerRow = (units: number) => (units > 6 ? 4 : 3);
const WALL_COLOR = { h: 214, s: 30, b: -100, c: -55 };
// Floor tile type + colour per room, cycled (taken from the bundled layout).
const FLOORS = [
  { tile: 7, color: { h: 25, s: 48, b: -43, c: -88 } },
  { tile: 1, color: { h: 209, s: 39, b: -25, c: -80 } },
  { tile: 9, color: { h: 209, s: 0, b: -16, c: -8 } },
];
// Layout data, not UI styling: the webview's AREA_DEFAULT_COLORS (server cannot import webview-ui).
/* eslint-disable pixel-agents/no-inline-colors */
const AREA_COLORS = [
  '#ff6b6b',
  '#feca57',
  '#48dbfb',
  '#1dd1a1',
  '#5f27cd',
  '#ff9ff3',
  '#54a0ff',
  '#ffa502',
];
/* eslint-enable pixel-agents/no-inline-colors */

export const seatUid = (key: string): string => `seat:${key}`;
export const contractorSeatUid = (room: string): string => `seat:codex@${room}`;
/** A spare desk's key: its seat is `seat:spare@<room>:<k>`, the same across resizes. */
export const spareKey = (room: string, k: number): string => `spare@${room}:${k}`;
export const codexLabel = (project: string): string => `codex·${project}`;

export interface PlacedFurniture {
  uid: string;
  type: string;
  col: number;
  row: number;
}

export interface GeneratedLayout {
  rooms: RoomRect[];
  layout: {
    version: 1;
    cols: number;
    rows: number;
    tiles: number[];
    tileColors: Array<{ h: number; s: number; b: number; c: number } | null>;
    furniture: PlacedFurniture[];
    areas: Array<{ label: string; color: string }>;
    areaTiles: Array<string | null>;
  };
  /** character key -> seat (chair uid). */
  seats: Record<string, string>;
  /** Rooms that did not fit under MAX_ROWS: the next floor takes them (T-0041). */
  overflow: string[];
}

export interface RoomRect {
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RoomSpec {
  label: string;
  /** Character keys, in seat order. */
  members: string[];
  /** One extra desk for Codex contractors. */
  contractorDesk?: boolean;
  /** Spare desks for temps (T-0041, roomSizer.ts). */
  spare?: number;
}

interface Room {
  label: string;
  /** Desk units in order: a character key, `spare@…` for a temp's, or null for the contractor desk. */
  units: Array<string | null>;
  lounge?: boolean;
  lobby?: boolean;
  w: number;
  h: number;
  x: number;
  y: number;
}

/** The column a room's whiteboard would start at to sit in the middle. */
const mid = (r: Pick<Room, 'x' | 'w'>) => r.x + Math.floor((r.w - WHITEBOARD_W) / 2);

/** Walls, walkways and desk units: STEP per unit, a walkway and a wall each side. */
function roomSize(r: Pick<Room, 'units' | 'lounge' | 'lobby'>): { w: number; h: number } {
  if (r.lobby) return LOBBY_SIZE;
  if (r.lounge) return LOUNGE_SIZE;
  const per = unitsPerRow(r.units.length);
  const perRow = Math.min(r.units.length, per);
  const rows = Math.ceil(r.units.length / per);
  return { w: STEP * perRow - WALK + 2 * (WALK + 1), h: STEP * rows - WALK + 2 * (WALK + 1) };
}

/**
 * Shelf packing: neighbours share a wall column, shelves share a wall row.
 * Rows wrap at a width that keeps the office about 1.6:1 (a desktop screen),
 * never past MAX_COLS. One void row on top leaves room for tall wall sprites.
 */
function pack(specs: Array<Pick<Room, 'label' | 'units' | 'lounge' | 'lobby'>>): Room[] {
  const sizes = specs.map(roomSize);
  const area = sizes.reduce((a, s) => a + s.w * s.h, 0);
  const rowWidth = Math.min(
    MAX_COLS,
    Math.max(...sizes.map((s) => s.w), Math.ceil(Math.sqrt(area * 1.6))),
  );
  const rooms: Room[] = [];
  let x = 0;
  let y = 1;
  let shelfH = 0;
  let shelfStart = 0;
  for (const [i, spec] of specs.entries()) {
    const { w, h } = sizes[i];
    if (x > 0 && x + w > rowWidth) {
      for (const r of rooms.slice(shelfStart)) r.h = shelfH;
      shelfStart = rooms.length;
      [x, y, shelfH] = [0, y + shelfH - 1, 0];
    }
    rooms.push({ ...spec, w, h, x, y });
    shelfH = Math.max(shelfH, h);
    x += w - 1;
  }
  for (const r of rooms.slice(shelfStart)) r.h = shelfH;
  return rooms;
}

/**
 * `lounge`: the lounge's label (a floor above the first names its own,
 * T-0027), `pantry` the label of its pantry corner (also one per floor).
 * `lobby`: the floor has the 로비 (floor 1), which then holds the office door instead of the lounge.
 */
export function generateLayout(
  roomSpecs: RoomSpec[],
  lounge = LOUNGE_ROOM,
  lobby = lounge === LOUNGE_ROOM,
  pantry = PANTRY_ROOM,
): GeneratedLayout {
  const work: Array<Pick<Room, 'label' | 'units'>> = roomSpecs
    .filter((r) => r.members.length || r.contractorDesk)
    .map((r) => ({
      label: r.label,
      units: [
        ...r.members,
        ...(r.contractorDesk ? [null] : []),
        ...Array.from({ length: r.spare ?? 0 }, (_, k) => spareKey(r.label, k)),
      ],
    }));
  const special: Array<Pick<Room, 'label' | 'units' | 'lounge' | 'lobby'>> = [
    { label: lounge, units: [], lounge: true },
    ...(lobby ? [{ label: LOBBY_ROOM, units: [], lobby: true }] : []),
  ];
  // The lounge and the lobby always fit: the last work rooms spill to the
  // next floor while the office would pass MAX_ROWS (T-0041).
  const overflow: string[] = [];
  let rooms = pack([...work, ...special]);
  while (work.length > 1 && Math.max(...rooms.map((r) => r.y + r.h)) > MAX_ROWS) {
    overflow.unshift(work.pop()!.label);
    rooms = pack([...work, ...special]);
  }

  const cols = Math.max(...rooms.map((r) => r.x + r.w));
  const rows = Math.max(...rooms.map((r) => r.y + r.h));
  const tiles = new Array<number>(cols * rows).fill(VOID);
  const tileColors = new Array<GeneratedLayout['layout']['tileColors'][number]>(cols * rows).fill(
    null,
  );
  const areaTiles = new Array<string | null>(cols * rows).fill(null);
  const furniture: PlacedFurniture[] = [];
  const seats: Record<string, string> = {};
  const pantryAreas: string[] = [];
  const set = (c: number, r: number, tile: number, color: (typeof tileColors)[number]) => {
    tiles[r * cols + c] = tile;
    tileColors[r * cols + c] = color;
  };

  rooms.forEach((room, i) => {
    const floor = FLOORS[i % FLOORS.length];
    for (let r = room.y; r < room.y + room.h; r++) {
      for (let c = room.x; c < room.x + room.w; c++) {
        const edge =
          r === room.y || r === room.y + room.h - 1 || c === room.x || c === room.x + room.w - 1;
        // Shared walls stay walls: never paint over a neighbour's floor.
        if (edge) {
          if (tiles[r * cols + c] === VOID) set(c, r, WALL, WALL_COLOR);
        } else {
          set(c, r, floor.tile, floor.color);
          areaTiles[r * cols + c] = room.label;
        }
      }
    }
    // Doors: to the previous room in the shelf (shared column), and from the
    // first room of a lower shelf up into the first room of the shelf above.
    if (room.x > 0) {
      for (let k = 0; k < DOOR; k++) set(room.x, room.y + room.h - 2 - k, floor.tile, floor.color);
    } else if (i > 0) {
      for (let k = 0; k < DOOR; k++) set(2 + k, room.y, floor.tile, floor.color);
    }

    // The office door (T-0041): a gap in the outer wall, the floor's last
    // row, where temps come in and everyone goes home. The lobby's on floor
    // 1, the lounge's above it.
    const door = (c: number) => {
      for (const k of [c, c + 1]) {
        set(k, room.y + room.h - 1, floor.tile, floor.color);
        areaTiles[(room.y + room.h - 1) * cols + k] = room.label;
      }
    };
    if (room.lobby) {
      // T-0046: the big board stands against the top wall, its screen up on
      // the wall, clear of a door down from the shelf above (cols 2-4 of a
      // first room); benches face it across a walkway.
      const bx = room.x + 5;
      const front = room.y + BOARD_SIZE.h - BOARD_BACKGROUND_ROWS;
      door(room.x + Math.floor(room.w / 2));
      furniture.push({ uid: 'lobby:board', type: BOARD_TYPE, col: bx, row: room.y - 1 });
      for (const k of [0, 1, 2])
        furniture.push({
          uid: `lobby:bench-${k + 1}`,
          type: 'LOBBY_BENCH',
          col: bx + 4 + 9 * k,
          row: front + 2,
        });
      furniture.push(
        { uid: 'lobby:plant-1', type: 'PLANT', col: room.x + 1, row: room.y + 1 },
        { uid: 'lobby:plant-2', type: 'PLANT', col: room.x + room.w - 2, row: front + 3 },
      );
      return;
    }
    if (room.lounge) {
      const tx = room.x + 5;
      const ty = room.y + 4;
      if (!lobby) door(tx);
      furniture.push(
        { uid: 'lounge:table', type: 'COFFEE_TABLE', col: tx, row: ty },
        { uid: 'lounge:sofa-front', type: 'SOFA_FRONT', col: tx, row: ty - 1 },
        { uid: 'lounge:sofa-back', type: 'SOFA_BACK', col: tx, row: ty + 2 },
        { uid: 'lounge:sofa-left', type: 'SOFA_SIDE', col: tx - 1, row: ty },
        { uid: 'lounge:sofa-right', type: 'SOFA_SIDE:left', col: tx + 2, row: ty },
        { uid: 'lounge:plant-1', type: 'PLANT', col: room.x + 1, row: room.y + 1 },
        { uid: 'lounge:plant-2', type: 'PLANT', col: room.x + room.w - 2, row: room.y + 5 },
      );
      // LOUNGE: the pantry is the top right corner (a corner, not a room of its own: the rooms'
      // packing stays as it was). The machines stand against the top wall, side by side, and
      // are used from the row below (free of the sofas, which end a row lower).
      const px = room.x + room.w - 1 - PANTRY_SIZE.w;
      (['vending', 'coffee', 'water'] as const).forEach((k, i) =>
        furniture.push({
          uid: PANTRY_UIDS[k],
          type: PANTRY_TYPES[k],
          col: px + i,
          row: room.y + 1,
        }),
      );
      for (let c = px; c < px + PANTRY_SIZE.w; c++)
        areaTiles[(room.y + 1 + PANTRY_MACHINE_ROWS) * cols + c] = pantry;
      pantryAreas.push(pantry);
      return;
    }

    const per = unitsPerRow(room.units.length);
    room.units.forEach((name, k) => {
      const ux = room.x + WALK + 1 + STEP * (k % per);
      const uy = room.y + WALK + 1 + STEP * Math.floor(k / per);
      const key = name ?? `codex@${room.label}`;
      const seat = name ? seatUid(name) : contractorSeatUid(room.label);
      furniture.push(
        { uid: `desk:${key}`, type: 'DESK_FRONT', col: ux, row: uy },
        { uid: `pc:${key}`, type: 'PC_FRONT_OFF', col: ux + 1, row: uy },
        { uid: seat, type: 'CUSHIONED_BENCH', col: ux + 1, row: uy + 2 },
      );
      if (name && !name.startsWith('spare@')) seats[name] = seat;
    });
    // T-0065: the whiteboard hangs on the top wall, as near the middle as two wall tiles
    // (no door) allow; its bottom row is the wall row, its top row the one above.
    const wall = (c: number) => tiles[room.y * cols + c] === WALL;
    const slots = Array.from({ length: room.w - 2 - (WHITEBOARD_W - 1) }, (_, k) => room.x + 1 + k)
      .filter((c) => wall(c) && wall(c + 1))
      .sort((a, b) => Math.abs(a - mid(room)) - Math.abs(b - mid(room)));
    if (slots.length)
      furniture.push({
        uid: whiteboardUid(room.label),
        type: WHITEBOARD_TYPE,
        col: slots[0],
        row: room.y - 1,
      });
    furniture.push({
      uid: `plant:${room.label}`,
      type: 'PLANT',
      col: room.x + room.w - 2,
      row: room.y + 1,
    });
  });

  return {
    rooms: rooms.map(({ label, x, y, w, h }) => ({ label, x, y, w, h })),
    layout: {
      version: 1,
      cols,
      rows,
      tiles,
      tileColors,
      furniture,
      areas: [
        ...rooms.map((r, i) => ({ label: r.label, color: AREA_COLORS[i % AREA_COLORS.length] })),
        ...pantryAreas.map((label, i) => ({
          label,
          color: AREA_COLORS[(rooms.length + i) % AREA_COLORS.length],
        })),
      ],
      areaTiles,
    },
    seats,
    overflow,
  };
}

// ── Floors (T-0027) ───────────────────────────────────────────

/** Void rows between stacked floors: no path joins two floors. */
export const FLOOR_GAP = 2;
export const floorPrefix = (id: string, k: number): string => (k ? `${id}/` : '');
export function floorRowOffsets(layouts: Array<{ rows: number }>): number[] {
  let top = 0;
  return layouts.map(({ rows }) => {
    const row = top;
    top += rows + FLOOR_GAP;
    return row;
  });
}

/** A floor's part of the stacked office (the layout's `cldFloors`). */
export interface FloorRect {
  id: string;
  row: number;
  rows: number;
  cols: number;
}

type AnyLayout = Record<string, unknown> & {
  cols: number;
  rows: number;
  tiles: unknown[];
  furniture: Array<Record<string, unknown> & { uid: string; row: number }>;
};

/**
 * Floors stacked top to bottom into the one layout upstream draws, seats and
 * walks, FLOOR_GAP void rows apart, with `cldFloors` saying which rows are
 * which floor. Furniture uids other than seats (`seat:<name>`, the
 * characters' own) get the floor's `prefix`, so the floors' lounges and
 * plants stay apart. Area labels are the caller's to keep apart (a floor's
 * annexes and lounge carry its number); the first of a label wins its colour.
 */
export function stackFloors(
  floors: Array<{ id: string; prefix: string; layout: Record<string, unknown> }>,
): Record<string, unknown> {
  const layouts = floors.map((f) => f.layout as AnyLayout);
  const cols = Math.max(...layouts.map((l) => l.cols));
  const cldFloors: FloorRect[] = [];
  const offsets = floorRowOffsets(layouts);
  for (const [k, l] of layouts.entries()) {
    cldFloors.push({ id: floors[k].id, row: offsets[k], rows: l.rows, cols: l.cols });
  }
  const rows = offsets.at(-1)! + layouts.at(-1)!.rows;
  const cells = (fill: unknown) => new Array<unknown>(cols * rows).fill(fill);
  const tiles = cells(VOID);
  const tileColors = cells(null);
  const areaTiles = cells(null);
  const carpetTiles = layouts.some((l) => Array.isArray(l.carpetTiles)) ? cells(null) : null;
  const furniture: AnyLayout['furniture'] = [];
  const areas: Array<{ label: string }> = [];
  for (const [k, l] of layouts.entries()) {
    const row0 = cldFloors[k].row;
    const per = (key: string) => (Array.isArray(l[key]) ? (l[key] as unknown[]) : null);
    const [colors, labels, carpet] = [per('tileColors'), per('areaTiles'), per('carpetTiles')];
    for (let r = 0; r < l.rows; r++) {
      for (let c = 0; c < l.cols; c++) {
        const from = r * l.cols + c;
        const to = (row0 + r) * cols + c;
        tiles[to] = l.tiles[from];
        tileColors[to] = colors?.[from] ?? null;
        areaTiles[to] = labels?.[from] ?? null;
        if (carpetTiles) carpetTiles[to] = carpet?.[from] ?? null;
      }
    }
    for (const f of l.furniture) {
      const uid = f.uid.startsWith('seat:') ? f.uid : `${floors[k].prefix}${f.uid}`;
      furniture.push({ ...f, uid, row: f.row + row0 });
    }
    for (const a of (per('areas') ?? []) as Array<{ label: string }>) {
      if (!areas.some((x) => x.label === a.label)) areas.push(a);
    }
  }
  // Upstream reads tile 8 as the old VOID unless the layout has a revision.
  const revision = Math.max(0, ...layouts.map((l) => Number(l.layoutRevision) || 0));
  return {
    version: 1,
    cols,
    rows,
    tiles,
    tileColors,
    furniture,
    areas,
    areaTiles,
    ...(carpetTiles && { carpetTiles }),
    ...(revision > 0 && { layoutRevision: revision }),
    ...(Array.isArray(layouts[0].pets) && { pets: layouts[0].pets }),
    cldFloors,
  };
}
