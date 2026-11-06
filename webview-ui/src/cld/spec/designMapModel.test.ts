import { describe, expect, it } from 'vitest';

import type {
  MapBlock,
  MapDesign,
  MapDrift,
  MapDriftItem,
  MapDriftKind,
} from '../../../../core/src/cld/spec/trace.js';
import { cellMarks, driftExamples, driftRow, ghosts, wantsDesign } from './designMapModel.js';
import { mapPath } from './traceApi.js';

const block = (id: string, kind: MapBlock['kind'] = 'unit'): MapBlock => ({
  id,
  name: id,
  kind,
  files: 1,
  inside: [],
  in: 0,
  out: 0,
  deeper: false,
  features: [],
  week: 0,
});
const design = (modules: MapDesign['modules']): MapDesign => ({
  modules,
  more: 0,
  edges: [],
  structure: null,
});
const drift = (items: MapDriftItem[] = []): MapDrift => {
  const counts = { designOnly: 0, codeOnly: 0, undesigned: 0, reversed: 0 } satisfies Record<
    MapDriftKind,
    number
  >;
  for (const it of items) counts[it.kind]++;
  return { counts, items, more: 0 };
};
const mod = (id: string, cells: string[] | undefined, by?: 'written' | 'confirmed' | 'guess') => ({
  id,
  label: `L${id}`,
  paths: [],
  ...(cells && { cells }),
  ...(by && { by }),
});
const blocks = [block('a'), block('b'), block('c'), block('tests', 'rail')];

describe('the request', () => {
  it('adds design=1 only for the design and overlay views', () => {
    expect(wantsDesign('code')).toBe(false);
    expect(wantsDesign('design')).toBe(true);
    expect(wantsDesign('overlay')).toBe(true);
    expect(mapPath([], undefined, undefined, wantsDesign('code'))).toBe('map?');
    expect(mapPath([], undefined, undefined, wantsDesign('overlay'))).toBe('map?design=1');
  });
});

describe('cellMarks', () => {
  it('marks agree, guess (never agree) and none; rails get nothing', () => {
    const m = cellMarks(
      design([mod('m1', ['a'], 'written'), mod('m2', ['b'], 'guess')]),
      drift(),
      blocks,
    );
    expect(m.get('a')).toBe('agree');
    expect(m.get('b')).toBe('guess');
    expect(m.get('c')).toBe('none');
    expect(m.has('tests')).toBe(false);
  });
  it('a confirmed pair agrees, and a guess beside a written pair still agrees', () => {
    const m = cellMarks(
      design([mod('m1', ['a'], 'confirmed'), mod('m2', ['a'], 'guess')]),
      drift(),
      blocks,
    );
    expect(m.get('a')).toBe('agree');
  });
  it('the design says nothing (no counted pair): no not-in-design mark, a guess alone does not count', () => {
    const m = cellMarks(design([mod('m2', ['b'], 'guess')]), drift(), blocks);
    expect(m.get('b')).toBe('guess');
    expect(m.has('a')).toBe(false);
    expect(cellMarks(design([]), drift(), blocks).size).toBe(0);
  });
  it('the server count of code-only cells keeps the mark when the module list was cut', () => {
    const m = cellMarks(design([]), drift([{ kind: 'codeOnly', cell: 'c' }]), blocks);
    expect(m.get('c')).toBe('none');
  });
});

describe('the number row and its examples', () => {
  it('an empty drift is four zeros in the owner order and no ghosts', () => {
    expect(driftRow(drift())).toEqual([
      { kind: 'designOnly', n: 0 },
      { kind: 'codeOnly', n: 0 },
      { kind: 'undesigned', n: 0 },
      { kind: 'reversed', n: 0 },
    ]);
    expect(ghosts(design([]), drift())).toEqual([]);
    expect(driftExamples(drift(), 'reversed')).toEqual([]);
  });
  const items: MapDriftItem[] = [
    { kind: 'designOnly', module: 'm1', path: 'x/one.ts' },
    { kind: 'designOnly', module: 'm1', path: 'x/two.ts' },
    { kind: 'designOnly', module: 'm9', path: 'y/z.ts' },
    { kind: 'codeOnly', cell: 'c' },
    { kind: 'undesigned', from: 'a', to: 'b', imports: 4 },
    { kind: 'reversed', from: 'b', to: 'a', imports: 2 },
  ];
  it('counts each kind and points each example at the card it opens', () => {
    const d = drift(items);
    expect(driftRow(d).map((x) => x.n)).toEqual([3, 1, 1, 1]);
    expect(driftExamples(d, 'designOnly').map((e) => e.target)).toEqual(['m1', 'm1', 'm9']);
    expect(driftExamples(d, 'codeOnly')[0]!.target).toBe('c');
    expect(driftExamples(d, 'undesigned')[0]!.target).toBe('a');
    expect(driftExamples(d, 'reversed')[0]!.target).toBe('b');
  });
  it('a ghost is one card per design-only module with its missing paths', () => {
    const g = ghosts(design([mod('m1', undefined, 'written')]), drift(items));
    expect(g).toEqual([
      { id: 'm1', label: 'Lm1', paths: ['x/one.ts', 'x/two.ts'] },
      { id: 'm9', label: 'y/z.ts', paths: ['y/z.ts'] },
    ]);
  });
});
