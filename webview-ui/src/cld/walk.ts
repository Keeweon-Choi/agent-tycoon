import { isWalkable } from '../office/layout/tileMap.js';
import { TileType, type TileType as TileTypeValue } from '../office/types.js';
import type { CameraKey } from './camera.js';

// floors.ts's two pure helpers, kept here on purpose (elevator.ts reuses them): upstream officeState.ts
// imports this file, and floors.ts pulls in the store, notices and JSX, which
// break the DOM-free Node build of webview-ui/test (tsc -b, tsconfig.node.json).
export type FloorRows = { id?: string; row: number; rows: number };
export function floorRects(layout: object): FloorRows[] | null {
  const rects = (layout as { cldFloors?: unknown }).cldFloors;
  return Array.isArray(rects) && rects.length > 1 ? (rects as FloorRows[]) : null;
}
export const floorIndexAt = (rects: FloorRows[], row: number): number =>
  rects.findIndex((r) => row >= r.row && row < r.row + r.rows);

/** Steps a character may have queued from separate key presses. */
export const WALK_QUEUE_MAX = 8;

export interface WalkTile {
  col: number;
  row: number;
}

export interface KeyboardWalkInput {
  action: CameraKey;
  tileCol: number;
  tileRow: number;
  /** Already queued keyboard steps: the next press extends their endpoint. */
  path: WalkTile[];
  tileMap: TileTypeValue[][];
  blockedTiles: Set<string>;
  ownSeat: WalkTile | null;
  layout: object;
}

/** Direction keys in press order; the last one has movement priority. */
export type HeldWalkKeys = CameraKey[];

/** Record a non-repeat directional keydown, making a re-press newest. */
export function holdWalkKey(held: HeldWalkKeys, action: CameraKey): HeldWalkKeys {
  return keyToWalkStep(action) ? [...held.filter((key) => key !== action), action] : held;
}

/** Remove a released direction without disturbing the other keys' priority. */
export function releaseWalkKey(held: HeldWalkKeys, action: CameraKey): HeldWalkKeys {
  return held.filter((key) => key !== action);
}

/** The most recently pressed direction still held, or no direction. */
export function winningWalkKey(held: HeldWalkKeys): CameraKey | null {
  return held.at(-1) ?? null;
}

/** Whether another distinct tap may extend the keyboard-walk queue. */
export function canQueueWalkStep(path: WalkTile[]): boolean {
  return path.length < WALK_QUEUE_MAX;
}

/** One cardinal tile step for a camera movement key; other keys do not walk. */
export function keyToWalkStep(action: CameraKey): WalkTile | null {
  switch (action) {
    case 'up':
      return { col: 0, row: -1 };
    case 'down':
      return { col: 0, row: 1 };
    case 'left':
      return { col: -1, row: 0 };
    case 'right':
      return { col: 1, row: 0 };
    default:
      return null;
  }
}

/** True when both tile rows belong to the same stacked-building floor. */
export function staysOnFloor(layout: object, fromRow: number, toRow: number): boolean {
  const rects = floorRects(layout);
  if (!rects) return true;
  const from = floorIndexAt(rects, fromRow);
  return from >= 0 && from === floorIndexAt(rects, toRow);
}

/**
 * The next single tile for keyboard walking, or null when the key is not a
 * direction or that tile is unavailable. `isWalkable` is deliberately shared
 * with pathfinding, so walls, furniture, seats, edges and void agree.
 */
export function keyboardWalkTarget(input: KeyboardWalkInput): WalkTile | null {
  const step = keyToWalkStep(input.action);
  if (!step) return null;
  const from = input.path[input.path.length - 1] ?? {
    col: input.tileCol,
    row: input.tileRow,
  };
  const target = { col: from.col + step.col, row: from.row + step.row };
  if (!staysOnFloor(input.layout, from.row, target.row)) return null;
  if (isWalkable(target.col, target.row, input.tileMap, input.blockedTiles)) return target;

  // Seats block everybody else. Their owner may still step back onto their
  // own chair, just as the return-to-seat pathfinder may.
  const isOwnSeat = input.ownSeat?.col === target.col && input.ownSeat?.row === target.row;
  const tile = input.tileMap[target.row]?.[target.col];
  return isOwnSeat && tile !== undefined && tile !== TileType.WALL && tile !== TileType.VOID
    ? target
    : null;
}

/** The next held-key step at a tile boundary, if the current winner can walk. */
export function heldKeyboardWalkTarget(
  held: HeldWalkKeys,
  input: Omit<KeyboardWalkInput, 'action'>,
): WalkTile | null {
  const action = winningWalkKey(held);
  return action ? keyboardWalkTarget({ ...input, action }) : null;
}

/** An agent taking up work wins over any player-directed walk. */
export function shouldReturnToSeat(wasActive: boolean, isActive: boolean): boolean {
  return !wasActive && isActive;
}

/** The keyboard-walk decision for a selected character before route checking. */
export function walkDecision(input: {
  isActive: boolean;
  cldAway?: boolean;
  matrixEffect: 'spawn' | 'despawn' | null;
}): 'walked' | 'active' | 'unavailable' {
  if (input.cldAway || input.matrixEffect) return 'unavailable';
  return input.isActive ? 'active' : 'walked';
}
