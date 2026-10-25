import { TileType } from '../types.js';

/** Check if a tile is walkable (floor, carpet, or doorway, and not blocked by furniture) */
export function isWalkable(
  col: number,
  row: number,
  tileMap: TileType[][],
  blockedTiles: Set<string>,
): boolean {
  const rows = tileMap.length;
  const cols = rows > 0 ? tileMap[0].length : 0;
  if (row < 0 || row >= rows || col < 0 || col >= cols) return false;
  const t = tileMap[row][col];
  if (t === TileType.WALL || t === TileType.VOID) return false;
  if (blockedTiles.has(`${col},${row}`)) return false;
  return true;
}

/** Get walkable tile positions (grid coords) for wandering */
export function getWalkableTiles(
  tileMap: TileType[][],
  blockedTiles: Set<string>,
): Array<{ col: number; row: number }> {
  const rows = tileMap.length;
  const cols = rows > 0 ? tileMap[0].length : 0;
  const tiles: Array<{ col: number; row: number }> = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (isWalkable(c, r, tileMap, blockedTiles)) {
        tiles.push({ col: c, row: r });
      }
    }
  }
  return tiles;
}

/** BFS pathfinding on 4-connected grid (no diagonals). Returns path excluding start, including end.
 *  cld-gui (ELEVATOR): `links` are extra one-step edges ("col,row" -> tiles), the elevator
 *  between stacked floors; a path that rides has one step that is not to a neighbour. */
export function findPath(
  startCol: number,
  startRow: number,
  endCol: number,
  endRow: number,
  tileMap: TileType[][],
  blockedTiles: Set<string>,
  links?: ReadonlyMap<string, ReadonlyArray<{ col: number; row: number }>> | null,
): Array<{ col: number; row: number }> {
  if (startCol === endCol && startRow === endRow) return [];

  const key = (c: number, r: number) => `${c},${r}`;
  const startKey = key(startCol, startRow);
  const endKey = key(endCol, endRow);

  // End must be walkable (or be a chair tile which may be adjacent to desk)
  // We allow the end tile even if it's not strictly walkable for chair positions
  const endWalkable = isWalkable(endCol, endRow, tileMap, blockedTiles);
  if (!endWalkable) {
    // If the end is a desk tile, we still can't path there
    return [];
  }

  const visited = new Set<string>();
  visited.add(startKey);

  const parent = new Map<string, string>();
  const queue: Array<{ col: number; row: number }> = [{ col: startCol, row: startRow }];

  const dirs = [
    { dc: 0, dr: -1 }, // up
    { dc: 0, dr: 1 }, // down
    { dc: -1, dr: 0 }, // left
    { dc: 1, dr: 0 }, // right
  ];

  const visit = (nc: number, nr: number, from: string) => {
    const nk = key(nc, nr);
    if (visited.has(nk)) return;
    if (!isWalkable(nc, nr, tileMap, blockedTiles)) return;
    visited.add(nk);
    parent.set(nk, from);
    queue.push({ col: nc, row: nr });
  };

  while (queue.length > 0) {
    const curr = queue.shift()!;
    const currKey = key(curr.col, curr.row);

    if (currKey === endKey) {
      // Reconstruct path
      const path: Array<{ col: number; row: number }> = [];
      let k = endKey;
      while (k !== startKey) {
        const [c, r] = k.split(',').map(Number);
        path.unshift({ col: c, row: r });
        k = parent.get(k)!;
      }
      return path;
    }

    for (const d of dirs) visit(curr.col + d.dc, curr.row + d.dr, currKey);
    const linked = links?.get(currKey);
    if (linked) for (const t of linked) visit(t.col, t.row, currKey);
  }

  // No path found
  return [];
}
