/**
 * SPT-P4A, pure: the architecture graph (contract TraceArch) turned into what the 아키텍처 view
 * draws. Subgraphs fold into one node ('+N') and unfold; edges into a folded group end on it (the
 * ones inside it go, parallel ones merge). dagre places the components with the open groups as
 * nested compound parents, and each group's box is drawn around its members, innermost first.
 */
import dagre from '@dagrejs/dagre';
import { type Edge, MarkerType, type Node } from '@xyflow/react';

import type { ArchEdge, ArchGroup, ArchNode, TraceArch } from '../../../../core/src/agent-tycoon/spec/trace.js';
import {
  SPEC_ARCH_DEPTH_MAX,
  SPEC_GRAPH_BOX_HEAD,
  SPEC_GRAPH_BOX_PAD,
  SPEC_GRAPH_MARGIN,
  SPEC_GRAPH_NODE,
  SPEC_GRAPH_NODE_GAP,
  SPEC_GRAPH_RANK_GAP,
} from '../../constants.js';
import { type Box, BOX_PREFIX } from './traceModel.js';

export interface ArchFold {
  group: ArchGroup;
  count: number;
}
export interface ArchView {
  nodes: ArchNode[];
  folds: ArchFold[];
  /** The open groups. */
  groups: ArchGroup[];
  edges: ArchEdge[];
}

/**
 * `id` and its ancestors, nearest first. A visited check and SPEC_ARCH_DEPTH_MAX end a parent cycle
 * or a runaway chain: the groups come over the wire, so no walk trusts them.
 */
export function ancestors(id: string | undefined, parentOf: (id: string) => string | undefined): string[] {
  const out: string[] = [];
  for (let at = id; at && out.length < SPEC_ARCH_DEPTH_MAX && !out.includes(at); at = parentOf(at)) out.push(at);
  return out;
}

/** The groups once each (the first of an id), a parent that is unknown, in a cycle or too deep dropped (the group drawn at the top). */
export function cleanGroups(groups: readonly ArchGroup[]): ArchGroup[] {
  const byId = new Map<string, ArchGroup>();
  for (const x of groups) if (!byId.has(x.id)) byId.set(x.id, x);
  const parentOf = (id: string) => byId.get(id)?.parent;
  return [...byId.values()].map((x) => {
    if (!x.parent) return x;
    const up = ancestors(x.parent, parentOf);
    const sound = byId.has(x.parent) && !up.includes(x.id) && up.length < SPEC_ARCH_DEPTH_MAX && !parentOf(up.at(-1)!);
    return sound ? x : { ...x, parent: undefined };
  });
}

const depthIn = (groups: readonly ArchGroup[]) => {
  const byId = new Map(groups.map((x) => [x.id, x] as const));
  return (x: ArchGroup) => ancestors(x.id, (id) => byId.get(id)?.parent).length - 1;
};

export function foldArch(g: TraceArch, folded: ReadonlySet<string>): ArchView {
  const clean = cleanGroups(g.groups);
  const byId = new Map(clean.map((x) => [x.id, x] as const));
  /** The outermost folded group at or above `id`, or null. */
  const closed = (id: string | undefined): string | null => {
    let out: string | null = null;
    for (const at of ancestors(id, (x) => byId.get(x)?.parent)) if (folded.has(at)) out = at;
    return out;
  };
  const into = new Map<string, string>();
  const count = new Map<string, number>();
  const nodes = g.nodes.filter((n) => {
    const c = closed(n.group);
    if (c) {
      into.set(n.id, c);
      count.set(c, (count.get(c) ?? 0) + 1);
    }
    return !c;
  });
  const groups: ArchGroup[] = [];
  const folds: ArchFold[] = [];
  for (const x of clean) {
    const c = closed(x.id);
    if (!c) groups.push(x);
    else {
      into.set(x.id, c);
      if (c === x.id) folds.push({ group: x, count: 0 });
    }
  }
  for (const f of folds) f.count = count.get(f.group.id) ?? 0;
  const merged = new Map<string, ArchEdge>();
  for (const e of g.edges) {
    const from = into.get(e.from) ?? e.from;
    const to = into.get(e.to) ?? e.to;
    if (from === to) continue;
    const key = `${e.layer}|${from}|${to}`;
    const old = merged.get(key);
    if (!old) merged.set(key, from === e.from && to === e.to ? e : { ...e, id: `fold:${key}`, from, to });
    else if (e.label && !old.label?.includes(e.label)) merged.set(key, { ...old, label: old.label ? `${old.label} · ${e.label}` : e.label });
  }
  return { nodes, folds, groups, edges: [...merged.values()] };
}

const NODE = SPEC_GRAPH_NODE.req;
const FOLD = SPEC_GRAPH_NODE.group;
export interface ArchLaid {
  /** Absolute boxes of the leaves (components, folded groups) and of the open groups. */
  pos: Map<string, Box>;
  boxes: Map<string, Box>;
}

/** A leaf's parent: a component's group, a folded group's parent (both open in the view). */
const leaves = (v: ArchView) => [
  ...v.nodes.map((n) => ({ id: n.id, parent: n.group, ...NODE })),
  ...v.folds.map((f) => ({ id: f.group.id, parent: f.group.parent, ...FOLD })),
];

export function layoutArch(v: ArchView): ArchLaid {
  const list = leaves(v);
  const compound = v.groups.length > 0;
  const dg = new dagre.graphlib.Graph({ compound });
  dg.setGraph({
    rankdir: 'LR',
    ranksep: SPEC_GRAPH_RANK_GAP,
    nodesep: compound ? SPEC_GRAPH_NODE_GAP + 2 * SPEC_GRAPH_BOX_PAD + SPEC_GRAPH_BOX_HEAD : SPEC_GRAPH_NODE_GAP,
    marginx: SPEC_GRAPH_MARGIN,
    marginy: SPEC_GRAPH_MARGIN + SPEC_GRAPH_BOX_HEAD,
  });
  dg.setDefaultEdgeLabel(() => ({}));
  for (const x of v.groups) dg.setNode(BOX_PREFIX + x.id, {});
  for (const x of v.groups) if (x.parent) dg.setParent(BOX_PREFIX + x.id, BOX_PREFIX + x.parent);
  for (const l of list) {
    dg.setNode(l.id, { width: l.w, height: l.h });
    if (l.parent) dg.setParent(l.id, BOX_PREFIX + l.parent);
  }
  // dagre lays no edge on a cluster: an edge to an open group is laid to its first member.
  const first = new Map<string, string>();
  const groupById = new Map(v.groups.map((x) => [x.id, x] as const));
  for (const l of list) for (const p of ancestors(l.parent, (id) => groupById.get(id)?.parent)) if (!first.has(p)) first.set(p, l.id);
  const leafOf = (id: string) => (dg.hasNode(id) ? id : first.get(id));
  for (const e of v.edges) {
    const [a, b] = [leafOf(e.from), leafOf(e.to)];
    if (a && b && a !== b) dg.setEdge(a, b);
  }
  dagre.layout(dg);
  const pos = new Map<string, Box>();
  for (const l of list) {
    const p = dg.node(l.id);
    pos.set(l.id, { x: p.x - l.w / 2, y: p.y - l.h / 2, w: l.w, h: l.h });
  }
  // Boxes from the inside out: members and inner boxes, padded, with the band for the name.
  const depth = depthIn(v.groups);
  const boxes = new Map<string, Box>();
  for (const x of [...v.groups].sort((a, b) => depth(b) - depth(a))) {
    const inner = [
      ...list.filter((l) => l.parent === x.id).map((l) => pos.get(l.id)!),
      ...v.groups.filter((y) => y.parent === x.id && boxes.has(y.id)).map((y) => boxes.get(y.id)!),
    ];
    if (!inner.length) continue;
    const x0 = Math.min(...inner.map((b) => b.x)) - SPEC_GRAPH_BOX_PAD;
    const y0 = Math.min(...inner.map((b) => b.y)) - SPEC_GRAPH_BOX_PAD - SPEC_GRAPH_BOX_HEAD;
    const x1 = Math.max(...inner.map((b) => b.x + b.w)) + SPEC_GRAPH_BOX_PAD;
    const y1 = Math.max(...inner.map((b) => b.y + b.h)) + SPEC_GRAPH_BOX_PAD;
    boxes.set(x.id, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
  }
  return { pos, boxes };
}

export type ArchNodeData = { node: ArchNode };
export type ArchGroupData = { group: ArchGroup };
export type ArchFoldData = { fold: ArchFold };
export type ArchFlowNode = Node<ArchNodeData, 'arch'> | Node<ArchGroupData, 'archGroup'> | Node<ArchFoldData, 'archFold'>;

export function toArchFlow(v: ArchView, laid: ArchLaid, selected: string | null): { nodes: ArchFlowNode[]; edges: Edge[] } {
  const rel = (b: Box, parent?: string) => {
    const p = parent ? laid.boxes.get(parent) : undefined;
    return {
      position: p ? { x: b.x - p.x, y: b.y - p.y } : { x: b.x, y: b.y },
      ...(p && { parentId: BOX_PREFIX + parent }),
      width: b.w,
      height: b.h,
      draggable: false,
    };
  };
  const depth = depthIn(v.groups);
  // Parents before children (React Flow's order for parentId).
  const nodes: ArchFlowNode[] = [...v.groups]
    .filter((x) => laid.boxes.has(x.id))
    .sort((a, b) => depth(a) - depth(b))
    .map((x) => ({ id: BOX_PREFIX + x.id, type: 'archGroup', ...rel(laid.boxes.get(x.id)!, x.parent), data: { group: x }, selectable: false, focusable: false }));
  for (const n of v.nodes) {
    const b = laid.pos.get(n.id);
    if (b) nodes.push({ id: n.id, type: 'arch', ...rel(b, n.group), data: { node: n }, selected: n.id === selected, ariaLabel: n.label });
  }
  for (const f of v.folds) {
    const b = laid.pos.get(f.group.id);
    if (b) nodes.push({ id: f.group.id, type: 'archFold', ...rel(b, f.group.parent), data: { fold: f }, ariaLabel: f.group.label });
  }
  const end = (id: string) => (laid.boxes.has(id) ? BOX_PREFIX + id : id);
  const marker = { type: MarkerType.ArrowClosed };
  const edges: Edge[] = v.edges.map((e) => ({
    id: e.id,
    source: end(e.from),
    target: end(e.to),
    className: `ag-e ag-e--${e.layer}`,
    ...(e.label && { label: e.label }),
    ...(e.ends !== 'none' && { markerEnd: marker }),
    ...(e.ends === 'both' && { markerStart: marker }),
    focusable: false,
  }));
  return { nodes, edges };
}
