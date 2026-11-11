import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RENEW_FILL_PCT } from '../../constants.js';
import { CompactionWatch } from './compactions.js';
import type { ProjectRecord } from './registry.js';
import type { Live } from './sessionMatch.js';

const MARK = '"compact_boundary"';

describe('CompactionWatch', () => {
  let dir: string;
  let file: string;
  let sessionId: string;
  let fill: number | undefined;
  let events: Array<Record<string, unknown>>;
  let nudges: Array<[string, number, number | null]>;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compactions-'));
    file = path.join(dir, 't.jsonl');
    sessionId = 's1';
    fill = 10;
    events = [];
    nudges = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const project = { name: 'alpha', compactionNudge: 2 } as unknown as ProjectRecord;
  const holder = (): Live =>
    ({
      kind: 'background',
      sessionId,
      agent: { compaction: { mark: MARK, fillPct: () => fill }, transcript: () => file },
    }) as unknown as Live;
  const watch = new CompactionWatch({
    event: (_t, _s, f) => events.push(f),
    nudge: (n, c, p) => nudges.push([n, c, p]),
  });
  const check = () => watch.check([project], holder);

  it('counts a mark split across two growing writes once, and does not nudge on the first look', () => {
    // first look: one boundary already there, never reported
    fs.writeFileSync(file, `{"t":${MARK}}\n`);
    check();
    expect(watch.countFor('alpha', 's1')).toBe(1);
    expect(events).toEqual([]);
    // the next boundary arrives cut in two across writes (the carry joins them)
    fs.appendFileSync(file, '{"t":"compact_');
    check();
    expect(watch.countFor('alpha', 's1')).toBe(1);
    fs.appendFileSync(file, 'boundary"}\n');
    check();
    expect(watch.countFor('alpha', 's1')).toBe(2);
    expect(events).toEqual([{ name: 'alpha', count: 2 }]);
    expect(watch.sigPart()).toEqual([['alpha', 2]]);
    // refilled after the count: the one nudge, once
    fill = RENEW_FILL_PCT + 1;
    fs.appendFileSync(file, '{"x":1}\n');
    check();
    fs.appendFileSync(file, '{"x":2}\n');
    check();
    expect(nudges).toEqual([['alpha', 2, RENEW_FILL_PCT + 1]]);
  });

  it('T-96: a later boundary before any refill nudges once with no fill (null), not a made-up one', () => {
    fs.writeFileSync(file, `{"t":${MARK}}\n`);
    check(); // first look
    fs.appendFileSync(file, `{"t":${MARK}}\n`);
    check(); // the 2nd boundary: the count is reached, the context is empty
    expect(nudges).toEqual([]);
    fs.appendFileSync(file, `{"t":${MARK}}\n`);
    check(); // the 3rd, no refill seen between
    expect(nudges).toEqual([['alpha', 3, null]]);
    fs.appendFileSync(file, `{"t":${MARK}}\n`);
    check();
    expect(nudges).toEqual([['alpha', 3, null]]); // once
  });

  it('counts a project without compactionNudge too, and never nudges it', () => {
    const plain = { name: 'plain' } as unknown as ProjectRecord;
    const watch = new CompactionWatch({
      event: (_t, _s, f) => events.push(f),
      nudge: (n, c, p) => nudges.push([n, c, p]),
    });
    fill = RENEW_FILL_PCT + 1;
    fs.writeFileSync(file, `{"t":${MARK}}\n{"t":${MARK}}\n`);
    watch.check([plain], holder);
    expect(watch.countFor('plain', 's1')).toBe(2);
    fs.appendFileSync(file, `{"t":${MARK}}\n`);
    watch.check([plain], holder);
    expect(watch.countFor('plain', 's1')).toBe(3);
    fs.appendFileSync(file, '{"x":1}\n');
    watch.check([plain], holder);
    expect(nudges).toEqual([]);
    expect(events).toEqual([{ name: 'plain', count: 3 }]);
  });

  it('a new session id resets the count, and forget drops it', () => {
    fs.writeFileSync(file, `{"t":${MARK}}\n{"t":${MARK}}\n`);
    check();
    expect(watch.countFor('alpha', 's1')).toBe(2);
    expect(watch.countFor('alpha', 's2')).toBe(0);
    sessionId = 's2';
    fs.writeFileSync(file, `{"t":${MARK}}\n`);
    check();
    expect(watch.countFor('alpha', 's2')).toBe(1);
    watch.forget('alpha');
    expect(watch.sigPart()).toEqual([]);
  });
});
