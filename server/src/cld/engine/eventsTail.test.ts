import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { EngineEvents, rotateEvents } from './events.js';
import { EventsTail } from './eventsTail.js';

const line = (n: number) =>
  JSON.stringify({ v: 1, type: 'turn_end', ts: `t${n}`, name: `o${n}` }) + '\n';

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-events-'));
  const file = path.join(dir, 'events.jsonl');
  const warnings: string[] = [];
  return { file, warnings, tail: new EventsTail(file, (m) => warnings.push(m)) };
}

describe('events.jsonl tail', () => {
  it('primes with the last N lines and then reads only appended ones', () => {
    const { file, tail } = setup();
    fs.writeFileSync(file, [1, 2, 3, 4, 5].map(line).join(''));
    expect(tail.primeLast(2).map((e) => e.ts)).toEqual(['t4', 't5']);
    expect(tail.readNew()).toEqual([]);
    fs.appendFileSync(file, line(6));
    expect(tail.readNew().map((e) => e.ts)).toEqual(['t6']);
  });

  it('keeps a partial line until it is complete', () => {
    const { file, tail } = setup();
    tail.primeLast(10); // file missing: start empty
    const l = line(1);
    fs.writeFileSync(file, l.slice(0, 10));
    expect(tail.readNew()).toEqual([]);
    fs.appendFileSync(file, l.slice(10));
    expect(tail.readNew().map((e) => e.ts)).toEqual(['t1']);
  });

  it('rereads from the start after truncation or replacement', () => {
    const { file, tail, warnings } = setup();
    fs.writeFileSync(file, line(1) + line(2));
    tail.primeLast(10);
    fs.writeFileSync(file, line(9)); // truncated (shorter)
    expect(tail.readNew().map((e) => e.ts)).toEqual(['t9']);
    const tmp = `${file}.new`;
    fs.writeFileSync(tmp, line(10) + line(11) + line(12));
    fs.renameSync(tmp, file); // replaced (new inode)
    expect(tail.readNew().map((e) => e.ts)).toEqual(['t10', 't11', 't12']);
    expect(warnings.filter((w) => w.includes('reading it again'))).toHaveLength(2);
  });

  it('skips a broken line with a warning and keeps going', () => {
    const { file, tail, warnings } = setup();
    tail.primeLast(10);
    fs.writeFileSync(file, line(1) + '{broken\n' + line(2));
    expect(tail.readNew().map((e) => e.ts)).toEqual(['t1', 't2']);
    expect(warnings).toEqual(['events.jsonl: skipped a broken line']);
  });

  it('rotates at the threshold, keeping one previous file', () => {
    const { file } = setup();
    fs.writeFileSync(file, line(1) + line(2));
    expect(rotateEvents(file, 1000)).toBe(false); // under: untouched
    expect(fs.existsSync(`${file}.1`)).toBe(false);
    expect(rotateEvents(file, 10)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, line(3) + line(4));
    expect(rotateEvents(file, 10)).toBe(true); // the older .1 is replaced
    expect(fs.readFileSync(`${file}.1`, 'utf-8')).toBe(line(3) + line(4));
    expect(rotateEvents(file, 10)).toBe(false); // nothing to rotate, no throw
  });

  it('reads across a rotation: the old file is finished, then the new one', () => {
    const { file, tail, warnings } = setup();
    fs.writeFileSync(file, line(1) + line(2));
    tail.primeLast(10);
    fs.appendFileSync(file, line(3)); // not read yet when the file rotates
    rotateEvents(file, 10);
    fs.writeFileSync(file, line(4) + line(5));
    expect(tail.readNew().map((e) => e.ts)).toEqual(['t3', 't4', 't5']);
    fs.appendFileSync(file, line(6));
    expect(tail.readNew().map((e) => e.ts)).toEqual(['t6']);
    expect(warnings).toEqual([]);
  });

  it('primes from the previous file when the new one is still short', () => {
    const { file, tail } = setup();
    fs.writeFileSync(`${file}.1`, [1, 2, 3].map(line).join(''));
    fs.writeFileSync(file, line(4));
    expect(tail.primeLast(10).map((e) => e.ts)).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('EngineEvents.rotate drains first, so the feed loses nothing', () => {
    const { file } = setup();
    const seen: string[] = [];
    const ev = new EngineEvents(file, (e) => seen.push(e.ts));
    ev.load();
    fs.appendFileSync(file, JSON.stringify({ v: 1, ts: 't', type: 'job_end', source: 'job', id: 'x' }) + '\n');
    expect(seen).toEqual([]); // the watcher is not running: the line is still pending
    expect(ev.rotate(10)).toBe(true);
    expect(seen).toEqual(['t']); // rotate read it before moving the file, not at the next append
    expect(ev.feed.map((f) => f.ts)).toEqual(['t']);
    ev.append('job_end', 'job', { id: 'y' }); // lands in the new file
    expect(seen).toHaveLength(2);
    expect(fs.readFileSync(`${file}.1`, 'utf-8')).toContain('"id":"x"');
    expect(fs.readFileSync(file, 'utf-8')).toContain('"id":"y"');
  });
});
