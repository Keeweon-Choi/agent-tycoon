/** INHERIT (계승): a new agent in a removed one's folder takes its records over, the owner's only. */
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { configDirectory } from '../configPath.js';
import { aliasOf, deleteGoneConversation, readNameHistory } from '../projectData.js';
import { transcriptPath } from '../providers/claudeProvider.js';
import { killFakeSessions, makeEngineHome, removeTestHome } from '../testHome.js';
import { Engine } from './engine.js';

vi.setConfig({ testTimeout: 90_000 });

/** The next registry save throws (a full disk), when set. */
const failSave = vi.hoisted(() => ({ next: false }));
vi.mock('./registry.js', async (load) => {
  const real = await load<typeof import('./registry.js')>();
  return {
    ...real,
    saveRegistry: (...args: Parameters<typeof real.saveRegistry>) => {
      if (failSave.next) {
        failSave.next = false;
        throw new Error('ENOSPC: no space left on device');
      }
      return real.saveRegistry(...args);
    },
  };
});

const FAST = { pollMs: 20, appearMs: 30_000, goneMs: 30_000, reviveGapMs: 150, safetyMs: 60_000, debounceMs: 50, watchMs: 0, renewPollMs: 20 };

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

function rig() {
  const { home, claudePath } = makeEngineHome();
  const e = new Engine({ claudePath, home, readOnly: false, systemdRun: null, log: () => undefined, timing: FAST, env: { ...process.env }, binDir: null });
  e.start();
  cleanup.push(() => {
    e.dispose();
    killFakeSessions(home);
    removeTestHome(home);
  });
  const cfg = configDirectory(home);
  let n = 0;
  const act = (action: 'add' | 'start' | 'remove', name: string, fields: Record<string, unknown> = {}, device = 'linux') =>
    e.run({ type: 'engineAction', requestId: `r${++n}`, action, name, ...fields }, true, device);
  const folder = (name: string) => {
    const d = path.join(home, 'work', name);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const write = (rel: string, data: unknown) => fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  const read = (rel: string) =>
    (fs.existsSync(path.join(cfg, rel)) ? JSON.parse(fs.readFileSync(path.join(cfg, rel), 'utf-8')) : {}) as Record<string, any>;
  /** `name` added in `dir`, started (a conversation file of its own), given Lv data, removed. */
  const removed = async (name: string, dir: string, purge = false) => {
    await act('add', name, { folder: dir });
    await act('start', name);
    const p = e.state().projects.find((x) => x.name === name)!;
    const file = transcriptPath(dir, p.sessionId!, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{}\n');
    write('levels.json', { v: 1, levels: { ...(read('levels.json').levels ?? {}), [`engine:${name}`]: { xp: 120, rebirths: 3, inherit: 1 } } });
    write('characters.json', { ...read('characters.json'), [name]: { preset: 'p1' } });
    expect(await act('remove', name, purge ? { purge: true } : {})).toMatchObject({ ok: true });
    return { key: readNameHistory(home).at(-1)!.as, sessionId: p.sessionId! };
  };
  return { home, e, act, folder, read, write, removed };
}

describe('inherit', () => {
  it('lists a folder\'s removed agents whose records remain, and moves them to the heir', async () => {
    const r = rig();
    const dir = r.folder('alpha');
    const before = Date.now();
    const { key, sessionId } = await r.removed('alpha', dir);
    await r.removed('beta', r.folder('beta'));
    expect(r.e.inheritable(dir)).toEqual([
      { key, name: 'alpha', removedAt: expect.any(Number), level: 2, rebirths: 3, inherit: 1, conversations: 1 },
    ]);

    const res = await r.act('add', 'gamma', { folder: dir, inheritFrom: key });
    expect(res).toMatchObject({ ok: true, note: expect.stringContaining('2') });
    expect(r.read('levels.json').levels['engine:gamma']).toEqual({ xp: 120, rebirths: 3, inherit: 2 });
    expect(r.read('levels.json').levels[`engine:${key}`]).toBeUndefined();
    expect(r.read('characters.json').gamma).toEqual({ preset: 'p1' });
    // Its conversation goes on in the heir, as a copy (it was started as 'alpha').
    const lead = r.read('projects.json').projects.find((p: any) => p.name === 'gamma').leadAssignmentId;
    expect(r.read('assignments.json').assignments.find((a: any) => a.assignmentId === lead)).toMatchObject({ sessionId, resumeAsCopy: true });
    const history = readNameHistory(r.home);
    expect(history.find((h) => h.as === key)?.gone).toMatchObject({ deleted: true, inherited: 'gamma' });
    expect(aliasOf(history, 'alpha', before + 1)).toBe('gamma'); // the old messages read as the heir's
    expect(r.e.inheritable(dir)).toEqual([]);
  });

  it('refuses another folder, a purged record and a non-owner', async () => {
    const r = rig();
    const dir = r.folder('alpha');
    const { key } = await r.removed('alpha', dir);
    expect(await r.act('add', 'other', { folder: r.folder('other'), inheritFrom: key })).toMatchObject({ ok: false, error: expect.stringContaining('다른 폴더') });
    expect(await r.act('add', 'agent', { folder: dir, inheritFrom: key }, 'mcp')).toMatchObject({ ok: false, error: expect.stringContaining('사장님만') });
    const purged = await r.removed('beta', r.folder('beta'), true);
    expect(r.e.inheritable(r.folder('beta'))).toEqual([]);
    expect(await r.act('add', 'beta2', { folder: r.folder('beta'), inheritFrom: purged.key })).toMatchObject({ ok: false, error: expect.stringContaining('남아 있지') });
    // Nothing was added by a refusal; the first record is still there to inherit.
    expect(r.e.state().projects.map((p) => p.name)).toEqual([]);
    expect(r.e.inheritable(dir)).toHaveLength(1);
  });
});

describe('inherit: review guards', () => {
  it('a registry save that fails moves nothing: the records stay under the gone name, still offered', async () => {
    const r = rig();
    const dir = r.folder('alpha');
    const { key } = await r.removed('alpha', dir);
    failSave.next = true;
    expect(await r.act('add', 'gamma', { folder: dir, inheritFrom: key })).toMatchObject({ ok: false });
    expect(r.read('levels.json').levels[`engine:${key}`]).toMatchObject({ xp: 120 });
    expect(r.read('levels.json').levels['engine:gamma']).toBeUndefined();
    expect(r.read('characters.json')[key]).toEqual({ preset: 'p1' });
    expect(r.e.inheritable(dir).map((a) => a.key)).toEqual([key]);
  });

  it("대화방 지우기 keeps a conversation a registered agent resumes", async () => {
    const r = rig();
    const dir = r.folder('alpha');
    const { key, sessionId } = await r.removed('alpha', dir);
    expect(await r.act('add', 'gamma', { folder: dir, inheritFrom: key })).toMatchObject({ ok: true });
    // The name-history write did not land: the contact is still there to delete.
    const file = path.join(configDirectory(r.home), 'name-history.json');
    const h = JSON.parse(fs.readFileSync(file, 'utf-8'));
    h.entries = h.entries
      .filter((e: any) => e.name !== key)
      .map((e: any) => (e.as === key ? { ...e, gone: { folder: e.gone.folder, sessionId: e.gone.sessionId, transcript: e.gone.transcript } } : e));
    fs.writeFileSync(file, JSON.stringify(h));
    const lines: string[] = [];
    expect(deleteGoneConversation(r.home, key, (l) => lines.push(l), r.e.registeredSessionIds())).toMatchObject({ deleted: 0 });
    expect(fs.existsSync(transcriptPath(dir, sessionId, r.home))).toBe(true);
    expect(lines.join('\n')).toContain(`${sessionId} kept`);
  });
});
