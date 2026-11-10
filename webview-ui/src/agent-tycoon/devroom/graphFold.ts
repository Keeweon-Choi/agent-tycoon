/**
 * DEVROOM-GRAPH2 (owner 11-03 11:51): the worktree graph folds like a tree. Every node with
 * children (the trunk, a branch line, a card cards were made from) and the whole graph section can
 * be folded; what is folded is kept per project in this browser. A folded branch keeps the selected
 * card in sight (its path stays drawn); picking a card unfolds the path to it.
 *
 * Node ids are branch names (the trunk's, a branch line's, a card's own branch); GRAPH_NODE is the
 * whole section. The trunk goes in as a branch line at depth -1 (trunkLine), so it folds and counts
 * like any other node.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';

import { type GraphLine, graphLines } from './devroomState.js';

export const FOLD_KEY = 'agty.devroom.fold.v1';
/** The whole graph section, folded to its header. */
export const GRAPH_NODE = '#graph';

/** project -> the folded node ids. */
export type FoldState = Readonly<Record<string, readonly string[]>>;

export const isFolded = (s: FoldState, project: string, node: string): boolean => !!s[project]?.includes(node);

function withNodes(s: FoldState, project: string, nodes: readonly string[]): FoldState {
  const next = { ...s };
  if (nodes.length) next[project] = nodes;
  else delete next[project];
  return next;
}

export function toggleFold(s: FoldState, project: string, node: string): FoldState {
  const now = s[project] ?? [];
  return withNodes(s, project, now.includes(node) ? now.filter((n) => n !== node) : [...now, node]);
}

/** `nodes` (the path to a picked card) open again; the same state when none was folded. */
export function unfoldNodes(s: FoldState, project: string, nodes: readonly string[]): FoldState {
  const now = s[project] ?? [];
  const left = now.filter((n) => !nodes.includes(n));
  return left.length === now.length ? s : withNodes(s, project, left);
}

/** What the storage holds, kept only where it is a list of names per project. */
export function parseFold(raw: string | null): FoldState {
  try {
    const data: unknown = JSON.parse(raw ?? '{}');
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return {};
    return Object.fromEntries(
      Object.entries(data).flatMap(([k, v]) =>
        Array.isArray(v) && v.length && v.every((n) => typeof n === 'string') ? [[k, v as string[]]] : [],
      ),
    );
  } catch {
    return {};
  }
}

/** The trunk as the graph's root line (depth -1: every other line hangs under it). */
export const trunkLine = <T>(name: string): GraphLine<T> => ({ kind: 'branch', name, depth: -1 });

/** A line's node id: a branch line's name, a card's branch. */
export const lineId = <T extends { wt: { branch: string } }>(line: GraphLine<T>): string =>
  line.kind === 'branch' ? line.name : line.row.wt.branch;

/** The ids of the lines above the line `id` (its branch line or parent cards), nearest last. */
export function pathTo<T extends { wt: { branch: string } }>(lines: readonly GraphLine<T>[], id: string): string[] {
  const at = lines.findIndex((l) => lineId(l) === id);
  if (at < 0) return [];
  const path: string[] = [];
  let depth = lines[at].depth;
  for (let i = at - 1; i >= 0; i--)
    if (lines[i].depth < depth) {
      path.unshift(lineId(lines[i]));
      depth = lines[i].depth;
    }
  return path;
}

export interface ShownLine<T> {
  line: GraphLine<T>;
  id: string;
  /** Cards under it (0: no toggle). */
  count: number;
  open: boolean;
}

/**
 * The lines drawn: a line under a folded one is left out, unless it is `keep` (the selected card)
 * or on the way to it. Each line carries how many cards hang under it.
 */
export function foldLines<T extends { wt: { branch: string } }>(
  lines: readonly GraphLine<T>[],
  folded: (id: string) => boolean,
  keep: string | null,
): ShownLine<T>[] {
  const kept = new Set(keep ? [...pathTo(lines, keep), keep] : []);
  const out: ShownLine<T>[] = [];
  let shutAt: number | null = null;
  lines.forEach((line, i) => {
    if (shutAt !== null && line.depth <= shutAt) shutAt = null;
    const id = lineId(line);
    let count = 0;
    for (let j = i + 1; j < lines.length && lines[j].depth > line.depth; j++) if (lines[j].kind === 'row') count++;
    const open = !folded(id);
    if (shutAt === null || kept.has(id)) out.push({ line, id, count, open });
    if (shutAt === null && !open && count) shutAt = line.depth;
  });
  return out;
}

// ── The store: one per browser, every project's folds ──

function readFold(): FoldState {
  try {
    return parseFold(localStorage.getItem(FOLD_KEY));
  } catch {
    return {}; // storage blocked: nothing folded this visit
  }
}

let state: FoldState = readFold();
const listeners = new Set<() => void>();
function set(next: FoldState): void {
  if (next === state) return;
  state = next;
  try {
    localStorage.setItem(FOLD_KEY, JSON.stringify(state));
  } catch {
    // Private mode: this visit still keeps it.
  }
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const useGraphFold = (): FoldState => useSyncExternalStore(subscribe, () => state);
export const toggleGraphFold = (project: string, node: string): void => set(toggleFold(state, project, node));
export const unfoldGraph = (project: string, nodes: readonly string[]): void => set(unfoldNodes(state, project, nodes));

// ── What the rail and the phone list draw ──

type Card = { wt: { branch: string; base: string; task: string } };

export interface FoldedGraph<T> {
  /** The whole section is open (GRAPH_NODE). */
  graphOpen: boolean;
  /** The trunk's line: its count is every card of the project. */
  trunk: ShownLine<T>;
  /** The lines under the trunk that are drawn; the resting ones (when that fold is open) from `restingFrom`. */
  lines: ShownLine<T>[];
  restingFrom: number;
  toggle: (node: string) => void;
}

/** The selected card back in sight after a fold moved the list (rail: picked, phone: expanded). */
function keepSelectedInSight(): void {
  try {
    requestAnimationFrame(() =>
      document
        .querySelector('[data-testid="devroom-card"][data-picked], [data-testid="devroom-card"][data-open]')
        ?.scrollIntoView({ block: 'nearest' }),
    );
  } catch {
    /* no layout here */
  }
}

/**
 * One project's graph with its folds. `selected`: the picked card's folder (task). A pick unfolds
 * the way to it (and opens the resting fold for a resting card): a click, the 작업실 or messenger
 * link, also one the dev room opens with. Not the dev room's own first choice (no pick before it,
 * currentPick), so a reload keeps the owner's folds; that card is still drawn under its folded
 * branch.
 */
export function useFoldedGraph<T extends Card>(
  project: string,
  trunkName: string,
  shown: readonly T[],
  resting: readonly T[],
  restOpen: boolean,
  selected: string | null,
  openResting: () => void,
): FoldedGraph<T> {
  const fold = useGraphFold();
  const shownL = graphLines(shown, trunkName);
  const restL = graphLines(resting, trunkName);
  const sel = selected === null ? undefined : [...shown, ...resting].find((r) => r.wt.task === selected);
  const prev = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const before = prev.current;
    prev.current = selected;
    if (!sel || before === selected) return;
    if (resting.includes(sel) && !restOpen) openResting();
    // From no pick to one is the dev room's own first choice (currentPick): the owner's folds stay.
    if (before === null) return;
    unfoldGraph(project, [GRAPH_NODE, ...pathTo([trunkLine<T>(trunkName), ...shownL, ...restL], sel.wt.branch)]);
    // The lines are read on this pick only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, selected]);
  const folded = (id: string) => isFolded(fold, project, id);
  const restSet = new Set<GraphLine<T>>(restL);
  const [trunk, ...lines] = foldLines([trunkLine<T>(trunkName), ...shownL, ...(restOpen ? restL : [])], folded, sel?.wt.branch ?? null);
  const at = lines.findIndex((l) => restSet.has(l.line));
  return {
    graphOpen: !folded(GRAPH_NODE),
    trunk: { ...trunk, count: shown.length + resting.length },
    lines,
    restingFrom: at < 0 ? lines.length : at,
    toggle: (node) => {
      toggleGraphFold(project, node);
      keepSelectedInSight();
    },
  };
}
