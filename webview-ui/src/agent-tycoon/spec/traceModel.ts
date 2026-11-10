/**
 * SPT-P3-GRAPH, pure: the trace graph (contract TraceGraph) turned into what the 그래프 tab draws.
 * Filters (types, 확정만 / 관측 포함 / 추정 포함) with the '숨긴 것 N개' count, commits folded into
 * '커밋 +N' per Task or requirement (SPT §7.1), the level breadcrumbs, the four state glyphs and
 * tones, and the React Flow nodes and edges (styles by class: confirmed solid, observed solid with
 * a tag, suggested dashed, rejected dimmed), and the words for sources and states. No React
 * components, no DOM, no layout engine here.
 */
import type { Edge, Node } from '@xyflow/react';

import type {
  EvidenceMark,
  LinkStatus,
  TraceEdge,
  TraceGraph,
  TraceNode,
  TraceNodeType,
  TraceSource,
  TraceState,
} from '../../../../core/src/agent-tycoon/spec/trace.js';
import { SPEC_GRAPH_FOLD_MIN } from '../../constants.js';
import { t, type TranslationKey } from '../../i18n/index.js';
import { openProjectFile } from '../files/explorerState.js';
import type { LedState } from '../game/parts.js';
import type { Crumb } from './traceApi.js';

export const FOLD_PREFIX = 'fold:';
export const BOX_PREFIX = 'box:';

// ── four states (SPT §5) ──
/** GAME-UI-0: an evidence mark as its LED (observed on, reported half, none off). */
const LED: Record<EvidenceMark, LedState> = { observed: 'on', reported: 'half', none: 'off' };
export const ledOf = (m?: EvidenceMark): LedState => LED[m ?? 'none'];
/** The list's 근거 column order: 코드 변경 · 통합 확인 · 시험 · 배포 (SPT §5.2). */
export const EVIDENCE_AXES = ['change', 'integration', 'test', 'deploy'] as const;
export type EvidenceAxis = (typeof EVIDENCE_AXES)[number] | 'reported';
export const AXIS_TEXT = {
  change: 'spec.ev.change',
  integration: 'spec.ev.integration',
  test: 'spec.ev.test',
  deploy: 'spec.ev.deploy',
  reported: 'spec.ev.reported',
} as const satisfies Record<EvidenceAxis, TranslationKey>;
/** What makes an axis's light what it is, from the server's rules (trace.ts buildIndex). */
const WHY: Partial<Record<`${EvidenceAxis}.${LedState}`, TranslationKey>> = {
  'change.on': 'game.why.change.on',
  'change.half': 'game.why.change.half',
  'integration.on': 'game.why.integration.on',
  'test.on': 'game.why.test.on',
  'test.half': 'game.why.test.half',
  'deploy.on': 'game.why.deploy.on',
  'deploy.half': 'game.why.deploy.half',
  'reported.half': 'game.why.reported.half',
};
/** '시험 · Task 가 시험 통과를 보고함 …' (the Led puts its word first): the axis, and why its light is `led` when a rule says. */
export const evidenceReason = (axis: EvidenceAxis, led: LedState): string => {
  const why = WHY[`${axis}.${led}`];
  return why ? `${t(AXIS_TEXT[axis])} · ${t(why)}` : t(AXIS_TEXT[axis]);
};

export type Tone = 'ok' | 'part' | 'warn' | 'bad' | 'none';
/** One tone per state axis (작업, 근거, 수용, 최신), for the node's four dots. */
export function stateTones(s?: TraceState): [Tone, Tone, Tone, Tone] {
  const w = s?.work;
  const work: Tone = !w?.total
    ? 'none'
    : w.byStatus.done === w.total
      ? 'ok'
      : w.byStatus.blocked
        ? 'bad'
        : 'part';
  const marks = EVIDENCE_AXES.map((k) => s?.evidence?.[k] ?? 'none');
  const ev: Tone = marks.every((m) => m === 'observed')
    ? 'ok'
    : marks.includes('observed')
      ? 'part'
      : marks.includes('reported')
        ? 'warn'
        : 'none';
  const acc = ({ none: 'none', validate: 'warn', accepted: 'ok', rejected: 'bad' } as const)[
    s?.acceptance?.current ?? 'none'
  ];
  const fresh = s?.freshness
    ? ({ current: 'ok', review: 'warn', missing: 'bad', unresolved: 'warn' } as const)[s.freshness]
    : 'none';
  return [work, ev, acc, fresh];
}

// ── words ──
const baseName = (p: string) => p.split('/').pop() ?? p;
/** Where an observed link was seen, in words: file:line, a commit, a Task, a job. */
export function sourceText(s?: TraceSource): string {
  if (!s) return '';
  if (s.path) return s.line ? `${s.path}:${s.line}` : s.path;
  return s.sha?.slice(0, 7) ?? s.taskId ?? s.jobId ?? s.msgId ?? '';
}
export const whoText = (by?: TraceEdge['by']) => (by ? (by.name ?? t(`spec.who.${by.kind}`)) : '');

/** '진행 1 · 끝 1' from a requirement's linked Task statuses, '' without any. */
export const workText = (s?: TraceState) =>
  Object.entries(s?.work?.byStatus ?? {})
    .filter(([, c]) => c)
    .map(([st, c]) => `${t(`tasks.status.${st}` as TranslationKey)} ${c}`)
    .join(' · ');

/** The file viewer on the source, scrolled to its line and the line marked (SPT-P3-ACCEPT). */
export function openSource(project: string, s?: TraceSource) {
  if (s?.path)
    openProjectFile(
      project,
      { name: baseName(s.path), path: s.path, kind: 'file', size: 0, mtime: 0 },
      s.line,
    );
}
const pad = (n: number) => String(n).padStart(2, '0');
/** 'MM-DD HH:mm' in local time (an acceptance record's when). */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── filters ──
export const LINK_LEVELS = ['confirmed', 'observed', 'suggested'] as const;
export type LinkLevel = (typeof LINK_LEVELS)[number];
export interface GraphFilters {
  hiddenTypes: ReadonlySet<TraceNodeType>;
  links: LinkLevel;
}
export const NO_FILTERS: GraphFilters = { hiddenTypes: new Set(), links: 'suggested' };
const RANK: Record<LinkStatus, number> = { confirmed: 0, observed: 1, suggested: 2, rejected: 1 };
const linkShown = (s: LinkStatus, level: LinkLevel) => RANK[s] <= RANK[level];

/** The filtered graph and how many nodes it hides (with the server's own `hidden`). In a
 *  neighbourhood, a node no longer connected to the centre is hidden too. */
export function applyFilters(
  g: TraceGraph,
  f: GraphFilters,
): { graph: TraceGraph; hidden: number } {
  const center = g.level === 'neighbourhood' ? g.center : undefined;
  let keep = new Set(
    g.nodes.filter((n) => n.id === center || !f.hiddenTypes.has(n.type)).map((n) => n.id),
  );
  let edges = g.edges.filter(
    (e) => linkShown(e.status, f.links) && keep.has(e.from) && keep.has(e.to),
  );
  if (center && keep.has(center)) {
    const reach = new Set([center]);
    for (let grew = true; grew;) {
      grew = false;
      for (const e of edges)
        for (const [a, b] of [
          [e.from, e.to],
          [e.to, e.from],
        ])
          if (reach.has(a) && !reach.has(b)) {
            reach.add(b);
            grew = true;
          }
    }
    keep = reach;
    edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  }
  const nodes = g.nodes.filter((n) => keep.has(n.id));
  const hidden =
    g.nodes.filter((n) => !keep.has(n.id)).reduce((sum, n) => sum + (n.count ?? 1), 0) +
    (g.hidden ?? 0);
  return { graph: { ...g, nodes, edges }, hidden };
}

// ── fold ──
/** Commits of one Task or requirement (more than SPEC_GRAPH_FOLD_MIN) become one node `fold:<owner>`
 *  with `count`, unless the owner is in `unfolded`. Parallel edges to it merge (the surest status wins). */
export function foldCommits(g: TraceGraph, unfolded: ReadonlySet<string>): TraceGraph {
  const byId = new Map(g.nodes.map((n) => [n.id, n] as const));
  const isCommit = (id: string) => byId.get(id)?.type === 'commit' && !byId.get(id)?.count;
  const owner = new Map<string, string>();
  for (const e of g.edges) {
    const pair =
      isCommit(e.to) && !isCommit(e.from)
        ? [e.to, e.from]
        : isCommit(e.from) && !isCommit(e.to)
          ? [e.from, e.to]
          : null;
    if (pair && !owner.has(pair[0])) owner.set(pair[0], pair[1]);
  }
  const perOwner = new Map<string, string[]>();
  for (const [c, o] of owner) perOwner.set(o, [...(perOwner.get(o) ?? []), c]);
  const into = new Map<string, string>();
  for (const [o, cs] of perOwner)
    if (cs.length > SPEC_GRAPH_FOLD_MIN && !unfolded.has(o))
      for (const c of cs) into.set(c, FOLD_PREFIX + o);
  if (!into.size) return g;
  const nodes = g.nodes.filter((n) => !into.has(n.id));
  for (const [o, cs] of perOwner)
    if (into.has(cs[0]))
      nodes.push({
        id: FOLD_PREFIX + o,
        type: 'commit',
        label: '',
        count: cs.length,
        group: byId.get(o)?.group,
      });
  const merged = new Map<string, TraceEdge>();
  const edges: TraceEdge[] = [];
  for (const e of g.edges) {
    const from = into.get(e.from) ?? e.from;
    const to = into.get(e.to) ?? e.to;
    if (from === e.from && to === e.to) {
      edges.push(e);
      continue;
    }
    if (from === to) continue;
    const id = `${FOLD_PREFIX}${from}>${to}`;
    const prev = merged.get(id);
    if (!prev || RANK[e.status] < RANK[prev.status]) merged.set(id, { ...e, id, from, to });
  }
  return { ...g, nodes, edges: [...edges, ...merged.values()] };
}
/** The owner a fold node stands for. */
export const foldOwner = (id: string) =>
  id.startsWith(FOLD_PREFIX) ? id.slice(FOLD_PREFIX.length) : null;

// ── levels ──
/** The breadcrumbs after moving to `next`: a level already on the path cuts back to it. */
export function moveTo(path: readonly Crumb[], next: Crumb): Crumb[] {
  const at = path.findIndex((c) => c.level === next.level);
  return [...(at < 0 ? path : path.slice(0, at)), next];
}
/** Where a node leads one level down: a group to its requirements, a requirement to its neighbourhood. */
export function drillFrom(n: TraceNode): Crumb | null {
  if (n.type === 'group') return { level: 'group', group: n.id, label: n.label };
  if (n.type === 'req') return { level: 'neighbourhood', center: n.id, label: n.label };
  return null;
}

// ── React Flow ──
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
/** Absolute top-left boxes of the nodes, and of the clusters (by group id). */
export interface Laid {
  pos: Map<string, Box>;
  boxes: Map<string, Box>;
}
export type TraceNodeData = { node: TraceNode; unlinked: boolean; center: boolean };
export type BoxNodeData = { label: string };
export type FlowNode = Node<TraceNodeData, 'trace'> | Node<BoxNodeData, 'box'>;
export type FlowEdge = Edge<{ edge: TraceEdge }>;

/** A requirement with no Task, no evidence and no link in this graph shows '미연결' (never hidden). */
export function unlinkedIds(g: TraceGraph): Set<string> {
  const linked = new Set(g.edges.flatMap((e) => [e.from, e.to]));
  return new Set(
    g.nodes
      .filter(
        (n) =>
          n.type === 'req' &&
          !linked.has(n.id) &&
          !n.state?.work?.total &&
          EVIDENCE_AXES.every((k) => (n.state?.evidence?.[k] ?? 'none') === 'none'),
      )
      .map((n) => n.id),
  );
}

export function toFlow(
  g: TraceGraph,
  laid: Laid,
  opts: { selected: string | null; selectedEdge: string | null; observedTag: string },
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const label = new Map(g.nodes.map((n) => [n.id, n.label] as const));
  const unlinked = unlinkedIds(g);
  const nodes: FlowNode[] = [...laid.boxes].map(([group, b]) => ({
    id: BOX_PREFIX + group,
    type: 'box',
    position: { x: b.x, y: b.y },
    width: b.w,
    height: b.h,
    data: { label: label.get(group) ?? group },
    selectable: false,
    focusable: false,
    draggable: false,
  }));
  for (const n of g.nodes) {
    const p = laid.pos.get(n.id);
    if (!p) continue;
    const box = n.group ? laid.boxes.get(n.group) : undefined;
    nodes.push({
      id: n.id,
      type: 'trace',
      position: box ? { x: p.x - box.x, y: p.y - box.y } : { x: p.x, y: p.y },
      ...(box && { parentId: BOX_PREFIX + n.group }),
      width: p.w,
      height: p.h,
      data: { node: n, unlinked: unlinked.has(n.id), center: n.id === g.center },
      selected: n.id === opts.selected,
      draggable: false,
      ariaLabel: n.title ? `${n.label} ${n.title}` : n.label,
    });
  }
  const edges: FlowEdge[] = g.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    className: `tg-e tg-e--${e.status}`,
    ...(e.status === 'observed' && { label: opts.observedTag }),
    focusable: false,
    selected: e.id === opts.selectedEdge,
    data: { edge: e },
  }));
  return { nodes, edges };
}
