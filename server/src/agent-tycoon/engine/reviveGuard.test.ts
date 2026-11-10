import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { configDir } from './events.js';
import { ReviveGuard } from './reviveGuard.js';

const MIN = 60_000;
const TIMING = { reviveWindowMs: 10 * MIN, reviveLimit: 3, reviveDayLimit: 6, reviveBackoffMs: MIN };

describe('ReviveGuard', () => {
  let home: string;
  let now: number;
  let events: Array<Record<string, unknown>>;
  let changed: number;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'revive-guard-'));
    now = 1_000_000_000;
    events = [];
    changed = 0;
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));
  const make = (timing = TIMING) =>
    new ReviveGuard({
      home,
      timing,
      now: () => now,
      log: () => {},
      event: (_t, _s, f) => events.push(f),
      changed: () => changed++,
    });
  const file = () => path.join(configDir(home), 'revive-guard.json');

  it('stops on the burst: the reviveLimit-th inside the window, one orch_giveup, one changed', () => {
    const g = make();
    expect(g.budget('a', false)).toBe('go');
    now += MIN;
    expect(g.budget('a', false)).toBe('go');
    now += MIN;
    expect(g.budget('a', false)).toBe('stop');
    expect(g.gaveUp('a')).toBeTruthy();
    expect(events).toEqual([{ name: 'a', error: g.gaveUp('a'), reason: 'crash_loop' }]);
    expect(changed).toBe(1);
    expect(g.budget('a')).toBe('stop'); // stays down, no second event
    expect(events).toHaveLength(1);
  });

  it('stops on the day cap when the revives are spread out', () => {
    const g = make();
    for (let i = 0; i < TIMING.reviveDayLimit; i++) {
      expect(g.budget('a', false)).toBe('go');
      now += 11 * MIN; // outside the burst window each time
    }
    expect(g.count('a')).toBe(TIMING.reviveDayLimit);
    expect(g.budget('a', false)).toBe('stop');
    expect(events[0]?.reason).toBe('day_cap');
  });

  it('backs off 2^(k-1) minutes after the k-th revive, but not for a daemon start', () => {
    const g = make({ ...TIMING, reviveLimit: 99 });
    expect(g.budget('a')).toBe('go');
    now += MIN - 1;
    expect(g.budget('a')).toBe('wait');
    now += 1;
    expect(g.budget('a')).toBe('go'); // 2nd, waited 1 min
    now += 2 * MIN - 1;
    expect(g.budget('a')).toBe('wait'); // after the 2nd: 2 min
    expect(g.budget('a', false)).toBe('go'); // a daemon start's revive is counted, not delayed
    now += 4 * MIN - 1;
    expect(g.budget('a')).toBe('wait'); // after the 3rd: 4 min
    now += 1;
    expect(g.budget('a')).toBe('go');
  });

  it('keeps counts and the give-up across a save and load; forgive clears both', () => {
    const g = make();
    g.budget('a', false);
    now += MIN;
    g.budget('a', false);
    now += MIN;
    g.budget('a', false); // gave up
    g.budget('b', false);
    const saved = JSON.parse(fs.readFileSync(file(), 'utf-8')) as Record<string, { attempts: number[]; gaveUp?: string }>;
    expect(saved.a?.attempts).toHaveLength(2);
    expect(typeof saved.a?.gaveUp).toBe('string');
    expect(saved.b).toEqual({ attempts: [now] });

    const again = make();
    expect(again.gaveUp('a')).toBe(g.gaveUp('a'));
    expect(again.count('a')).toBe(2);
    expect(again.count('b')).toBe(1);

    again.forgive('a');
    expect(again.gaveUp('a')).toBeUndefined();
    expect(again.count('a')).toBe(0);
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8'))).not.toHaveProperty('a');
    expect(make().budget('a', false)).toBe('go');
  });

  it('uses the last start error as the give-up text, and clearGaveUp drops the mark', () => {
    const g = make();
    g.noteError('a', 'spawn failed');
    g.budget('a', false);
    now += MIN;
    g.budget('a', false);
    now += MIN;
    expect(g.budget('a', false)).toBe('stop');
    expect(g.gaveUp('a')).toBe('spawn failed');
    g.clearGaveUp('a');
    expect(g.gaveUp('a')).toBeUndefined();
    expect(make().gaveUp('a')).toBeUndefined();
  });
});
