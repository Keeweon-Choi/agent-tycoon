import { describe, expect, it } from 'vitest';

import type { MapBlock, MapStructure } from '../../../../core/src/cld/spec/trace.js';
import {
  cardLines,
  cardOrder,
  gridCells,
  NO_FILTER,
  relationsOf,
  sides,
} from './archCardsModel.js';

const block = (
  id: string,
  layer: string | undefined,
  kind: MapBlock['kind'] = 'unit',
  features: MapBlock['features'] = [],
): MapBlock => ({
  id,
  name: id.split('/').pop()!,
  kind,
  layer,
  files: 1,
  inside: [],
  in: 0,
  out: 0,
  deeper: false,
  features,
  week: 0,
});
const S: MapStructure = {
  crumbs: [],
  bands: [
    { id: 'ui', name: 'ui', files: 2, blocks: ['ui', 'ui/office'] },
    { id: 'core', name: 'core', files: 1, blocks: ['core'] },
  ],
  blocks: [
    block('ui', 'ui', 'layer', [{ key: 'FR-A', reqs: 2 }]),
    block('ui/office', 'ui'),
    block('core', 'core'),
    block('tests', undefined, 'rail'),
  ],
  pairs: [
    { a: 'ui', b: 'core', ab: 80, ba: 0 },
    { a: 'ui/office', b: 'ui', ab: 3, ba: 60 },
    { a: 'ui/office', b: 'core', ab: 5, ba: 0 },
  ],
  violations: 0,
  violationFiles: [],
  files: 3,
  imports: 148,
  unresolved: 0,
  big: 0,
  at: '',
  ms: 1,
  rssKb: 1,
};

describe('archCards', () => {
  it('orders band by band, rails only when asked, and filters', () => {
    expect(cardOrder(S, NO_FILTER).map((b) => b.id)).toEqual(['ui', 'ui/office', 'core']);
    expect(cardOrder(S, { ...NO_FILTER, rails: true }).map((b) => b.id)).toEqual([
      'ui',
      'ui/office',
      'core',
      'tests',
    ]);
    expect(cardOrder(S, { ...NO_FILTER, layers: new Set(['core']) }).map((b) => b.id)).toEqual([
      'core',
    ]);
    expect(
      cardOrder(S, { ...NO_FILTER, links: new Set(['linked'] as const) }).map((b) => b.id),
    ).toEqual(['ui']);
    expect(cardOrder(S, { ...NO_FILTER, query: 'OFF' }).map((b) => b.id)).toEqual(['ui/office']);
  });

  it('places on a grid and picks the sides a line runs between', () => {
    const g = gridCells(['a', 'b', 'c', 'd'], 3);
    expect(g.get('d')).toEqual({ row: 1, col: 0 });
    expect(sides(g.get('b')!, g.get('a')!)).toEqual(['l', 'r']);
    expect(sides(g.get('a')!, g.get('d')!)).toEqual(['b', 't']);
    expect(sides(g.get('d')!, g.get('c')!)).toEqual(['t', 'b']);
  });

  it('draws the bold pairs, and every pair of the picked card, importer first', () => {
    const shown = new Set(['ui', 'ui/office', 'core']);
    expect(cardLines(S.pairs, shown, 50, null).map((l) => [l.from, l.to, l.two])).toEqual([
      ['ui', 'core', false],
      ['ui', 'ui/office', true],
    ]);
    expect(cardLines(S.pairs, shown, 50, 'core').map((l) => l.id)).toEqual([
      'ui|core',
      'ui/office|ui',
      'ui/office|core',
    ]);
    expect(cardLines(S.pairs, new Set(['ui', 'ui/office']), 50, null)).toHaveLength(1);
  });

  it('counts what a cell uses, what uses it and the two-way ones', () => {
    const r = relationsOf(S.pairs, 'ui');
    expect(r.uses).toEqual([
      { id: 'core', n: 80 },
      { id: 'ui/office', n: 60 },
    ]);
    expect(r.usedBy).toEqual([{ id: 'ui/office', n: 3 }]);
    expect(r.both).toEqual([{ id: 'ui/office', n: 63 }]);
    expect(r.partners).toBe(2);
  });
});
