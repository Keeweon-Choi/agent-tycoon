// EX-3j (P0, D3): a home holding today's (D2) stores -- projects.json v2 +
// assignments.json v1, DMs with history, two rooms with members and posts with
// mentions, a queued message and an inbox file, pins, agent tokens -- shows the
// same in the office and the CLI after D3 loads it and after two Workers join a
// project; none of those stores is rewritten; a mention still reaches the same
// session. D3b: before any swap a start writes nothing of its own (a 9-Lead home too).
import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { codexDir } from './engine/codex.js';
import { readRecords } from './engine/git/worktrees.js';
import type { Typist } from './engine/messenger.js';
import { startEngineOffice } from './officeTestKit.js';
import { transcriptPath } from './providers/claudeProvider.js';
import { makeEngineHome, removeTestHome, REPO_ROOT } from './testHome.js';

const WAIT = { timeout: 20_000, interval: 50 };
const run = promisify(execFile);
const CLI = path.join(REPO_ROOT, 'cld/bin/cld-gui');
const SID = { alpha: '1a1a1a1a-0000-4000-8000-00000000000a', beta: '2b2b2b2b-0000-4000-8000-00000000000b' };
const BG = { alpha: 'bgalpha01', beta: 'bgbeta001' };
const TOKEN = { alpha: 'A'.repeat(43), beta: 'B'.repeat(43) };

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0).reverse()) c();
});

/** /proc start time; none off Linux, where liveness is the pid alone (claudeProvider.processAlive). */
const procStart = (pid: number): string | undefined => {
  if (process.platform !== 'linux') return undefined;
  const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  return s.slice(s.lastIndexOf(')') + 2).split(' ')[19];
};
const at = (minute: number) => `2026-10-23T01:${String(minute).padStart(2, '0')}:00.000Z`;
const user = (text: string, minute: number, uuid: string) =>
  JSON.stringify({ type: 'user', uuid, timestamp: at(minute), message: { role: 'user', content: text } });
const reply = (text: string, minute: number, uuid: string, tool = false) =>
  JSON.stringify({
    type: 'assistant',
    uuid,
    timestamp: at(minute),
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text },
        ...(tool ? [{ type: 'tool_use', id: `t-${uuid}`, name: 'Bash', input: { command: 'make' } }] : []),
      ],
    },
  });

/** Today's stores, as a D2 daemon left them, with both sessions live (alpha mid-turn). */
function d2Home(): { home: string; files: () => Record<string, string> } {
  const { home } = makeEngineHome();
  cleanup.push(() => removeTestHome(home));
  const cfg = path.join(home, '.config', 'agent-tycoon');
  const put = (rel: string, text: string) => {
    const f = path.join(cfg, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
    fs.writeFileSync(f, text, { mode: 0o600 });
  };
  const folder = { alpha: path.join(home, 'work', 'alpha'), beta: path.join(home, 'work', 'beta') };
  for (const f of Object.values(folder)) fs.mkdirSync(f, { recursive: true });
  put(
    'projects.json',
    `${JSON.stringify(
      {
        v: 2,
        projects: [
          { projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: folder.alpha, room: 'lab', leadAssignmentId: 'a_aaaaaaaaaa' },
          { projectId: 'p_bbbbbbbbbb', name: 'beta', folder: folder.beta, leadAssignmentId: 'a_bbbbbbbbbb' },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const lead = (name: 'alpha' | 'beta', id: string, projectId: string) => ({
    assignmentId: id,
    projectId,
    role: 'lead',
    provider: 'claude',
    model: 'opus',
    wantRunning: true,
    sessionId: SID[name],
    backgroundId: BG[name],
  });
  put(
    'assignments.json',
    `${JSON.stringify(
      { v: 1, assignments: [lead('alpha', 'a_aaaaaaaaaa', 'p_aaaaaaaaaa'), lead('beta', 'a_bbbbbbbbbb', 'p_bbbbbbbbbb')] },
      null,
      2,
    )}\n`,
  );
  // DMs with history (the sessions' transcripts).
  const transcript = (name: 'alpha' | 'beta', lines: string[]) => {
    const t = transcriptPath(folder[name], SID[name], home);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, `${lines.join('\n')}\n`);
  };
  transcript('alpha', [
    user('[사장 · 메신저 · 10-23 10:00]\n배포 상태 알려 줘', 0, 'ua1'),
    reply('배포 끝났어요. 로그는 logs/deploy.txt', 1, 'aa1'),
    user("[사장 · 단톡방 'dev' · 10-23 10:02]\n@alpha @beta 배포 확인", 2, 'ua2'),
    reply('dev 방: 확인했어요', 3, 'aa2'),
    user('[사장 · 메신저 · 10-23 10:04]\n다음 작업 해 줘', 4, 'ua3'),
    reply('테스트 돌리는 중', 5, 'aa3', true), // its turn still runs: the queued message waits
  ]);
  transcript('beta', [
    user('[cld-gui · alpha에게서 · 10-23 10:00]\n리뷰 부탁해', 0, 'ub1'),
    reply('리뷰 남겼어요', 1, 'ab1'),
    user("[사장 · 단톡방 'dev' · 10-23 10:02]\n@alpha @beta 배포 확인", 2, 'ub2'),
    reply('beta 도 확인', 3, 'ab2'),
    JSON.stringify({ type: 'system', subtype: 'turn_duration', timestamp: at(3) }),
  ]);
  // Live background sessions (not the fake's: a plain process, so no stop kills them).
  for (const name of ['alpha', 'beta'] as const) {
    const child = spawn('sleep', ['600'], { stdio: 'ignore' });
    cleanup.push(() => child.kill('SIGKILL'));
    const pid = child.pid!;
    const dir = path.join(home, '.claude', 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${pid}.json`),
      JSON.stringify({
        pid,
        procStart: procStart(pid),
        sessionId: SID[name],
        cwd: folder[name],
        kind: 'bg',
        name,
        jobId: BG[name],
        status: name === 'alpha' ? 'busy' : 'idle',
        startedAt: Date.parse(at(0)),
      }),
    );
  }
  // Two rooms with members, posts with mentions and their deliveries.
  put(
    'groups.json',
    `${JSON.stringify({ v: 1, groups: [{ id: 'devroom01', name: 'dev', members: ['alpha', 'beta'] }, { id: 'opsroom01', name: 'ops', members: ['beta'] }] })}\n`,
  );
  const post = (id: string, minute: number, text: string, targets: string[], roomName: string, sender: string | null = null) =>
    JSON.stringify({
      v: 1,
      kind: 'post',
      post: { id, at: Date.parse(at(minute)), roomName, sender, text, targets, delivery: Object.fromEntries(targets.map((t) => [t, 'pending'])) },
    });
  const delivered = (id: string, member: string) => JSON.stringify({ v: 1, kind: 'delivery', id, member, state: 'delivered' });
  put(
    'groups/devroom01.jsonl',
    `${[post('p1', 2, '@alpha @beta 배포 확인', ['alpha', 'beta'], 'dev'), delivered('p1', 'alpha'), delivered('p1', 'beta'), post('p2', 6, '그냥 메모', [], 'dev')].join('\n')}\n`,
  );
  put('groups/opsroom01.jsonl', `${[post('p3', 7, '@beta 로그 봐 줘', ['beta'], 'ops', 'alpha'), delivered('p3', 'beta')].join('\n')}\n`);
  // A queued message (alpha is mid-turn) and an inbox file.
  const created = Date.parse(at(8));
  put(
    `queue/${created}-abc123.json`,
    JSON.stringify({ v: 1, to: 'alpha', text: '끝나면 이것도', from: null, source: 'messenger:pc', ifIdle: false, created }),
  );
  put('inbox/beta/20261023-100900-abc.md', '[사장 · 메신저 · 10-23 10:09]\n꺼져 있을 때 보낸 글');
  // Pins (favourites) and the agents' tokens.
  put('pins.json', JSON.stringify({ v: 1, keys: ['alpha', 'room:devroom01'] }));
  const hash = (t: string) => createHash('sha256').update(t).digest('hex');
  put('agent-tokens.json', JSON.stringify({ v: 1, tokens: { alpha: hash(TOKEN.alpha), beta: hash(TOKEN.beta) } }));

  const stores = ['projects.json', 'assignments.json', 'groups.json', 'groups', 'queue', 'inbox', 'pins.json', 'agent-tokens.json'];
  const files = () => {
    const out: Record<string, string> = {};
    const walk = (rel: string) => {
      const abs = path.join(cfg, rel);
      if (!fs.existsSync(abs)) return;
      if (fs.statSync(abs).isDirectory()) for (const n of fs.readdirSync(abs).sort()) walk(path.join(rel, n));
      else out[rel] = fs.readFileSync(abs, 'utf-8');
    };
    stores.forEach(walk);
    for (const name of ['alpha', 'beta'] as const)
      out[`transcript:${name}`] = fs.readFileSync(transcriptPath(folder[name], SID[name], home), 'utf-8');
    return out;
  };
  return { home, files };
}

/** What the office and the CLI show for today's conversations (runtime agent ids left out). */
async function shown(home: string, typed: Array<{ id: string; text: string }>) {
  const typist: Typist = { type: (id, text) => (typed.push({ id, text }), Promise.resolve('typed')) };
  const t = await startEngineOffice({ home, readOnly: false, chat: true, extra: { typist } });
  const got: Array<Record<string, unknown>> = [];
  const send = (m: Record<string, unknown>) => got.push(m);
  t.office.onClientReady(send); // the snapshot a page gets (rooms, pins, …)
  type Contact = { agentId: number; name: string; project?: string; preview?: string };
  /** The newest message of a type this client got (published ones: from `t.messages`). */
  const latest = <T,>(
    type: string,
    pick: (m: Record<string, unknown>) => boolean = () => true,
    from: Array<Record<string, unknown>> = got,
  ) => [...from].reverse().find((m) => m.type === type && pick(m)) as T | undefined;
  const contacts = await vi.waitFor(() => {
    t.office.recompute();
    const list =
      latest<{ contacts: Contact[] }>('messengerContacts', undefined, t.messages)?.contacts ?? [];
    for (const name of ['alpha', 'beta']) expect(list.find((c) => c.name === name)?.preview).toBeTruthy();
    return list;
  }, WAIT);
  const rooms = latest<{ rooms: Array<{ id: string; name: string; members: string[] }> }>('groupRooms')!.rooms;
  const timelines: Record<string, unknown> = {};
  for (const room of rooms) {
    t.office.onClientMessage({ type: 'groupView', room: room.id, on: true }, send, true);
    timelines[room.id] = await vi.waitFor(() => {
      const m = latest<{ posts: unknown[] }>('groupTimeline', (x) => (x.room as { id: string }).id === room.id);
      expect(m).toBeDefined();
      return m!.posts;
    }, WAIT);
  }
  const chats: Record<string, unknown> = {};
  for (const name of ['alpha', 'beta']) {
    const agentId = contacts.find((c) => c.name === name)!.agentId;
    t.office.onClientMessage({ type: 'chatView', agentId, on: true }, send, true);
    chats[name] = await vi.waitFor(() => {
      const m = latest<Record<string, unknown>>('chatTranscript', (x) => x.agentId === agentId);
      expect(m).toBeDefined();
      const { agentId: _id, ...rest } = m!;
      return rest;
    }, WAIT);
  }
  // Asynchronous: the daemon answering it lives in this process.
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await run(process.execPath, [CLI, ...args], {
          env: { ...process.env, HOME: home, CLD_OUTPUT: 'json' },
          encoding: 'utf8',
          timeout: 15_000,
        })
      ).stdout,
    ) as unknown;
  const view = {
    contacts: contacts
      .filter((c) => !c.project)
      .map(({ agentId: _id, ...c }) => c)
      .sort((a, b) => a.name.localeCompare(b.name)),
    rooms,
    timelines,
    chats,
    pins: latest('pinnedConversations'),
    cli: {
      groups: await cli('groups'),
      dev: await cli('groups', 'read', 'dev'),
      ops: await cli('groups', 'read', 'ops'),
    },
    tokens: { alpha: t.office.engine!.tokens.agentOf(TOKEN.alpha), beta: t.office.engine!.tokens.agentOf(TOKEN.beta) },
    workers: contacts.filter((c) => c.project).map((c) => [c.name, c.project]),
  };
  return { t, send, view };
}

describe('EX-3j: today’s DMs, rooms, mentions, history, queue, pins and tokens survive D3', () => {
  it('the same contact list, rooms, members, timelines, queue, favourites and tokens; nothing rewritten', async () => {
    const { home, files } = d2Home();
    const original = files();
    // D3b: every file under the config dir, for "before any swap nothing new is written".
    const everything = () => {
      const cfg = path.join(home, '.config', 'agent-tycoon');
      const out: Record<string, string> = {};
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.isFile()) out[path.relative(cfg, p)] = fs.readFileSync(p, 'utf-8');
        }
      };
      walk(cfg);
      return out;
    };
    const allBefore = everything();
    const typed: Array<{ id: string; text: string }> = [];

    // 1. D3 loads today's stores.
    const before = await shown(home, typed);
    // The one-off D2-vs-D3 comparison runs this file in a D2 checkout too and diffs the dumps.
    if (process.env.EX3J_DUMP) {
      fs.writeFileSync(process.env.EX3J_DUMP, JSON.stringify(before.view, null, 1));
      before.t.stop();
      return;
    }
    // What a D2 office showed for these stores (derived from the fixture, not from this code).
    expect(before.view.contacts.map((c) => [c.name, c.preview])).toEqual([
      ['alpha', '테스트 돌리는 중'],
      ['beta', '리뷰 남겼어요'], // the room turn after it stays out of the DM (T-0119)
    ]);
    expect(before.view.rooms.map((r) => [r.name, r.members])).toEqual([
      ['전체', ['alpha', 'beta']],
      ['dev', ['alpha', 'beta']],
      ['ops', ['beta']],
    ]);
    expect(
      (before.view.timelines.devroom01 as Array<{ id: string; targets: string[]; delivery: unknown }>).map((p) => [p.id, p.targets, p.delivery]),
    ).toEqual([
      ['p1', ['alpha', 'beta'], { alpha: 'delivered', beta: 'delivered' }],
      ['p2', [], {}],
    ]);
    expect((before.view.chats.alpha as { queued?: Array<{ text: string }> }).queued?.map((q) => q.text)).toEqual(['끝나면 이것도']);
    // C2: none of these records has a mark, so they pair by their header text as before:
    // the DMs show each prompt and its reply in order, the room post gathers both replies,
    // and no id appears anywhere.
    type Item = { kind: string; text: string; from?: string; fromName?: string };
    const said = (chat: unknown) => (chat as { items: Item[] }).items.map((i) => [i.kind, i.text, i.from ?? null]);
    expect(said(before.view.chats.alpha)).toEqual([
      ['user', '배포 상태 알려 줘', null],
      ['assistant', '배포 끝났어요. 로그는 logs/deploy.txt', null],
      ['user', '다음 작업 해 줘', null],
      ['assistant', '테스트 돌리는 중', null],
      ['tool', 'Running: make', null],
    ]);
    expect(said(before.view.chats.beta)).toEqual([
      ['user', '리뷰 부탁해', 'peer'],
      ['assistant', '리뷰 남겼어요', null],
    ]);
    expect(
      (before.view.timelines.devroom01 as Array<{ replies: Array<{ member: string; items: Item[] }> }>)[0].replies.map((r) => [
        r.member,
        r.items.map((i) => i.text),
      ]),
    ).toEqual([
      ['alpha', ['dev 방: 확인했어요']],
      ['beta', ['beta 도 확인']],
    ]);
    expect(JSON.stringify(before.view)).not.toContain('messageId');
    expect(before.view.pins).toEqual({ type: 'pinnedConversations', keys: ['alpha', 'room:devroom01'] });
    expect(before.view.tokens).toEqual({ alpha: 'alpha', beta: 'beta' });
    expect(before.view.workers).toEqual([]);
    before.t.stop();
    expect(files()).toEqual(original); // loading rewrote nothing
    // D3b: before any swap no file changes and nothing of D3b's appears (no lead-history.json,
    // no journal); only what every start wrote before D3b (on a used machine: there already).
    const allAfter = everything();
    expect({
      added: Object.keys(allAfter).filter((k) => !(k in allBefore)).sort(),
      changed: Object.keys(allBefore).filter((k) => allAfter[k] !== allBefore[k]),
    }).toEqual({ added: ['characters.json', 'characters/README.md', 'engine.boot', 'host.json'], changed: [] });
    // CH-1: the first start pins every character's look, then $meta.
    expect(JSON.parse(allAfter['characters.json']).$meta).toMatchObject({ v: 2 });
    expect(typed).toEqual([]); // and typed nothing (alpha is mid-turn, the inbox waits for a start)

    // 2. Two Workers join alpha (the upgrade in use): only assignments.json gains them.
    const upgrade = await shown(home, typed);
    for (const name of ['alpha-a', 'alpha-b']) {
      upgrade.t.office.onClientMessage(
        { type: 'engineAction', requestId: `add-${name}`, action: 'add', name, role: 'worker', project: 'alpha' },
        upgrade.send,
        true,
      );
      await vi.waitFor(() => expect(upgrade.t.office.engine!.names()).toContain(name), WAIT);
    }
    upgrade.t.stop();
    const now = files();
    expect({ ...now, 'assignments.json': '' }).toEqual({ ...original, 'assignments.json': '' });
    const leads = (text: string) =>
      (JSON.parse(text) as { assignments: Array<{ role: string }> }).assignments.filter((a) => a.role === 'lead');
    expect(leads(now['assignments.json'])).toEqual(leads(original['assignments.json']));

    // 3. D3 loads it again: everything that was there shows the same.
    const after = await shown(home, typed);
    const { workers, ...same } = after.view;
    const { workers: _none, ...was } = before.view;
    expect(same).toEqual(was);
    expect(workers).toEqual([
      ['alpha-a', 'alpha'],
      ['alpha-b', 'alpha'],
    ]);
    expect({ ...files(), 'assignments.json': '' }).toEqual({ ...original, 'assignments.json': '' });

    // 4. A mention reaches the same session it did: beta's live one.
    after.t.office.onClientMessage({ type: 'groupPost', requestId: 'm1', room: 'ops', text: '@beta 다시 확인' }, after.send, true);
    await vi.waitFor(() => expect(typed).toHaveLength(1), WAIT);
    expect(typed[0].id).toBe(BG.beta);
    // C2: a new post is delivered with its mark; the old posts and files stay as they were.
    expect(typed[0].text).toMatch(/^\[사장 · 단톡방 'ops' · [^\]]+\] ⟨m:[a-z2-7]{8}⟩\n@beta 다시 확인$/);
    expect(files()['groups/opsroom01.jsonl'].startsWith(original['groups/opsroom01.jsonl'])).toBe(true);
    after.t.stop();
  }, 120_000);
});

// D3b: a home shaped like this machine's (9 Leads, assignments.json v1, titles, remote control,
// the orchestrator rules for 8 of 9, no Worker): a D3b daemon start writes nothing of its own.
describe('D3b: before any swap the daemon writes nothing new', () => {
  it('9 Leads and no Worker: no file changes, no lead-history.json, no journal (D5: an old Codex record neither; W2: an old worktrees.json neither)', async () => {
    const { home } = makeEngineHome();
    cleanup.push(() => removeTestHome(home));
    const cfg = path.join(home, '.config', 'agent-tycoon');
    const rules = path.join(home, 'rules-engine.md');
    fs.writeFileSync(rules, '# rules\n');
    const names = ['ops-lead', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
    const pid = (i: number) => `p_${String.fromCharCode(97 + i).repeat(10)}`;
    const aid = (i: number) => `a_${String.fromCharCode(97 + i).repeat(10)}`;
    const projects = names.map((name, i) => {
      const folder = path.join(home, 'work', name);
      fs.mkdirSync(folder, { recursive: true });
      return { projectId: pid(i), name, folder, room: i < 4 ? 'dev' : 'ops', leadAssignmentId: aid(i) };
    });
    const assignments = names.map((name, i) => ({
      assignmentId: aid(i),
      projectId: pid(i),
      role: 'lead',
      provider: 'claude',
      title: name === 'ops-lead' ? 'ops-lead' : `${name} lead`,
      remoteControl: true,
      ...(i > 0 && { rulesFile: rules }),
      wantRunning: false,
    }));
    fs.mkdirSync(cfg, { recursive: true });
    fs.writeFileSync(path.join(cfg, 'projects.json'), `${JSON.stringify({ v: 2, projects }, null, 2)}\n`);
    fs.writeFileSync(path.join(cfg, 'assignments.json'), `${JSON.stringify({ v: 1, assignments }, null, 2)}\n`);
    // W2: a worktrees.json from before W2 (no taskId, assignmentId, createdBy): read, never rewritten.
    const oldTree = { project: 'p1', task: 'codex-1022-041502', path: path.join(projects[1].folder, '.worktrees', 'codex-1022-041502'), branch: 'task/codex-1022-041502', base: 'main', created: '2026-10-22T04:15:02.000Z', status: 'active' };
    fs.writeFileSync(path.join(cfg, 'worktrees.json'), `${JSON.stringify([oldTree], null, 2)}\n`);
    const everything = () => {
      const out: Record<string, string> = {};
      const walk = (dir: string) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          const p = path.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.isFile()) out[path.relative(cfg, p)] = fs.readFileSync(p, 'utf-8');
        }
      };
      walk(cfg);
      return out;
    };
    // D5: a `cld-gui codex` record from before D5 (no Worker in it): read, never rewritten or told.
    const codexState = codexDir(home);
    fs.mkdirSync(codexState, { recursive: true });
    const oldRun = {
      id: '1023-100000-p1',
      project: 'p1',
      model: null,
      state: 'done',
      dir: projects[1].folder,
      worktree: null,
      branch: null,
      base: null,
      spec: path.join(home, 'spec.md'),
      started: '2026-10-23T10:00:00+09:00',
      ended: '2026-10-23T10:05:00+09:00',
      exit: 0,
      resetAt: null,
      sid: null,
      commits: null,
      jobId: '1023-100000-p1',
      log: '/nowhere.log',
      pid: 4242,
      source: 'cli',
    };
    fs.writeFileSync(path.join(codexState, `${oldRun.id}.json`), `${JSON.stringify(oldRun)}\n`);
    const codexFiles = () => Object.fromEntries(fs.readdirSync(codexState).map((f) => [f, fs.readFileSync(path.join(codexState, f), 'utf-8')]));
    const codexBefore = codexFiles();
    const before = everything();
    const t = await startEngineOffice({ home, readOnly: false, chat: true });
    t.office.recompute();
    expect(t.office.engine!.names()).toEqual(names);
    expect(t.office.codex!.records().map((r) => r.id)).toEqual([oldRun.id]);
    expect(readRecords(path.join(cfg, 'worktrees.json'))).toEqual([oldTree]);
    expect(t.office.repos.worktrees.forTask('p1', 'T-1')).toBeUndefined();
    t.stop();
    const after = everything();
    expect({
      added: Object.keys(after).filter((k) => !(k in before)).sort(),
      changed: Object.keys(before).filter((k) => after[k] !== before[k]),
    }).toEqual({ added: ['characters.json', 'characters/README.md', 'engine.boot', 'host.json'], changed: [] });
    expect(JSON.parse(after['characters.json']).$meta).toMatchObject({ v: 2 }); // CH-1 pin
    expect(codexFiles()).toEqual(codexBefore);
  }, 60_000);
});
