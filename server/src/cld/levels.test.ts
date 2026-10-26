import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { appendEvent, eventsPath } from './engine/events.js';
import { levelFloor, levelOf, LevelStore, levelView, XP_JOB, XP_TOOL, XP_TURN } from './levels.js';
import { ROSTER, startEngineOffice } from './officeTestKit.js';

const dirs: string[] = [];
const file = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-levels-'));
  dirs.push(d);
  return path.join(d, 'levels.json');
};
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('level curve', () => {
  it('starts at Lv 1 and each level asks 100 more XP than the last', () => {
    expect([0, 99, 100, 299, 300, 599, 600].map(levelOf)).toEqual([1, 1, 2, 2, 3, 3, 4]);
    expect([1, 2, 3, 4].map(levelFloor)).toEqual([0, 100, 300, 600]);
  });

  it('levelOf and levelFloor agree for every level', () => {
    for (let n = 1; n < 200; n++) {
      expect(levelOf(levelFloor(n))).toBe(n);
      expect(levelOf(levelFloor(n + 1) - 1)).toBe(n);
    }
  });

  it('the view says where the bar starts and ends', () => {
    expect(levelView(130, 2)).toEqual({ level: 2, xp: 130, floor: 100, next: 300, rebirths: 2 });
  });
});

describe('LevelStore', () => {
  it('counts a completed turn (active -> waiting) and each tool once', () => {
    const s = new LevelStore(file());
    s.observe(1, 'engine:a', { type: 'agentStatus', status: 'waiting' }); // no turn was running
    s.observe(1, 'engine:a', { type: 'agentStatus', status: 'active' });
    s.observe(1, 'engine:a', { type: 'agentToolStart', toolId: 't1' });
    s.observe(1, 'engine:a', { type: 'agentToolStart', toolId: 't1' }); // the hook path reports it too
    s.observe(1, 'engine:a', { type: 'agentToolStart', toolId: 't2' });
    s.observe(1, 'engine:a', { type: 'agentStatus', status: 'waiting' });
    s.observe(1, 'engine:a', { type: 'agentStatus', status: 'waiting' }); // text-idle timer repeats it
    expect(s.view('engine:a')?.xp).toBe(XP_TURN + 2 * XP_TOOL);
    s.dispose();
  });

  it('rebirth counts only a renew that started the new conversation', () => {
    const s = new LevelStore(file());
    s.observeEvent({ type: 'orch_renew', name: 'a', ok: false, code: 'not_idle' });
    expect(s.view('engine:a')?.rebirths).toBe(0);
    s.observeEvent({ type: 'orch_renew', name: 'a', ok: true });
    s.observeEvent({ type: 'orch_renew', name: 'a', ok: true });
    expect(s.view('engine:a')?.rebirths).toBe(2);
    s.dispose();
  });

  it('a finished job or Codex task earns XP; a failed or stopped one does not', () => {
    const s = new LevelStore(file());
    s.observeEvent({ type: 'job_end', project: 'a', exit: 0 });
    s.observeEvent({ type: 'job_end', project: 'a', exit: 1 });
    s.observeEvent({ type: 'job_end', project: 'a', exit: 0, stopped: true });
    s.observeEvent({ type: 'codex_end', project: 'a', state: 'done' });
    s.observeEvent({ type: 'codex_end', project: 'a', state: 'failed' });
    expect(s.view('engine:a')?.xp).toBe(2 * XP_JOB);
    s.dispose();
  });

  it('D5: a Codex Worker’s finished run earns its own character the XP, not its project’s', () => {
    const s = new LevelStore(file());
    s.observeEvent({ type: 'codex_end', project: 'a', agent: 'a-w1', state: 'done' });
    expect(s.view('engine:a-w1')?.xp).toBe(XP_JOB);
    expect(s.view('engine:a')?.xp ?? 0).toBe(0);
    s.dispose();
  });

  it('a Codex task counts once: it is a job (kind codex) and ends with codex_end too', () => {
    const s = new LevelStore(file());
    s.observeEvent({ type: 'job_end', project: 'a', exit: 0, kind: 'codex' });
    s.observeEvent({ type: 'codex_end', project: 'a', state: 'done' });
    expect(s.view('engine:a')?.xp).toBe(XP_JOB);
    s.dispose();
  });

  it('an unnamed session has no level to keep', () => {
    const s = new LevelStore(file());
    s.addXp('sid:abc', 50);
    expect(s.view('sid:abc')).toBeUndefined();
    s.dispose();
  });

  it('writes 0600 after the debounce, announces it once, and a new store reads it back', () => {
    vi.useFakeTimers();
    const f = file();
    const changed = vi.fn();
    const s = new LevelStore(f, changed, 1000);
    s.addXp('engine:a', 120);
    s.rebirth('engine:a');
    expect(fs.existsSync(f)).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(new LevelStore(f).view('engine:a')).toMatchObject({ xp: 120, rebirths: 1, level: 2 });
  });

  it('dispose flushes what is pending', () => {
    const f = file();
    const s = new LevelStore(f, () => undefined, 60_000);
    s.addXp('engine:a', 5);
    s.dispose();
    expect(new LevelStore(f).view('engine:a')?.xp).toBe(5);
  });

  it('a corrupt file is kept aside as levels.json.corrupt-<time>, never overwritten', () => {
    vi.useFakeTimers();
    const f = file();
    const bytes = '{"v":1,"levels":{"engine:a":{"xp":5000,"rebirths":3}'; // cut off mid-write
    fs.writeFileSync(f, bytes);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const s = new LevelStore(f, () => undefined, 1000);
    expect(s.view('engine:a')).toMatchObject({ xp: 0, level: 1 });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    s.addXp('engine:a', 2);
    vi.advanceTimersByTime(1000); // the next write
    const aside = fs.readdirSync(path.dirname(f)).filter((n) => n.startsWith('levels.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(path.dirname(f), aside[0]), 'utf-8')).toBe(bytes);
    expect(new LevelStore(f).view('engine:a')?.xp).toBe(2);
  });

  it('forget drops a removed character\'s status and tool memory', () => {
    const s = new LevelStore(file());
    s.observe(1, 'engine:a', { type: 'agentStatus', status: 'active' });
    s.observe(1, 'engine:a', { type: 'agentToolStart', toolId: 't1' });
    s.forget(1);
    s.observe(1, 'engine:a', { type: 'agentStatus', status: 'waiting' }); // no turn is known to run
    s.observe(1, 'engine:a', { type: 'agentToolStart', toolId: 't1' }); // a new tool again
    expect(s.view('engine:a')?.xp).toBe(2 * XP_TOOL);
    s.dispose();
  });
});

describe('the office keeps and shows them', () => {
  it('observed work and a renew reach the snapshot row; history and other rows earn nothing', async () => {
    const { office, home, store, messages, stop, agentId } = await startEngineOffice({ projects: ROSTER });
    office.onClientOpened(() => undefined); // someone is looking: the flush republishes the snapshot
    const id = agentId('alpha');
    store.broadcast({ type: 'agentStatus', id, status: 'active' });
    store.broadcast({ type: 'agentToolStart', id, toolId: 'x1' });
    store.broadcast({ type: 'agentStatus', id, status: 'waiting' });
    store.broadcast({ type: 'agentToolStart', id: 999, toolId: 'x2' }); // no such character
    appendEvent(eventsPath(home), 'orch_renew', 'engine', { name: 'alpha', ok: true });
    await vi.waitFor(() => expect(office.officeState().orchestrators.find((o) => o.name === 'alpha')?.level?.rebirths).toBe(1));
    stop(); // flushes the debounce
    const row = (name: string) =>
      (
        [...messages].reverse().find((m) => m.type === 'officeSnapshot') as unknown as {
          orchestrators: Array<{ name: string; level?: Record<string, number> }>;
        }
      ).orchestrators.find((o) => o.name === name);
    expect(row('alpha')?.level).toMatchObject({ xp: XP_TURN + XP_TOOL, level: 1, rebirths: 1 });
    expect(row('beta')?.level).toMatchObject({ xp: 0, level: 1, rebirths: 0 });
    const disk = JSON.parse(fs.readFileSync(`${home}/.config/agent-tycoon/levels.json`, 'utf-8'));
    expect(disk.levels['engine:alpha']).toEqual({ xp: XP_TURN + XP_TOOL, rebirths: 1 });
  });

  it('with nobody watching the flush writes the file and builds no snapshot', async () => {
    const { office, home, store, messages, stop, agentId } = await startEngineOffice({ projects: ROSTER });
    const snapshots = () => messages.filter((m) => m.type === 'officeSnapshot').length;
    const id = agentId('alpha');
    const before = snapshots();
    store.broadcast({ type: 'agentStatus', id, status: 'active' });
    store.broadcast({ type: 'agentStatus', id, status: 'waiting' });
    stop(); // flushes the debounce
    expect(snapshots()).toBe(before);
    const disk = JSON.parse(fs.readFileSync(`${home}/.config/agent-tycoon/levels.json`, 'utf-8'));
    expect(disk.levels['engine:alpha'].xp).toBe(XP_TURN);
    expect(office.officeState().orchestrators.find((o) => o.name === 'alpha')?.level?.xp).toBe(XP_TURN);
  });

  it('a renew already in events.jsonl when the office starts is history: no rebirth; a live one is', async () => {
    const first = await startEngineOffice({ projects: ROSTER });
    const { home } = first;
    first.stop();
    appendEvent(eventsPath(home), 'orch_renew', 'engine', { name: 'alpha', ok: true });
    appendEvent(eventsPath(home), 'job_end', 'job', { project: 'alpha', exit: 0 });
    const { office, stop } = await startEngineOffice({ home });
    const rebirths = () =>
      office.officeState().orchestrators.find((o) => o.name === 'alpha')?.level?.rebirths;
    expect(rebirths()).toBe(0);
    expect(office.officeState().orchestrators.find((o) => o.name === 'alpha')?.level?.xp).toBe(0);
    appendEvent(eventsPath(home), 'orch_renew', 'engine', { name: 'alpha', ok: true });
    await vi.waitFor(() => expect(rebirths()).toBe(1));
    stop();
  });
});
