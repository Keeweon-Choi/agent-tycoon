import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  LOUNGE_DRINK_MAX_SEC,
  LOUNGE_DRINK_MIN_SEC,
  LOUNGE_DRINK_STEP_SEC,
  LOUNGE_DRINK_STEPS,
  LOUNGE_USE_SEC,
  OWNER_CHARACTER_ID,
} from '../constants.js';
import { OfficeState } from '../office/engine/officeState.js';
import type { LoadedAssetData } from '../office/layout/furnitureCatalog.js';
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js';
import {
  type Character,
  CharacterState,
  Direction,
  type OfficeLayout,
  TILE_SIZE,
  TileType,
} from '../office/types.js';
import { director, makeAction, ownerDrink } from './director/actions.js';
import { Director } from './director/director.js';
import { visitFloor } from './elevator.js';
import {
  beginRest,
  DRINK_SEC,
  drinkPose,
  endBreak,
  endRest,
  LOUNGE_SUFFIX,
  machineStand,
  nextDrinkIn,
  pantryNear,
  playSec,
  playState,
  restDropAt,
  restSpotFor,
  restStep,
  startBreak,
} from './lounge.js';
import { setOfficeHours } from './officeHours.js';
import { agtyHandleMessage, agtyResetForTests } from './officeStore.js';
import { staffResetForTests, staffSnapshot, staffStep } from './staff.js';
import { floorIndexAt, floorRects } from './walk.js';

const LOUNGE = `1${LOUNGE_SUFFIX}`;
const LOBBY = '\uB85C\uBE44'; // the lobby's label

beforeAll(() => {
  const asset = (id: string, extra: Partial<LoadedAssetData['catalog'][number]> = {}) => ({
    id,
    label: id,
    category: 'misc',
    width: 16,
    height: 16,
    footprintW: 1,
    footprintH: 1,
    isDesk: false,
    ...extra,
  });
  const machine = (id: string) => [
    asset(id, { height: 32, footprintH: 2, groupId: id, state: 'off' }),
    ...[1, 2, 3].map((k) =>
      asset(`${id}_${k}`, {
        height: 32,
        footprintH: 2,
        groupId: id,
        state: 'on',
        animationGroup: `${id}__ON`,
        frame: k - 1,
      }),
    ),
  ];
  const catalog = [
    asset('CHAIR', { category: 'chairs' }),
    asset('SOFA', { category: 'chairs' }),
    ...machine('VENDING_MACHINE'),
    ...machine('COFFEE_MACHINE'),
    asset('WATER_COOLER', { height: 32, footprintH: 2 }),
  ];
  const sprites = Object.fromEntries(catalog.map((c) => [c.id, [['x']]]));
  expect(buildDynamicCatalog({ catalog, sprites })).toBe(true);
});

const COLS = 12;
const ROWS = 11;
/** A walled floor: a work room (cols 1-5), a lounge (cols 6-10) with a sofa of two seats and the
 *  three pantry machines on its top wall (stand tiles in row 3). `lobby`: that sofa is a lobby's bench. */
function floorTiles(): number[] {
  return Array.from({ length: COLS * ROWS }, (_, i) => {
    const c = i % COLS;
    const r = Math.floor(i / COLS);
    const edge = c === 0 || r === 0 || c === COLS - 1 || r === ROWS - 1;
    return edge ? TileType.WALL : TileType.FLOOR_1;
  });
}
function areas(offset = 0, zone = LOUNGE): Array<string | null> {
  return Array.from({ length: COLS * ROWS }, (_, i) => {
    const c = i % COLS;
    const r = Math.floor(i / COLS) - offset;
    if (r < 1 || r >= ROWS - 1 || c < 1 || c >= COLS - 1) return null;
    return c >= 6 ? zone : 'room';
  });
}
const lounge = (row0 = 0, uidPrefix = '') => [
  { uid: `${uidPrefix}lounge:sofa-a`, type: 'SOFA', col: 7, row: row0 + 6 },
  { uid: `${uidPrefix}lounge:sofa-b`, type: 'SOFA', col: 8, row: row0 + 6 },
  { uid: `${uidPrefix}lounge:vending`, type: 'VENDING_MACHINE', col: 7, row: row0 + 1 },
  { uid: `${uidPrefix}lounge:coffee`, type: 'COFFEE_MACHINE', col: 8, row: row0 + 1 },
  { uid: `${uidPrefix}lounge:water`, type: 'WATER_COOLER', col: 9, row: row0 + 1 },
];
function oneFloor(zone = LOUNGE, sofas = true): OfficeLayout {
  const furniture = [
    { uid: 'seat:a', type: 'CHAIR', col: 2, row: 3 },
    { uid: 'seat:b', type: 'CHAIR', col: 3, row: 3 },
    { uid: 'seat:c', type: 'CHAIR', col: 4, row: 3 },
    ...lounge().filter((f) => sofas || !f.type.startsWith('SOFA')),
  ];
  return {
    version: 1,
    cols: COLS,
    rows: ROWS,
    tiles: floorTiles(),
    furniture,
    areaTiles: areas(0, zone),
  } as OfficeLayout;
}
const GAP = 2;
function twoFloors(): OfficeLayout {
  const gap = new Array(COLS * GAP).fill(TileType.VOID);
  const f2 = ROWS + GAP;
  return {
    version: 1,
    cols: COLS,
    rows: ROWS * 2 + GAP,
    tiles: [...floorTiles(), ...gap, ...floorTiles()],
    furniture: [{ uid: 'seat:a', type: 'CHAIR', col: 2, row: 3 }, ...lounge(), ...lounge(f2, '2/')],
    areaTiles: [...areas(0), ...new Array(COLS * GAP).fill(null), ...areas()],
    agtyFloors: [
      { id: '1', row: 0, rows: ROWS, cols: COLS },
      { id: '2', row: f2, rows: ROWS, cols: COLS },
    ],
  } as OfficeLayout;
}

function office(layout: OfficeLayout, ids: number[]): OfficeState {
  const os = new OfficeState(layout);
  os.rebuildFromLayout(layout);
  for (const id of ids) {
    // each at its own desk (seat:a, seat:b, seat:c): never on a sofa
    os.addAgent(id, 0, 0, `seat:${'abc'[ids.indexOf(id)]}`, true);
    os.setAgentActive(id, false);
  }
  return os;
}
const at = (ch: Character) => [ch.tileCol, ch.tileRow];
function run(os: OfficeState, s: number, each?: () => void): void {
  for (let t = 0; t < s; t += 0.05) {
    os.update(0.05);
    each?.();
  }
}
/** Put a character on a tile (no walk). */
function place(os: OfficeState, id: number, col: number, row: number): Character {
  const ch = os.characters.get(id)!;
  Object.assign(ch, {
    tileCol: col,
    tileRow: row,
    x: col * TILE_SIZE + TILE_SIZE / 2,
    y: row * TILE_SIZE + TILE_SIZE / 2,
    path: [],
    state: CharacterState.IDLE,
  });
  return ch;
}

describe('the rest spot (LOUNGE)', () => {
  it('is the nearest free sofa seat in the lounge, a different one for each character', () => {
    const os = office(oneFloor(), [1, 2, 3]);
    const seats = [...os.seats.keys()].filter((u) => u.startsWith('lounge:sofa'));
    expect(seats).toHaveLength(2);
    beginRest(os, os.characters.get(1)!);
    beginRest(os, os.characters.get(2)!);
    const [a, b] = [1, 2].map((id) => os.characters.get(id)!.agtyRest!.spot);
    expect(a.seat && seats.includes(a.seat)).toBe(true);
    expect(b.seat && seats.includes(b.seat)).toBe(true);
    expect(a.seat).not.toBe(b.seat);
    // the sofa is full: the third dozes at its own desk, never standing round the sofa
    const ch3 = os.characters.get(3)!;
    const desk = os.seats.get(ch3.seatId!)!;
    expect(restSpotFor(os, ch3)).toEqual({ tile: { col: desk.seatCol, row: desk.seatRow }, seat: ch3.seatId });
  });

  it('falls back to its own desk when the floor has no lounge, and counts the lobby benches', () => {
    const none = office(oneFloor('room', false), [1]);
    none.rebuildFromLayout({
      ...oneFloor('room', false),
      areaTiles: areas(0, 'room'),
    } as OfficeLayout);
    const ch = none.characters.get(1)!;
    expect(restSpotFor(none, ch)).toEqual({
      tile: { col: none.seats.get(ch.seatId!)!.seatCol, row: none.seats.get(ch.seatId!)!.seatRow },
      seat: ch.seatId,
    });
    const lobby = office(oneFloor(LOBBY), [1]);
    expect(restSpotFor(lobby, lobby.characters.get(1)!).seat).toMatch(/^lounge:sofa/);
  });

  it('never takes a seat somebody else holds', () => {
    const os = office(oneFloor(), [1, 2]);
    const sofa = [...os.seats.keys()].filter((u) => u.startsWith('lounge:sofa'));
    os.seats.get(sofa[0])!.assigned = true; // a temp lingers on it
    expect(restSpotFor(os, os.characters.get(1)!).seat).toBe(sofa[1]);
  });
});

describe('the drink timer and the drinking sequence (LOUNGE)', () => {
  it('a drink comes a few minutes apart, at random', () => {
    expect(nextDrinkIn(() => 0)).toBe(LOUNGE_DRINK_MIN_SEC);
    expect(nextDrinkIn(() => 1)).toBe(LOUNGE_DRINK_MAX_SEC);
    expect(LOUNGE_DRINK_MIN_SEC).toBeGreaterThanOrEqual(120); // "a few minutes"
  });

  it("plays the owner's seven steps in even steps: stand, hold, open, drink, drink back, hold, smile", () => {
    expect(DRINK_SEC).toBeCloseTo(LOUNGE_DRINK_STEPS * LOUNGE_DRINK_STEP_SEC);
    const steps = (kind: 'vending' | 'coffee' | 'water') =>
      Array.from({ length: LOUNGE_DRINK_STEPS }, (_, k) =>
        drinkPose(kind, (k + 0.5) * LOUNGE_DRINK_STEP_SEC),
      );
    const can = steps('vending');
    expect(can.map((p) => p.step)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(can.map((p) => p.prop?.name ?? null)).toEqual([
      null,
      'can',
      'can',
      'canTilt',
      'canTilt',
      'can',
      'can',
    ]);
    expect(can[2].hiss).not.toBeNull(); // it hisses as it opens, and only then
    expect(can.filter((p) => p.hiss)).toHaveLength(1);
    expect(can[3].prop!.at[1]).toBeLessThan(can[1].prop!.at[1]); // raised to the mouth
    const mug = steps('coffee');
    expect(mug.map((p) => p.prop?.name ?? null)).toEqual([
      null,
      'mug',
      'mug',
      'mug',
      'mug',
      'mug',
      'mug',
    ]);
    expect(mug[2].prop!.at[1]).toBeLessThan(mug[1].prop!.at[1]); // raised
    expect(mug[3].prop!.at[1]).toBeLessThan(mug[2].prop!.at[1]); // to the lips
    expect(mug.filter((p) => p.steam)).toHaveLength(1); // steam on the sip
    expect(steps('water')[1].prop!.name).toBe('paperCup');
    expect(steps('water').some((p) => p.steam)).toBe(false);
    // the sequence ends where it ends: no step past the last
    expect(drinkPose('coffee', 99).step).toBe(LOUNGE_DRINK_STEPS - 1);
  });

  it('a machine plays its states in turn and rests after (coffee: cup, pouring, done)', () => {
    const [a, b, c] = LOUNGE_USE_SEC.coffee;
    expect(
      [0, a - 0.01, a, a + b - 0.01, a + b, a + b + c - 0.01].map((t) => playState('coffee', t)),
    ).toEqual([0, 0, 1, 1, 2, 2]);
    expect(playSec('coffee')).toBeCloseTo(a + b + c);
    expect(playSec('water')).toBeGreaterThan(0);
  });
});

describe('resting in the lounge (LOUNGE)', () => {
  it('walks to its sofa seat and sits, keeping its desk; on duty again it walks back to the desk', () => {
    const os = office(oneFloor(), [1]);
    const ch = os.characters.get(1)!;
    const desk = ch.seatId!;
    const deskSeat = os.seats.get(desk)!;
    place(os, 1, deskSeat.seatCol, deskSeat.seatRow);
    beginRest(os, ch);
    const sofa = ch.agtyRest!.spot;
    expect(sofa.seat).toMatch(/^lounge:sofa/);
    expect(ch.path.length).toBeGreaterThan(0);
    run(os, 8);
    expect(at(ch)).toEqual([sofa.tile.col, sofa.tile.row]);
    expect(ch.state).toBe(CharacterState.TYPE); // sitting
    expect(ch.agtyRest!.phase).toBe('rest');
    expect(ch.seatId).toBe(desk); // the desk is still its seat: nothing here is ever saved as one
    expect(os.getPersistableSeats()[1].seatId).toBe(desk);
    expect(os.seats.get(desk)!.assigned).toBe(true);
    // it stays still: the FSM does not stand it up or wander it off
    run(os, 40);
    expect(at(ch)).toEqual([sofa.tile.col, sofa.tile.row]);
    expect(ch.state).toBe(CharacterState.TYPE);
    // back on duty: out of its rest, walking from where it is to its desk, no door, no spawn effect
    endRest(os, ch);
    os.sendToSeat(1);
    expect(ch.agtyRest).toBeUndefined();
    expect(ch.matrixEffect).toBe(null);
    expect(ch.path.at(-1)).toEqual({ col: deskSeat.seatCol, row: deskSeat.seatRow });
    // it gets there; an idle character may then stand up and wander off again (the FSM's idle walk,
    // random), which made "at the desk after 10 s" fail now and then
    let reached = false;
    run(os, 10, () => {
      reached ||= ch.tileCol === deskSeat.seatCol && ch.tileRow === deskSeat.seatRow;
    });
    expect(reached).toBe(true);
  });

  it('now and then walks to a machine, stands facing it while it plays, drinks, and goes back', () => {
    const os = office(oneFloor(), [1]);
    const ch = os.characters.get(1)!;
    beginRest(os, ch, { instant: true });
    const spot = { ...ch.agtyRest!.spot.tile };
    const r = ch.agtyRest!;
    r.next = 0.01;
    const phases: string[] = [r.phase];
    let facing = 0;
    let stand: number[] | null = null;
    run(os, 80, () => {
      if (phases.at(-1) !== r.phase) phases.push(r.phase);
      if (r.phase === 'use') {
        stand = at(ch);
        if (ch.dir === Direction.RIGHT) facing++;
      }
    });
    expect(phases).toEqual(['rest', 'fetch', 'use', 'drink', 'go', 'rest']);
    // C1: beside the machine it uses (screen left of its front tile), never in front of it
    expect(stand![1]).toBe(3);
    expect([6, 7, 8]).toContain(stand![0]); // one column left of the vending, coffee or water
    expect(facing).toBeGreaterThan(0); // facing the machine
    expect(at(ch)).toEqual([spot.col, spot.row]); // back where it sat
  });

  it('C1: uses a machine from beside its front tile (screen left, then right), then diagonally in front, else from in front', () => {
    const m = { col: 8, row: 1 }; // two rows tall: its front tile is (8, 2)
    const all = () => true;
    expect(machineStand(m, 2, all)).toEqual({ stand: { col: 7, row: 3 }, face: Direction.RIGHT });
    const noLeft = (t: { col: number; row: number }) => !(t.col === 7 && t.row === 3);
    expect(machineStand(m, 2, noLeft)).toEqual({ stand: { col: 9, row: 1 }, face: Direction.DOWN });
    // side by side (both side tiles taken): the diagonal-front tiles, left then right
    const sides = (t: { col: number; row: number }) =>
      !(t.col === 7 && t.row === 3) && !(t.col === 9 && t.row === 1);
    expect(machineStand(m, 2, sides)).toEqual({ stand: { col: 7, row: 4 }, face: Direction.UP });
    const noFrontLeft = (t: { col: number; row: number }) =>
      sides(t) && !(t.col === 7 && t.row === 4);
    expect(machineStand(m, 2, noFrontLeft)).toEqual({
      stand: { col: 9, row: 2 },
      face: Direction.LEFT,
    });
    const below = (t: { col: number; row: number }) => t.col === 8 && t.row === 3;
    expect(machineStand(m, 2, below)).toEqual({ stand: { col: 8, row: 3 }, face: Direction.UP });
    expect(machineStand(m, 2, () => false)).toBeNull();
  });

  it('shows the machine in its state while it is used, and idle before and after', () => {
    const os = office(oneFloor(), [1]);
    const ch = os.characters.get(1)!;
    beginRest(os, ch, { instant: true });
    const r = ch.agtyRest!;
    // pin the choice: only the coffee machine is free
    for (const f of os.layout.furniture)
      if (f.uid === 'lounge:vending' || f.uid === 'lounge:water') f.row = 99;
    os.rebuildFromLayout(os.layout);
    r.next = 0.01;
    const used: boolean[] = [];
    const pic = () => os.furniture.find((f) => f.y < 3 * TILE_SIZE && f.x === 8 * TILE_SIZE);
    const idle = pic()!.sprite;
    run(os, 30, () => {
      if (r.phase === 'use') used.push(pic()!.sprite !== idle);
    });
    expect(used.length).toBeGreaterThan(0);
    expect(used.every(Boolean)).toBe(true);
    expect(pic()!.sprite).toBe(idle);
  });

  it('a character dropped on a free seat sits there; on a blocked spot it stands on the nearest free tile', () => {
    const os = office(oneFloor(), [1, 2]);
    const ch = os.characters.get(1)!;
    beginRest(os, ch, { instant: true });
    const sofa = [...os.seats].filter(([u]) => u.startsWith('lounge:sofa'));
    const other = sofa.find(([u]) => u !== ch.agtyRest!.spot.seat)!;
    expect(restDropAt(os, ch, other[1].seatCol, other[1].seatRow)).toBe(true);
    run(os, 8);
    expect([at(ch), ch.state, ch.agtyRest!.spot.seat]).toEqual([
      [other[1].seatCol, other[1].seatRow],
      CharacterState.TYPE,
      other[0],
    ]);
    expect(ch.seatId).toBe('seat:a'); // its desk did not change
    // a wall: nearest walkable tile within reach, standing, dozing
    expect(restDropAt(os, ch, 11, 5)).toBe(true);
    run(os, 8);
    expect(ch.state).toBe(CharacterState.IDLE);
    expect(ch.agtyRest!.spot.seat).toBeNull();
    expect(at(ch)[0]).toBe(10);
    // far from anything (off the map): nowhere, it stays
    const before = { ...ch.agtyRest!.spot };
    expect(restDropAt(os, ch, 11, 50)).toBe(false);
    expect(ch.agtyRest!.spot).toEqual(before);
  });

  it('a character dropped on another floor rides there (by elevator) and rests there; its desk stays', () => {
    const os = office(twoFloors(), [1]);
    const ch = os.characters.get(1)!;
    expect(os.agtyElevators).toHaveLength(2);
    beginRest(os, ch, { instant: true });
    const rects = floorRects(os.layout)!;
    const floorOf = () => floorIndexAt(rects, ch.tileRow);
    expect(floorOf()).toBe(0);
    expect(visitFloor(os, 1, '2')).toBe(true); // a resting one is dropped by the same call as a working one
    let rode = false;
    run(os, 40, () => (rode ||= !!ch.agtyRide));
    expect(rode).toBe(true);
    expect(floorOf()).toBe(1);
    expect(ch.agtyRest!.phase).toBe('rest');
    expect(ch.seatId).toBe('seat:a');
    expect(ch.agtyVisit).toBeUndefined(); // a rest, not a visit
    // dropped on a seat of the lower floor again: it rides back and sits
    const sofa = [...os.seats].find(([u]) => u === 'lounge:sofa-a')!;
    expect(restDropAt(os, ch, sofa[1].seatCol, sofa[1].seatRow)).toBe(true);
    run(os, 40);
    expect([floorOf(), ch.state]).toEqual([0, CharacterState.TYPE]);
  });

  it('a spot whose seat is gone (the layout changed) is replaced; the desk keeps its character after a re-sent layout', () => {
    const os = office(oneFloor(), [1]);
    const ch = os.characters.get(1)!;
    beginRest(os, ch, { instant: true });
    const where = at(ch);
    os.rebuildFromLayout(oneFloor()); // re-sent: the resting character is not snapped back to its desk
    expect(at(ch)).toEqual(where);
    os.rebuildFromLayout(oneFloor(LOUNGE, false)); // the sofa was removed in the editor
    run(os, 5);
    expect(ch.agtyRest!.spot.seat).toBe(ch.seatId); // no rest seat left: it dozes at its desk
  });

  it('ten resting characters keep the office out of the full frame rate (nothing animates)', () => {
    const os = office(oneFloor(), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const ch of os.characters.values()) beginRest(os, ch, { instant: true });
    run(os, 5);
    expect([...os.characters.values()].every((c) => c.agtyRest?.phase === 'rest')).toBe(true);
    expect(os.isAnimating()).toBe(false);
    run(os, 120); // far from a drink (150 s and more): still still
    expect(os.isAnimating()).toBe(false);
  });

  it('restStep leaves a walking character to the FSM', () => {
    const os = office(oneFloor(), [1]);
    const ch = os.characters.get(1)!;
    beginRest(os, ch);
    expect(ch.state).toBe(CharacterState.WALK);
    expect(restStep(os, ch, 0.05)).toBe(false);
  });
});

describe('off duty, through the staff director (LOUNGE)', () => {
  const at18 = (m = 0) => Date.UTC(2026, 9, 21, 18, m); // a Wednesday evening, host on UTC
  beforeEach(() => {
    staffResetForTests();
    setOfficeHours({ on: true });
  });
  afterEach(() => {
    staffResetForTests();
    agtyResetForTests();
  });
  function staffOffice(ids: Array<[string, number]>) {
    agtyHandleMessage({ type: 'hostInfo', utcOffsetMin: 0 } as never);
    agtyHandleMessage({
      type: 'officeSnapshot',
      tabs: [],
      orchestrators: ids.map(([name, agentId]) => ({ name, agentId, state: 'running' })),
    } as never);
    const os = office(
      oneFloor(),
      ids.map(([, id]) => id),
    );
    return os;
  }
  function go(os: OfficeState, now: number, s: number): void {
    for (let t = 0; t < s; t += 0.1) {
      os.update(0.1);
      staffStep(os, 0.1, now);
    }
  }

  it('closing time: an idle one rests in the lounge instead of leaving, still off duty; opening time: back to its desk', () => {
    const os = staffOffice([['a', 1]]);
    go(os, Date.UTC(2026, 9, 21, 12, 0), 4); // the office came up at noon
    const ch = os.characters.get(1)!;
    const desk = ch.seatId;
    expect(ch.agtyRest).toBeUndefined();
    go(os, at18(), 1);
    expect(ch.agtyRest).toBeUndefined(); // the grace
    go(os, at18(31), 30);
    expect(Object.keys(staffSnapshot().away)).toEqual(['1']);
    expect(ch.agtyAway).toBe(false); // in the building, drawn
    expect(ch.agtyRest!.spot.seat).toMatch(/^lounge:sofa/);
    expect(ch.seatId).toBe(desk);
    // no door: it never reaches the edge of the office, never a despawn effect
    expect(ch.matrixEffect).toBe(null);
    go(os, Date.UTC(2026, 9, 22, 9, 0), 0.5);
    expect(staffSnapshot().away).toEqual({});
    expect(ch.agtyRest).toBeUndefined();
    expect(ch.path.length).toBeGreaterThan(0); // walking to its desk
    go(os, Date.UTC(2026, 9, 22, 9, 0), 15);
    const seat = os.seats.get(desk!)!;
    expect(at(ch)).toEqual([seat.seatCol, seat.seatRow]);
  });

  it('a temp still leaves through the door (only permanent staff rest)', () => {
    const os = staffOffice([['lead', 1]]);
    const t0 = Date.now();
    go(os, t0, 4);
    const sub = os.addSubagent(1, 'tu-a');
    expect(os.characters.get(sub)).toBeDefined();
    expect(os.characters.get(sub)!.agtyRest).toBeUndefined();
    go(os, t0, 2);
    // a sub-agent is never given a rest, whatever the hour
    expect(os.characters.get(sub)?.agtyRest).toBeUndefined();
  });
});

describe('a coffee break from work (C1)', () => {
  it("walks to the coffee machine, drinks, walks back to its desk and is the FSM's again; work never calls it back early", () => {
    const os = office(oneFloor(), [1]);
    const ch = os.characters.get(1)!;
    os.setAgentActive(1, true);
    run(os, 2);
    const desk = at(ch);
    const d = new Director(() => false, makeAction);
    d.play(1, { kind: 'coffee' });
    const phases: string[] = [];
    let at3 = -1;
    for (let t = 0; t < 60 && d.playing(1); t += 0.05) {
      os.update(0.05);
      d.step(os, 0.05);
      const r = ch.agtyRest;
      if (r && phases.at(-1) !== r.phase) phases.push(r.phase);
      if (r?.phase === 'use') at3 = ch.tileRow;
      if (r?.phase === 'fetch') os.setAgentActive(1, true); // tools keep running meanwhile
    }
    expect(phases).toEqual(['fetch', 'use', 'drink', 'go']);
    expect(at3).toBe(3); // in front of the machine
    expect(d.playing(1)).toBe(false);
    expect(ch.agtyRest).toBeUndefined();
    expect(at(ch)).toEqual(desk);
    expect(ch.isActive).toBe(true);
  });

  it('with no coffee machine on its floor there is no walk (the drink is shown in place)', () => {
    const layout = oneFloor();
    layout.furniture = layout.furniture.filter((f) => f.type !== 'COFFEE_MACHINE');
    const os = office(layout, [1]);
    const ch = os.characters.get(1)!;
    expect(startBreak(os, ch, 'coffee')).toBeNull();
    expect(ch.agtyRest).toBeUndefined();
  });

  it('a tap ends the break: the character heads back to its desk', () => {
    const os = office(oneFloor(), [1]);
    const ch = os.characters.get(1)!;
    os.setAgentActive(1, true); // working: it stays at the desk once there
    const rest = startBreak(os, ch, 'coffee')!;
    run(os, 0.5);
    endBreak(os, ch, rest);
    expect(ch.agtyRest).toBeUndefined();
    run(os, 10);
    expect(at(ch)).toEqual([2, 3]);
  });
});

describe('FX-ALL: every character takes the coffee break', () => {
  it("a sub-agent walks to the machine, drinks and walks back to its spot by its parent; the owner's walk command still cannot move it", () => {
    const os = office(oneFloor(), [1]);
    const sub = os.characters.get(os.addSubagent(1, 'tu-a'))!;
    run(os, 1);
    const spot = at(sub);
    expect(os.walkToTile(sub.id, 9, 8)).toBe(false); // the right-click walk: still refused
    const d = new Director(() => false, makeAction);
    d.play(sub.id, { kind: 'coffee' });
    const phases: string[] = [];
    let used: number[] | null = null;
    for (let t = 0; t < 60 && d.playing(sub.id); t += 0.05) {
      os.update(0.05);
      d.step(os, 0.05);
      const r = sub.agtyRest;
      if (r && phases.at(-1) !== r.phase) phases.push(r.phase);
      if (r?.phase === 'use') used = at(sub);
    }
    expect(phases).toEqual(['fetch', 'use', 'drink', 'go']);
    expect(used).toEqual([7, 3]); // at the coffee machine
    expect(at(sub)).toEqual(spot);
    expect(sub.agtyRest).toBeUndefined();
  });

  it("the owner's character drinks at the machine it stands by (the nearest, or the one tapped), not from afar or at the water cooler", () => {
    const os = office(oneFloor(), []);
    const owner = os.spawnOwner()!;
    place(os, OWNER_CHARACTER_ID, 8, 3); // below the coffee machine, diagonal to the vending one
    expect(pantryNear(os, owner)?.kind).toBe('coffee');
    expect(pantryNear(os, owner, { col: 7, row: 2 })?.kind).toBe('vending'); // tapped
    expect(pantryNear(os, owner, { col: 9, row: 2 })).toBeNull(); // the water cooler
    expect(pantryNear(os, owner, { col: 3, row: 3 })).toBeNull(); // not a machine
    place(os, OWNER_CHARACTER_ID, 3, 7); // across the room
    expect(pantryNear(os, owner)).toBeNull();
    expect(ownerDrink(os)).toBe(false);
    place(os, OWNER_CHARACTER_ID, 8, 3);
    expect(ownerDrink(os, { col: 7, row: 1 })).toBe(true);
    expect(director.playing(OWNER_CHARACTER_ID)).toBe(true);
    expect(ownerDrink(os)).toBe(false); // one at a time
    director.skip(os, OWNER_CHARACTER_ID);
  });
});
