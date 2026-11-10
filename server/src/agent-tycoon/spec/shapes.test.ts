import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { TraceItem } from '../../../../core/src/agent-tycoon/spec/trace.js';
import { SPEC_SCAN_MIN_MS, SPEC_SETTLE_MS } from '../../constants.js';
import { GIT_AVAILABLE, makeTempRepo, type TempRepo } from '../engine/git/testRepo.js';
import { classify, preselected, walkDocs } from './discover.js';
import { criteriaOf, extract, type Extracted, itemSource, verifyOf } from './extract.js';
import { type SpecProject, SpecService } from './service.js';
import { adrStatus, kiroReq, openspecOps, readKiroTasks, shapeOf, shapeOpt } from './shapes.js';
import { kitOf, kitOpt } from './speckit.js';
import { type FeatureReq, featuresOf } from './structure.js';

const FIX = path.join(__dirname, '__fixtures__');

interface Doc {
  path: string;
  text: string;
  kind: ReturnType<typeof classify>;
  items: Extracted[];
}
/** The way the service reads a folder: walk, classify by name and head, extract with the path's own shape. */
function readFolder(name: string): Doc[] {
  const root = path.join(FIX, name);
  return walkDocs(root, true).files.map((f) => {
    const text = fs.readFileSync(path.join(root, f.path), 'utf-8');
    const kind = classify(f.path, text);
    const items = extract(text, path.basename(f.path), { kind, mode: 'auto', depth: 2, shortIds: false, idPatterns: [], ...kitOpt(f.path), ...shapeOpt(f.path) });
    return { path: f.path, text, kind, items };
  });
}
const doc = (docs: Doc[], p: string) => docs.find((d) => d.path === p)!;
const brief = (d: Doc) => d.items.map((i) => [i.shape, i.displayId ?? null, i.title]);
const reqsOf = (docs: Doc[]): FeatureReq[] =>
  docs
    .filter((d) => d.kind === 'requirements')
    .flatMap((d) => d.items.map((i, n) => ({ uid: `${d.path}#${n}`, id: i.displayId ?? '', doc: d.path, path: d.path, section: i.section, line: i.line, changed: false, progress: false, blocked: false })));

describe('OpenSpec (openspec-mini)', () => {
  const docs = readFolder('openspec-mini');

  it('is told by its folders: capability specs and a change in progress are requirements, the archive is a record', () => {
    expect(docs.map((d) => [d.path, d.kind])).toEqual([
      ['docs/notes.md', 'other'],
      ['openspec/changes/add-2fa/proposal.md', 'other'],
      ['openspec/changes/add-2fa/specs/auth/spec.md', 'requirements'],
      ['openspec/changes/add-2fa/tasks.md', 'task'],
      ['openspec/changes/archive/2025-01-24-old-login/specs/auth/spec.md', 'log'],
      ['openspec/specs/auth/spec.md', 'requirements'],
      ['openspec/specs/billing/spec.md', 'requirements'],
    ]);
    expect(preselected('log', 'committed')).toBe(false); // the archive is not ticked by default
    expect(shapeOf('openspec/changes/archive/x/specs/a/spec.md')).toBeNull();
  });

  it('reads the requirement names as titles and each Scenario as one acceptance criterion', () => {
    const auth = doc(docs, 'openspec/specs/auth/spec.md');
    expect(brief(auth)).toEqual([
      ['reqhead', null, 'User Authentication'],
      ['reqhead', null, 'Session Expiry'],
    ]);
    const crit = auth.items.map((i) => criteriaOf(itemSource(auth.text, i.line, i.shape), i.shape));
    expect(crit.map((c) => c.length)).toEqual([2, 1]);
    expect(crit[0][0]).toContain('Valid credentials');
    expect(crit[0][0]).toContain('a JWT token is returned');
    expect(doc(docs, 'openspec/specs/billing/spec.md').items).toHaveLength(1);
  });

  it('a change: tasks.md checkboxes are tasks; delta requirements are ADDED / MODIFIED / REMOVED and nothing else', () => {
    const tasks = doc(docs, 'openspec/changes/add-2fa/tasks.md');
    expect(tasks.items.map((i) => i.shape)).toEqual(['check', 'check', 'check', 'check']);
    const delta = doc(docs, 'openspec/changes/add-2fa/specs/auth/spec.md');
    expect(brief(delta).map((b) => b[2])).toEqual(['Two-Factor Authentication', 'Session Expiry', 'Remember Me']);
    expect([...openspecOps(delta.text).values()]).toEqual(['added', 'modified', 'removed']);
  });

  it('features: one per capability, one per change in progress (tagged changing); the archive adds none', () => {
    const { features, common } = featuresOf(reqsOf(docs));
    expect(common).toEqual([]);
    expect(features.map((f) => [f.key, f.rule, f.reqs, f.changing ?? false]).sort()).toEqual([
      ['os:auth', 'openspec', 2, false],
      ['os:billing', 'openspec', 1, false],
      ['osc:add-2fa', 'openspec', 3, true],
    ]);
  });

  it('negative: the same headings outside the folders stay what they were (plain headings, no tag, no id, no feature rule)', () => {
    const notes = doc(docs, 'docs/notes.md');
    expect(shapeOf(notes.path)).toBeNull();
    expect(brief(notes)).toEqual([
      ['reqhead', null, 'Requirement: Looks like OpenSpec but sits in no OpenSpec folder'],
      ['reqhead', null, 'Requirement: Also not a delta'],
    ]);
    expect(notes.items.flatMap((i) => i.refs)).toEqual([]); // PERM-PROMPT is a tag, not an id
    expect(openspecOps('## ADDED Requirements\n### Requirement: x\n').size).toBe(1); // the reader alone would; only the folder lets the service ask
    expect([...openspecOps(doc(docs, 'openspec/changes/add-2fa/specs/auth/spec.md').text.replace('## REMOVED Requirements', '## RENAMED Requirements')).values()]).toEqual(['added', 'modified']);
  });
});

describe('Kiro (kiro-mini)', () => {
  const docs = readFolder('kiro-mini');
  const req = doc(docs, '.kiro/specs/login/requirements.md');
  const tasks = doc(docs, '.kiro/specs/login/tasks.md');

  it('is told by its folder; a numbered feature folder is Kiro here, not Spec Kit', () => {
    expect(docs.map((d) => [d.path, d.kind])).toEqual([
      ['.kiro/specs/001-search/requirements.md', 'requirements'],
      ['.kiro/specs/login/design.md', 'design'],
      ['.kiro/specs/login/requirements.md', 'requirements'],
      ['.kiro/specs/login/tasks.md', 'task'],
      ['docs/notes.md', 'other'],
    ]);
    expect(kitOf('.kiro/specs/001-search/tasks.md')).toBeNull();
    expect(kitOf('specs/001-search/tasks.md')).not.toBeNull();
  });

  it('requirements: `<feature>/R<n>`, the name after a colon as the title, EARS lines as acceptance criteria', () => {
    expect(brief(req)).toEqual([
      ['reqhead', 'login/R1', 'Requirement 1'],
      ['reqhead', 'login/R2', 'Reset the password'],
      ['reqhead', 'login/R3', 'Requirement 3'],
    ]);
    const crit = req.items.map((i) => criteriaOf(itemSource(req.text, i.line, i.shape), i.shape));
    expect(crit.map((c) => c.length)).toEqual([3, 2, 1]);
    expect(crit[0][1]).toBe('WHEN a member submits a wrong password five times THEN the system SHALL lock the account for 15 minutes');
    expect(brief(doc(docs, '.kiro/specs/001-search/requirements.md'))).toEqual([['reqhead', '001-search/R1', 'Requirement 1']]);
  });

  it('tasks: the numbered checkboxes are tasks, `_Requirements: 1.1, 1.3_` below one makes them references (written, not guessed)', () => {
    const refs = tasks.items.map((i) => [i.title, i.refs]);
    expect(refs).toEqual([
      ['1. Set up the auth module', ['login/R1']],
      ['2. Implement sign-in', []],
      ['2.1 Verify credentials and create the session', ['login/R1']],
      ['2.2 Lock the account after repeated failures', ['login/R1']],
      ['3. Implement the password reset', []],
      ['3.2 Send the reset mail', ['login/R2']],
      ['4. Failed sign-in list', ['login/R3']],
      ['4.1 Wire the list into the staff screen', []],
      ['5. Hand over', []],
    ]);
    const read = readKiroTasks(tasks.text);
    expect(read.find((t) => t.id === '3.1')).toMatchObject({ done: false, reqs: [{ req: 2, criterion: 1 }, { req: 2, criterion: 2 }] });
    expect(read.filter((t) => t.done).map((t) => t.id)).toEqual(['1', '2.1']);
  });

  it('features: one per Kiro folder, ids are not a prefix family', () => {
    const { features } = featuresOf(reqsOf(docs));
    expect(features.map((f) => [f.key, f.rule, f.reqs]).sort()).toEqual([
      ['kiro:001-search', 'kiro', 1],
      ['kiro:login', 'kiro', 3],
    ]);
  });

  it('negative: `### Requirement 3` and a `_Requirements:` line outside a Kiro folder stay as today; a line not indented under its task, or not numbers, is not read', () => {
    const notes = doc(docs, 'docs/notes.md');
    expect(brief(notes)).toEqual([['reqhead', null, 'Requirement 3']]);
    expect(notes.items.flatMap((i) => i.refs)).toEqual([]);
    expect(kiroReq('Requirement three')).toBeNull();
    expect(kiroReq('Requirements 4: Many')).toEqual({ n: 4, name: 'Many' });
    expect(readKiroTasks('- [ ] 1. A\n_Requirements: 1.1_\n- [ ] 2. B\n  - _Requirements: x.1_\n  - _requirements: 1.1 and more_\n')).toMatchObject([{ reqs: [] }, { reqs: [] }]);
  });
});

describe('ADR (adr-mini)', () => {
  const docs = readFolder('adr-mini');
  const status = Object.fromEntries(docs.map((d) => [path.basename(d.path), d.kind === 'decision' ? adrStatus(d.text) : 'not a decision']));

  it('every file under an ADR folder is a decision; its status is the one word the file says', () => {
    expect(status).toEqual({
      '0001-use-postgres.md': 'accepted', // Nygard `## Status`
      '0002-use-queue.md': 'superseded', // MADR front matter, `superseded by ADR-0004`
      '0003-proposal.md': 'proposed', // front matter
      '0004-deprecated.md': 'deprecated',
      '0005-madr-template.md': undefined, // the unfilled template placeholder is not a status
      '0006-rejected.md': undefined, // a word outside the four is not guessed
      '0007-no-status.md': undefined,
      '0008-madr2.md': 'accepted', // MADR 2 `* Status: accepted`
      'decisions.md': undefined,
    });
  });

  it('a decision stays out of the requirements: it is a decision kind, and the front-matter one is the only item', () => {
    expect(docs.every((d) => d.kind === 'decision')).toBe(true);
    expect(brief(doc(docs, 'docs/adr/0003-proposal.md'))).toEqual([['heading', 'ADR-0003', 'Use feature flags']]);
    expect(featuresOf(reqsOf(docs))).toEqual({ features: [], common: [] });
  });

  it('negative: a status word inside a code block, or in a random line later in a document, is not read', () => {
    expect(adrStatus('# x\n\n```\nStatus: accepted\n```\n')).toBeUndefined();
    expect(adrStatus(`# x\n${'\n'.repeat(50)}Status: accepted\n`)).toBeUndefined();
    expect(adrStatus('---\nstatus: Accepted (amended 2025-05-01)\n---\n')).toBe('accepted');
    expect(adrStatus('# x\n\n## Status\n\n제안됨\n')).toBe('proposed');
  });

  it('the folder rule: adr, adrs, decisions, docs-adr; a plain doc with a number in its name is not a decision', () => {
    for (const p of ['adr/0001-a.md', 'docs/adrs/0002-b.md', 'docs/decisions/0003-c.md', 'docs/architecture-decisions/0004-d.md', 'docs-adr/0005-e.md']) expect(classify(p)).toBe('decision');
    expect(classify('docs/0001-a.md')).not.toBe('decision');
    expect(classify('docs/madrid/0001-a.md')).not.toBe('decision');
  });
});

describe('SRS 검증 column (srs-mini)', () => {
  const [srs] = readFolder('srs-mini');
  const block = (i: Extracted) => itemSource(srs.text, i.line, i.shape);

  it('is the way to check (확인 방법), one entry per <br>, and no longer an acceptance criterion', () => {
    expect(srs.items.map((i) => i.displayId)).toEqual(['FR-OFC-001', 'FR-OFC-002', 'FR-OFC-003', 'FR-ACC-001']);
    expect(srs.items.map((i) => verifyOf(block(i), i.shape))).toEqual([['시험 office.test.ts', '화면 사진'], ['계측'], [], []]);
    expect(srs.items.map((i) => criteriaOf(block(i), i.shape).length)).toEqual([0, 0, 0, 2]);
  });

  it('negative: a column that only looks like it (검증 결과) is neither; an 인수 기준 column is still the criteria', () => {
    const acc = srs.items[3];
    expect(verifyOf(block(acc), acc.shape)).toEqual([]);
    expect(criteriaOf(block(acc), acc.shape)).toEqual(['단추를 누르면 수락됨', '다시 누르면 취소됨']);
  });
});

describe.skipIf(!GIT_AVAILABLE)('the item detail carries what the shape adds', () => {
  let repo: TempRepo | null = null;
  let home = '';
  afterEach(() => {
    repo?.cleanup();
    repo = null;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('verify (SRS), changing (OpenSpec delta), decision (ADR status); a Kiro requirement has its `<feature>/R<n>` ID', async () => {
    repo = makeTempRepo();
    const files = {
      'docs/requirements/SRS.md': 'srs-mini/SRS.md',
      'openspec/changes/add-2fa/specs/auth/spec.md': 'openspec-mini/openspec/changes/add-2fa/specs/auth/spec.md',
      'docs/adr/0003-proposal.md': 'adr-mini/docs/adr/0003-proposal.md',
      '.kiro/specs/login/requirements.md': 'kiro-mini/.kiro/specs/login/requirements.md',
    };
    for (const [to, from] of Object.entries(files)) repo.write(to, fs.readFileSync(path.join(FIX, from), 'utf-8'));
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'docs: shapes']);
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-shapes-')));
    const project: SpecProject = { name: 'alpha', folder: repo.folder, projectId: 'p_abcdefghij' };
    const clock = Date.now() + SPEC_SETTLE_MS * 2 + SPEC_SCAN_MIN_MS;
    const s = new SpecService({ home, projects: () => [project], broadcast: () => undefined, run: repo.run, now: () => clock, later: () => undefined, idle: () => undefined, tasks: () => [], jobs: () => [] });
    expect(await s.enable(project, Object.keys(files))).toMatchObject({ ok: true });
    const list = (await s.items(project, {})) as { ok: true; value: { items: Array<{ uid: string; displayId?: string; title?: string; path?: string }> } };
    const detail = async (u: string): Promise<TraceItem> => {
      const r = await s.item(project, u);
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    const byId = (id: string) => list.value.items.find((i) => i.displayId === id)!;
    const srs = await detail(byId('FR-OFC-001').uid);
    expect(srs.verify).toEqual(['시험 office.test.ts', '화면 사진']);
    expect(srs.criteria).toBeUndefined();
    const adr = await detail(byId('ADR-0003').uid);
    expect(adr.decision).toBe('proposed');
    expect(adr.verify).toBeUndefined();
    expect(byId('login/R2')).toBeDefined();
    const delta = list.value.items.filter((i) => i.title === 'Session Expiry' || i.title === 'Remember Me');
    expect(delta).toHaveLength(2);
    expect((await Promise.all(delta.map((i) => detail(i.uid)))).map((d) => d.changing).sort()).toEqual(['modified', 'removed']);
  });
});
