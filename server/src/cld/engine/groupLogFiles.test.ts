import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as zlib from 'zlib';

import { maintainGroupLogs, roomSegments } from './groupLogFiles.js';
import { GroupMessages, type GroupMessenger } from './groupMessages.js';
import { GroupStore, groupTimelineDir } from './groups.js';

let homes: string[] = [];
afterEach(() => {
  for (const h of homes) fs.rmSync(h, { recursive: true, force: true });
  homes = [];
});
const home = () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-group-months-'));
  homes.push(h);
  return h;
};
const at = (iso: string) => Date.parse(iso);
const post = (id: string, when: string) =>
  JSON.stringify({ v: 1, kind: 'post', post: { id, at: at(when), roomName: 'r', sender: null, text: id, targets: [], delivery: {} } });
const delivery = (id: string) => JSON.stringify({ v: 1, kind: 'delivery', id, member: 'alpha', state: 'delivered' });
const messenger: GroupMessenger = { send: async () => ({ ok: true, delivered: 'pane' }) };

function rig(clock: { t: number }) {
  const h = home();
  const store = new GroupStore(h, () => ['alpha'], () => 'room0001');
  const room = store.create('팀', ['alpha']);
  let n = 0;
  const groups = new GroupMessages({ home: h, store, messenger, now: () => clock.t, ids: () => `p${++n}` });
  return { h, dir: groupTimelineDir(h), groups, room: store.list().find((r) => r.name === '팀')!, room_: room };
}

describe('group room logs by month', () => {
  it('writes into the month of the clock, and a recent read spans the month boundary', async () => {
    const clock = { t: at('2026-10-31T23:00:00Z') };
    const { dir, groups, room } = rig(clock);
    await groups.post({ room: room.name, text: 'old', from: null, source: 'test' });
    clock.t = at('2026-11-01T00:30:00Z');
    await groups.post({ room: room.name, text: 'new', from: null, source: 'test' });
    expect(fs.readdirSync(dir).sort()).toEqual(['room0001.2026-10.jsonl', 'room0001.2026-11.jsonl']);
    // Two posts wanted, the current month holds one: the previous file is read too.
    expect(groups.timeline(room, 2).map((p) => p.text)).toEqual(['old', 'new']);
    // One wanted: the current month is enough.
    expect(groups.timeline(room, 1).map((p) => p.text)).toEqual(['new']);
  });

  it('splits an earlier-version log by month, gzips a 7-month-old month, deletes nothing, and a rerun changes nothing', async () => {
    const clock = { t: at('2026-11-01T12:00:00Z') };
    const { dir, groups, room } = rig(clock);
    fs.mkdirSync(dir, { recursive: true });
    const lines = [
      post('a', '2026-04-10T00:00:00Z'), // 7 months old: gzipped
      delivery('a'),
      post('b', '2026-05-02T00:00:00Z'), // 6 months old: stays plain
      post('c', '2026-10-31T00:00:00Z'),
      delivery('c'),
    ];
    fs.writeFileSync(path.join(dir, 'room0001.jsonl'), `${lines.join('\n')}\n`);
    const log: string[] = [];
    maintainGroupLogs(dir, clock.t, (l) => log.push(l));
    expect(fs.readdirSync(dir).sort()).toEqual([
      'room0001.2026-04.jsonl.gz',
      'room0001.2026-05.jsonl',
      'room0001.2026-10.jsonl',
    ]);
    expect(zlib.gunzipSync(fs.readFileSync(path.join(dir, 'room0001.2026-04.jsonl.gz'))).toString()).toBe(`${lines[0]}\n${lines[1]}\n`);
    // The month of the delivery line follows its post; every line is still there, in order.
    expect(fs.readFileSync(path.join(dir, 'room0001.2026-10.jsonl'), 'utf8')).toBe(`${lines[3]}\n${lines[4]}\n`);
    expect(roomSegments(dir, 'room0001').map((f) => path.basename(f))).toHaveLength(3);
    // The gzipped month is still listed and read.
    expect(groups.timeline(room, 10).map((p) => [p.id, p.delivery])).toEqual([
      ['a', {}],
      ['b', {}],
      ['c', {}],
    ]);
    const before = fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n)).toString('base64'));
    maintainGroupLogs(dir, clock.t, (l) => log.push(l));
    expect(fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n)).toString('base64'))).toEqual(before);
    expect(log).toEqual([]);
  });

  it('a split interrupted before the old file went is redone whole; month files already there are kept', () => {
    const dir = home();
    const lines = [post('a', '2026-10-01T00:00:00Z'), post('b', '2026-10-02T00:00:00Z')];
    fs.writeFileSync(path.join(dir, 'r1.jsonl'), `${lines.join('\n')}\n`);
    // A month file left by the crashed run plus a newer line appended meanwhile.
    fs.writeFileSync(path.join(dir, 'r1.2026-10.jsonl'), `${lines.join('\n')}\n${post('c', '2026-10-03T00:00:00Z')}\n`);
    maintainGroupLogs(dir, at('2026-11-01T00:00:00Z'), () => {});
    expect(fs.existsSync(path.join(dir, 'r1.jsonl'))).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'r1.2026-10.jsonl'), 'utf8').split('\n').filter(Boolean)).toEqual([
      ...lines,
      post('c', '2026-10-03T00:00:00Z'),
    ]);
  });
});
