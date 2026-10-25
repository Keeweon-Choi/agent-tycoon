import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { GIT_AVAILABLE, makeTempRepo } from './engine/git/testRepo.js';
import { engineJobsOutput, localStatusReport } from './statusReport.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const remove of cleanup.splice(0)) remove();
});

describe.skipIf(!GIT_AVAILABLE)('localStatusReport', () => {
  it('W2 (8): its git runs no code of the repository’s (a clean filter, an fsmonitor, a hook), still counts the change', async () => {
    const repo = makeTempRepo();
    cleanup.push(repo.cleanup);
    const marks = path.join(repo.root, 'marks');
    fs.mkdirSync(marks);
    repo.write('.gitattributes', '*.txt filter=e\n');
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'attr']);
    repo.git(['config', 'filter.e.clean', `sh -c 'touch "${marks}/clean"; cat'`]);
    const fsmon = path.join(repo.root, 'fsmon.sh');
    fs.writeFileSync(fsmon, `#!/bin/sh\ntouch "${marks}/fsmonitor"\nexit 1\n`, { mode: 0o755 });
    repo.git(['config', 'core.fsmonitor', fsmon]);
    repo.write('a.txt', 'two\n'); // same size, so status must clean it to compare
    const report = await localStatusReport('alpha', repo.folder, '');
    expect(report.git?.dirty).toBe(1);
    expect(fs.readdirSync(marks)).toEqual([]);
    // armed: plain git runs it
    repo.git(['status', '--porcelain']);
    expect(fs.readdirSync(marks).sort()).toEqual(['clean', 'fsmonitor']);
  });

  it('reads a project git summary and leaves a non-git folder without one', async () => {
    const repo = makeTempRepo();
    cleanup.push(repo.cleanup);
    repo.write('second.txt', 'two\n');
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'second']);
    fs.writeFileSync(path.join(repo.folder, 'untracked.txt'), 'dirty\n');

    const report = await localStatusReport('alpha', repo.folder, '');
    expect(report).toMatchObject({
      name: 'alpha',
      cmd: null,
      isDefault: true,
      exit: 0,
      output: '',
      truncated: false,
      git: { branch: 'main', dirty: 1 },
    });
    expect(report.git?.recent.slice(0, 2).map((commit) => commit.subject)).toEqual([
      'second',
      'init',
    ]);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-status-'));
    cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    expect((await localStatusReport('plain', dir, '')).git).toBeNull();
  });
});

describe('engineJobsOutput', () => {
  it('uses the project jobs newest first, or the empty-state text', () => {
    expect(engineJobsOutput('alpha', [])).toBe('돌고 있는 작업 없음');
    expect(
      engineJobsOutput('alpha', [
        {
          project: 'other',
          cmd: 'ignored',
          started: '2026-10-22T08:00:00.000Z',
          ended: null,
          exit: null,
        },
        {
          project: 'alpha',
          cmd: 'npm test',
          started: '2026-10-22T09:45:00.000Z',
          ended: null,
          exit: null,
        },
        {
          project: 'alpha',
          cmd: 'npm run build',
          started: '2026-10-22T08:30:00.000Z',
          ended: '2026-10-22T08:35:00.000Z',
          exit: 0,
        },
      ]),
    ).toMatch(/^running npm test \(\d{2}:\d{2}\)\ndone npm run build \(\d{2}:\d{2}\)$/);
  });
});
