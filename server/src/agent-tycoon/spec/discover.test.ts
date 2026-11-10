import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { SPEC_WALK_FILES_MAX } from '../../constants.js';
import { GIT_AVAILABLE, makeTempRepo, type TempRepo } from '../engine/git/testRepo.js';
import { blobOf, classify, preselected, readGitView, readRecentCommits, walkDocs } from './discover.js';

let repo: TempRepo | null = null;
afterEach(() => {
  repo?.cleanup();
  repo = null;
});

describe('classify', () => {
  it.each([
    ['agent-tycoon/docs/requirements/SRS.md', 'requirements'],
    ['PRD.md', 'requirements'],
    ['docs/PRODUCT_ROADMAP.md', 'requirements'],
    ['specs/login/spec.md', 'requirements'],
    ['agent-tycoon/docs/design/spec-tracking.md', 'design'],
    ['ARCHITECTURE.md', 'design'],
    ['agent-tycoon/docs/adr/0019-spec-identity-sidecar.md', 'decision'],
    ['DECISIONS.md', 'decision'],
    ['agent-tycoon/docs/test/test-plan.md', 'test'],
    ['TEST_PLAN.md', 'test'],
    ['agent-tycoon/tasks/T-0050-x.md', 'task'],
    ['specs/login/tasks.md', 'task'],
    ['TODO.md', 'plan'],
    ['ROADMAP.md', 'plan'],
    ['HANDOFF.md', 'log'],
    ['agent-tycoon/docs/CHANGELOG.md', 'log'],
    ['agent-tycoon/docs/research/spec-tracking-identity-2026-11-03.md', 'log'],
    ['README.md', 'other'],
  ])('%s is %s', (rel, kind) => expect(classify(rel)).toBe(kind));

  it('ticks every kind but other and log, and nothing git ignores', () => {
    expect(preselected('requirements', 'untracked')).toBe(true);
    expect(preselected('requirements', 'ignored')).toBe(false);
    expect(preselected('log', 'committed')).toBe(false);
    expect(preselected('other', 'committed')).toBe(false);
  });
});

describe('walkDocs', () => {
  const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-spec-walk-')));
  const put = (root: string, rel: string, text = 'x') => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };

  it('finds Markdown files, never under skipped, protected or linked folders, never a link', () => {
    const root = tmp();
    for (const rel of ['a.md', 'docs/b.MD', 'docs/c.txt', 'node_modules/x/README.md', '.git/x.md', '.worktrees/t/a.md', 'venv/lib/a.md', 'datasets/d.md', '.claude/plan.md', 'dist/a.md'])
      put(root, rel);
    put(root, 'big.md', 'x'.repeat(2 * 1024 * 1024 + 1));
    fs.symlinkSync(path.join(root, 'a.md'), path.join(root, 'link.md'));
    fs.symlinkSync(path.join(root, 'docs'), path.join(root, 'linked'));
    expect(walkDocs(root, true).files.map((f) => f.path)).toEqual(['a.md', 'docs/b.MD']);
    // Names only: no lstat, so the size cap is not seen.
    expect(walkDocs(root, false).files.map((f) => f.path)).toEqual(['a.md', 'big.md', 'docs/b.MD']);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('stops at the depth and file caps', () => {
    const root = tmp();
    put(root, '1/2/3/4/5/6/7/deep.md');
    put(root, '1/2/3/4/5/6/ok.md');
    expect(walkDocs(root, false).files.map((f) => f.path)).toEqual(['1/2/3/4/5/6/ok.md']);
    for (let i = 0; i <= SPEC_WALK_FILES_MAX; i++) put(root, `many/${i}.md`);
    const r = walkDocs(root, false);
    expect([r.files.length, r.capped]).toEqual([SPEC_WALK_FILES_MAX, true]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe.skipIf(!GIT_AVAILABLE)('git as evidence', () => {
  it('committed, modified, untracked and ignored, from a project folder inside the repository', async () => {
    repo = makeTempRepo();
    repo.write('proj/.gitignore', 'secret.md\n');
    repo.write('proj/docs/SRS.md', '# SRS\n');
    repo.write('proj/docs/design.md', '# D\n');
    repo.write('proj/secret.md', 'token\n');
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'docs']);
    repo.write('proj/docs/design.md', '# D2\n');
    repo.write('proj/docs/new plan.md', '# new\n');
    const folder = path.join(repo.folder, 'proj');
    const v = await readGitView(repo.run, folder);
    expect(v.repo).toBe(true);
    expect(v.branch).toBe('main');
    expect(['docs/SRS.md', 'docs/design.md', 'docs/new plan.md', 'secret.md', 'gone.md'].map(v.stateOf)).toEqual([
      'committed', 'modified', 'untracked', 'ignored', 'ignored',
    ]);
    // The blob id is git's own for a committed file.
    const blob = repo.git(['rev-parse', 'HEAD:proj/docs/SRS.md']).trim();
    expect(blobOf(fs.readFileSync(path.join(folder, 'docs/SRS.md')))).toBe(blob);
    const commits = await readRecentCommits(repo.run, folder, 20);
    expect(commits.map((c) => c.subject)).toEqual(['docs', 'init']);
    expect(commits[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('a folder that is no repository is not-git', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-spec-nogit-')));
    repo = makeTempRepo({ commit: false });
    const v = await readGitView(repo.run, root);
    expect([v.repo, v.stateOf('a.md')]).toEqual([false, 'not-git']);
    expect(await readRecentCommits(repo.run, root, 5)).toEqual([]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
