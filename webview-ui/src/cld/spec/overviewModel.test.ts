import '../../i18n/specStrings.js';

import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { SPEC_OVERVIEW_DONE_WINDOW_MS, SPEC_OVERVIEW_VIEWED } from '../../constants.js';
import { parseViewed, pushViewed, questLights, rollDigits, showText, taskCounts, weekView } from './overviewModel.js';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const task = (status: string, updatedAt = '2026-11-03T10:00:00Z', project = 'alpha') => ({ project, status: status as 'done', updatedAt });

describe('SPT-P3-OVERVIEW model', () => {
  it("taskCounts: this project's Tasks per status, done in the last 7 days apart", () => {
    const old = new Date(NOW - SPEC_OVERVIEW_DONE_WINDOW_MS - 1).toISOString();
    const c = taskCounts([task('todo'), task('doing'), task('doing'), task('review'), task('blocked'), task('done'), task('done', old), task('proposed'), task('doing', undefined, 'beta')], 'alpha', NOW);
    expect(c).toEqual({ todo: 1, doing: 2, review: 1, blocked: 1, done: 2, doneWeek: 1 });
  });

  it('recently viewed requirements: newest first, once, at most SPEC_OVERVIEW_VIEWED; a bad stored value is an empty list', () => {
    let list = parseViewed(null);
    for (let i = 0; i < SPEC_OVERVIEW_VIEWED + 2; i++) list = pushViewed(list, { uid: `i_${i}`, label: `FR-${i}` });
    list = pushViewed(list, { uid: 'i_3', label: 'FR-3' });
    expect(list.map((v) => v.uid)).toEqual(['i_3', 'i_6', 'i_5', 'i_4', 'i_2']);
    expect(parseViewed(JSON.stringify(list))).toEqual(list);
    expect(parseViewed('{oops')).toEqual([]);
    expect(parseViewed('{"uid":"x"}')).toEqual([]);
    expect(parseViewed(JSON.stringify([{ uid: 'a', label: 'A' }, { uid: 1 }, null]))).toEqual([{ uid: 'a', label: 'A' }]);
  });

  it("showText names every filter the server's overview numbers open", () => {
    const filters = ['unlinked', 'observed', 'linked', 'review', 'missing', 'ev:integration', 'evr:deploy'];
    const texts = filters.map(showText);
    expect(new Set(texts).size).toBe(filters.length);
    expect(texts.every((x) => x && !x.startsWith('spec.'))).toBe(true);
  });

  it('the overview stays light: nothing it imports (statically, transitively) pulls in the graph, React Flow or dagre', () => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = fs.readFileSync(file, 'utf-8');
      for (const m of src.matchAll(/^import (?!type )[^;]*?from '([^']+)'/gms)) {
        const spec = m[1];
        expect(spec).not.toMatch(/@xyflow|dagre|TraceGraph|traceLayout/);
        if (!spec.startsWith('./')) continue; // the spec folder's own modules
        const ts = path.resolve(path.dirname(file), spec).replace(/\.js$/, '');
        const hit = ['.ts', '.tsx'].map((e) => ts + e).find((f) => fs.existsSync(f));
        if (hit) walk(hit);
      }
    };
    walk(path.join(__dirname, 'Overview.tsx'));
    expect([...seen].map((f) => path.basename(f))).toEqual(expect.arrayContaining(['Overview.tsx', 'SpecTabs.tsx', 'ReqDetail.tsx', 'overviewModel.ts']));
  });

  it("GAME-UI-0 questLights: the requirement's evidence, else the Task's own facts; a half light says why when the data does", () => {
    const at = '2026-11-03T10:00:00Z';
    const task = { id: 'T-5', testsPassed: { value: true, source: 'reported' as const, at }, commits: { value: 2, source: 'observed' as const, at } };
    expect(questLights(task)).toEqual([
      { axis: 'change', led: 'on' },
      { axis: 'integration', led: 'off' },
      { axis: 'test', led: 'half', why: expect.stringContaining('T-5') },
      { axis: 'deploy', led: 'off' },
    ]);
    const ev = { change: 'observed', integration: 'observed', test: 'reported', deploy: 'reported', reported: false } as const;
    const lights = questLights({ id: 'T-6' }, ev);
    expect(lights.map((l) => l.led)).toEqual(['on', 'on', 'half', 'half']);
    expect(lights[2].why).toBeUndefined(); // another Task's report: no reason to give, only '시험 보고만'
    expect(lights[3].why).toBeTruthy(); // a deploy ◐ is always a deploy job's exit 0 without 배포 확인
    expect(questLights({ id: 'T-7', commits: { value: 1, source: 'inferred', at } })[0].led).toBe('off');
  });
});

describe('GAME-UI-1 G2 model', () => {
  it('rollDigits: 0009 → 0010 rolls the ones then the tens; zeros in front dimmed; a fall does not roll', () => {
    expect(rollDigits(9, 10)).toEqual([
      { was: '0', now: '0', lead: true },
      { was: '0', now: '0', lead: true },
      { was: '0', now: '1', lead: false, roll: 1 },
      { was: '9', now: '0', lead: false, roll: 0 },
    ]);
    expect(rollDigits(10, 9).some((c) => c.roll !== undefined)).toBe(false);
    expect(rollDigits(0, 0).map((c) => c.lead)).toEqual([true, true, true, false]);
    expect(rollDigits(9999, 10000).map((c) => c.now).join('')).toBe('10000');
  });

  it('weekView: a new record (gold) only past a real best; cells capped, rejected on top; future days apart', () => {
    const days = (a: number[], r: number[] = []) => a.map((accepted, i) => ({ accepted, rejected: r[i] ?? 0 }));
    const calm = weekView({ start: '2026-11-02', today: 1, days: days([4, 5, 0, 0, 0, 0, 0], [0, 1]), weeks: [3, 0, 7, 11, 14] });
    expect([calm.total, calm.best, calm.record]).toEqual([9, 14, false]);
    expect(calm.days.map((d) => [d.cells, d.rejectedCells, d.today, d.future])[1]).toEqual([5, 1, true, false]);
    expect(calm.days[2].future).toBe(true);
    expect(calm.bars).toEqual([8, 2, 18, 28, 36, 23]);
    expect(weekView({ start: '', today: 4, days: days([4, 5, 3, 2, 1, 0, 0]), weeks: [3, 0, 7, 11, 14] }).record).toBe(true);
    // A first week ever beats nothing; a day past the cell cap keeps its count.
    const first = weekView({ start: '', today: 0, days: days([12, 0, 0, 0, 0, 0, 0], [3]), weeks: [0, 0, 0, 0, 0] });
    expect([first.record, first.days[0].cells, first.days[0].rejectedCells, first.days[0].accepted]).toEqual([false, 10, 0, 12]);
  });

  it('score.css animates only under :root[data-game-motion=on]', () => {
    const css = fs.readFileSync(path.join(__dirname, 'score.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, , body]) => /\banimation\b/.test(body));
    expect(rules.length).toBeGreaterThan(0);
    for (const [, sel] of rules) expect(sel.trim()).toMatch(/^:root\[data-game-motion='on'\]/);
  });
});
