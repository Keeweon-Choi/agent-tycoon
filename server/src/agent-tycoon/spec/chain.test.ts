// SPT C2 (§8.4, TC-234): FR-TRC-018's links from requirements to files by four paths, on a real
// scan of temp repositories: test data never links (the runner agent-tycoon/test/run-game-cockpit.ts names
// FR-DEMO-001 as example data; negative control: the rule off links it), commits and task numbers
// reach their files, a commit naming only a head-comment tag counts apart (§14 D3), the cells
// light by feature and the chain counts; the default paths follow the judged sample.
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as zlib from 'zlib';

import type { MapLinkPath } from '../../../../core/src/agent-tycoon/spec/trace.js';
import { SPEC_MAP_COMMITS_MAX, SPEC_MAP_PATH_ON_RATE, SPEC_MAP_PATHS_ON, SPEC_MAP_TIME_MS } from '../../constants.js';
import type { GitResult, GitRunner } from '../engine/git/gitRun.js';
import { GIT_AVAILABLE, makeTempRepo, type TempRepo } from '../engine/git/testRepo.js';
import { blockDetail, type ChainReq, featureChain, fileRule, lightCells, LINK_PATHS, linkedCount, reqLinks, tagOnly } from './chain.js';
import { headTags, readCommits, scanCode, type ScanCommit, testNameIds } from './mapWorker.js';
import { structureOwned } from './structure.js';

const REPO = path.resolve(__dirname, '../../../..');
const NOW = Date.now();
const WEEK = NOW - 7 * 24 * 3600 * 1000;
let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});
const req = (id: string, more: Partial<ChainReq> = {}): ChainReq => ({ uid: `u:${id}`, id, tasks: [], folders: [], ...more });
const named = (scan: Awaited<ReturnType<typeof scanCode>>, set: Set<number>) => [...set].map((i) => scan.files[i]).sort();

describe('what names a number', () => {
  it('test names (it, test, describe and their .only/.skip) and head-comment tags that are no display ID', () => {
    expect(testNameIds("it('FR-DEMO-003 starts', () => {});\ndescribe.skip(`NFR-PERF-001 budget`, x);\nconst data = 'FR-DEMO-002';\ntest(\"plain\", y)")).toEqual(['FR-DEMO-003', 'NFR-PERF-001']);
    expect(headTags('/**\n * SPT-P3: the board\n * FR-DEMO-001 is a number, not a tag\n */\n// MAP-A too')).toEqual(['SPT-P3', 'MAP-A']);
  });
  it('the rule per file: a layer body counts, a test file or a rail only its names, test data nothing; off: every body', () => {
    expect(fileRule('server/src/agent-tycoon/engine/core.ts', true)).toBe('body');
    expect(fileRule('server/src/agent-tycoon/engine/core.test.ts', true)).toBe('names');
    expect(fileRule('agent-tycoon/test/run-game-cockpit.ts', false)).toBe('names');
    expect(fileRule('server/src/agent-tycoon/spec/__fixtures__/x.ts', true)).toBe('none');
    expect(fileRule('webview-ui/src/__mocks__/x.ts', true)).toBe('none');
    expect(fileRule('agent-tycoon/test/run-game-cockpit.ts', false, false)).toBe('body');
  });
});

describe('a commit linked only by a head-comment tag (SPT §14 D3)', () => {
  const c = (tags: string[], ids: string[]): ScanCommit => ({ sha: 'a'.repeat(40), t: 0, s: 'x', ids, tags, f: [] });
  it('a tag with a requirement or a task number is linked by that number; a tag with an unknown number or none is tag-only; no tag is none', () => {
    const known = new Set(['FR-DEMO-001']);
    expect(tagOnly(c(['SPT-P3'], ['FR-DEMO-001']), known)).toBe(false);
    expect(tagOnly(c(['SPT-P3'], ['T-0099']), known)).toBe(false);
    expect(tagOnly(c(['SPT-P3'], ['FR-OTHER-001']), known)).toBe(true);
    expect(tagOnly(c(['SPT-P3'], []), known)).toBe(true);
    expect(tagOnly(c([], ['FR-OTHER-001']), known)).toBe(false);
  });
});

describe('the commit read (git log in the child)', () => {
  const SHA = (n: number) => n.toString(16).padStart(40, '0');
  const rec = (n: number, msg: string, names: string) => `\x1e${SHA(n)}\x1f${1_700_000_000 + n}\x1f${msg}\n\x1f\n${names}\n`;
  const answer = (stdout: string, more: Partial<GitResult> = {}): GitResult => ({ code: 0, stdout: Buffer.from(stdout), stderr: '', capped: false, timedOut: false, ...more });
  const at = new Map([['src/a.ts', 0]]);

  it(`at most SPEC_MAP_COMMITS_MAX (${SPEC_MAP_COMMITS_MAX}) commits: git is asked for no more than that`, async () => {
    // A history longer than the cap, of which git gives what its `-N` asks.
    const run: GitRunner = async (_cwd, args) => {
      const n = Number(args.find((a) => /^-\d+$/.test(a))?.slice(1) ?? Infinity);
      return answer(Array.from({ length: Math.min(n, SPEC_MAP_COMMITS_MAX + 5) }, (_, i) => rec(i, 'feat: FR-DEMO-001', 'src/a.ts')).join(''));
    };
    const { commits, capped } = await readCommits('/x', run, at, []);
    expect([commits.length, capped]).toEqual([SPEC_MAP_COMMITS_MAX, false]);
  });

  it('output cut at SPEC_MAP_LOG_MAX_BYTES: the record cut in the middle is dropped, the whole ones kept', async () => {
    const cut = `\x1e${SHA(3)}\x1f1700000003\x1ffeat: FR-DEMO-003 the rest\n\x1f\nsrc/a`;
    const run: GitRunner = async () => answer(rec(1, 'feat: FR-DEMO-001', 'src/a.ts') + rec(2, 'feat: FR-DEMO-002', 'src/a.ts') + cut, { code: null, capped: true });
    const { commits, capped } = await readCommits('/x', run, at, []);
    expect([commits.map((x) => x.ids), capped]).toEqual([[['FR-DEMO-001'], ['FR-DEMO-002']], true]);
  });

  it.skipIf(!GIT_AVAILABLE)('git gets the scan time left as its timeout, so it ends before the daemon kills the child', async () => {
    repo = makeTempRepo();
    const r = repo;
    r.write('src/a.ts', 'export const a = 1;\n');
    r.git(['add', '-A']);
    r.git(['commit', '-q', '-m', 'feat: FR-DEMO-001']);
    const seen: Array<number | undefined> = [];
    const run: GitRunner = (cwd, args, opts) => (args.includes('log') && seen.push(opts?.timeoutMs), r.run(cwd, args, opts));
    let calls = 0;
    // The scan's first look is 0 ms, every one after 12 s in.
    await scanCode(r.folder, run, () => (calls++ ? 12_000 : 0));
    expect(seen).toEqual([SPEC_MAP_TIME_MS - 12_000]);
  });

  it.skipIf(!GIT_AVAILABLE)('merge commits are not read (their message names no work of their own); the merged branch commits are', async () => {
    repo = makeTempRepo();
    const r = repo;
    r.git(['checkout', '-q', '-b', 'side']);
    r.write('src/a.ts', 'export const a = 1;\n');
    r.git(['add', '-A']);
    r.git(['commit', '-q', '-m', 'feat: FR-DEMO-002 on the side']);
    r.git(['checkout', '-q', 'main']);
    r.git(['merge', '-q', '--no-ff', '-m', 'Merge side for FR-DEMO-009', 'side']);
    const { commits } = await readCommits(r.folder, r.run, at, []);
    expect(commits.map((x) => x.s)).toEqual(['feat: FR-DEMO-002 on the side']);
  });
});

describe.skipIf(!GIT_AVAILABLE)('the four paths on a real scan', () => {
  function setup() {
    repo = makeTempRepo();
    const r = repo;
    // The runner's own text (its example data names FR-DEMO-001, FR-DEMO-002, FR-TRC-008).
    r.write('agent-tycoon/test/run-game-cockpit.ts', fs.readFileSync(path.join(REPO, 'agent-tycoon/test/run-game-cockpit.ts'), 'utf-8'));
    r.write('server/src/engine/core.ts', '// FR-DEMO-001: the engine core\nexport const core = 1;\n');
    r.write('server/src/engine/core.test.ts', "const sample = 'FR-DEMO-002';\nit('FR-DEMO-004 restarts', () => {});\n");
    r.write('server/src/spec/__fixtures__/srs.ts', "export const rows = ['FR-DEMO-001', 'FR-DEMO-002'];\n");
    r.write('server/src/spec/board.ts', "/**\n * SPT-P3: the board\n */\nimport { core } from '../engine/core.js';\nexport const b = core;\n");
    r.write('server/src/spec/queue.ts', '// T-0018 the queue\nexport const q = 1;\n');
    r.write('agent-tycoon/tasks/T-0018-engine.md', '# T-0018 Engine core (E1): projects\n\nBuilds FR-DEMO-003 and FR-DEMO-005.\n');
    r.git(['add', '-A']);
    r.git(['commit', '-q', '-m', 'test: all files']);
    r.write('server/src/engine/run.ts', 'export const run = 1;\n');
    r.write('server/src/spec/__fixtures__/srs.ts', "export const rows = ['FR-DEMO-001'];\n");
    r.git(['add', '-A']);
    r.git(['commit', '-q', '-m', 'feat(engine): run the session\n\nRefs FR-DEMO-001']);
    r.write('server/src/spec/board.ts', "/**\n * SPT-P3: the board\n */\nimport { core } from '../engine/core.js';\nexport const b = core + 1;\n");
    r.git(['commit', '-q', '-am', 'feat(spec): SPT-P3 the board moves']);
    r.write('server/src/engine/run.ts', 'export const run = 2;\n');
    r.git(['commit', '-q', '-am', 'fix(engine): T-0018 the run']);
    return r;
  }

  it('TC-234: the runner example number and test data are no link; negative control: with the rule off they are', async () => {
    const r = setup();
    const scan = await scanCode(r.folder, r.run);
    const reqs = ['FR-DEMO-001', 'FR-DEMO-002', 'FR-DEMO-004', 'FR-ENG-001', 'FR-TRC-008'].map((id) => req(id));
    const on = reqLinks(scan, reqs, WEEK)!;
    const direct = (l: typeof on, id: string) => named(scan, l.reqs.get(`u:${id}`)!.paths.direct);
    expect(direct(on, 'FR-DEMO-001')).toEqual(['server/src/engine/core.ts']);
    expect(direct(on, 'FR-DEMO-002')).toEqual([]); // the test file's data, the fixture
    expect(direct(on, 'FR-DEMO-004')).toEqual(['server/src/engine/core.test.ts']); // a test name
    expect([direct(on, 'FR-ENG-001'), direct(on, 'FR-TRC-008')]).toEqual([[], []]); // only in the runner's example data
    // The commit naming FR-DEMO-001 changed run.ts and the fixture: the fixture is out.
    expect(named(scan, on.reqs.get('u:FR-DEMO-001')!.paths.commit)).toEqual(['server/src/engine/run.ts']);
    const off = reqLinks(scan, reqs, WEEK, new Map(), false)!;
    expect(direct(off, 'FR-ENG-001')).toEqual(['agent-tycoon/test/run-game-cockpit.ts']);
    expect(direct(off, 'FR-TRC-008')).toEqual(['agent-tycoon/test/run-game-cockpit.ts']);
    expect(direct(off, 'FR-DEMO-001')).toEqual(['server/src/engine/core.ts', 'server/src/spec/__fixtures__/srs.ts']);
    expect(named(scan, off.reqs.get('u:FR-DEMO-001')!.paths.commit)).toContain('server/src/spec/__fixtures__/srs.ts');
  });

  it('the task path (its spec names the requirement; a file and a commit name the task), confirmed folders, tag-only commits, lit cells, the chain and a cell detail', async () => {
    const r = setup();
    const scan = await scanCode(r.folder, r.run);
    expect(scan.links!.tasks['T-0018']).toEqual({ title: 'Engine core (E1): projects', ids: ['FR-DEMO-003', 'FR-DEMO-005'] });
    expect(scan.links!.commits.map((c) => c.s)).toEqual(['fix(engine): T-0018 the run', 'feat(spec): SPT-P3 the board moves', 'feat(engine): run the session', 'test: all files']);
    const reqs = [req('FR-DEMO-001'), req('FR-DEMO-003'), req('FR-DEMO-006', { tasks: ['T-0018'], folders: ['server/src/engine/'] })];
    const links = reqLinks(scan, reqs, WEEK)!;
    const three = links.reqs.get('u:FR-DEMO-003')!;
    expect(three.tasks).toEqual(['T-0018']);
    expect(named(scan, three.paths.task)).toEqual(['server/src/engine/run.ts', 'server/src/spec/queue.ts']);
    expect(three.recent).toBe(true);
    const six = links.reqs.get('u:FR-DEMO-006')!;
    expect(named(scan, six.paths.confirmed)).toEqual(['server/src/engine/core.test.ts', 'server/src/engine/core.ts', 'server/src/engine/run.ts']);
    expect(named(scan, six.paths.task)).toEqual(named(scan, three.paths.task));
    // D3: the SPT-P3 commit names a tag and no number; the T-0018 one is no tag-only commit.
    expect(links.commits.filter((c) => tagOnly(c, links.known)).map((c) => c.s)).toEqual(['feat(spec): SPT-P3 the board moves']);
    const all = new Set<MapLinkPath>(LINK_PATHS);
    expect(linkedCount(links, ['u:FR-DEMO-001', 'u:FR-DEMO-003', 'u:FR-DEMO-006'], new Set(['direct']))).toBe(1);
    expect(linkedCount(links, ['u:FR-DEMO-001', 'u:FR-DEMO-003', 'u:FR-DEMO-006'], all)).toBe(3);
    const owned = structureOwned(scan)!;
    expect(owned.s.blocks.map((b) => b.id).sort()).toEqual(['server/src/engine', 'server/src/spec', 'server/src/spec/__fixtures__', 'tests']);
    const keyOf = new Map(reqs.map((x) => [x.uid, 'FR-DEMO']));
    lightCells(links, owned.s, owned.owner, keyOf, all, WEEK);
    const by = new Map(owned.s.blocks.map((b) => [b.id, b]));
    expect(by.get('server/src/engine')!.features).toEqual([{ key: 'FR-DEMO', reqs: 3 }]);
    expect(by.get('server/src/spec')!.features).toEqual([{ key: 'FR-DEMO', reqs: 2 }]); // queue.ts by the task
    expect(by.get('tests')!.features).toEqual([]); // the runner: no link
    expect(by.get('server/src/engine')!.week).toBe(3);
    lightCells(links, owned.s, owned.owner, keyOf, new Set(['direct']), WEEK);
    expect(by.get('server/src/spec')!.features).toEqual([]);
    const fc = featureChain(links, reqs.map((x) => x.uid), scan.files, all, WEEK);
    expect(fc.chain).toEqual({ reqs: 3, tasks: 1, commits: 1, files: 4 }); // core, core.test (confirmed), run, queue
    expect(fc.tasks).toEqual([{ id: 'T-0018', title: 'Engine core (E1): projects', reqs: 2 }]);
    expect(fc.week).toBe(2); // FR-DEMO-001's commit and T-0018's
    expect(fc.perReq.get('u:FR-DEMO-001')!.paths).toEqual({ direct: { n: 1, files: ['server/src/engine/core.ts'] }, commit: { n: 1, files: ['server/src/engine/run.ts'] } });
    lightCells(links, owned.s, owned.owner, keyOf, all, WEEK);
    const d = blockDetail(links, scan, owned.s, owned.owner, 'server/src/spec', new Map([['FR-DEMO', { short: 'DEMO', name: '시연' }]]))!;
    expect(d.features).toEqual([{ key: 'FR-DEMO', short: 'DEMO', name: '시연', reqs: 2 }]);
    expect(d.tags).toEqual([{ tag: 'SPT-P3', files: 1 }]);
    expect(d.tagOnly).toBe(1);
    expect(d.recent.map((c) => [c.subject, c.tags])).toEqual([
      ['feat(spec): SPT-P3 the board moves', ['SPT-P3']],
      ['test: all files', []], // the fixture the FR-DEMO-001 commit changed is a cell of its own here
    ]);
    expect(blockDetail(links, scan, owned.s, owned.owner, 'nowhere', new Map())).toBeNull();
  });
});

describe('the paths on by default follow the judged sample (agent-tycoon/docs/research/spec-map-links-2026-11-04.md)', () => {
  type Row = { id: string; path: MapLinkPath; file: string; verdict: 'ok' | 'wrong' };
  const file = path.join(__dirname, '__fixtures__/links-sample-1104.json.gz');
  const sample = (fs.existsSync(file) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf-8')) : { rows: [] }) as { rows: Row[] };
  const rate = (p: MapLinkPath) => {
    const rs = sample.rows.filter((r) => r.path === p);
    return rs.length ? rs.filter((r) => r.verdict === 'ok').length / rs.length : null;
  };
  // 확정 is the owner's own confirmation: on without a sample.
  const expected = LINK_PATHS.filter((p) => p === 'confirmed' || (rate(p) ?? 0) >= SPEC_MAP_PATH_ON_RATE);

  it('30 requirements judged (direct 8/10, commit 3/10, task 8/27); a path right 70% of the time or more is on, the others only in [펼치기]', () => {
    expect(new Set(sample.rows.map((r) => r.id)).size).toBe(30);
    const n = (p: MapLinkPath) => [sample.rows.filter((r) => r.path === p && r.verdict === 'ok').length, sample.rows.filter((r) => r.path === p).length];
    expect([n('direct'), n('commit'), n('task')]).toEqual([
      [8, 10],
      [3, 10],
      [8, 27],
    ]);
    expect([...SPEC_MAP_PATHS_ON]).toEqual(expected);
    expect(expected).toEqual(['confirmed', 'direct']);
  });
  it('negative control: without the accuracy line every path would be on, not what the constant says', () => {
    const loose = LINK_PATHS.filter((p) => p === 'confirmed' || (rate(p) ?? 0) >= 0);
    expect(loose).not.toEqual([...SPEC_MAP_PATHS_ON]);
  });
});
