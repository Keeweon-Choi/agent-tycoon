/** CLONE-PROGRESS: git's real `clone --progress` stderr (fixtures/git-clone-progress.txt, a
 *  --no-local clone of this repository, `\r` updates and all) read the way the daemon reads it. */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type CloneProgress, CloneProgressReader, parseCloneProgress, throttled } from './cloneProgress.js';

const REAL = fs.readFileSync(path.join(__dirname, 'fixtures', 'git-clone-progress.txt'), 'utf-8');

afterEach(() => vi.useRealTimers());

describe('clone progress', () => {
  it('reads every phase of a real clone, however the chunks fall', () => {
    expect(REAL).toContain('\r');
    for (const size of [1, 7, 333, REAL.length]) {
      const got: CloneProgress[] = [];
      const reader = new CloneProgressReader((p) => got.push(p));
      for (let i = 0; i < REAL.length; i += size) reader.push(REAL.slice(i, i + size));
      reader.end();
      const phases = got.map((p) => p.phase).filter((p, i, all) => all[i - 1] !== p);
      expect(phases, `chunks of ${size}`).toEqual(['enumerating', 'counting', 'compressing', 'receiving', 'resolving', 'updating']);
      expect(got.find((p) => p.phase === 'enumerating')).toEqual({ phase: 'enumerating', done: 4546 });
      const received = got.filter((p) => p.phase === 'receiving');
      expect(received.at(-1)).toEqual({ phase: 'receiving', percent: 100, done: 4546, total: 4546, size: '345.25 MiB', speed: '36.71 MiB/s' });
      expect(received.some((p) => p.percent! < 100 && p.size && p.speed)).toBe(true);
      expect(got.at(-1)).toEqual({ phase: 'updating', percent: 100, done: 4207, total: 4207 });
      // What is not progress is kept for the failure's reason.
      expect(reader.other).toEqual(["Cloning into 'cap'...", 'remote: Total 4546 (delta 114), reused 4141 (delta 92), pack-reused 0']);
    }
  });

  it('parses one line; anything else is not progress', () => {
    expect(parseCloneProgress('remote: Counting objects:  50% (2/4)        ')).toEqual({ phase: 'counting', percent: 50, done: 2, total: 4 });
    expect(parseCloneProgress('Receiving objects:   4% (182/4546), 19.77 MiB | 39.52 MiB/s')).toEqual({
      phase: 'receiving', percent: 4, done: 182, total: 4546, size: '19.77 MiB', speed: '39.52 MiB/s',
    });
    expect(parseCloneProgress('Receiving objects:  12% (5/40), 812.00 KiB | 400.00 KiB/s')).toMatchObject({ size: '812.00 KiB', speed: '400.00 KiB/s' });
    expect(parseCloneProgress("fatal: repository 'x' does not exist")).toBeNull();
    expect(parseCloneProgress('warning: You appear to have cloned an empty repository.')).toBeNull();
  });

  it('sends at most one report per interval, a new phase at once, and the last one after the wait', () => {
    vi.useFakeTimers();
    const sent: CloneProgress[] = [];
    const t = throttled((p) => sent.push(p), 250, () => Date.now());
    t.push({ phase: 'receiving', percent: 1 });
    t.push({ phase: 'receiving', percent: 2 });
    t.push({ phase: 'receiving', percent: 3 });
    expect(sent.map((p) => p.percent)).toEqual([1]);
    vi.advanceTimersByTime(250);
    expect(sent.map((p) => p.percent)).toEqual([1, 3]);
    t.push({ phase: 'resolving', percent: 0 });
    expect(sent.at(-1)).toEqual({ phase: 'resolving', percent: 0 });
    t.push({ phase: 'resolving', percent: 50 });
    t.stop();
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(3);
  });
});
