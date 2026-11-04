import { describe, expect, it } from 'vitest';

import type { TraceArch } from '../../../../core/src/cld/spec/trace.js';
import { SPEC_ARCH_DEPTH_MAX } from '../../constants.js';
import { ancestors, cleanGroups, foldArch, layoutArch, toArchFlow } from './archModel.js';

const src = { path: 'd.md', line: 1 };
const node = (id: string, group?: string) => ({ id, label: id, kind: 'component' as const, from: 'doc' as const, standing: 'doc' as const, sources: [src], ...(group && { group }) });
const G: TraceArch = {
  layer: 'interaction',
  nodes: [node('api', 'core'), node('db', 'core'), node('web', 'sys'), node('user')],
  groups: [
    { id: 'sys', label: 'System', source: src },
    { id: 'core', label: 'Core', parent: 'sys', source: src },
  ],
  edges: [
    { id: 'e1', from: 'web', to: 'api', layer: 'composition', source: src },
    { id: 'e2', from: 'api', to: 'db', layer: 'composition', source: src },
    { id: 'e3', from: 'user', to: 'sys', layer: 'composition', source: src },
    { id: 'e4', from: 'web', to: 'db', layer: 'interaction', label: 'read', source: src },
    { id: 'e5', from: 'web', to: 'api', layer: 'interaction', label: 'call', source: src },
  ],
  unsupported: [],
  counts: { approved: 0, proposed: 0, fromDocs: 4 },
  diagrams: [],
};

describe('the architecture view', () => {
  it('nested groups are boxes around their members, parents first in the flow', () => {
    const v = foldArch(G, new Set());
    const laid = layoutArch(v);
    const [sys, core] = [laid.boxes.get('sys')!, laid.boxes.get('core')!];
    expect(core.x).toBeGreaterThan(sys.x);
    expect(core.x + core.w).toBeLessThan(sys.x + sys.w);
    const api = laid.pos.get('api')!;
    expect(api.x).toBeGreaterThan(core.x);
    const flow = toArchFlow(v, laid, null);
    expect(flow.nodes.slice(0, 2).map((n) => n.id)).toEqual(['box:sys', 'box:core']);
    expect(flow.nodes.find((n) => n.id === 'api')).toMatchObject({ parentId: 'box:core' });
    expect(flow.edges.find((e) => e.id === 'e3')).toMatchObject({ target: 'box:sys', markerEnd: { type: 'arrowclosed' } });
    expect(flow.edges.find((e) => e.id === 'e4')).toMatchObject({ className: 'ag-e ag-e--interaction', label: 'read' });
  });
  it('a folded group is one node with its count; edges into it end on it, inner ones go, parallel ones merge', () => {
    const v = foldArch(G, new Set(['core']));
    expect(v.nodes.map((n) => n.id)).toEqual(['web', 'user']);
    expect(v.folds).toEqual([{ group: G.groups[1], count: 2 }]);
    expect(v.edges.map((e) => `${e.layer[0]}:${e.from}>${e.to}:${e.label ?? ''}`)).toEqual(['c:web>core:', 'c:user>sys:', 'i:web>core:read · call']);
    const outer = foldArch(G, new Set(['sys', 'core']));
    expect(outer.folds.map((f) => [f.group.id, f.count])).toEqual([['sys', 3]]);
    expect(outer.groups).toEqual([]);
    expect(outer.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['user>sys']);
    const flow = toArchFlow(v, layoutArch(v), null);
    expect(flow.nodes.find((n) => n.id === 'core')).toMatchObject({ type: 'archFold', parentId: 'box:sys' });
  });
  it('groups from the wire that loop, repeat or run deep are drawn, never walked forever (the old view hung on a reopened subgraph)', () => {
    const loop: TraceArch = {
      ...G,
      nodes: [node('x', 'B2'), node('y', 'self'), node('z', 'g40')],
      groups: [
        { id: 'B', label: 'B', parent: 'A', source: src },
        { id: 'A', label: 'A', parent: 'B', source: src },
        { id: 'B2', label: 'B again', parent: 'A', source: src },
        { id: 'B', label: 'B twice', source: src },
        { id: 'self', label: 'self', parent: 'self', source: src },
        ...Array.from({ length: 41 }, (_, i) => ({ id: `g${i}`, label: `g${i}`, ...(i && { parent: `g${i - 1}` }), source: src })),
      ],
      edges: [{ id: 'e', from: 'x', to: 'A', layer: 'composition', source: src }],
    };
    const clean = cleanGroups(loop.groups);
    expect(clean.filter((g) => g.id === 'B')).toHaveLength(1);
    expect(clean.find((g) => g.id === 'self')!.parent).toBeUndefined();
    for (const g of clean) expect(ancestors(g.id, (id) => clean.find((x) => x.id === id)?.parent).length).toBeLessThanOrEqual(SPEC_ARCH_DEPTH_MAX);
    for (const folded of [new Set<string>(), new Set(['A', 'B']), new Set(['g3'])]) {
      const v = foldArch(loop, folded);
      const flow = toArchFlow(v, layoutArch(v), null);
      expect(flow.nodes.length).toBeGreaterThan(0);
    }
    expect(ancestors('a', () => 'a')).toEqual(['a']);
  });
  it('the re-review`s malformed groups: every case ends, quickly, with each flow node once', () => {
    const grp = (id: string, parent?: string) => ({ id, label: id, source: src, ...(parent && { parent }) });
    const chain = Array.from({ length: 1000 }, (_, i) => grp(`G${i}`, i ? `G${i - 1}` : undefined));
    const cases: Array<[ReturnType<typeof grp>[], ReturnType<typeof node>[], string[]]> = [
      [[grp('A', 'A')], [node('x', 'A'), node('y')], []],
      [[grp('A', 'B'), grp('B', 'A')], [node('x', 'A'), node('y')], []],
      [[grp('A', 'C'), grp('B', 'A'), grp('C', 'B')], [node('x', 'B'), node('y', 'C')], []],
      [[grp('A', 'C'), grp('B', 'A'), grp('C', 'B')], [node('x', 'B'), node('y', 'C')], ['A', 'B']],
      [[grp('A'), grp('A', 'B'), grp('B', 'A')], [node('x', 'A'), node('y')], []],
      [[grp('A', 'nope')], [node('x', 'A'), node('y')], []],
      [chain, [node('x', 'G999'), node('y', 'G5')], []],
      [chain, [node('x', 'G999'), node('y', 'G5')], ['G20', 'G500']],
      [[grp('A')], [node('x', 'ghost'), node('y', 'A')], []],
    ];
    for (const [groups, nodes, folded] of cases) {
      const t0 = performance.now();
      const d: TraceArch = { ...G, nodes, groups, edges: [{ id: 'e', from: 'x', to: groups[0].id, layer: 'composition', source: src }] };
      const v = foldArch(d, new Set(folded));
      const f = toArchFlow(v, layoutArch(v), null);
      expect(new Set(f.nodes.map((n) => n.id)).size).toBe(f.nodes.length);
      expect(performance.now() - t0).toBeLessThan(1000);
    }
  });
});
