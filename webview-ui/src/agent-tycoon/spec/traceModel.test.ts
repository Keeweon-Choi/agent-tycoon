import { describe, expect, it } from 'vitest';

import type { TraceEdge, TraceGraph, TraceNode } from '../../../../core/src/agent-tycoon/spec/trace.js';
import type { Crumb } from './traceApi.js';
import { layoutTrace } from './traceLayout.js';
import {
  applyFilters,
  drillFrom,
  evidenceReason,
  foldCommits,
  ledOf,
  moveTo,
  NO_FILTERS,
  stateTones,
  toFlow,
  unlinkedIds,
} from './traceModel.js';

const n = (id: string, type: TraceNode['type'], extra: Partial<TraceNode> = {}): TraceNode => ({
  id,
  type,
  label: id,
  ...extra,
});
const e = (
  from: string,
  to: string,
  status: TraceEdge['status'],
  rel: TraceEdge['rel'] = 'changes',
): TraceEdge => ({ id: `${from}>${to}`, from, to, rel, status });

/** FR-1 in the middle: a Task, three commits of its own, one of the Task's, a job, one rejected Task. */
const hood: TraceGraph = {
  level: 'neighbourhood',
  center: 'r1',
  nodes: [
    n('r1', 'req'),
    n('t1', 'task'),
    n('t2', 'task'),
    n('c1', 'commit'),
    n('c2', 'commit'),
    n('c3', 'commit'),
    n('c4', 'commit'),
    n('j1', 'job'),
  ],
  edges: [
    e('r1', 't1', 'confirmed', 'implements'),
    e('r1', 'c1', 'observed'),
    e('r1', 'c2', 'observed'),
    e('r1', 'c3', 'confirmed'),
    e('t1', 'c4', 'suggested'),
    e('r1', 'j1', 'suggested', 'verifies'),
    e('r1', 't2', 'rejected', 'implements'),
  ],
  hidden: 2,
};

describe('trace graph model', () => {
  it('LEDs and tones follow the four states', () => {
    expect((['observed', 'reported', 'none', undefined] as const).map(ledOf)).toEqual(['on', 'half', 'off', 'off']);
    expect([evidenceReason('test', 'half').split(' · '), evidenceReason('test', 'off').split(' · ')].map((x) => x.length)).toEqual([2, 1]);
    expect(
      stateTones({
        work: { total: 2, byStatus: { done: 2 } },
        acceptance: { current: 'none' },
        freshness: 'review',
      }),
    ).toEqual(['ok', 'none', 'none', 'warn']);
  });

  it('folds three commits of one owner into one +N node, the surest status kept, and unfolds on demand', () => {
    const f = foldCommits(hood, new Set());
    const fold = f.nodes.find((x) => x.id === 'fold:r1');
    expect(fold).toMatchObject({ type: 'commit', count: 3 });
    expect(f.nodes.some((x) => x.id === 'c1')).toBe(false);
    expect(f.nodes.some((x) => x.id === 'c4')).toBe(true); // the Task's single commit stays
    expect(f.edges.find((x) => x.to === 'fold:r1')?.status).toBe('confirmed');
    expect(
      foldCommits(hood, new Set(['r1'])).nodes.filter((x) => x.type === 'commit'),
    ).toHaveLength(4);
  });

  it('filters by link level and type, hides what lost the centre, and counts the hidden', () => {
    const confirmed = applyFilters(hood, { ...NO_FILTERS, links: 'confirmed' });
    expect(confirmed.graph.nodes.map((x) => x.id).sort()).toEqual(['c3', 'r1', 't1']);
    expect(confirmed.hidden).toBe(5 + 2);
    const observed = applyFilters(hood, { ...NO_FILTERS, links: 'observed' });
    expect(observed.graph.edges.some((x) => x.status === 'rejected')).toBe(true);
    expect(observed.graph.nodes.some((x) => x.id === 'j1')).toBe(false);
    const noTasks = applyFilters(hood, { hiddenTypes: new Set(['task']), links: 'suggested' });
    expect(noTasks.graph.nodes.some((x) => x.id === 'c4')).toBe(false); // only reachable through t1
    expect(noTasks.hidden).toBe(3 + 2);
    expect(
      applyFilters(hood, { hiddenTypes: new Set(['req']), links: 'suggested' }).graph.nodes.some(
        (x) => x.id === 'r1',
      ),
    ).toBe(true);
  });

  it('moves between the three levels', () => {
    const top: Crumb[] = [{ level: 'overview' }];
    const g = moveTo(top, drillFrom(n('FR-ENG', 'group'))!);
    const r = moveTo(g, drillFrom(n('r1', 'req', { label: 'FR-ENG-001' }))!);
    expect(r.map((c) => c.level)).toEqual(['overview', 'group', 'neighbourhood']);
    expect(moveTo(r, { level: 'overview' })).toEqual(top);
    expect(moveTo(r, { level: 'neighbourhood', center: 'r2', label: 'FR-ENG-002' })).toHaveLength(
      3,
    );
    expect(drillFrom(n('t1', 'task'))).toBeNull();
  });

  it('turns a graph into React Flow nodes and edges, styled by status, clusters as parents', () => {
    const g: TraceGraph = {
      level: 'group',
      nodes: [
        n('r1', 'req', { group: 's1' }),
        n('r2', 'req', { group: 's1' }),
        n('r3', 'req', { group: 's2' }),
        n('s1', 'group', { label: '3.1' }),
      ],
      edges: [e('r1', 'r2', 'observed', 'refs'), e('r2', 'r3', 'suggested', 'refs')],
    };
    const laid = layoutTrace(g);
    expect(laid.boxes.size).toBe(2);
    const { nodes, edges } = toFlow(g, laid, {
      selected: 'r2',
      selectedEdge: null,
      observedTag: 'seen',
    });
    expect(nodes[0]).toMatchObject({
      id: 'box:s1',
      type: 'box',
      data: { label: '3.1' },
      selectable: false,
      focusable: false,
    });
    const r1 = nodes.find((x) => x.id === 'r1')!;
    expect(r1.parentId).toBe('box:s1');
    expect(r1.position.x).toBeGreaterThan(0); // relative to its box, inside the padding
    expect(nodes.find((x) => x.id === 'r2')?.selected).toBe(true);
    expect(edges.map((x) => [x.className, x.label, x.focusable])).toEqual([
      ['tg-e tg-e--observed', 'seen', false],
      ['tg-e tg-e--suggested', undefined, false],
    ]);
    // Boxes do not overlap.
    const [a, b] = [...laid.boxes.values()];
    expect(a.y + a.h <= b.y || b.y + b.h <= a.y || a.x + a.w <= b.x || b.x + b.w <= a.x).toBe(true);
  });

  it('marks unlinked requirements, and lays a graph without links out as a grid', () => {
    const g: TraceGraph = {
      level: 'group',
      nodes: [
        n('r1', 'req'),
        n('r2', 'req', { state: { work: { total: 1, byStatus: { doing: 1 } } } }),
      ],
      edges: [],
    };
    expect([...unlinkedIds(g)]).toEqual(['r1']);
    const laid = layoutTrace(g);
    expect(laid.pos.get('r1')!.y).toBe(laid.pos.get('r2')!.y);
  });
});
