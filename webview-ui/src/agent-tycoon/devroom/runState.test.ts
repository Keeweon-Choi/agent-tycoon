import { describe, expect, it } from 'vitest';

import type { OfficeJob } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { testsLine } from './mergeState.js';
import { clock, devUrlOf, latestRun, liveRuns, runText, runTone, tailLines } from './runState.js';

const job = (o: Partial<OfficeJob>): OfficeJob => ({
  id: 'j',
  pid: 7,
  project: 'shop',
  cmd: 'npm run --ignore-scripts test',
  created: '2026-11-06T18:10:00+09:00',
  started: '2026-11-06T18:10:00+09:00',
  ended: null,
  exit: null,
  run: { task: 'feat-t1', script: 'test', role: 'test' },
  ...o,
});

describe('DV2 run state', () => {
  it("finds a worktree's newest run of a script, and only the dev room's runs", () => {
    const old = job({ id: 'a', created: '2026-11-06T18:00:00+09:00', ended: '2026-11-06T18:01:00+09:00', exit: 1 });
    const now = job({ id: 'b' });
    const other = job({ id: 'c', run: { task: 'feat-t2', script: 'test', role: 'test' } });
    const plain = job({ id: 'd', run: undefined });
    const jobs = [now, old, other, plain];
    expect(latestRun(jobs, 'shop', 'feat-t1', 'test')?.id).toBe('b');
    expect(latestRun(jobs, 'shop', 'feat-t1', 'dev')).toBeUndefined();
    expect(liveRuns(jobs)).toBe(2);
  });

  it('says each state as the mockups do', () => {
    expect(runText(undefined, null)).toBe(t('devroom.run.never'));
    expect(runTone(job({}))).toBe('running');
    expect(runText(job({}), 'http://localhost:5174/')).toBe(t('devroom.run.runningAt', { url: 'localhost:5174' }));
    const failed = job({ ended: '2026-11-06T18:12:00+09:00', exit: 1 });
    expect(runText(failed, null)).toBe(t('devroom.run.failed', { code: 1, time: clock(failed.ended) }));
    expect(runTone(job({ ended: 'x', exit: 143, stopped: true }))).toBe('stopped');
    expect(runTone(job({ ended: 'x', exit: 0 }))).toBe('ok');
  });

  it('offers only a loopback address from the log', () => {
    expect(devUrlOf('  VITE ready\n  Local:   http://localhost:5174/\n  Network: http://192.168.0.4:5174/\n')).toBe('http://localhost:5174/');
    expect(devUrlOf('Local: http://192.168.0.4:5174/')).toBeNull();
    expect(devUrlOf('Listening on http://evil.example:80')).toBeNull();
    expect(tailLines('a\nb\nc\n\n', 2)).toBe('b\nc');
  });

  it("the merge pre-check's tests line: observed with exit code and time, else the reported pass, else none", () => {
    const at = '2026-11-06T18:12:00+09:00';
    const observed = { value: false, source: 'observed' as const, at };
    const ran = job({ ended: at, exit: 1 });
    expect(testsLine(observed, ran)).toEqual({ ok: false, text: t('devroom.run.preCheck', { code: 1, time: clock(at) }) });
    expect(testsLine({ ...observed, value: true }, undefined)).toEqual({ ok: true, text: t('devroom.run.preCheckPass', { time: clock(at) }) });
    expect(testsLine({ value: true, source: 'reported', at }, undefined)).toEqual({ ok: true, text: t('devroom.tests') });
    expect(testsLine(undefined, undefined)).toBeNull();
  });
});
