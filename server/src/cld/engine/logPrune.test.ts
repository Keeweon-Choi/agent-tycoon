import * as fs from 'fs';
import { createRequire } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../testHome.js';
import { codexDir } from './codex.js';
import { jobsDir } from './jobs.js';
import {
  EVENTS_ROTATE_BYTES,
  LOG_DIR_CAP_BYTES,
  LOG_KEEP_DAYS,
  LOG_PRUNE_INTERVAL_MS,
} from './logPolicy.js';
import { plainFileSize, pruneLogs } from './logPrune.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-24T12:00:00+09:00');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

function rig() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-prune-'));
  homes.push(home);
  const jobs = jobsDir(home);
  const codex = codexDir(home);
  fs.mkdirSync(jobs, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  const logs: string[] = [];
  const run = (extra: Parameters<typeof pruneLogs>[0] extends infer O ? Partial<O> : never = {}) =>
    pruneLogs({ home, now: NOW, log: (l) => logs.push(l), ...extra });
  /** A job: record (ended = days ago, or running), log of `size` bytes. */
  const job = (id: string, endedDaysAgo: number | null, size = 10) => {
    fs.writeFileSync(
      path.join(jobs, `${id}.json`),
      JSON.stringify({ id, pid: null, log: path.join(jobs, `${id}.log`), ended: endedDaysAgo === null ? null : ago(endedDaysAgo) }),
    );
    fs.writeFileSync(path.join(jobs, `${id}.log`), 'x'.repeat(size));
  };
  const task = (id: string, state: string, endedDaysAgo: number | null, size = 10) => {
    fs.writeFileSync(
      path.join(codex, `${id}.json`),
      JSON.stringify({ id, state, dir: '/w', ended: endedDaysAgo === null ? null : ago(endedDaysAgo) }),
    );
    fs.writeFileSync(path.join(codex, `${id}.jsonl`), 'x'.repeat(size));
  };
  const has = (dir: string, name: string) => fs.existsSync(path.join(dir, name));
  return { home, jobs, codex, logs, run, job, task, has };
}

describe('log pruning (U-42)', () => {
  it('removes finished logs older than 30 days with their record, keeps recent, running and unknown files', () => {
    const r = rig();
    r.job('1001-000001-old', 31);
    r.job('1001-000002-new', 29);
    r.job('1001-000003-run', null);
    r.job('1001-000004-runold', null);
    fs.writeFileSync(path.join(r.jobs, '1001-000001-old.exit'), '0'); // goes with its job
    fs.writeFileSync(path.join(r.jobs, 'gate-last.log'), 'not a job log');
    fs.writeFileSync(path.join(r.jobs, '1001-000009-norecord.log'), 'no record');
    fs.writeFileSync(path.join(r.jobs, 'notes.txt'), 'x');
    const out = r.run();
    expect(out.jobs.count).toBe(1);
    expect(out.jobs.bytes).toBe(10);
    expect(r.has(r.jobs, '1001-000001-old.log')).toBe(false);
    expect(r.has(r.jobs, '1001-000001-old.json')).toBe(false);
    expect(r.has(r.jobs, '1001-000001-old.exit')).toBe(false);
    for (const keep of [
      '1001-000002-new.log',
      '1001-000002-new.json',
      '1001-000003-run.log',
      '1001-000004-runold.log',
      'gate-last.log',
      '1001-000009-norecord.log',
      'notes.txt',
    ])
      expect(r.has(r.jobs, keep), keep).toBe(true);
    expect(r.logs.at(-1)).toMatch(/log prune: jobs 1 \(0\.0 MB\), codex 0 \(0\.0 MB\) removed/);
  });

  it('prunes finished Codex tasks only (running and limit stay), keeping the same rule', () => {
    const r = rig();
    r.task('1001-000001-a', 'done', 40);
    r.task('1001-000002-b', 'failed', 31);
    r.task('1001-000003-c', 'limit', 90); // waiting for a reset: resumes later
    r.task('1001-000004-d', 'running', 90);
    r.task('1001-000005-e', 'done', 1);
    const out = r.run();
    expect(out.codex.count).toBe(2);
    expect(r.has(r.codex, '1001-000001-a.jsonl')).toBe(false);
    expect(r.has(r.codex, '1001-000002-b.jsonl')).toBe(false);
    for (const keep of ['1001-000003-c', '1001-000004-d', '1001-000005-e'])
      expect([r.has(r.codex, `${keep}.json`), r.has(r.codex, `${keep}.jsonl`)]).toEqual([true, true]);
  });

  it('D5: a finished Codex Worker run takes its prompt, last message and told mark along; a recent one keeps them', () => {
    const r = rig();
    const sidecars = ['prompt.md', 'last.md', 'told'];
    for (const [id, days] of [['1001-000001-w', 40], ['1001-000002-w', 2]] as const) {
      r.task(id, 'done', days);
      for (const ext of sidecars) fs.writeFileSync(path.join(r.codex, `${id}.${ext}`), 'x');
    }
    expect(r.run().codex.count).toBe(1);
    for (const ext of ['json', 'jsonl', ...sidecars]) {
      expect(r.has(r.codex, `1001-000001-w.${ext}`), ext).toBe(false);
      expect(r.has(r.codex, `1001-000002-w.${ext}`), ext).toBe(true);
    }
  });

  it('over the cap, removes the oldest finished logs first (log only) until under', () => {
    const r = rig();
    r.job('1001-000001-a', 20, 100);
    r.job('1001-000002-b', 10, 100);
    r.job('1001-000003-c', 5, 100);
    r.job('1001-000004-run', null, 400); // running logs count toward the size, never go
    const total = fs.readdirSync(r.jobs).reduce((n, f) => n + fs.statSync(path.join(r.jobs, f)).size, 0);
    // 150 bytes over the cap: the two oldest (100 each) go, c stays
    const out = r.run({ capBytes: total - 150 });
    expect(out.jobs.count).toBe(2);
    expect(r.has(r.jobs, '1001-000003-c.log')).toBe(true);
    expect(r.has(r.jobs, '1001-000002-b.log')).toBe(false);
    expect(r.has(r.jobs, '1001-000001-a.log')).toBe(false);
    expect(r.has(r.jobs, '1001-000001-a.json')).toBe(true);
    expect(r.has(r.jobs, '1001-000004-run.log')).toBe(true);
    // however small the cap, nothing running or unknown goes
    r.run({ capBytes: 1 });
    expect(r.has(r.jobs, '1001-000004-run.log')).toBe(true);
    expect(r.has(r.jobs, '1001-000003-c.log')).toBe(false);
  });

  it('a failing unlink is logged and skipped, the rest still go', () => {
    const r = rig();
    r.job('1001-000001-a', 40);
    r.job('1001-000002-b', 40);
    const out = r.run({
      unlink: (f) => {
        if (f.endsWith('-a.log')) throw new Error('EACCES');
        fs.unlinkSync(f);
      },
    });
    expect(out.jobs.count).toBe(1);
    expect(r.has(r.jobs, '1001-000001-a.log')).toBe(true);
    expect(r.has(r.jobs, '1001-000001-a.json')).toBe(true); // retried next time
    expect(r.has(r.jobs, '1001-000002-b.log')).toBe(false);
    expect(r.logs.some((l) => l.includes('1001-000001-a.log') && l.includes('EACCES'))).toBe(true);
  });

  it('follows no symlink out of the folder and refuses a record whose name is not an id', () => {
    const r = rig();
    const outside = path.join(r.home, 'precious.txt');
    fs.writeFileSync(outside, 'keep me');
    r.job('1001-000001-link', 40);
    fs.rmSync(path.join(r.jobs, '1001-000001-link.log'));
    fs.symlinkSync(outside, path.join(r.jobs, '1001-000001-link.log'));
    // a record named like a path, and one whose id disagrees with its file name
    fs.writeFileSync(path.join(r.jobs, '..%2f.json'), JSON.stringify({ id: '..', ended: ago(99) }));
    fs.writeFileSync(
      path.join(r.jobs, '1001-000002-liar.json'),
      JSON.stringify({ id: '1001-000003-other', ended: ago(99) }),
    );
    fs.writeFileSync(path.join(r.jobs, '1001-000002-liar.log'), 'x');
    r.run();
    expect(fs.readFileSync(outside, 'utf-8')).toBe('keep me');
    expect(fs.lstatSync(path.join(r.jobs, '1001-000001-link.log')).isSymbolicLink()).toBe(true);
    expect(r.has(r.jobs, '1001-000002-liar.log')).toBe(true);
  });

  it('never trusts a record\'s log field: an absolute or ../ path outside is left alone', () => {
    const r = rig();
    const abs = path.join(r.home, 'abs-target.txt');
    const rel = path.join(r.home, 'rel-target.txt');
    fs.writeFileSync(abs, 'abs');
    fs.writeFileSync(rel, 'rel');
    for (const [id, log] of [
      ['1001-000001-abs', abs],
      ['1001-000002-rel', path.join(r.jobs, '..', '..', '..', '..', 'rel-target.txt')],
    ] as const) {
      fs.writeFileSync(
        path.join(r.jobs, `${id}.json`),
        JSON.stringify({ id, pid: null, log, ended: ago(99) }),
      );
      fs.writeFileSync(path.join(r.jobs, `${id}.log`), 'x');
    }
    expect(path.resolve(r.jobs, '..', '..', '..', '..', 'rel-target.txt')).toBe(rel);
    // the same for a Codex task, whose record also names a log
    fs.writeFileSync(
      path.join(r.codex, '1001-000003-cx.json'),
      JSON.stringify({ id: '1001-000003-cx', state: 'done', dir: '/w', log: abs, ended: ago(99) }),
    );
    fs.writeFileSync(path.join(r.codex, '1001-000003-cx.jsonl'), 'x');
    r.run();
    expect(fs.readFileSync(abs, 'utf-8')).toBe('abs');
    expect(fs.readFileSync(rel, 'utf-8')).toBe('rel');
    expect(r.has(r.jobs, '1001-000001-abs.log')).toBe(false); // its own log, by name, did go
    expect(r.has(r.jobs, '1001-000002-rel.log')).toBe(false);
    expect(r.has(r.codex, '1001-000003-cx.jsonl')).toBe(false);
  });

  it('a name that is a path, a directory or a link is no plain file of the folder', () => {
    const r = rig();
    const outside = path.join(r.home, 'outside.txt');
    fs.writeFileSync(outside, 'keep');
    fs.writeFileSync(path.join(r.jobs, 'inside.log'), 'abc');
    fs.mkdirSync(path.join(r.jobs, 'sub'));
    fs.writeFileSync(path.join(r.jobs, 'sub', 'deep.log'), 'x');
    fs.symlinkSync(outside, path.join(r.jobs, 'link.log'));
    expect(plainFileSize(r.jobs, 'inside.log')).toBe(3);
    expect(plainFileSize(r.jobs, 'sub/deep.log')).toBeNull();
    expect(plainFileSize(r.jobs, '../outside.txt')).toBeNull();
    expect(plainFileSize(r.jobs, outside)).toBeNull();
    expect(plainFileSize(r.jobs, 'sub')).toBeNull();
    expect(plainFileSize(r.jobs, 'link.log')).toBeNull();
    expect(plainFileSize(r.jobs, 'missing.log')).toBeNull();
  });

  it('skips a jobs/ or codex/ folder that is itself a symlink, with one log line', () => {
    const r = rig();
    for (const [dir, ext] of [
      [r.jobs, '.log'],
      [r.codex, '.jsonl'],
    ] as const) {
      const target = path.join(r.home, `target-${path.basename(dir)}`);
      fs.rmSync(dir, { recursive: true });
      fs.mkdirSync(target);
      fs.symlinkSync(target, dir);
      const id = '1001-000001-old';
      fs.writeFileSync(
        path.join(target, `${id}.json`),
        JSON.stringify({ id, state: 'done', dir: '/w', ended: ago(99) }),
      );
      fs.writeFileSync(path.join(target, `${id}${ext}`), 'x');
    }
    r.run();
    for (const [name, ext] of [
      ['target-jobs', '.log'],
      ['target-codex', '.jsonl'],
    ])
      expect(fs.existsSync(path.join(r.home, name, `1001-000001-old${ext}`)), name).toBe(true);
    expect(r.logs.filter((l) => l.includes('is a symlink'))).toHaveLength(2);
  });

  it('a missing folder, or an unreadable record, is not an error', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-prune-'));
    homes.push(home);
    const lines: string[] = [];
    expect(() => pruneLogs({ home, now: NOW, log: (l) => lines.push(l) })).not.toThrow();
    const r = rig();
    fs.writeFileSync(path.join(r.jobs, '1001-000001-bad.json'), '{broken');
    fs.writeFileSync(path.join(r.jobs, '1001-000001-bad.log'), 'x');
    r.run();
    expect(r.has(r.jobs, '1001-000001-bad.log')).toBe(true);
  });

  it('the policy numbers are the decided ones, and cld-gui doctor prints the same', () => {
    expect([LOG_KEEP_DAYS, LOG_DIR_CAP_BYTES, EVENTS_ROTATE_BYTES, LOG_PRUNE_INTERVAL_MS]).toEqual([
      30,
      1024 ** 3,
      5 * 1024 * 1024,
      DAY,
    ]);
    const sizes = createRequire(__filename)(path.join(REPO_ROOT, 'cld/bin/cld-gui-sizes.js')) as Record<string, number>;
    expect([sizes.LOG_KEEP_DAYS, sizes.LOG_DIR_CAP_BYTES, sizes.EVENTS_ROTATE_BYTES]).toEqual([
      LOG_KEEP_DAYS,
      LOG_DIR_CAP_BYTES,
      EVENTS_ROTATE_BYTES,
    ]);
  });
});
