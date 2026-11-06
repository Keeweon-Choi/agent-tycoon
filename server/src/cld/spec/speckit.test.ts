// K9 (Project Brain §8): the Spec Kit folder read by rules. The sample is the R4 "lendlib" project
// (__fixtures__/sample-speckit/SOURCE.md): the numbers below are the ones the design documents state
// (stories 7, FR 12, SC 5, tasks 15/25, plan paths 8, 계획만 `src/web/components`).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { TraceMap } from '../../../../core/src/cld/spec/trace.js';
import { SPEC_SETTLE_MS } from '../../constants.js';
import { GIT_AVAILABLE, makeTempRepo, recording, type TempRepo } from '../engine/git/testRepo.js';
import { reqLinks } from './chain.js';
import { classify } from './discover.js';
import { criteriaOf, extract, itemSource } from './extract.js';
import type { CodeScan } from './mapWorker.js';
import { type SpecProject, SpecService } from './service.js';
import { kitOf, kitOpt, type KitSpec, readPlan, readResearch, readSpec, readTasks, STORY_ID } from './speckit.js';
import { codeIndex, kitBlock, storyTasks } from './speckitMap.js';

const FIX = path.join(__dirname, '__fixtures__', 'sample-speckit');
const FEATURES = ['001-catalog', '002-checkout', '003-reminders'];
const read = (dir: string, file: string) => fs.readFileSync(path.join(FIX, 'specs', dir, file), 'utf-8');
const CODE = fs.readFileSync(path.join(FIX, 'files.txt'), 'utf-8').split('\n').filter(Boolean);

/** The sample's numbers as the reader sees them; `tags` false turns the `[P]`/`[USn]` rule off. */
function sampleNumbers(tags = true) {
  const n = { stories: 0, frs: 0, scs: 0, tasks: 0, done: 0, parallel: 0, tagged: 0, planPaths: 0 };
  for (const dir of FEATURES) {
    const spec = readSpec(read(dir, 'spec.md'));
    const tasks = readTasks(read(dir, 'tasks.md'), tags);
    n.stories += spec.stories.length;
    n.frs += spec.frs.length;
    n.scs += spec.scs.length;
    n.tasks += tasks.tasks.length;
    n.done += tasks.tasks.filter((t) => t.done).length;
    n.parallel += tasks.tasks.filter((t) => t.parallel).length;
    n.tagged += tasks.tasks.filter((t) => t.story !== undefined).length;
    n.planPaths += readPlan(read(dir, 'plan.md')).paths.length;
  }
  return n;
}
const SAMPLE = { stories: 7, frs: 12, scs: 5, tasks: 25, done: 15, parallel: 9, tagged: 23, planPaths: 8 };

describe('the readers on the lendlib sample', () => {
  it('give the numbers the design documents state', () => {
    expect(sampleNumbers()).toEqual(SAMPLE);
  });

  it('negative control: with the [P] / [USn] rule off the same numbers do not come out', () => {
    expect(sampleNumbers(false)).not.toEqual(SAMPLE);
    expect(sampleNumbers(false)).toMatchObject({ parallel: 0, tagged: 0, tasks: 25 });
  });

  it('a story: title, priority, its acceptance scenarios; an FR: its text; a task: tags, files, phase', () => {
    const spec = readSpec(read('002-checkout', 'spec.md'));
    expect(spec.title).toBe('대여와 반납');
    expect(spec.stories.map((s) => [s.n, s.priority, s.scenarios.length])).toEqual([[1, 'P1', 1], [2, 'P1', 1], [3, 'P3', 1]]);
    expect(spec.stories[0].scenarios[0]).toMatch(/^Given .*When .*Then /);
    expect(spec.frs.map((f) => f.id)).toEqual(['FR-001', 'FR-002', 'FR-003', 'FR-004', 'FR-005']);
    const t = readTasks(read('002-checkout', 'tasks.md'));
    expect(t.phases.map((p) => p.label)).toEqual(['3', '4', '5']);
    expect(t.tasks[0]).toMatchObject({ id: 'T001', done: true, parallel: true, story: 1, files: ['src/shared/models/loan.ts'], phase: 0 });
    expect(t.tasks[6]).toMatchObject({ id: 'T007', done: false, parallel: false, story: 2, files: ['src/web/pages/scan.ts'], phase: 1 });
    // an API route is not a path; the file after `in` is
    expect(t.tasks[8].files).toEqual(['src/api/loans/renew.ts']);
  });

  it('plan.md: the Technical Context as written, the Project Structure paths; unknown sections ignored', () => {
    expect(readPlan(read('001-catalog', 'plan.md')).context).toEqual({ 'Language/Version': 'TypeScript 5.9', Storage: 'SQLite', Testing: 'vitest' });
    expect(readPlan(read('002-checkout', 'plan.md')).paths.map((p) => [p.path, p.note])).toEqual([
      ['src/api/loans/', '대여·반납·연장 API'],
      ['src/web/pages/', '내 대여 화면'],
      ['src/shared/models/', 'Loan'],
    ]);
  });
});

describe('the template shapes the sample does not have (github/spec-kit templates)', () => {
  const PLAN = [
    '# Implementation Plan: [FEATURE]',
    '## Technical Context',
    '<!-- ACTION REQUIRED',
    '**Language/Version**: hidden in a comment',
    '-->',
    '**Language/Version**: Python 3.11',
    '**Primary Dependencies**: [e.g., FastAPI, UIKit, LLVM or NEEDS CLARIFICATION]',
    '**Testing**: pytest',
    '**Project Type**: NEEDS CLARIFICATION',
    '## Project Structure',
    '### Documentation (this feature)',
    '```text',
    'specs/001-x/',
    '├── plan.md',
    '└── tasks.md',
    '```',
    '### Source Code (repository root)',
    '```text',
    '# [REMOVE IF UNUSED] Option 1: Single project (DEFAULT)',
    'src/',
    '├── models/',
    '│   └── user.py',
    '├── services/',
    '└── lib/',
    'tests/',
    '└── unit/',
    '# [REMOVE IF UNUSED] Option 3: Mobile + API',
    'api/',
    '└── [same as backend above]',
    '```',
    '**Structure Decision**: prose is not read',
    '',
  ].join('\n');

  it('plan.md: filled values only, a box-drawing tree becomes full paths, the documentation tree and comments are skipped', () => {
    const p = readPlan(PLAN);
    expect(p.context).toEqual({ 'Language/Version': 'Python 3.11', Testing: 'pytest' });
    expect(p.paths.map((x) => x.path)).toEqual(['src/', 'src/models/', 'src/models/user.py', 'src/services/', 'src/lib/', 'tests/', 'tests/unit/', 'api/']);
  });

  it('spec.md: NEEDS CLARIFICATION, entities, a story without a priority, shapes inside code or comments ignored', () => {
    const spec: KitSpec = readSpec(
      [
        '# Feature Specification: Accounts',
        '### User Story 1 - Sign up (Priority: P1)',
        '**Acceptance Scenarios**:',
        '1. **Given** a visitor, **When** they sign up, **Then** an account exists',
        '2. **Given** a taken email, **When** they sign up, **Then** they are told',
        '### User Story 2 - Reset',
        '<!--',
        '- **FR-099**: in a comment',
        '-->',
        '```',
        '- **FR-098**: in a fence',
        '```',
        '- **FR-001**: System MUST authenticate users via [NEEDS CLARIFICATION: auth method?]',
        '### Key Entities *(include if feature involves data)*',
        '- **Account**: who signs up',
        '- **Session**: a login',
        '',
      ].join('\n'),
    );
    expect(spec.stories.map((s) => [s.n, s.priority, s.scenarios.length])).toEqual([[1, 'P1', 2], [2, '', 0]]);
    expect(spec.frs).toMatchObject([{ id: 'FR-001', clarify: true, text: 'System MUST authenticate users via' }]);
    expect(spec.entities).toEqual(['Account', 'Session']);
  });

  it('research.md: Decision / Rationale / Alternatives considered, bold or bulleted', () => {
    const d = readResearch(
      ['# Research', '## Storage', '- **Decision**: SQLite', '- **Rationale**: no server', '- **Alternatives considered**: Postgres', '## Queue', '**Decision:** in-process', ''].join('\n'),
    );
    expect(d).toEqual([
      { topic: 'Storage', decision: 'SQLite', rationale: 'no server', alternatives: 'Postgres', line: 3 },
      { topic: 'Queue', decision: 'in-process', line: 7 },
    ]);
  });

  it('tasks.md: phases, `Phase N`, a done mark in either case, tags in either order; prose sections are named, not read', () => {
    const t = readTasks(['## Phase 1: Setup', '- [X] T001 [US1] [P] Do it in src/a.py', '- [ ] T002 depends on T001', '## Dependencies & Execution Order', '- prose', '## Phase N: Polish', '- [ ] T003 [P] Docs (FR-004)', ''].join('\n'));
    expect(t.tasks.map((x) => [x.id, x.done, x.parallel, x.story, x.phase])).toEqual([['T001', true, true, 1, 0], ['T002', false, false, undefined, 0], ['T003', false, true, undefined, 1]]);
    expect(t.tasks[2].frs).toEqual(['FR-004']);
    expect(t.phases.map((p) => p.label)).toEqual(['1', 'N']);
    expect(t.dependenciesProse).toBe(true);
  });
});

describe('the document items (registry identity) of a Spec Kit folder', () => {
  const opts = (kind: 'requirements' | 'task', dir: string) => ({ kind, mode: 'auto' as const, depth: 2, shortIds: false, idPatterns: [], speckit: dir });
  it('a story, an FR or SC line and a task get the display ID <folder>/<number>; the same number in two folders is two items', () => {
    const a = extract(read('001-catalog', 'spec.md'), 'spec.md', opts('requirements', '001-catalog'));
    const b = extract(read('002-checkout', 'spec.md'), 'spec.md', opts('requirements', '002-checkout'));
    const ids = (xs: typeof a) => xs.map((x) => x.displayId);
    expect(ids(b)).toEqual(['002-checkout/US1', '002-checkout/US2', '002-checkout/US3', '002-checkout/FR-001', '002-checkout/FR-002', '002-checkout/FR-003', '002-checkout/FR-004', '002-checkout/FR-005', '002-checkout/SC-001', '002-checkout/SC-002']);
    expect(ids(a).filter((x) => ids(b).includes(x))).toEqual([]);
    expect(b.map((x) => x.shape)).toEqual(['heading', 'heading', 'heading', ...Array(7).fill('bullet')]);
    const tasks = extract(read('002-checkout', 'tasks.md'), 'tasks.md', opts('task', '002-checkout'));
    expect(tasks[0]).toMatchObject({ shape: 'check', displayId: '002-checkout/T001', title: 'Loan model in src/shared/models/loan.ts', refs: ['002-checkout/US1'] });
    expect(tasks.length).toBe(10);
  });

  it('a story\'s acceptance criteria are its Given/When/Then lines; an FR line has none', () => {
    const text = read('002-checkout', 'spec.md');
    const items = extract(text, 'spec.md', opts('requirements', '002-checkout'));
    expect(criteriaOf(itemSource(text, items[1].line, items[1].shape), items[1].shape)).toEqual(['Given 빌린 책, When 바코드를 스캔하면, Then 대여가 끝나고 책이 다시 대여 가능이 된다.']);
    expect(criteriaOf(itemSource(text, items[3].line, items[3].shape), items[3].shape)).toEqual([]);
  });

  it('regression: without a feature folder nothing changes (FR bullets, tasks and stories stay what they were)', () => {
    const text = read('002-checkout', 'spec.md');
    expect(extract(text, 'spec.md', { ...opts('requirements', 'x'), speckit: undefined })).toEqual([]);
    const t = extract(read('002-checkout', 'tasks.md'), 'tasks.md', { ...opts('task', 'x'), speckit: undefined });
    expect(t.every((x) => x.displayId === undefined)).toBe(true);
    expect(kitOpt('docs/specs/auth.md')).toEqual({});
    expect(kitOpt('specs/002-checkout/spec.md')).toEqual({ speckit: '002-checkout' });
  });

  it('the files of a feature folder are sorted into kinds; others keep the old rules', () => {
    expect([ 'spec.md', 'tasks.md', 'plan.md', 'research.md', 'data-model.md'].map((f) => classify(`specs/002-checkout/${f}`))).toEqual(['requirements', 'task', 'plan', 'decision', 'requirements']);
    expect(classify('specs/login/plan.md')).toBe('requirements');
    expect(kitOf('specs/002-checkout/spec.md')).toEqual({ dir: '002-checkout', file: 'spec.md' });
    expect(STORY_ID.exec('002-checkout/US2')?.slice(1)).toEqual(['002-checkout', '2']);
  });
});

describe('the block for ?feature=', () => {
  const reads = (dir: string) => ({ spec: readSpec(read(dir, 'spec.md')), tasks: readTasks(read(dir, 'tasks.md')), plan: readPlan(read(dir, 'plan.md')) });

  it('stories with their tasks and files, FR left unlinked to stories, 계획만 folders, and what is not read', () => {
    const k = kitBlock('002-checkout', reads('002-checkout'), codeIndex(CODE), true);
    expect(k.counts).toEqual({ stories: 3, frs: 5, scs: 2, tasks: 10, done: 6, clarify: 0 });
    expect(k.stories.map((s) => [s.id, s.priority, s.tasks, s.done, s.files])).toEqual([['US1', 'P1', 5, 5, 5], ['US2', 'P1', 3, 1, 3], ['US3', 'P3', 2, 0, 2]]);
    expect(k.phases.map((p) => [p.label, p.tasks, p.done])).toEqual([['3', 5, 5], ['4', 3, 1], ['5', 2, 0]]);
    expect(k.planOnly).toEqual(['src/web/components']);
    expect(k.taskList.find((t) => t.id === 'T010')!.files).toEqual([{ path: 'src/web/components/renew.ts', exists: false }]);
    expect(k.taskList.find((t) => t.id === 'T001')!.files).toEqual([{ path: 'src/shared/models/loan.ts', exists: true }]);
    // the sample writes no FR number in a task line, and no template notation links FR to a story
    expect(k.frs.every((f) => !f.tasks)).toBe(true);
    expect(k.notRead).toEqual(['frStory', 'frTask', 'constitution']);
  });

  it('without a code scan nothing is judged to exist', () => {
    const k = kitBlock('002-checkout', reads('002-checkout'), null, false);
    expect(k.planOnly).toEqual([]);
    expect(k.plan.every((p) => p.exists === null)).toBe(true);
  });

  it('the chain\'s side: a story\'s task ids, titles and files', () => {
    const s = storyTasks('002-checkout', reads('002-checkout').tasks, 2);
    expect(s.ids).toEqual(['002-checkout/T006', '002-checkout/T007', '002-checkout/T008']);
    expect(s.files).toEqual(['src/api/loans/return.ts', 'src/web/pages/scan.ts', 'tests/return.test.ts']);
  });

  it('the chain: files a story\'s tasks.md lines write are its 직접 files (only those that exist); negative control: without them nothing links', () => {
    const scan: CodeScan = { files: CODE, edges: [], unresolved: 0, workspaces: [], big: 0, at: '', ms: 0, rssKb: 0, links: { body: {}, names: {}, tags: {}, tasks: {}, commits: [], capped: false } };
    const own = storyTasks('002-checkout', reads('002-checkout').tasks, 1);
    const req = (written?: readonly string[]) => ({ uid: 'u', id: '002-checkout/US1', tasks: own.ids, folders: [], ...(written && { written }) });
    expect(reqLinks(scan, [req(own.files)], 0)!.reqs.get('u')!.paths.direct.size).toBe(5);
    expect(reqLinks(scan, [req()], 0)!.reqs.get('u')!.paths.direct.size).toBe(0);
    expect(reqLinks(scan, [req(['src/web/components/renew.ts'])], 0)!.reqs.get('u')!.paths.direct.size).toBe(0);
  });

  it('masks a secret a line writes', () => {
    const k = kitBlock('001-x', { spec: readSpec('# Feature Specification: X\n- **FR-001**: System MUST use password=hunter2 here\n') }, null, false);
    expect(JSON.stringify(k)).not.toContain('hunter2');
  });
});

// ── through the service: tracked files only, the chain, the numbers, and a project that is not Spec Kit ──

let repo: TempRepo | null = null;
const homes: string[] = [];
afterEach(() => {
  repo?.cleanup();
  repo = null;
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

async function setup(files: Record<string, string>, docs: string[], code: string[]) {
  repo = makeTempRepo();
  for (const [p, t] of Object.entries(files)) repo.write(p, t);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'init']);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-kit-')));
  homes.push(home);
  const project: SpecProject = { name: 'alpha', folder: repo.folder, projectId: 'p_abcdefghij' };
  const clock = { now: Date.now() + SPEC_SETTLE_MS * 2 };
  const scan: CodeScan = { files: code, edges: [], unresolved: 0, workspaces: [], big: 0, at: '2026-11-06T00:00:00.000Z', ms: 1, rssKb: 1, links: { body: {}, names: {}, tags: {}, tasks: {}, commits: [], capped: false } };
  const s = new SpecService({
    home,
    projects: () => [project],
    broadcast: () => undefined,
    run: recording(repo.run).run,
    now: () => clock.now,
    later: () => undefined,
    idle: () => undefined,
    tasks: () => [],
    jobs: () => [],
    specMap: async () => scan,
  });
  expect(await s.enable(project, docs)).toMatchObject({ ok: true });
  const map = async (q: { feature?: string } = {}): Promise<TraceMap> => {
    const r = await s.map(project, q);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  return { map, project };
}

const kitFiles = (dirs = FEATURES) =>
  Object.fromEntries(dirs.flatMap((d) => ['spec.md', 'tasks.md', 'plan.md'].map((f) => [`specs/${d}/${f}`, read(d, f)] as const)));
const kitDocs = (dirs = FEATURES) => dirs.flatMap((d) => ['spec.md', 'tasks.md', 'plan.md'].map((f) => `specs/${d}/${f}`));

describe.skipIf(!GIT_AVAILABLE)('the 지도 on a Spec Kit project, through the service', () => {
  it('three features named by their spec, with the numbers; the chain story → tasks → files is lit from tasks.md', async () => {
    const t = await setup(kitFiles(), kitDocs(), CODE);
    const v = await t.map();
    expect(v.features.map((f) => [f.key, f.rule, f.name, f.kit])).toEqual([
      ['sk:001-catalog', 'speckit', '책 목록과 검색', { stories: 2, frs: 4, scs: 2, tasks: 10, done: 8, clarify: 1 }],
      ['sk:002-checkout', 'speckit', '대여와 반납', { stories: 3, frs: 5, scs: 2, tasks: 10, done: 6, clarify: 0 }],
      ['sk:003-reminders', 'speckit', '반납 알림', { stories: 2, frs: 3, scs: 1, tasks: 5, done: 1, clarify: 0 }],
    ]);
    const sum = (f: (k: NonNullable<(typeof v.features)[number]['kit']>) => number) => v.features.reduce((n, x) => n + f(x.kit!), 0);
    expect([sum((k) => k.stories), sum((k) => k.frs), sum((k) => k.scs), sum((k) => k.done), sum((k) => k.tasks)]).toEqual([7, 12, 5, 15, 25]);
    // stories + FR + SC are the feature's requirements; only the stories reach files (an FR's link to a story is not written)
    expect(v.features.map((f) => [f.reqs, f.linked])).toEqual([[8, 2], [10, 2], [6, 1]]);
    const d = (await t.map({ feature: 'sk:002-checkout' })).feature!;
    expect(d.name).toBe('대여와 반납');
    expect(d.chain).toMatchObject({ reqs: 10, tasks: 10, files: 6 });
    expect(d.tasks.map((x) => x.id).slice(0, 2)).toEqual(['002-checkout/T001', '002-checkout/T002']);
    expect(d.tasks[0].title).toBe('Loan model in src/shared/models/loan.ts');
    const us1 = d.reqs.find((r) => r.label === '002-checkout/US1')!;
    expect(us1.paths!.direct!.n).toBe(5);
    expect(us1.paths!.direct!.files).toEqual(['src/api/loans/checkout.ts', 'src/db/loans.ts', 'src/shared/models/loan.ts']);
    expect(d.kit!.planOnly).toEqual(['src/web/components']);
    expect(d.kit!.notRead).toEqual(['frStory', 'frTask']);
  });

  it('only tracked documents are read: leave plan.md and tasks.md untracked and their parts are missing, not guessed', async () => {
    const t = await setup(kitFiles(['002-checkout']), ['specs/002-checkout/spec.md'], CODE);
    const d = (await t.map({ feature: 'sk:002-checkout' })).feature!;
    expect(d.kit!.read).toEqual(['spec']);
    expect(d.kit!.counts).toMatchObject({ stories: 3, tasks: 0 });
    expect(d.kit!.plan).toEqual([]);
    expect(d.chain.tasks).toBe(0);
  });

  it('regression: a project that is not Spec Kit gets no kit anywhere, and the same features as before', async () => {
    const SRS = '# SRS\n\n### 3.1 지도(MAP)\n\n| ID | 요구 |\n|---|---|\n| FR-MAP-001 | a |\n| FR-MAP-002 | b |\n';
    const t = await setup({ 'docs/requirements/SRS.md': SRS, 'docs/specs/auth.md': '# Auth\n\n- **FR-001**: a bullet that is not Spec Kit\n- [ ] T001 a task that is not Spec Kit\n' }, ['docs/requirements/SRS.md', 'docs/specs/auth.md'], ['a.ts']);
    const v = await t.map();
    expect(v.features.map((f) => [f.key, f.reqs, 'kit' in f])).toEqual([['FR-MAP', 2, false]]);
    expect((await t.map({ feature: 'FR-MAP' })).feature).not.toHaveProperty('kit');
  });
});

describe('RQ4: a feature written the way the spec workflow rules ask', () => {
  const ENGINE = path.join(__dirname, '__fixtures__', 'engine-path', 'specs', '004-loan-renewal');
  const own = (file: string) => fs.readFileSync(path.join(ENGINE, file), 'utf-8');

  it('reads whole: stories, FR, SC, the plan, and each task names its FR, so frTask is no longer not read', () => {
    const reads = { spec: readSpec(own('spec.md')), tasks: readTasks(own('tasks.md')), plan: readPlan(own('plan.md')) };
    const k = kitBlock('004-loan-renewal', reads, null, false);
    expect(k.counts).toEqual({ stories: 2, frs: 4, scs: 1, tasks: 4, done: 2, clarify: 1 });
    expect(k.frs.map((f) => [f.id, f.tasks])).toEqual([
      ['FR-001', ['T002']],
      ['FR-002', ['T001', 'T002', 'T003']],
      ['FR-003', ['T004']],
      ['FR-004', undefined],
    ]);
    expect(k.notRead).not.toContain('frTask');
    expect(k.notRead).toEqual(['frStory']); // the template writes no FR → story link: still not read, never guessed
    expect(reads.plan.context).toMatchObject({ 'Language/Version': 'TypeScript 5.9', Testing: 'vitest' });
    expect(reads.plan.paths.map((p) => p.path)).toEqual(['src/', 'src/api/', 'src/api/loans/', 'src/api/loans/renew.ts', 'src/db/', 'src/db/loans.ts']);
    // the same folder without the rules' habit (no FR in a task line) is the template's gap again
    const bare = readTasks(own('tasks.md').replace(/ FR-\d{3}/g, ''));
    expect(kitBlock('004-loan-renewal', { ...reads, tasks: bare }, null, false).notRead).toContain('frTask');
  });
});
