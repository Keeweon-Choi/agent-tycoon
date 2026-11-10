/**
 * DEVROOM-SUBVIEW (owner 11-03 10:54, "Orca 처럼 자유롭게"): the 터미널 board's panes as a tree of
 * splits, like Orca's tab groups. A leaf shows one agent (by name; null = empty) in its view (DEVROOM-PANE-CHAT:
 * 대화 or 터미널, 대화 when unset, as in a tree saved before views); a split puts two
 * nodes side by side (`row`) or one over the other (`col`), `ratio` being the first one's share.
 * Pure rules: split at a pane's edge, replace or swap at its centre, close (the sibling takes the
 * space), resize, the 1 · 2 · 2×2 quick starts. A node is addressed by its path ('a'/'b' steps).
 */

export const PANE_VIEWS = ['chat', 'terminal'] as const;
export type PaneView = (typeof PANE_VIEWS)[number];
export type PaneLeaf = { leaf: string | null; view?: PaneView };
export type PaneNode = PaneLeaf | { dir: 'row' | 'col'; a: PaneNode; b: PaneNode; ratio: number };
export type Path = readonly ('a' | 'b')[];
export type Zone = 'left' | 'right' | 'top' | 'bottom' | 'center';

/** A split's share never goes below this (the pixel minimum is the caller's: `clampRatio`). */
export const RATIO_MIN = 0.1;
/** At most this many panes: each one is a live terminal. */
export const LEAVES_MAX = 6;

export const isLeaf = (n: PaneNode): n is PaneLeaf => 'leaf' in n;
/** A leaf's view: 대화 unless the owner switched it. */
export const viewOf = (n: PaneLeaf): PaneView => n.view ?? 'chat';
const leafOf = (leaf: string | null, view: PaneView | undefined): PaneLeaf => (view ? { leaf, view } : { leaf });

export function at(n: PaneNode, path: Path): PaneNode | null {
  let node: PaneNode = n;
  for (const step of path) {
    if (isLeaf(node)) return null;
    node = node[step];
  }
  return node;
}

/** `n` with the node at `path` replaced by `f(node)`. */
function update(n: PaneNode, path: Path, f: (node: PaneNode) => PaneNode): PaneNode {
  if (!path.length) return f(n);
  if (isLeaf(n)) return n;
  const [step, ...rest] = path;
  return { ...n, [step]: update(n[step], rest, f) };
}

/** Every pane, in reading order. */
export function leaves(n: PaneNode, path: Path = []): { path: Path; name: string | null; view: PaneView }[] {
  return isLeaf(n) ? [{ path, name: n.leaf, view: viewOf(n) }] : [...leaves(n.a, [...path, 'a']), ...leaves(n.b, [...path, 'b'])];
}

export const pathKey = (p: Path): string => p.join('') || 'root';
const samePath = (a: Path, b: Path) => pathKey(a) === pathKey(b);
const pathOf = (n: PaneNode, name: string): Path | null => leaves(n).find((l) => l.name === name)?.path ?? null;

/** The pane at `path` shows its agent in `view`. */
export const setView = (n: PaneNode, path: Path, view: PaneView): PaneNode =>
  update(n, path, (l) => (isLeaf(l) ? { leaf: l.leaf, view } : l));

/** Close the pane at `path`: its sibling takes the space; the last pane only empties. */
export function closeAt(n: PaneNode, path: Path): PaneNode {
  if (!path.length) return { leaf: null };
  const parent = path.slice(0, -1);
  const other = path[path.length - 1] === 'a' ? 'b' : 'a';
  return update(n, parent, (p) => (isLeaf(p) ? p : p[other]));
}

/**
 * `name` dropped on the pane at `path`. At an edge it splits that pane there (a name already shown
 * elsewhere moves: its old pane closes); at the centre it takes the pane (the two swap when it was
 * shown elsewhere). Past LEAVES_MAX an edge drop is refused (unchanged). A view goes with its agent.
 */
export function drop(n: PaneNode, path: Path, zone: Zone, name: string): PaneNode {
  const target = at(n, path);
  if (!target || !isLeaf(target)) return n;
  const from = pathOf(n, name);
  if (from && samePath(from, path)) return n;
  const moved = from ? (at(n, from) as PaneLeaf).view : undefined;
  if (zone === 'center') {
    const swapped = from ? update(n, from, () => leafOf(target.leaf, target.view)) : n;
    return update(swapped, path, () => leafOf(name, moved));
  }
  if (!from && leaves(n).length >= LEAVES_MAX) return n;
  const first = zone === 'left' || zone === 'top';
  const fresh: PaneNode = leafOf(name, moved);
  const split = update(n, path, (old) => ({
    dir: zone === 'left' || zone === 'right' ? 'row' : 'col',
    a: first ? fresh : old,
    b: first ? old : fresh,
    ratio: 0.5,
  }));
  // The old pane is not under `path` (it would be `path` itself): its path still holds.
  return from ? closeAt(split, from) : split;
}

/** Show `name` in the pane at `path` (a card's press): the centre drop. */
export const showAt = (n: PaneNode, path: Path, name: string): PaneNode => drop(n, path, 'center', name);

/** The split at `path` gets `ratio`, kept within [min, 1 - min]. */
export function resize(n: PaneNode, path: Path, ratio: number, min = RATIO_MIN): PaneNode {
  const r = Math.min(1 - min, Math.max(min, ratio));
  return update(n, path, (s) => (isLeaf(s) ? s : { ...s, ratio: r }));
}

/** The quick starts: one pane, two side by side, 2×2; filled with `names` in order. */
export function preset(count: 1 | 2 | 4, names: readonly (string | null)[]): PaneNode {
  const l = (i: number): PaneNode => ({ leaf: names[i] ?? null });
  const row = (i: number): PaneNode => ({ dir: 'row', a: l(i), b: l(i + 1), ratio: 0.5 });
  return count === 1 ? l(0) : count === 2 ? row(0) : { dir: 'col', a: row(0), b: row(2), ratio: 0.5 };
}

/** Names off the board leave their panes empty; empty panes take the agents no pane shows (in `order`). */
export function fillTree(n: PaneNode, order: readonly string[]): PaneNode {
  const kept = (name: string | null) => (name !== null && order.includes(name) ? name : null);
  const shown = new Set(leaves(n).map((l) => kept(l.name)));
  const free = order.filter((name) => !shown.has(name));
  const walk = (node: PaneNode): PaneNode =>
    isLeaf(node)
      ? kept(node.leaf) !== null
        ? node
        : { leaf: free.shift() ?? null }
      : { ...node, a: walk(node.a), b: walk(node.b) };
  return walk(n);
}

/** A stored tree, checked node by node (anything odd: null, the caller starts over). */
export function parseTree(raw: unknown, depth = 0): PaneNode | null {
  if (!raw || typeof raw !== 'object' || depth > LEAVES_MAX) return null;
  const o = raw as Record<string, unknown>;
  if ('leaf' in o) {
    if (typeof o.leaf !== 'string' && o.leaf !== null) return null;
    return leafOf(o.leaf, PANE_VIEWS.find((v) => v === o.view)); // an unknown view: the default
  }
  if ((o.dir !== 'row' && o.dir !== 'col') || typeof o.ratio !== 'number' || !Number.isFinite(o.ratio)) return null;
  const a = parseTree(o.a, depth + 1);
  const b = parseTree(o.b, depth + 1);
  if (!a || !b) return null;
  const tree: PaneNode = { dir: o.dir, a, b, ratio: Math.min(1 - RATIO_MIN, Math.max(RATIO_MIN, o.ratio)) };
  return depth === 0 && leaves(tree).length > LEAVES_MAX ? null : tree;
}

// ── Per viewer, per project ─────────────────────────────────

const keyOf = (project: string) => `agty.devroom.panes.${project}`;

export function loadTree(project: string): PaneNode | null {
  try {
    return parseTree(JSON.parse(localStorage.getItem(keyOf(project)) ?? 'null'));
  } catch {
    return null; // no storage, or a torn value: start over
  }
}

export function saveTree(project: string, tree: PaneNode): void {
  try {
    localStorage.setItem(keyOf(project), JSON.stringify(tree));
  } catch {
    // Private mode: this visit still remembers it.
  }
}
