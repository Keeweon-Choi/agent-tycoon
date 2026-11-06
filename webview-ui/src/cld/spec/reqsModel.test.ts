// RQ2: the 요구사항 tree, pure: 문서 → 기능 → 요구사항, a tool folder as one row, 모든 기능 공통
// last, a repeated display ID counted once, the filter and the 읽는 법 tag.
import { describe, expect, it } from 'vitest';

import {
  buildTree,
  type DocRow,
  filterTree,
  headCounts,
  type ItemRow,
  readHow,
  viewsOf,
} from './reqsModel.js';

const doc = (uid: string, path: string, more: Partial<DocRow> = {}): DocRow => ({
  uid,
  path,
  kind: 'requirements',
  mode: 'auto',
  depth: 3,
  tracked: true,
  state: 'active',
  git: 'committed',
  changedAt: '',
  size: 0,
  mtimeMs: 0,
  fresh: false,
  sensitive: false,
  items: 0,
  ...more,
});
const row = (
  uid: string,
  docUid: string,
  path: string,
  displayId: string,
  feature: ItemRow['feature'],
  more: Partial<ItemRow> = {},
): ItemRow => ({
  uid,
  displayId,
  title: displayId,
  section: '',
  doc: path,
  docUid,
  kind: 'requirements',
  shape: 'row',
  state: 'active',
  line: 1,
  feature,
  ...more,
});
const TRC = { key: 'FR-TRC', name: 'spec tracking', rule: 'prefix' } as const;
const NFR = { key: 'NFR-PERF', name: 'NFR-PERF', rule: 'common' } as const;
const KIT = { key: 'sk:001-login', name: '001-login', rule: 'speckit' } as const;
const docs = [
  doc('d_srs', 'docs/SRS.md'),
  doc('d_trace', 'docs/traceability.md'),
  doc('d_kit', 'specs/001-login/spec.md'),
  doc('d_prd', 'docs/PRD.md'),
];
const rows = [
  row('r_1', 'd_srs', 'docs/SRS.md', 'NFR-PERF-001', NFR),
  row('r_2', 'd_srs', 'docs/SRS.md', 'FR-TRC-001', TRC, {
    trace: { acceptance: { current: 'accepted' } },
  }),
  row('r_3', 'd_trace', 'docs/traceability.md', 'FR-TRC-001', TRC, {
    trace: { acceptance: { current: 'accepted' } },
  }),
  row('r_4', 'd_kit', 'specs/001-login/spec.md', 'FR-001', KIT, { shape: 'bullet' }),
];

describe('the requirements tree', () => {
  const views = viewsOf(rows);
  const tree = buildTree(rows, views, docs);

  it('documents, then features (the common ones last), then requirements; a tool folder is one row', () => {
    expect(tree.map((d) => [d.label, d.total])).toEqual([
      ['SRS.md', 2],
      ['traceability.md', 1],
      ['specs/', 1],
      ['PRD.md', 0],
    ]);
    expect(tree[0].features.map((f) => [f.key, f.tail])).toEqual([
      ['FR-TRC', 'TRC'],
      ['common', 'NFR-PERF'],
    ]);
    expect(tree[0].features[0].counts).toEqual({ todo: 0, doing: 0, done: 1 });
    expect(tree[2].tool).toBe('speckit');
    expect(tree[2].docs.map((d) => d.uid)).toEqual(['d_kit']);
  });

  it('a display ID in two documents shows in both and counts once', () => {
    expect(headCounts(rows, views)).toEqual({ total: 3, todo: 2, doing: 0, done: 1 });
  });

  it('filters by state, dropping what is left empty; the how-it-is-read tag', () => {
    expect(filterTree(tree, (r) => r.view.status === 'done').map((d) => d.label)).toEqual([
      'SRS.md',
      'traceability.md',
    ]);
    expect(readHow(tree[0], docs[0])).toBe('row');
    expect(readHow(tree[2], docs[2])).toBe('speckit');
    expect(readHow(tree[3], doc('d_prd', 'docs/PRD.md', { mode: 'headings' }))).toBe('headings');
    expect(readHow(tree[3], docs[3])).toBe('none');
  });
});
