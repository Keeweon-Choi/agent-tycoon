import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as zlib from 'zlib';

import { goneName } from '../../../core/src/cld/goneAgent.js';
import { configDirectory } from './configPath.js';
import { combinedRulesFile } from './engine/agentRules.js';
import { approvalsPath,ApprovalStore } from './engine/delegation.js';
import { checkName } from './engine/registry.js';
import {
  aliasOf,
  deleteGoneConversation,
  goneAgents,
  moveProjectData,
  NameTaken,
  PROJECT_STORES,
  purgeProjectData,
  readNameHistory,
  recordFormerName,
  takenBy,
} from './projectData.js';
import { transcriptPath } from './providers/claudeProvider.js';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});

const GONE = goneName('a_abcdefghij');

/** Every file under `dir` with its bytes: a "nothing changed" check. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p).toString('base64');
    }
  };
  walk(dir);
  return out;
}

/** A temp HOME with every store holding `alpha` (and `beta`, which nothing may touch). */
function populated() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-project-data-'));
  homes.push(home);
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => {
    const file = path.join(cfg, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
  };
  put('characters.json', { owner: { look: 'OWNER' }, alpha: { preset: 'p1' }, beta: { palette: 2, hueShift: 0 }, $meta: { v: 2, auto: { alpha: { palette: 1, d: 3 } } } });
  put('levels.json', { v: 1, levels: { 'engine:alpha': { xp: 300, rebirths: 2 }, 'engine:beta': { xp: 5, rebirths: 0 } } });
  put('pins.json', { v: 1, keys: ['alpha', 'room:r1', 'beta'] });
  put('roster.json', { v: 1, projects: { alpha: { employees: [], executions: {} }, beta: { employees: [], executions: {} } } });
  put('building.json', { version: 1, perProject: false, floors: [{ id: '1', name: '1층', rooms: [], characters: ['alpha', 'beta'] }] });
  put('groups.json', { v: 1, groups: [{ id: 'r1', name: 'team', members: ['alpha', 'beta'] }] });
  const post = { v: 1, kind: 'post', post: { id: 'm1', at: 1, sender: 'alpha', text: 'hi', targets: ['beta', 'alpha'], delivery: { alpha: 'delivered', beta: 'pending' }, messageIds: { alpha: 'x1' } } };
  const delivery = { v: 1, kind: 'delivery', id: 'm1', member: 'alpha', state: 'delivered' };
  put('groups/r1.2026-11.jsonl', `${JSON.stringify(post)}\n${JSON.stringify(delivery)}\nnot json "alpha"\n`);
  put('groups/r1.2026-01.jsonl.gz', zlib.gzipSync(`${JSON.stringify(post)}\n`));
  put('inbox/alpha/1-a.md', 'hello');
  put('inbox/alpha/1-a.md.meta.json', { to: 'alpha', text: 'hello' });
  put('queue/q1.json', { to: 'alpha', from: null, text: 'x' });
  put('queue/q2.json', { to: 'beta', from: 'alpha', text: 'y' });
  put('typed/alpha.json', [{ text: 'x', at: 1 }]);
  put('renewals/alpha.json.failed', { name: 'alpha', message: 'handoff' });
  put('revive-guard.json', { alpha: { attempts: [1], gaveUp: 'x' }, beta: { attempts: [] } });
  put(path.relative(cfg, combinedRulesFile(home, 'alpha')), 'rules');
  put('tasks.json', { v: 2, tasks: [{ id: 't1', project: 'alpha', title: 'x', assignee: { assignmentId: 'a_1', name: 'alpha' } }] });
  put('approvals.json', {
    v: 1,
    approvals: [{ id: 'ap-1', approver: 'user', project: 'alpha', caller: 'alpha', input: {} }],
    modes: { alpha: 'off', beta: 'reuse' },
    newWorkers: [{ project: 'alpha', name: 'alpha-w', at: 1 }],
  });
  put('tracking.json', { v: 1, projects: { alpha: { docs: { on: ['a.md'], off: [] } }, beta: {} } });
  put('worktrees.json', [{ project: 'alpha', task: 'login', path: '/w/alpha/.worktrees/login', branch: 'task/login', base: 'main', created: 'x', status: 'active' }]);
  put('merge-history.json', { alpha: [{ task: 'login' }] });
  put('review-notes.json', { v: 1, notes: { 'alpha\0login': [{ id: 'n1' }], 'beta\0x': [] } });
  put('protected-branches.json', { alpha: ['release'], beta: ['main'] });
  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(cfg, rel), 'utf-8')) as Record<string, any>;
  const exists = (rel: string) => fs.existsSync(path.join(cfg, rel));
  const lines = (rel: string) => {
    const raw = fs.readFileSync(path.join(cfg, rel));
    return (rel.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf-8').split('\n');
  };
  return { home, cfg, read, exists, lines, put };
}

describe('projectData', () => {
  it('move: every store follows the new name; beta is untouched', () => {
    const h = populated();
    expect(moveProjectData(h.home, 'alpha', 'gamma')).toEqual([]);
    expect(h.read('characters.json')).toEqual({ owner: { look: 'OWNER' }, gamma: { preset: 'p1' }, beta: { palette: 2, hueShift: 0 }, $meta: { v: 2, auto: { gamma: { palette: 1, d: 3 } } } });
    expect(h.read('levels.json').levels).toEqual({ 'engine:gamma': { xp: 300, rebirths: 2 }, 'engine:beta': { xp: 5, rebirths: 0 } });
    expect(h.read('pins.json').keys).toEqual(['gamma', 'room:r1', 'beta']);
    expect(Object.keys(h.read('roster.json').projects).sort()).toEqual(['beta', 'gamma']);
    expect(h.read('building.json').floors[0].characters).toEqual(['gamma', 'beta']);
    expect(h.read('groups.json').groups[0].members).toEqual(['gamma', 'beta']);
    const [post, delivery, torn] = h.lines('groups/r1.2026-11.jsonl').map((l, i) => (i < 2 ? JSON.parse(l) : l));
    expect(post.post).toMatchObject({ sender: 'gamma', targets: ['beta', 'gamma'], delivery: { gamma: 'delivered', beta: 'pending' }, messageIds: { gamma: 'x1' } });
    expect(delivery.member).toBe('gamma');
    expect(torn).toBe('not json "alpha"');
    expect(JSON.parse(h.lines('groups/r1.2026-01.jsonl.gz')[0]).post.sender).toBe('gamma');
    expect(h.exists('inbox/alpha')).toBe(false);
    expect(fs.readFileSync(path.join(h.cfg, 'inbox/gamma/1-a.md'), 'utf-8')).toBe('hello');
    expect(h.read('inbox/gamma/1-a.md.meta.json').to).toBe('gamma');
    expect(h.read('queue/q1.json').to).toBe('gamma');
    expect(h.read('queue/q2.json')).toMatchObject({ to: 'beta', from: 'gamma' });
    expect(h.exists('typed/gamma.json') && !h.exists('typed/alpha.json')).toBe(true);
    expect(h.read('renewals/gamma.json.failed').name).toBe('gamma');
    expect(Object.keys(h.read('revive-guard.json')).sort()).toEqual(['beta', 'gamma']);
    expect(fs.existsSync(combinedRulesFile(h.home, 'alpha'))).toBe(false);
    expect(h.read('tasks.json').tasks[0]).toMatchObject({ project: 'gamma', assignee: { name: 'gamma' } });
    // The review's: a Lead's delegation mode and day count, and its repository records.
    expect(h.read('approvals.json')).toMatchObject({
      approvals: [{ project: 'gamma', caller: 'gamma' }],
      modes: { gamma: 'off', beta: 'reuse' },
      newWorkers: [{ project: 'gamma', name: 'alpha-w' }],
    });
    expect(h.read('approvals.json').modes.alpha).toBeUndefined();
    expect(Object.keys(h.read('tracking.json').projects).sort()).toEqual(['beta', 'gamma']);
    expect(h.read('worktrees.json' as never)[0].project).toBe('gamma');
    expect(Object.keys(h.read('merge-history.json'))).toEqual(['gamma']);
    expect(Object.keys(h.read('review-notes.json').notes).sort()).toEqual(['beta\0x', 'gamma\0login']);
    // The owner's protected branches: a merge or guard install under the new name keeps them.
    expect(h.read('protected-branches.json')).toEqual({ gamma: ['release'], beta: ['main'] });
  });

  it("a new Worker's daily-count entry is not data under its name (delegate_task notes it before addWorker)", () => {
    const h = populated();
    new ApprovalStore(approvalsPath(h.home)).noteNewWorker('lead', 'lead-a');
    expect(takenBy(h.home, 'lead-a')).toEqual([]);
    expect(takenBy(h.home, 'lead')).toContain('approvals.json');
  });

  it('refuses a target that has data in any store, and changes nothing (the owner\'s look stays)', () => {
    const h = populated();
    const before = snapshot(h.cfg);
    expect(() => moveProjectData(h.home, 'alpha', 'owner')).toThrow(NameTaken);
    expect(() => moveProjectData(h.home, 'alpha', 'beta')).toThrow(NameTaken);
    expect(snapshot(h.cfg)).toEqual(before);
    expect(takenBy(h.home, 'beta')).toEqual(expect.arrayContaining(['characters.json', 'levels.json', 'pins.json', 'groups/', 'approvals.json']));
    expect(takenBy(h.home, 'gamma')).toEqual([]);
    // Data under a name alone (a store nobody lists) is enough.
    h.put('typed/delta.json', []);
    expect(() => moveProjectData(h.home, 'alpha', 'delta')).toThrow(/typed/);
    expect(snapshot(h.cfg)).toEqual({ ...before, 'typed/delta.json': Buffer.from('[]').toString('base64') });
  });

  it('reserved names are never an agent\'s name', () => {
    for (const n of ['owner', 'Owner', '사장', 'agty', 'cld-gui']) expect(checkName(n)).toMatch(/쓸 수 없어요/);
    for (const n of ['emp:1', '~a_abcdefghij', 'room:x', '$meta']) expect(checkName(n)).toMatch(/이름은/);
    expect(checkName('tycoon-admin')).toBeNull();
  });

  it('move to the gone name: detached (no member), the rest under it, its repository records too', () => {
    const h = populated();
    expect(moveProjectData(h.home, 'alpha', GONE, undefined, true)).toEqual([]);
    expect(h.read('levels.json').levels[`engine:${GONE}`]).toEqual({ xp: 300, rebirths: 2 });
    expect(h.read('levels.json').levels['engine:alpha']).toBeUndefined();
    expect(h.read('pins.json').keys).toEqual([GONE, 'room:r1', 'beta']);
    expect(h.read('groups.json').groups[0].members).toEqual(['beta']);
    expect(h.read('building.json').floors[0].characters).toEqual(['beta']);
    expect(JSON.parse(h.lines('groups/r1.2026-11.jsonl')[0]).post.sender).toBe(GONE);
    expect(h.read('tasks.json').tasks[0].project).toBe(GONE);
    expect(h.read('approvals.json').modes).toEqual({ [GONE]: 'off', beta: 'reuse' });
    expect(Object.keys(h.read('tracking.json').projects).sort()).toEqual(['beta', GONE]);
    expect(h.read('worktrees.json' as never)[0].project).toBe(GONE);
    expect(Object.keys(h.read('merge-history.json'))).toEqual([GONE]);
    expect(Object.keys(h.read('review-notes.json').notes).sort()).toEqual(['beta\0x', `${GONE}\0login`]);
    expect(h.read('protected-branches.json')).toEqual({ [GONE]: ['release'], beta: ['main'] });
    // A new project of the old name finds none of it.
    expect(takenBy(h.home, 'alpha')).toEqual([]);
  });

  it("purge: alpha's data is gone, the room history and Tasks kept under the gone name, beta untouched", () => {
    const h = populated();
    expect(purgeProjectData(h.home, 'alpha', GONE)).toEqual([]);
    expect(h.read('characters.json')).toEqual({ owner: { look: 'OWNER' }, beta: { palette: 2, hueShift: 0 }, $meta: { v: 2, auto: {} } });
    expect(h.read('levels.json').levels).toEqual({ 'engine:beta': { xp: 5, rebirths: 0 } });
    expect(h.read('pins.json').keys).toEqual(['room:r1', 'beta']);
    expect(Object.keys(h.read('roster.json').projects)).toEqual(['beta']);
    expect(h.read('groups.json').groups[0].members).toEqual(['beta']);
    expect(JSON.parse(h.lines('groups/r1.2026-11.jsonl')[0]).post.sender).toBe(GONE);
    expect(h.read('tasks.json').tasks[0].project).toBe(GONE);
    expect(h.exists('inbox/alpha') || h.exists('typed/alpha.json') || h.exists('renewals/alpha.json.failed')).toBe(false);
    expect(h.exists('queue/q1.json')).toBe(false);
    expect(h.exists('queue/q2.json')).toBe(true);
    expect(Object.keys(h.read('revive-guard.json'))).toEqual(['beta']);
    expect(h.read('approvals.json')).toMatchObject({ approvals: [], modes: { beta: 'reuse' }, newWorkers: [] });
    expect(Object.keys(h.read('tracking.json').projects)).toEqual(['beta']);
    expect(h.read('worktrees.json' as never)).toEqual([]);
    expect(h.read('merge-history.json')).toEqual({});
    expect(Object.keys(h.read('review-notes.json').notes)).toEqual(['beta\0x']);
    expect(h.read('protected-branches.json')).toEqual({ beta: ['main'] });
    expect(fs.existsSync(combinedRulesFile(h.home, 'alpha'))).toBe(false);
  });

  it('a store that fails is named and logged; the others still go', () => {
    const h = populated();
    fs.writeFileSync(path.join(h.cfg, 'levels.json'), '{broken');
    const log: string[] = [];
    // The check reads it too: an unreadable store might hold the name, so a plain move refuses.
    expect(() => moveProjectData(h.home, 'alpha', 'gamma')).toThrow(/levels\.json/);
    expect(moveProjectData(h.home, 'alpha', 'gamma', (l) => log.push(l), true)).toEqual(['levels.json']);
    expect(log[0]).toContain('levels.json not changed');
    expect(h.read('pins.json').keys[0]).toBe('gamma');
    expect(PROJECT_STORES.length).toBeGreaterThan(15);
  });

  it('name history: rename, removal, a new agent of the same name; an A -> B -> A history ends', () => {
    const h = populated();
    recordFormerName(h.home, { name: 'alpha', until: 100, as: 'gamma' });
    recordFormerName(h.home, { name: 'alpha', until: 100, as: 'gamma' }); // a roll-forward's repeat
    recordFormerName(h.home, { name: 'gamma', until: 200, as: GONE, gone: { folder: '/w/a', transcript: '/t.jsonl' } });
    const e = readNameHistory(h.home);
    expect(e).toHaveLength(2);
    expect(aliasOf(e, 'alpha', 50)).toBe(GONE); // alpha -> gamma -> removed
    expect(aliasOf(e, 'gamma', 150)).toBe(GONE);
    expect(aliasOf(e, 'gamma', 250)).toBeUndefined(); // a later gamma is itself
    expect(aliasOf(e, 'alpha', 150)).toBeUndefined();
    expect(goneAgents(e)).toEqual([{ name: GONE, at: 200, folder: '/w/a', transcript: '/t.jsonl' }]);
    const loop = [
      { name: 'a', until: 100, as: 'b' },
      { name: 'b', until: 200, as: 'a' },
    ];
    expect(aliasOf(loop, 'a', 50)).toBeUndefined(); // a -> b -> a: itself again, and it ends
    expect(aliasOf(loop, 'b', 150)).toBe('a');
  });

  it('a name-history entry with a non-string transcript is not read', () => {
    const h = populated();
    h.put('name-history.json', { v: 1, entries: [{ name: 'x', until: 1, as: GONE, gone: { folder: '/w', transcript: 42 } }, { name: 'y', until: 2, as: 'z' }] });
    expect(readNameHistory(h.home)).toEqual([{ name: 'y', until: 2, as: 'z' }]);
  });
});

describe('대화방 지우기 (deleteGoneConversation)', () => {
  it("deletes exactly the removed agent's own session files and records; rooms and others stay", () => {
    const h = populated();
    const folder = path.join(h.home, 'work', 'alpha');
    const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
    const [now, renewed, asLead, cleared, other] = [id(1), id(2), id(3), id(4), id(9)];
    const file = (sid: string) => {
      const f = transcriptPath(folder, sid, h.home);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, '{}\n');
      return f;
    };
    const mine = [now, renewed, asLead, cleared].map(file);
    fs.mkdirSync(path.join(path.dirname(mine[0]), now, 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(mine[0]), now, 'subagents', 'agent-x.jsonl'), '{}\n');
    const others = [file(other), path.join(h.home, '.claude', 'settings.json'), path.join(h.home, '.claude', 'sessions', 's.json')];
    for (const o of others.slice(1)) {
      fs.mkdirSync(path.dirname(o), { recursive: true });
      fs.writeFileSync(o, '{}');
    }
    // Its records: a renew linked `renewed` to `now`; a Lead term of its assignment held `asLead`.
    // A /clear before that renew: the engine followed `cleared` -> `renewed` (orch_follow).
    h.put(
      'events.jsonl',
      [
        { v: 1, type: 'orch_follow', name: 'alpha', old_session_id: cleared, session_id: renewed },
        { v: 1, type: 'orch_renew', name: 'alpha', old_session_id: renewed, session_id: now, ok: true },
        { v: 1, type: 'orch_renew', name: 'beta', old_session_id: other, session_id: id(8), ok: true },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n'),
    );
    h.put('lead-history.json', { v: 1, terms: [{ projectId: 'p_x', assignmentId: GONE.slice(1), sessionId: asLead, transcript: mine[2], bytes: 2, endedAt: 1 }] });
    expect(moveProjectData(h.home, 'alpha', GONE, undefined, true)).toEqual([]);
    recordFormerName(h.home, { name: 'alpha', until: 300, as: GONE, gone: { folder, transcript: mine[0], sessionId: now } });
    const rooms = h.lines('groups/r1.2026-11.jsonl');

    expect(deleteGoneConversation(h.home, '~a_zzzzzzzzzz')).toBeNull();
    expect(deleteGoneConversation(h.home, GONE)).toEqual({ deleted: 4, failed: [] });
    for (const f of mine) expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(mine[0]), now))).toBe(false);
    for (const f of others) expect(fs.existsSync(f)).toBe(true);
    expect(h.exists(`inbox/${GONE}`) || h.exists(`typed/${GONE}.json`)).toBe(false);
    expect(h.read('levels.json').levels).toEqual({ 'engine:beta': { xp: 5, rebirths: 0 } });
    expect(h.read('characters.json')[GONE]).toBeUndefined();
    expect(h.lines('groups/r1.2026-11.jsonl')).toEqual(rooms); // shared: kept
    const entry = readNameHistory(h.home).find((e) => e.as === GONE)!;
    expect(entry.gone).toEqual({ folder, sessionId: now, deleted: true });
    expect(goneAgents(readNameHistory(h.home))).toEqual([]); // off the contact list
    expect(aliasOf(readNameHistory(h.home), 'alpha', 100)).toBe(GONE); // its posts still "(알 수 없음)"
    expect(deleteGoneConversation(h.home, GONE)).toBeNull(); // once
  });
});
