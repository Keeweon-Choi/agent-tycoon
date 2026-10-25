import { describe, expect, it } from 'vitest';

import { OfficeState } from '../office/engine/officeState.js';
import { CharacterState, type OfficeLayout, TileType } from '../office/types.js';
import {
  canQueueWalkStep,
  heldKeyboardWalkTarget,
  holdWalkKey,
  keyboardWalkTarget,
  keyToWalkStep,
  releaseWalkKey,
  shouldReturnToSeat,
  staysOnFloor,
  WALK_QUEUE_MAX,
  walkDecision,
  winningWalkKey,
} from './walk.js';

const floor = (): TileType[][] => [
  [TileType.FLOOR_1, TileType.FLOOR_1, TileType.FLOOR_1, TileType.FLOOR_1],
  [TileType.FLOOR_1, TileType.FLOOR_1, TileType.FLOOR_1, TileType.FLOOR_1],
  [TileType.FLOOR_1, TileType.FLOOR_1, TileType.FLOOR_1, TileType.FLOOR_1],
];

const target = (action: 'up' | 'down' | 'left' | 'right', blocked = new Set<string>()) =>
  keyboardWalkTarget({
    action,
    tileCol: 1,
    tileRow: 1,
    path: [],
    tileMap: floor(),
    blockedTiles: blocked,
    ownSeat: null,
    layout: { cols: 4, rows: 3 },
  });

describe('keyboard walking', () => {
  it('permits visible OFF, resting, and resting sub-agent characters, but not working or gone-home ones', () => {
    expect(walkDecision({ isActive: false, matrixEffect: null })).toBe('walked'); // OFF/resting
    expect(walkDecision({ isActive: false, matrixEffect: null })).toBe('walked'); // resting sub-agent
    expect(walkDecision({ isActive: true, matrixEffect: null })).toBe('active');
    expect(walkDecision({ isActive: false, cldAway: true, matrixEffect: null })).toBe(
      'unavailable',
    );
  });

  it('maps WASD/arrow camera directions to one cardinal tile', () => {
    expect(keyToWalkStep('up')).toEqual({ col: 0, row: -1 });
    expect(keyToWalkStep('down')).toEqual({ col: 0, row: 1 });
    expect(keyToWalkStep('left')).toEqual({ col: -1, row: 0 });
    expect(keyToWalkStep('right')).toEqual({ col: 1, row: 0 });
    expect(keyToWalkStep('zoomIn')).toBeNull();
    expect(target('right')).toEqual({ col: 2, row: 1 });
  });

  it('uses pathfinding walkability for walls, furniture, other seats and edges', () => {
    const wall = floor();
    wall[1][2] = TileType.WALL;
    expect(
      keyboardWalkTarget({
        action: 'right',
        tileCol: 1,
        tileRow: 1,
        path: [],
        tileMap: wall,
        blockedTiles: new Set(),
        ownSeat: null,
        layout: { cols: 4, rows: 3 },
      }),
    ).toBeNull();
    expect(target('right', new Set(['2,1']))).toBeNull(); // furniture or another seat
    expect(
      keyboardWalkTarget({
        action: 'left',
        tileCol: 0,
        tileRow: 1,
        path: [],
        tileMap: floor(),
        blockedTiles: new Set(),
        ownSeat: null,
        layout: { cols: 4, rows: 3 },
      }),
    ).toBeNull();
  });

  it('extends queued holds and never crosses a stacked-floor boundary', () => {
    expect(
      keyboardWalkTarget({
        action: 'right',
        tileCol: 1,
        tileRow: 1,
        path: [{ col: 2, row: 1 }],
        tileMap: floor(),
        blockedTiles: new Set(),
        ownSeat: null,
        layout: { cols: 4, rows: 3 },
      }),
    ).toEqual({ col: 3, row: 1 });
    const layout = {
      cols: 4,
      rows: 7,
      cldFloors: [
        { id: 'one', row: 0, rows: 3, cols: 4 },
        { id: 'two', row: 4, rows: 3, cols: 4 },
      ],
    };
    expect(staysOnFloor(layout, 2, 3)).toBe(false);
  });

  it('gives the newest held direction priority and falls back on release', () => {
    let held = holdWalkKey([], 'right');
    held = holdWalkKey(held, 'down');
    expect(winningWalkKey(held)).toBe('down');
    held = releaseWalkKey(held, 'down');
    expect(winningWalkKey(held)).toBe('right');
    expect(winningWalkKey(releaseWalkKey(held, 'right'))).toBeNull();
  });

  it('continues only into a free tile in the winning held direction', () => {
    const input = {
      tileCol: 1,
      tileRow: 1,
      path: [],
      tileMap: floor(),
      blockedTiles: new Set<string>(),
      ownSeat: null,
      layout: { cols: 4, rows: 3 },
    };
    expect(heldKeyboardWalkTarget(['right'], input)).toEqual({ col: 2, row: 1 });
    expect(heldKeyboardWalkTarget([], input)).toBeNull();
    expect(
      heldKeyboardWalkTarget(['right'], { ...input, blockedTiles: new Set(['2,1']) }),
    ).toBeNull();
  });

  it('caps separate quick taps at the keyboard queue maximum', () => {
    expect(
      canQueueWalkStep(Array.from({ length: WALK_QUEUE_MAX - 1 }, () => ({ col: 1, row: 1 }))),
    ).toBe(true);
    expect(
      canQueueWalkStep(Array.from({ length: WALK_QUEUE_MAX }, () => ({ col: 1, row: 1 }))),
    ).toBe(false);
  });

  it('hands a manually walking agent back to its seat when work starts', () => {
    const layout: OfficeLayout = {
      version: 1,
      cols: 4,
      rows: 3,
      tiles: floor().flat(),
      furniture: [],
    };
    const office = new OfficeState(layout);
    office.addAgent(1, 0, 0, undefined, true);
    const ch = office.characters.get(1)!;
    ch.isActive = false;
    ch.tileCol = 2;
    ch.tileRow = 1;
    ch.x = 80;
    ch.y = 48;
    ch.seatId = 'seat';
    office.seats.set('seat', {
      uid: 'seat',
      seatCol: 1,
      seatRow: 1,
      facingDir: 0,
      assigned: true,
    });
    office.blockedTiles.add('1,1');

    expect(shouldReturnToSeat(false, true)).toBe(true);
    office.setAgentActive(1, true);
    expect(ch.path).toEqual([{ col: 1, row: 1 }]);
  });
});

describe('walking the selected character', () => {
  const room = (wallAt?: number) => {
    const tiles: TileType[] = Array.from({ length: 3 * 8 }, () => TileType.FLOOR_1);
    if (wallAt !== undefined) tiles[8 + wallAt] = TileType.WALL;
    const layout: OfficeLayout = { version: 1, cols: 8, rows: 3, tiles, furniture: [] };
    const office = new OfficeState(layout);
    office.addAgent(1, 0, 0, undefined, true);
    const ch = office.characters.get(1)!;
    ch.isActive = false;
    ch.matrixEffect = null;
    ch.seatId = null;
    ch.tileCol = 1;
    ch.tileRow = 1;
    ch.x = 24;
    ch.y = 24;
    office.selectedAgentId = 1;
    return { office, ch };
  };
  const tick = (office: OfficeState, seconds: number) => {
    for (let t = 0; t < seconds; t += 0.05) office.update(0.05);
  };

  it('three presses walk three tiles right and the camera follows', () => {
    const { office, ch } = room();
    for (let i = 0; i < 3; i++) expect(office.walkSelectedStep('right')).toBe('walked');
    expect(office.cameraFollowId).toBe(1);
    tick(office, 1.3); // 3 tiles at 3 tiles/s, before the idle wander timer
    expect([ch.tileCol, ch.tileRow]).toEqual([4, 1]);
  });

  it('continues a held direction at tile boundaries, then stops within one tile', () => {
    const { office, ch } = room();
    office.setHeldWalkKeys(['right']);
    expect(office.walkSelectedStep('right')).toBe('walked');
    tick(office, 0.2);
    expect(ch.state).toBe('walk');
    expect(ch.tileCol).toBe(2);
    expect(ch.path).toHaveLength(1);

    office.setHeldWalkKeys([]);
    tick(office, 0.3);
    expect(ch.tileCol).toBe(3);
    expect(ch.path).toHaveLength(0);
    expect(ch.keyboardWalk).toBeUndefined();
  });

  it('turns to the newest held direction at the next tile boundary', () => {
    const { office, ch } = room();
    office.setHeldWalkKeys(['right']);
    office.walkSelectedStep('right');
    tick(office, 0.1);
    office.setHeldWalkKeys(['right', 'down']);
    tick(office, 0.15);
    expect([ch.tileCol, ch.tileRow]).toEqual([2, 1]);
    expect(ch.y).toBeGreaterThan(24);

    office.setHeldWalkKeys(['right']);
    tick(office, 0.2);
    expect(ch.tileRow).toBe(2);
    expect(ch.x).toBeGreaterThan(40);
  });

  it('carries movement past a tile boundary into the remaining path', () => {
    const { office, ch } = room();
    ch.keyboardWalk = true;
    ch.state = CharacterState.WALK;
    ch.path = [
      { col: 2, row: 1 },
      { col: 3, row: 1 },
    ];
    office.update(0.2);
    expect(ch.tileCol).toBe(2);
    expect(ch.path).toEqual([{ col: 3, row: 1 }]);
    expect(ch.moveProgress).toBeCloseTo(0.2);
  });

  it('a wall stops the walk and reports blocked', () => {
    const { office, ch } = room(3);
    for (let i = 0; i < 4; i++) office.walkSelectedStep('right');
    tick(office, 1); // before the idle wander timer
    expect(ch.tileCol).toBe(2);
    expect(office.walkSelectedStep('right')).toBe('blocked');
  });

  it('an active, gone-home or unselected character is not walked, while a resting sub-agent is', () => {
    const { office, ch } = room();
    ch.isActive = true;
    expect(office.walkSelectedStep('right')).toBe('active');
    ch.isActive = false;
    ch.cldAway = true;
    expect(office.walkSelectedStep('right')).toBe('unavailable');
    ch.cldAway = false;
    ch.isSubagent = true;
    expect(office.walkSelectedStep('right')).toBe('walked');
    ch.path = [];
    office.selectedAgentId = null;
    expect(office.walkSelectedStep('right')).toBe('unavailable');
    expect(ch.path).toEqual([]);
  });

  it('work starting while it walks sends it back to its seat', () => {
    const { office, ch } = room();
    office.seats.set('seat', { uid: 'seat', seatCol: 6, seatRow: 1, facingDir: 0, assigned: true });
    office.blockedTiles.add('6,1');
    ch.seatId = 'seat';
    office.walkSelectedStep('left');
    office.setAgentActive(1, true);
    expect(ch.path.at(-1)).toEqual({ col: 6, row: 1 });
    expect(office.walkSelectedStep('left')).toBe('active');
  });
});
