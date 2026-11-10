/**
 * SPT-P3-GRAPH: dagre placement of a trace graph, left to right. Clusters (a node's `group`, when
 * the graph has two or more) are dagre compound parents so their members stay together; their
 * boxes are drawn around the members with a band for the name. A graph without links (an
 * overview of groups, a group of unlinked requirements) is a grid instead of one long column.
 */
import dagre from '@dagrejs/dagre';

import type { TraceGraph, TraceNode } from '../../../../core/src/agent-tycoon/spec/trace.js';
import {
  SPEC_GRAPH_BOX_HEAD,
  SPEC_GRAPH_BOX_PAD,
  SPEC_GRAPH_MARGIN,
  SPEC_GRAPH_NODE,
  SPEC_GRAPH_NODE_GAP,
  SPEC_GRAPH_RANK_GAP,
} from '../../constants.js';
import { type Box, BOX_PREFIX, type Laid } from './traceModel.js';

export function nodeSize(n: TraceNode): { w: number; h: number } {
  return SPEC_GRAPH_NODE[
    n.type === 'req' || n.type === 'group' || n.type === 'commit' ? n.type : 'other'
  ];
}

export function layoutTrace(g: TraceGraph): Laid {
  const groups = new Set(g.nodes.flatMap((n) => (n.group ? [n.group] : [])));
  const compound = groups.size >= 2;
  const pos = new Map<string, Box>();
  if (!g.edges.length && !compound) {
    const cols = Math.max(1, Math.ceil(Math.sqrt(g.nodes.length)));
    g.nodes.forEach((n, i) => {
      const { w, h } = nodeSize(n);
      const cell = SPEC_GRAPH_NODE.group;
      pos.set(n.id, {
        x: (i % cols) * (cell.w + SPEC_GRAPH_NODE_GAP),
        y: Math.floor(i / cols) * (cell.h + SPEC_GRAPH_NODE_GAP),
        w,
        h,
      });
    });
    return { pos, boxes: new Map() };
  }
  const dg = new dagre.graphlib.Graph({ compound });
  // A cluster's band and padding sit outside the members dagre spaces, so leave room for them.
  const gap = compound
    ? SPEC_GRAPH_NODE_GAP + 2 * SPEC_GRAPH_BOX_PAD + SPEC_GRAPH_BOX_HEAD
    : SPEC_GRAPH_NODE_GAP;
  dg.setGraph({
    rankdir: 'LR',
    ranksep: SPEC_GRAPH_RANK_GAP,
    nodesep: gap,
    marginx: SPEC_GRAPH_MARGIN,
    marginy: SPEC_GRAPH_MARGIN,
  });
  dg.setDefaultEdgeLabel(() => ({}));
  if (compound) for (const grp of groups) dg.setNode(BOX_PREFIX + grp, {});
  for (const n of g.nodes) {
    const { w, h } = nodeSize(n);
    dg.setNode(n.id, { width: w, height: h });
    if (compound && n.group) dg.setParent(n.id, BOX_PREFIX + n.group);
  }
  for (const e of g.edges) dg.setEdge(e.from, e.to);
  dagre.layout(dg);
  for (const n of g.nodes) {
    const p = dg.node(n.id);
    const { w, h } = nodeSize(n);
    pos.set(n.id, { x: p.x - w / 2, y: p.y - h / 2, w, h });
  }
  const boxes = new Map<string, Box>();
  if (compound)
    for (const grp of groups) {
      const members = g.nodes.filter((n) => n.group === grp).map((n) => pos.get(n.id)!);
      const x0 = Math.min(...members.map((b) => b.x)) - SPEC_GRAPH_BOX_PAD;
      const y0 = Math.min(...members.map((b) => b.y)) - SPEC_GRAPH_BOX_PAD - SPEC_GRAPH_BOX_HEAD;
      const x1 = Math.max(...members.map((b) => b.x + b.w)) + SPEC_GRAPH_BOX_PAD;
      const y1 = Math.max(...members.map((b) => b.y + b.h)) + SPEC_GRAPH_BOX_PAD;
      boxes.set(grp, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  return { pos, boxes };
}
