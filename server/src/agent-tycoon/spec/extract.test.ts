import { describe, expect, it } from 'vitest';

import { extract, type ExtractOptions, norm } from './extract.js';

const opts = (o: Partial<ExtractOptions> = {}): ExtractOptions => ({ kind: 'requirements', mode: 'auto', depth: 2, shortIds: false, idPatterns: [], ...o });
const brief = (text: string, o?: Partial<ExtractOptions>, name = 'doc.md') =>
  extract(text, name, opts(o)).map((i) => [i.shape, i.displayId ?? null, i.title, i.line]);

describe('extract', () => {
  it('an SRS-style table: the first cell or an ID column, the status column out of the text', () => {
    const srs = [
      '# SRS',
      '## 3.1 Office',
      '| ID | 요구 | 상태 |',
      '|---|---|---|',
      '| FR-OFC-001 | 탭마다 방 | 완료 |',
      '| NFR-PERF-008 | 꺼지면 비용 0 | 진행 |',
      '',
      '| 이름 | ID |',
      '|---|---|',
      '| 로그인 | R-01 |',
      '| 그냥 행 | 없음 |',
    ].join('\n');
    expect(brief(srs)).toEqual([
      ['row', 'FR-OFC-001', '탭마다 방', 5],
      ['row', 'NFR-PERF-008', '꺼지면 비용 0', 6],
      ['row', 'R-01', '로그인', 10],
    ]);
    const items = extract(srs, 'SRS.md', opts());
    expect(items[0].section).toBe('3.1 Office');
    expect(items.map((i) => i.ordinal)).toEqual([0, 1, 2]);
    // The status cell is not the text: 완료 → 진행 keeps the hash.
    const moved = extract(srs.replace('| 탭마다 방 | 완료 |', '| 탭마다 방 | 진행 |'), 'SRS.md', opts());
    expect(moved[0].textHash).toBe(items[0].textHash);
    expect(extract(srs.replace('탭마다 방', '탭마다 큰 방'), 'SRS.md', opts())[0].textHash).not.toBe(items[0].textHash);
  });

  it('headings that start with an ID, with their section as the text; mentions are not items', () => {
    const design = '# Cockpit\n\n## D-001 사이드카에 둔다\n이유 FR-OFC-001 참고\n### 세부\n더\n## D-002: 본문 없음\n';
    expect(brief(design, { kind: 'design' })).toEqual([
      ['heading', 'D-001', '사이드카에 둔다', 3],
      ['heading', 'D-002', '본문 없음', 7],
    ]);
    const [a] = extract(design, 'd.md', opts({ kind: 'design' }));
    expect(extract(design.replace('더', '더 많이'), 'd.md', opts({ kind: 'design' }))[0].textHash).not.toBe(a.textHash);
  });

  it('a front-matter id makes the document one item, unless a heading already defines it', () => {
    const adr = '---\nid: ADR-0013\ntitle: 엔진은 백그라운드 세션\nstatus: accepted\n---\n# 맥락\n글\n';
    expect(brief(adr, { kind: 'decision' })).toEqual([['fm', 'ADR-0013', '엔진은 백그라운드 세션', 1]]);
    expect(brief('---\nid: ADR-0014\n---\n# ADR-0014 정책 없는 코어\n', { kind: 'decision' })).toEqual([['heading', 'ADR-0014', '정책 없는 코어', 4]]);
    expect(brief('---\nid: SRS\n---\n# SRS\n')).toEqual([]); // not a display ID
  });

  it('OpenSpec and Kiro requirement headings', () => {
    const spec = '# Login\n### Requirement: User login\nThe system SHALL\n#### Scenario: ok\n- WHEN\n### Requirement 3\nKiro body\n';
    expect(brief(spec)).toEqual([
      ['reqhead', null, 'Requirement: User login', 2],
      ['reqhead', null, 'Requirement 3', 6],
    ]);
  });

  it('checkboxes in plans and task specs only; ticking one keeps its hash', () => {
    const plan = '# Plan\n## 이번 주\n- [ ] 개요 탭\n- [x] 문서 탭\n';
    expect(brief(plan, { kind: 'plan' })).toEqual([
      ['check', null, '개요 탭', 3],
      ['check', null, '문서 탭', 4],
    ]);
    expect(brief(plan, { kind: 'design' })).toEqual([]);
    const [open] = extract(plan, 'p.md', opts({ kind: 'plan' }));
    expect(extract(plan.replace('- [ ] 개요', '- [x] 개요'), 'p.md', opts({ kind: 'plan' }))[0].textHash).toBe(open.textHash);
    expect(open.section).toBe('이번 주');
  });

  it('ID-less headings only in headings mode: depth 2 folds ### into its parent, depth 3 lists them', () => {
    const prd = '# 설치 안내\n## 1. 목적\n글\n## 2. 첫 실행\n### 2.1 로그인\n글\n### 2.2 프로젝트\n## 3. 기능\n';
    expect(brief(prd)).toEqual([]);
    expect(brief(prd, { mode: 'headings' })).toEqual([
      ['heading', null, '1. 목적', 2],
      ['heading', null, '2. 첫 실행', 4],
      ['heading', null, '3. 기능', 8],
    ]);
    expect(brief(prd, { mode: 'headings', depth: 3 }).map((r) => r[2])).toEqual(['1. 목적', '2. 첫 실행', '2.1 로그인', '2.2 프로젝트', '3. 기능']);
    // Folded: an edit under ### changes its ## parent's text.
    const before = extract(prd, 'PRD.md', opts({ mode: 'headings' }))[1].textHash;
    expect(extract(prd.replace('### 2.2 프로젝트', '### 2.2 프로젝트들'), 'PRD.md', opts({ mode: 'headings' }))[1].textHash).not.toBe(before);
    // More than one `#`: they are sections too.
    expect(brief('# A\n# B\n', { mode: 'headings' }).map((r) => r[2])).toEqual(['A', 'B']);
    expect(brief(prd, { mode: 'off' })).toEqual([]);
  });

  it('a status row without an ID; fenced code is skipped; the project patterns and short ids count', () => {
    const doc = '| 항목 | 상태 |\n|---|---|\n| 반영 A | 완료 |\n\n```\n| FR-X-001 | no |\n|---|---|\n```\n## S1 짧은 것\n## ABC_7 우리 것\n';
    expect(brief(doc)).toEqual([['row', null, '반영 A', 3]]);
    expect(brief(doc, { shortIds: true, idPatterns: ['ABC_\\d{1,5}'] }).map((r) => r[1])).toEqual([null, 'S1', 'ABC_7']);
  });

  it('norm drops markup, case, the own ID, spaces and punctuation', () => {
    expect(norm('**FR-1**: Tab `per` room.', 'FR-1')).toBe('tabperroom');
  });
});
