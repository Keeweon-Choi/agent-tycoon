/** RENAME + PROJECT-DATA: `agty rename` (who may, when it applies) and remove's detach / purge. */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { goneName } from '../../../../core/src/cld/goneAgent.js';
import { configDirectory } from '../configPath.js';
import { aliasOf, readNameHistory } from '../projectData.js';
import { transcriptPath } from '../providers/claudeProvider.js';
import { engineCalls, killFakeSessions, makeEngineHome, removeTestHome } from '../testHome.js';
import { waitFor } from '../waitKit.js';
import type { ControlDeps, Reply } from './control.js';
import { answerControl } from './control.js';
import { Engine } from './engine.js';

vi.setConfig({ testTimeout: 90_000 });

const FAST = { pollMs: 20, appearMs: 30_000, goneMs: 30_000, reviveGapMs: 150, safetyMs: 60_000, debounceMs: 50, watchMs: 0, renewPollMs: 20 };

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

function rig() {
  const { home, claudePath } = makeEngineHome();
  const events: Array<Record<string, unknown>> = [];
  const e = new Engine({
    claudePath,
    home,
    readOnly: false,
    systemdRun: null,
    log: () => undefined,
    timing: FAST,
    env: { ...process.env },
    binDir: null,
    event: (type, source, fields) => events.push({ type, source, ...fields }),
  });
  e.start();
  const more: Engine[] = [];
  /** A second engine on the same HOME (the daemon started again). */
  const boot = () => {
    const e2 = new Engine({ claudePath, home, readOnly: false, systemdRun: null, log: () => undefined, timing: FAST, env: { ...process.env }, binDir: null });
    more.push(e2);
    e2.start();
    return e2;
  };
  cleanup.push(() => {
    for (const x of more) x.dispose();
    e.dispose();
    killFakeSessions(home); // only the fake sessions this test started
    removeTestHome(home);
  });
  const cfg = configDirectory(home);
  let n = 0;
  const act = (action: 'add' | 'start' | 'remove', name: string, fields: Record<string, unknown> = {}) =>
    e.run({ type: 'engineAction', requestId: `r${++n}`, action, name, ...fields }, true, 'linux');
  const folder = (name: string) => {
    const d = path.join(home, 'work', name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const project = (name: string) => e.state().projects.find((p) => p.name === name);
  const write = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(cfg, rel)), { recursive: true });
    fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  };
  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(cfg, rel), 'utf-8')) as Record<string, any>;
  /** The fake's session file for a live job: status set by hand (a turn running or over). */
  const setStatus = (id: string, status: string) => {
    const dir = path.join(home, '.claude', 'sessions');
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      const j = JSON.parse(fs.readFileSync(file, 'utf-8')) as { jobId?: string };
      if (j.jobId === id) fs.writeFileSync(file, JSON.stringify({ ...j, status }));
    }
  };
  return { home, e, boot, events, act, folder, project, write, read, setStatus };
}

describe('agty rename: who may', () => {
  const deps = (renamed: string[]): ControlDeps =>
    ({
      names: () => ['alpha', 'beta'],
      agentOf: (token: string) => ({ 'tok-alpha': 'alpha', 'tok-beta': 'beta' })[token] ?? null,
      isOwner: (c: string) => c === 'owner',
      projectAt: () => null,
      rename: (name: string, to: string): Reply => (renamed.push(`${name}->${to}`), { ok: true }),
    }) as unknown as ControlDeps;
  const ask = (args: Record<string, unknown>, who: { token?: string; owner?: string }, renamed: string[]) =>
    answerControl({ cmd: 'rename', cwd: '/', source: 'cli', args, ...who }, deps(renamed));

  it('an agent renames itself; another agent and an unidentified caller are refused; the owner renames anyone', async () => {
    const done: string[] = [];
    expect(await ask({ to: 'gamma' }, { token: 'tok-alpha' }, done)).toMatchObject({ ok: true, name: 'alpha', to: 'gamma' });
    expect(await ask({ to: 'gamma', project: 'alpha' }, { token: 'tok-alpha' }, done)).toMatchObject({ ok: true });
    expect(await ask({ to: 'gamma', project: 'beta' }, { token: 'tok-alpha' }, done)).toMatchObject({ ok: false, code: 'forbidden' });
    // An agent token wins over the owner token: still only itself.
    expect(await ask({ to: 'gamma', project: 'beta' }, { token: 'tok-alpha', owner: 'owner' }, done)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await ask({ to: 'gamma', project: 'alpha' }, {}, done)).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await ask({ to: 'gamma', project: 'beta' }, { owner: 'owner' }, done)).toMatchObject({ ok: true, name: 'beta' });
    expect(await ask({ to: 'gamma' }, { owner: 'owner' }, done)).toMatchObject({ ok: false, code: 'no_project' });
    expect(done).toEqual(['alpha->gamma', 'alpha->gamma', 'beta->gamma']);
  });

  it('project remove and its --purge are the owner\'s', async () => {
    const reqs: unknown[] = [];
    const d = {
      ...deps([]),
      workers: () => [],
      engineAction: async (req: unknown) => (reqs.push(req), { ok: true }),
    } as unknown as ControlDeps;
    const ask2 = (who: { token?: string; owner?: string }) =>
      answerControl({ cmd: 'project', cwd: '/', source: 'cli', args: { op: 'remove', name: 'alpha', purge: true }, ...who }, d);
    expect(await ask2({ token: 'tok-alpha' })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await ask2({ owner: 'owner' })).toMatchObject({ ok: true, name: 'alpha' });
    expect(reqs).toEqual([expect.objectContaining({ action: 'remove', name: 'alpha', purge: true })]);
  });
});

describe('Engine.rename', () => {
  it('waits for the turn to end, then -n <new> --resume <same conversation>; look and level follow', async () => {
    const r = rig();
    await r.act('add', 'alpha', { folder: r.folder('alpha') });
    await r.act('start', 'alpha');
    const old = r.project('alpha')!;
    // Claude writes the transcript once the conversation has a message (a resume needs it).
    const t = transcriptPath(old.folder, old.sessionId!, r.home);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, '{}\n');
    r.write('levels.json', { v: 1, levels: { 'engine:alpha': { xp: 120, rebirths: 1 } } });
    r.write('characters.json', { alpha: { preset: 'p1' } });
    r.setStatus(old.bgId!, 'busy');
    expect(r.e.rename('alpha', 'gamma', 'cli')).toEqual({ ok: true });
    expect(r.e.rename('alpha', 'delta', 'cli')).toMatchObject({ ok: false, code: 'rename_pending' });
    expect(r.e.rename('beta', 'x', 'cli')).toMatchObject({ ok: false, code: 'unknown_project' });
    await new Promise((res) => setTimeout(res, 150));
    expect(r.project('alpha')).toBeDefined(); // nothing while the turn runs
    expect(engineCalls(r.home).some((c) => c.argv[0] === 'stop')).toBe(false);
    r.setStatus(old.bgId!, 'idle'); // the turn ends
    await r.e.renameRun;
    expect(r.project('alpha')).toBeUndefined();
    expect(r.project('gamma')).toMatchObject({ live: true });
    const calls = engineCalls(r.home).map((c) => c.argv.join(' '));
    expect(calls.some((c) => c.startsWith('--bg -n gamma --resume ' + old.sessionId))).toBe(true);
    expect(r.read('levels.json').levels).toEqual({ 'engine:gamma': { xp: 120, rebirths: 1 } });
    expect(r.read('characters.json')).toEqual({ gamma: { preset: 'p1' } });
    expect(r.events.find((x) => x.type === 'orch_rename')).toMatchObject({ name: 'alpha', to: 'gamma', ok: true });
    // A message alpha sent before the rename now reads as gamma's.
    expect(aliasOf(readNameHistory(r.home), 'alpha', Date.now() - 60_000)).toBe('gamma');
  });

  it('refuses a name that is taken, reserved, holds data, or breaks the name rule; nothing changes', async () => {
    const r = rig();
    await r.act('add', 'alpha', { folder: r.folder('alpha') });
    await r.act('add', 'beta', { folder: r.folder('beta') });
    r.write('characters.json', { owner: { look: 'OWNER' }, alpha: { preset: 'p1' } });
    r.write('levels.json', { v: 1, levels: { 'engine:alpha': { xp: 1, rebirths: 0 }, 'engine:gamma': { xp: 9, rebirths: 0 } } });
    expect(r.e.rename('alpha', 'beta', 'cli')).toMatchObject({ ok: false, code: 'name_taken' });
    expect(r.e.rename('alpha', 'owner', 'cli')).toMatchObject({ ok: false, code: 'usage', error: expect.stringContaining('owner') });
    expect(r.e.rename('alpha', 'gamma', 'cli')).toMatchObject({ ok: false, code: 'name_taken', error: expect.stringContaining('levels.json') });
    expect(r.e.rename('alpha', '-bad', 'cli')).toMatchObject({ ok: false, code: 'usage' });
    expect(r.e.rename('alpha', 'alpha', 'cli')).toMatchObject({ ok: false, code: 'usage' });
    expect(r.read('characters.json')).toEqual({ owner: { look: 'OWNER' }, alpha: { preset: 'p1' } });
    expect(r.project('alpha')).toBeDefined();
  });

  it('a pending rename is bound to its agent: removed meanwhile, a new agent of the name is left alone', async () => {
    const r = rig();
    await r.act('add', 'alpha', { folder: r.folder('alpha') });
    await r.act('start', 'alpha');
    r.setStatus(r.project('alpha')!.bgId!, 'busy');
    expect(r.e.rename('alpha', 'gamma', 'cli')).toEqual({ ok: true });
    expect(await r.act('remove', 'alpha')).toMatchObject({ ok: true });
    await r.act('add', 'alpha', { folder: r.folder('alpha2') }); // another assignment, same name
    await r.e.renameRun;
    expect(r.project('alpha')).toBeDefined();
    expect(r.project('gamma')).toBeUndefined();
    expect(r.events.find((x) => x.type === 'orch_rename')).toMatchObject({ name: 'alpha', to: 'gamma', ok: false, code: 'gone' });
  });

  it('a rename and a renew of one agent are exclusive, whichever comes first', async () => {
    const r = rig();
    await r.act('add', 'alpha', { folder: r.folder('alpha') });
    await r.act('add', 'beta', { folder: r.folder('beta') });
    await r.act('start', 'alpha');
    await r.act('start', 'beta');
    r.setStatus(r.project('alpha')!.bgId!, 'busy');
    r.setStatus(r.project('beta')!.bgId!, 'busy');
    expect(r.e.rename('alpha', 'gamma', 'cli')).toEqual({ ok: true });
    expect(r.e.renew('alpha', 'HANDOFF', 'cli')).toMatchObject({ ok: false, code: 'rename_pending' });
    expect(r.e.renew('beta', 'HANDOFF', 'cli')).toEqual({ ok: true });
    expect(r.e.rename('beta', 'delta', 'cli')).toMatchObject({ ok: false, code: 'renew_pending' });
    r.e.dispose(); // both stay pending: nothing more to see
  });

  it('add refuses a name that still has data in a store, and says which', async () => {
    const r = rig();
    r.write('levels.json', { v: 1, levels: { 'engine:delta': { xp: 9, rebirths: 2 } } });
    const res = await r.act('add', 'delta', { folder: r.folder('delta') });
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('levels.json') });
    expect(r.project('delta')).toBeUndefined();
    await r.act('add', 'alpha', { folder: r.folder('alpha') });
    r.write('typed/w1.json', []);
    expect(await r.act('add', 'w1', { project: 'alpha', role: 'worker' })).toMatchObject({ ok: false, error: expect.stringContaining('typed/') });
  });

  it('a conversation the engine follows (a /clear, a resume copy) leaves an orch_follow link', async () => {
    const r = rig();
    await r.act('add', 'alpha', { folder: r.folder('alpha') });
    await r.act('start', 'alpha');
    const p = r.project('alpha')!;
    const next = '22222222-3333-4444-8555-666666666666';
    // The same job, a new conversation id (what /clear does).
    const dir = path.join(r.home, '.claude', 'sessions');
    for (const f of fs.readdirSync(dir)) {
      const file = path.join(dir, f);
      const j = JSON.parse(fs.readFileSync(file, 'utf-8')) as { jobId?: string };
      if (j.jobId === p.bgId) fs.writeFileSync(file, JSON.stringify({ ...j, sessionId: next }));
    }
    r.e.refresh(); // what the sessions folder's watch calls
    await waitFor(() => expect(r.project('alpha')!.sessionId).toBe(next));
    expect(r.events.find((x) => x.type === 'orch_follow')).toMatchObject({ name: 'alpha', old_session_id: p.sessionId, session_id: next });
  });

  it('a crash after the registry write rolls forward at the next start (rename-journal.json)', async () => {
    const r = rig();
    await r.act('add', 'alpha', { folder: r.folder('alpha') });
    r.e.dispose();
    // The crash: the registry says gamma, the journal is there, the stores still say alpha.
    const projects = r.read('projects.json');
    const id = projects.projects[0].leadAssignmentId as string;
    projects.projects[0].name = 'gamma';
    r.write('projects.json', projects);
    r.write('rename-journal.json', { v: 1, from: 'alpha', to: 'gamma', assignmentId: id, at: Date.now() });
    r.write('levels.json', { v: 1, levels: { 'engine:alpha': { xp: 40, rebirths: 1 } } });
    r.write('typed/alpha.json', []);
    const e2 = r.boot();
    expect(e2.state().projects.map((p) => p.name)).toEqual(['gamma']);
    expect(r.read('levels.json').levels).toEqual({ 'engine:gamma': { xp: 40, rebirths: 1 } });
    expect(fs.existsSync(path.join(configDirectory(r.home), 'typed/gamma.json'))).toBe(true);
    expect(fs.existsSync(path.join(configDirectory(r.home), 'rename-journal.json'))).toBe(false);
    expect(aliasOf(readNameHistory(r.home), 'alpha', Date.now() - 60_000)).toBe('gamma');
  });

  it('a journal cut short before the registry write is dropped (nothing had moved)', async () => {
    const r = rig();
    await r.act('add', 'alpha', { folder: r.folder('alpha') });
    r.e.dispose();
    const id = r.read('projects.json').projects[0].leadAssignmentId as string;
    r.write('rename-journal.json', { v: 1, from: 'alpha', to: 'gamma', assignmentId: id, at: Date.now() });
    r.write('levels.json', { v: 1, levels: { 'engine:alpha': { xp: 40, rebirths: 1 } } });
    const e2 = r.boot();
    expect(e2.state().projects.map((p) => p.name)).toEqual(['alpha']);
    expect(r.read('levels.json').levels).toEqual({ 'engine:alpha': { xp: 40, rebirths: 1 } });
    expect(fs.existsSync(path.join(configDirectory(r.home), 'rename-journal.json'))).toBe(false);
  });
});

describe('remove: detach or purge', () => {
  async function removed(purge: boolean) {
    const r = rig();
    const dir = r.folder('alpha');
    await r.act('add', 'alpha', { folder: dir });
    await r.act('start', 'alpha');
    const p = r.project('alpha')!;
    const mine = transcriptPath(dir, p.sessionId!, r.home);
    fs.mkdirSync(path.dirname(mine), { recursive: true });
    fs.writeFileSync(mine, '{}\n');
    // Another agent's conversation in the same folder.
    const other = path.join(path.dirname(mine), '11111111-2222-4333-8444-555555555555.jsonl');
    fs.writeFileSync(other, '{}\n');
    r.write('levels.json', { v: 1, levels: { 'engine:alpha': { xp: 120, rebirths: 3 } } });
    r.write('characters.json', { alpha: { preset: 'p1' } });
    const before = Date.now() - 1;
    const res = await r.act('remove', 'alpha', purge ? { purge: true } : {});
    expect(res).toMatchObject({ ok: true });
    const entry = readNameHistory(r.home).at(-1)!;
    expect(entry).toMatchObject({ name: 'alpha', as: expect.stringMatching(/^~a_/), gone: { folder: dir, transcript: mine } });
    return { r, mine, other, gone: entry.as, before };
  }

  it('purge deletes the data, never a conversation file (its own or another agent\'s)', async () => {
    const { r, mine, other } = await removed(true);
    expect(r.read('levels.json').levels).toEqual({});
    expect(r.read('characters.json')).toEqual({});
    expect(fs.existsSync(mine) && fs.existsSync(other)).toBe(true);
  });

  it('a new project of the same name inherits neither history nor level (point 3)', async () => {
    const { r, gone, before } = await removed(false);
    expect(r.read('levels.json').levels).toEqual({ [`engine:${gone}`]: { xp: 120, rebirths: 3 } });
    expect(gone).toBe(goneName(gone.slice(1)));
    await r.act('add', 'alpha', { folder: r.folder('alpha2') });
    expect(r.read('levels.json').levels['engine:alpha']).toBeUndefined();
    expect(r.read('characters.json').alpha).toBeUndefined();
    const history = readNameHistory(r.home);
    expect(aliasOf(history, 'alpha', before)).toBe(gone); // the old one's messages
    expect(aliasOf(history, 'alpha', Date.now() + 1)).toBeUndefined(); // the new one's are its own
    await waitFor(() => expect(r.project('alpha')).toBeDefined());
  });
});
