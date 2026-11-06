/**
 * BRN K3: the agent query tools over fake spec reads, a real Task store and real transcript files:
 * scope (another agent's conversation, a room the caller is not in, another project's Task), the
 * rate (30 a minute), the size caps, not_covered with what is missing, masking, the agent_query
 * event, and get_resume_context on K1's renew history and delivered handoff.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { TraceItem, TraceNode } from '../../../../core/src/cld/spec/trace.js';
import { AGENT_QUERY_BYTES, AGENT_QUERY_PER_MINUTE, AGENT_QUERY_RESUME_BYTES, AGENT_QUERY_ROOM_POSTS, AGENT_QUERY_SEARCH_BYTES, AGENT_QUERY_WINDOW_MS, RESUME_ITEM_CHARS, RESUME_SECTION_ITEMS } from '../../constants.js';
import { AgentQueries, fit, type QueryDeps, resumeHandoff, type SpecReads } from './agentQueries.js';
import { configDir } from './events.js';
import type { GitRunner } from './git/gitRun.js';
import type { GroupPost } from './groupMessages.js';
import type { GroupRoom } from './groups.js';
import type { RosterAgent } from './mcpTools.js';
import { McpTools } from './mcpTools.js';
import { RENEW_HISTORY_VERSION, renewHistoryPath } from './renewals.js';
import { tasksPath, TaskStore } from './tasks.js';

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});
const tmp = () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-k3-'));
  cleanup.push(() => fs.rmSync(h, { recursive: true, force: true }));
  return h;
};
const agent = (name: string, project: string, role: RosterAgent['role'], id: string): RosterAgent => ({
  name, project, role, assignmentId: id, provider: 'claude', wantRunning: true, live: true, busy: false,
});
const ALPHA = agent('alpha', 'alpha', 'lead', 'a_aaaaaaaaaa');
const WORKER = agent('alpha-a', 'alpha', 'worker', 'a_bbbbbbbbbb');
const BETA = agent('beta', 'beta', 'lead', 'a_cccccccccc');
const T0 = Date.parse('2026-11-06T01:00:00Z');

const rec = (type: 'user' | 'assistant', text: string, n: number) =>
  `${JSON.stringify({
    type,
    uuid: `${String(n).padStart(8, '0')}-rec`,
    timestamp: new Date(T0 + n * 1000).toISOString(),
    message: type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] },
  })}\n`;

const node = (id: string, label: string, pathOf = 'docs/SRS.md'): TraceNode => ({ id, type: 'req', label, title: `${label} title`, source: { path: pathOf, line: 3 } });
const UID_A = 'r_aaaaaaaaaa';
const UID_S = 'r_ssssssssss';
/** FR-A-001 defined a second time, in the sensitive document. */
const UID_P = 'r_pppppppppp';
/** A requirement linked only to the sensitive one (depth 2 from FR-A-001). */
const UID_X = 'r_xxxxxxxxxx';

/** Fake spec reads: FR-A-001 (r_aaaaaaaaaa) in SRS.md, FR-S-001 in the sensitive doc; tracking per flag. */
function fakeSpec(o: { on?: boolean } = {}): SpecReads & { calls: string[] } {
  const on = o.on ?? true;
  const calls: string[] = [];
  const rows = [
    { uid: UID_A, displayId: 'FR-A-001', title: 'The office answers token=hunter22', section: '3.1', doc: 'docs/SRS.md', kind: 'requirements' },
    { uid: UID_S, displayId: 'FR-S-001', title: 'secret plan', section: '9', doc: 'docs/private.md', kind: 'requirements' },
    { uid: UID_P, displayId: 'FR-A-001', title: 'again, in private', section: '9', doc: 'docs/private.md', kind: 'requirements' },
  ];
  const item = (uid: string): TraceItem =>
    uid === UID_A
      ? {
          node: node(UID_A, 'FR-A-001'),
          edges: [
            { id: 'e1', from: UID_A, to: 'T-1', rel: 'implements', status: 'observed', reason: 'title' },
            { id: 'e2', from: UID_A, to: UID_S, rel: 'refs', status: 'confirmed' },
          ],
          nodes: [{ id: 'T-1', type: 'task', label: 'T-1' }, node(UID_S, 'FR-S-001', 'docs/private.md')],
          text: 'The office answers. password=letmein',
          history: [{ at: 'x', kind: 'identity', what: 'created' } as never],
        }
      : { node: node(UID_S, 'FR-S-001', 'docs/private.md'), edges: [], nodes: [] };
  return {
    calls,
    head: async () => (calls.push('head'), { rev: 7, head: 'f'.repeat(40) }),
    sensitive: () => ({ paths: new Set(['docs/private.md']), uids: new Set([UID_S, UID_P]) }),
    summary: async () => (on ? { enabled: true, docs: { total: 2 }, items: { total: 2 }, unlinked: 1, questions: 0 } : { enabled: false, candidates: 3 }),
    items: async (_p, q) => (calls.push(`items:${q.q}`), { ok: true, value: { enabled: on, total: on ? 2 : 0, items: on ? rows.filter((r) => r.displayId.toLowerCase().includes(q.q.toLowerCase()) || r.title.includes(q.q)) : [] } }),
    item: async (_p, uid) => (on ? { ok: true, value: item(uid) } : { ok: false, error: 'off' }),
    graph: async (_p, q) => ({ ok: true, value: { level: 'neighbourhood', center: q.center, nodes: item(q.center).nodes.concat(item(q.center).node, node(UID_X, 'FR-X-001')), edges: [...item(q.center).edges, { id: 'e3', from: UID_S, to: UID_X, rel: 'refs', status: 'confirmed' }] } as never }),
    task: async (_p, id) => (on ? { ok: true, value: { enabled: true, edges: id === 'T-1' ? [{ id: 'e9', from: UID_A, to: 'T-1', rel: 'implements', status: 'observed' }] : [], nodes: id === 'T-1' ? [node(UID_A, 'FR-A-001')] : [] } } : { ok: true, value: { enabled: false, edges: [], nodes: [] } }),
    taskCode: async () => ({ ok: true, value: { files: ['server/src/a.ts', 'docs/private.md'], filesTotal: 2, modules: [{ id: 'server', name: 'server', files: 1 }] } }),
    recent: async () => ({ ok: true, value: { commits: [{ sha: 'a'.repeat(40), subject: 'feat: x', at: 'now', reqs: [{ uid: UID_S, label: 'FR-S-001', status: 'observed' }, { uid: UID_A, label: 'FR-A-001', status: 'observed' }] }], jobs: [], merges: [] } }),
    map: async () => ({ ok: true, value: { reqTotal: 1, features: [{ key: 'FR-A', name: 'A', reqs: 1, linked: 1, blocked: false, progress: false, changed: 0 }] } as never }),
  };
}

function world(o: { spec?: SpecReads | null; now?: () => number; run?: GitRunner } = {}) {
  const h = tmp();
  const tasks = new TaskStore(tasksPath(h), () => undefined, () => undefined);
  const dir = path.join(h, 'proj');
  fs.mkdirSync(dir);
  const files: Record<string, string> = { alpha: path.join(dir, 'alpha.jsonl'), 'alpha-a': path.join(dir, 'worker.jsonl') };
  fs.writeFileSync(
    files.alpha,
    [
      rec('user', '[사장 · 메신저 · 11-06 10:00] ⟨m:aaaaaaa2⟩\n먼저 이것부터', 1),
      rec('assistant', '알겠습니다', 2),
      rec('user', '[사장 · 메신저 · 11-06 10:01] ⟨m:bbbbbbb2⟩\n배포 키는 token=supersecret123 이다', 3),
      rec('assistant', '배포하겠습니다', 4),
      rec('user', '[cld-gui · alpha-a에게서 · 11-06 10:02] ⟨m:ccccccc2⟩\n끝났어요', 5),
    ].join(''),
  );
  fs.writeFileSync(files['alpha-a'], rec('user', '[사장 · 메신저 · 11-06 10:03] ⟨m:wwwwwww2⟩\n워커만 아는 말', 0));
  const rooms: GroupRoom[] = [
    { id: 'g1', name: '팀방', members: ['alpha', 'alpha-a'] },
    { id: 'g2', name: 'beta방', members: ['beta'] },
  ];
  const posts: Record<string, GroupPost[]> = {
    g1: [
      { id: 'p1', at: T0, sender: 'alpha', text: '시작', targets: [], delivery: {} },
      { id: 'p2', at: T0 + 1000, sender: null, text: '키 api_key=abcdef123456', targets: [], delivery: {}, messageIds: { 'alpha-a': 'ddddddd2' } },
      { id: 'p3', at: T0 + 2000, sender: 'alpha-a', text: '네', targets: [], delivery: {} },
    ],
    g2: [{ id: 'q1', at: T0, sender: 'beta', text: 'beta 끼리', targets: [], delivery: {}, messageIds: { beta: 'eeeeeee2' } }],
  };
  const events: Array<Record<string, unknown> & { type: string }> = [];
  const roomReads: Array<[string, number]> = [];
  const folders: Record<string, string> = { alpha: dir };
  const deps: QueryDeps = {
    home: h,
    transcriptOf: (n) => files[n] ?? null,
    folderOf: (n) => folders[n] ?? null,
    rooms: () => rooms,
    timeline: (r, limit) => (roomReads.push([r.id, limit]), (posts[r.id] ?? []).slice(-limit)),
    tasks,
    event: (type, fields) => events.push({ type, ...fields }),
    ...(o.spec !== null && { spec: o.spec ?? fakeSpec() }),
    run: o.run ?? (async () => ({ code: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), truncated: false }) as never),
    now: o.now,
  };
  const q = new AgentQueries(deps);
  return { h, q, tasks, events, roomReads, dir, call: (me: RosterAgent, tool: string, input: Record<string, unknown> = {}) => q.call(me, tool, input) };
}

describe('get_message', () => {
  it('a message of my own conversation: its text masked, the lines before and after, sender, time, conversation', async () => {
    const w = world();
    const r = await w.call(ALPHA, 'get_message', { id: '⟨m:bbbbbbb2⟩' });
    expect(r).toMatchObject({ project: 'alpha', rev: 7, head: 'f'.repeat(40), conversation: { kind: 'dm', agent: 'alpha' } });
    const m = r.message as { id: string; sender: string; at: string; text: string };
    expect(m).toMatchObject({ id: 'bbbbbbb2', sender: 'owner', at: new Date(T0 + 3000).toISOString() });
    expect(m.text).toContain('token=***');
    expect(m.text).not.toContain('supersecret123');
    expect(r.before).toMatchObject({ sender: 'alpha', text: '알겠습니다' });
    expect(r.after).toMatchObject({ sender: 'alpha', text: '배포하겠습니다' });
    expect(((await w.call(ALPHA, 'get_message', { id: 'ccccccc2' })).message as { sender: string }).sender).toBe('alpha-a');
  });

  it("another agent's one-to-one message is not read: not_covered with what is missing", async () => {
    const w = world();
    const r = await w.call(ALPHA, 'get_message', { id: 'wwwwwww2' });
    expect(r).toMatchObject({ status: 'not_covered', missing: [{ code: 'not_found' }] });
    expect(JSON.stringify(r)).not.toContain('워커만');
    // The Worker reads its own.
    expect(((await w.call(WORKER, 'get_message', { id: 'wwwwwww2' })).message as { text: string }).text).toContain('워커만');
  });

  it('a room post: by its id or a member delivery id, from the caller\'s rooms only and their newest posts', async () => {
    const w = world();
    const r = await w.call(WORKER, 'get_message', { id: 'ddddddd2' });
    expect(r).toMatchObject({ conversation: { kind: 'room', id: 'g1', name: '팀방' }, message: { id: 'p2', sender: 'owner' }, before: { text: '시작' }, after: { text: '네' } });
    expect((r.message as { text: string }).text).toBe('키 api_key=***');
    // Another room's post is never read: its id is not found (out_of_scope would say it exists).
    w.roomReads.length = 0;
    expect(await w.call(ALPHA, 'get_message', { id: 'q1' })).toMatchObject({ status: 'not_covered', missing: [{ code: 'not_found' }] });
    expect(await w.call(ALPHA, 'get_message', { id: 'eeeeeee2' })).toMatchObject({ status: 'not_covered', missing: [{ code: 'not_found' }] });
    expect(w.roomReads).toEqual([['g1', AGENT_QUERY_ROOM_POSTS], ['g1', AGENT_QUERY_ROOM_POSTS]]);
    expect(JSON.stringify(await w.call(ALPHA, 'get_message', { id: 'q1' }))).not.toContain('beta 끼리');
    expect(await w.call(ALPHA, 'get_message', { id: 'bad id!' })).toMatchObject({ error: { code: 'bad_input' } });
  });
});

describe('limits and answerability', () => {
  it(`at most ${AGENT_QUERY_PER_MINUTE} queries a minute per agent; another agent has its own; the window frees them`, async () => {
    let now = T0;
    const w = world({ now: () => now });
    for (let i = 0; i < AGENT_QUERY_PER_MINUTE; i++) expect(await w.call(ALPHA, 'search_requirements', { query: 'FR' })).not.toHaveProperty('error');
    const r = await w.call(ALPHA, 'get_message', { id: 'aaaaaaa2' });
    expect(r).toMatchObject({ error: { code: 'rate_limited' }, retryAfterSec: 60 });
    expect(await w.call(WORKER, 'get_message', { id: 'wwwwwww2' })).not.toHaveProperty('error');
    now += AGENT_QUERY_WINDOW_MS;
    expect(await w.call(ALPHA, 'get_message', { id: 'aaaaaaa2' })).not.toHaveProperty('error');
  });

  it('a looping agent logs one rate_limited event per window; the refusals in between are counted into the next event', async () => {
    let now = T0;
    const w = world({ now: () => now });
    let limited = 0;
    for (let i = 0; i < 200; i++) if ((await w.call(ALPHA, 'search_requirements', { query: 'FR' })).error) limited++;
    expect(limited).toBe(200 - AGENT_QUERY_PER_MINUTE);
    const mine = () => w.events.filter((e) => e.from === 'alpha');
    expect(mine().length).toBe(AGENT_QUERY_PER_MINUTE + 1);
    expect(mine().at(-1)).toMatchObject({ code: 'rate_limited' });
    now += AGENT_QUERY_WINDOW_MS;
    await w.call(ALPHA, 'search_requirements', { query: 'FR' });
    expect(mine().at(-1)).toMatchObject({ covered: 'full', droppedRateLimited: 200 - AGENT_QUERY_PER_MINUTE - 1 });
  });

  it('answers are cut to their cap with truncated (8 KB, search 4 KB, resume 16 KB)', () => {
    const big = { project: 'p', items: Array.from({ length: 200 }, (_, i) => ({ uid: `r_${i}`, title: 'x'.repeat(80) })), text: 'y'.repeat(20_000) };
    for (const cap of [AGENT_QUERY_BYTES, AGENT_QUERY_SEARCH_BYTES, AGENT_QUERY_RESUME_BYTES]) {
      const r = fit(big, cap);
      expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(cap);
      expect(r).toMatchObject({ project: 'p', truncated: true });
    }
    expect(fit({ a: 1 }, AGENT_QUERY_BYTES)).toEqual({ a: 1 });
    // Nothing to halve: 2000 short fields. The cap still holds, with the head and why.
    const flat = { project: 'p', rev: 1, asOf: 'x', head: null, ...Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}`, i])) };
    const small = fit(flat, 1024);
    expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThanOrEqual(1024);
    expect(small).toEqual({ project: 'p', rev: 1, asOf: 'x', head: null, truncated: true, missing: [expect.objectContaining({ code: 'too_big' })] });
  });

  it('a line maskText had to cut (over its 2000 characters) makes the answer truncated', async () => {
    const w = world();
    fs.appendFileSync(path.join(w.dir, 'alpha.jsonl'), rec('user', `[사장 · 메신저 · 11-06 10:08] ⟨m:ggggggg2⟩\n${'a '.repeat(1100)}`, 8));
    const r = await w.call(ALPHA, 'get_message', { id: 'ggggggg2' });
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(AGENT_QUERY_BYTES); // not the size cap
    expect(r.truncated).toBe(true);
    expect((await w.call(ALPHA, 'get_message', { id: 'bbbbbbb2' })).truncated).toBeUndefined();
  });

  it('a long message through the tool comes back under 8 KB', async () => {
    const w = world();
    fs.appendFileSync(path.join(w.dir, 'alpha.jsonl'), rec('user', `[사장 · 메신저 · 11-06 10:09] ⟨m:fffffff2⟩\n${'긴 글 한 줄\n'.repeat(3000)}`, 9));
    const r = await w.call(ALPHA, 'get_message', { id: 'fffffff2' });
    expect(r.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThanOrEqual(AGENT_QUERY_BYTES);
  });

  it('not covered, never guessed: no spec reader, tracking off, an unknown ID, a sensitive document; each call is one agent_query event with the running counts', async () => {
    expect(await world({ spec: null }).call(ALPHA, 'get_requirement', { id: 'FR-A-001' })).toMatchObject({ status: 'not_covered', missing: [{ code: 'no_spec' }] });
    const off = world({ spec: fakeSpec({ on: false }) });
    expect(await off.call(ALPHA, 'get_traceability_summary')).toMatchObject({ status: 'not_covered', missing: [{ code: 'tracking_off' }] });
    expect(await off.call(ALPHA, 'search_requirements', { query: 'FR' })).toMatchObject({ status: 'not_covered', missing: [{ code: 'tracking_off' }] });
    const w = world();
    expect(await w.call(ALPHA, 'get_requirement', { id: 'FR-NONE-9' })).toMatchObject({ status: 'not_covered', missing: [{ code: 'not_found' }] });
    expect(await w.call(ALPHA, 'get_requirement', { id: 'FR-S-001' })).toMatchObject({ status: 'not_covered', missing: [{ code: 'sensitive' }] });
    const ok = await w.call(ALPHA, 'get_requirement', { id: 'fr-a-001' });
    expect(ok).toMatchObject({ requirement: { node: { id: UID_A }, links: [{ to: 'T-1' }] } });
    const s = JSON.stringify(ok);
    expect(s).not.toContain('letmein');
    expect(s).not.toContain(UID_S); // the sensitive end and its edge are left out
    expect(s).not.toContain('history');
    expect(await w.call(ALPHA, 'search_requirements', { query: 'secret' })).toMatchObject({ status: 'not_covered' });
    expect(s).not.toContain(UID_P); // FR-A-001 is also defined in the sensitive document: not named
    expect(w.events.map((e) => [e.tool, e.covered, e.asked, e.notCovered])).toEqual([
      ['get_requirement', 'none', 1, 1],
      ['get_requirement', 'none', 2, 2],
      ['get_requirement', 'full', 3, 2],
      ['search_requirements', 'none', 4, 3],
    ]);
    expect(w.events[0]).toMatchObject({ type: 'agent_query', from: 'alpha', project: 'alpha', ask: '{"id":"FR-NONE-9"}', missing: ['not_found'] });
    // The asked arguments are masked per string, so the per-line rules (an environment dump) apply.
    await w.call(ALPHA, 'search_requirements', { query: 'A_ONE=v1\nB_TWO=v2\nC_THREE=v3\nD_FOUR=leakvalue' });
    expect(w.events.at(-1)!.ask).not.toContain('leakvalue');
  });

  it('get_related_context: the neighbourhood without the sensitive document; no link is not_covered', async () => {
    const w = world();
    const r = await w.call(ALPHA, 'get_related_context', { id: UID_A });
    expect(r).toMatchObject({ center: UID_A, edges: [{ from: UID_A, to: 'T-1', rel: 'implements', status: 'observed' }] });
    expect(JSON.stringify(r)).not.toContain(UID_S);
    expect(JSON.stringify(await w.call(ALPHA, 'get_related_context', { id: UID_A, depth: 2 }))).not.toContain(UID_X); // reached only through it
    // The summary: the 개요's counts (they include the sensitive document) left out, its labels too.
    const sum = await w.call(ALPHA, 'get_traceability_summary');
    expect(sum).toMatchObject({ requirements: 1, missing: [{ code: 'sensitive_counts' }], recent: { commits: [{ reqs: ['FR-A-001'] }] } });
    expect(sum).not.toHaveProperty('items');
    expect(JSON.stringify(sum)).not.toContain('FR-S-001');
    expect(await w.call(ALPHA, 'get_related_context', { id: UID_A, depth: 3 })).toMatchObject({ error: { code: 'bad_input' } });
  });
});

describe('get_task_context', () => {
  it('my open task by default with its requirements, code (sensitive files out) and facts; another project task is out of scope', async () => {
    const w = world();
    const t = w.tasks.add({ project: 'alpha', title: 'T one', status: 'doing', assignee: { assignmentId: WORKER.assignmentId!, name: WORKER.name } }, 'alpha', T0);
    expect(t.ok).toBe(true);
    const id = (t.task as { id: string }).id;
    expect(id).toBe('T-1');
    const r = await w.call(WORKER, 'get_task_context');
    expect(r).toMatchObject({ task: { id: 'T-1', status: 'doing', assignee: 'alpha-a' }, requirements: [{ id: UID_A }], code: { files: ['server/src/a.ts'], modules: [{ id: 'server' }] } });
    expect(r).not.toHaveProperty('missing');
    expect(await w.call(ALPHA, 'get_task_context')).toMatchObject({ status: 'not_covered', missing: [{ code: 'no_task' }] });
    expect(await w.call(BETA, 'get_task_context', { taskId: 'T-1' })).toMatchObject({ error: { code: 'out_of_scope' } });
    // Tracking off: the task still answers, its requirement part is listed as missing.
    const off = world({ spec: fakeSpec({ on: false }) });
    off.tasks.add({ project: 'alpha', title: 'T one', status: 'doing' }, 'alpha', T0);
    expect(await off.call(ALPHA, 'get_task_context', { taskId: 'T-1' })).toMatchObject({ task: { id: 'T-1' }, requirements: [], missing: [{ code: 'tracking_off' }] });
  });
});

describe('get_resume_context', () => {
  it('my last handoff, its work basis, what changed since, and its references resolved', async () => {
    const shaFull = 'abc1234' + 'a'.repeat(33);
    const gitCalls: string[][] = [];
    const run: GitRunner = async (_cwd, args) => {
      gitCalls.push(args);
      const out = args[0] === 'rev-list' ? `${shaFull}\n` : args.includes('--no-walk') ? `${shaFull}\tfix(engine): the old one\n` : `${'b'.repeat(40)}\tfeat(brain): after the handoff\n`;
      return { code: 0, stdout: Buffer.from(out), stderr: Buffer.from(''), truncated: false } as never;
    };
    const w = world({ run });
    expect(await w.call(ALPHA, 'get_resume_context')).toMatchObject({ status: 'not_covered', missing: [{ code: 'no_handoff' }] });
    w.tasks.add({ project: 'alpha', title: 'renewed task', status: 'doing' }, 'alpha', T0);
    const ended = Date.now() - 60_000;
    fs.mkdirSync(path.dirname(renewHistoryPath(w.h)), { recursive: true });
    fs.writeFileSync(renewHistoryPath(w.h), JSON.stringify({ v: RENEW_HISTORY_VERSION, terms: [{ name: 'alpha', sessionId: 'old-1', next: 'new-1', transcript: '/x/old-1.jsonl', bytes: 10, endedAt: ended }] }));
    const delivered = path.join(configDir(w.h), 'inbox', 'alpha', 'delivered');
    fs.mkdirSync(delivered, { recursive: true });
    const text = [
      '[cld-gui renew · 11-06 10:00] 컨텍스트가 포화돼 새 대화로 이어 간다.',
      '- 안전 문장',
      '',
      '--- 인수인계 ---',
      '## 목표\nFR-A-001 을 끝낸다 (T-1, 커밋 abc1234, 메시지 ⟨m:bbbbbbb2⟩, password=hunter2)',
      '## 다음 행동\n시험',
      '',
      '--- 작업 기준 (엔진이 직접 읽은 값) ---',
      `폴더: /x · 브랜치: feat/k3 · HEAD: ${'c'.repeat(40)} · 바뀐 파일: 0개`,
    ].join('\n');
    fs.writeFileSync(path.join(delivered, '20261106-100000.md'), text);
    fs.writeFileSync(path.join(delivered, '20261106-110000.md'), '[사장 · 메신저] not a handoff');
    const r = await w.call(ALPHA, 'get_resume_context');
    expect(r).toMatchObject({
      renew: { oldSession: 'old-1', newSession: 'new-1' },
      base: { branch: 'feat/k3', head: 'c'.repeat(40) },
      since: { commits: [{ sha: 'b'.repeat(40), subject: 'feat(brain): after the handoff' }] },
    });
    expect(r.handoff).toContain('## 목표');
    expect(r.handoff).not.toContain('hunter2');
    expect(r.basis).toContain('브랜치: feat/k3');
    expect(r.refs).toEqual([
      { ref: { t: 'display', id: 'FR-A-001' }, uid: UID_A, label: 'FR-A-001', title: 'FR-A-001 title' },
      { ref: { t: 'task', id: 'T-1' }, title: 'renewed task', status: 'doing' },
      { ref: { t: 'commit', sha: shaFull }, subject: 'fix(engine): the old one' },
      { ref: { t: 'msg', where: 'alpha', id: 'bbbbbbb2' }, resolved: false, why: 'read it with get_message' },
    ]);
    expect(gitCalls.some((a) => a.includes(`${'c'.repeat(40)}..HEAD`))).toBe(true);
    // Another agent has no handoff of its own: mine is never shown to it.
    expect(await w.call(WORKER, 'get_resume_context')).toMatchObject({ status: 'not_covered' });
  });
});

describe('through McpTools', () => {
  it('the query tools need a known agent; without the queries part they answer unavailable', async () => {
    const h = tmp();
    const tasks = new TaskStore(tasksPath(h), () => undefined, () => undefined);
    const base = { roster: () => [ALPHA], tasks, queueLength: () => 0, limited: () => false, send: async () => ({ ok: true }), groupPost: async () => ({ ok: true }), findRoom: () => null, timeline: () => [] };
    expect(await new McpTools(base).call('alpha', 'get_message', { id: 'aaaaaaa2' })).toMatchObject({ error: { code: 'unavailable' } });
    const w = world();
    const t = new McpTools({ ...base, queries: w.q });
    expect(await t.call('ghost', 'get_message', { id: 'aaaaaaa2' })).toMatchObject({ error: { code: 'no_identity' } });
    expect(await t.call('alpha', 'get_message', { id: 'aaaaaaa2' })).toMatchObject({ message: { text: expect.stringContaining('먼저') } });
  });
});

describe('BRN K5: resumeHandoff (the 개요\'s five lines)', () => {
  /** A renew first message as K1 writes it (handoff.renewPrompt): safety lines, the handoff, the work basis. */
  const renewText = (handoff: string) =>
    ['[cld-gui renew · 11-06 10:00] 컨텍스트가 포화돼 새 대화로 이어 간다.', '- 안전 문장', '', '--- 인수인계 ---', handoff, '', '--- 작업 기준 (엔진이 직접 읽은 값) ---', '폴더: /x · 브랜치: main · HEAD: abc1234 · 바뀐 파일: 0개'].join('\n');
  const inbox = (h: string, name: string, sub = 'delivered') => {
    const d = path.join(configDir(h), 'inbox', name, sub);
    fs.mkdirSync(d, { recursive: true });
    return d;
  };
  const HANDOFF = [
    '## 목표',
    '- [사실] K5 다섯 줄을 개요 맨 위에 둔다',
    '## 완료',
    ...Array.from({ length: 7 }, (_, i) => `- [사실] 완료 ${i + 1}`),
    '## 미해결',
    '- [판단] 폰 줄바꿈이 깨질 것 같다',
    '- 꼬리표 없는 줄 token=ghp_abcdefghijklmnopqrstuvwxyz0123',
    `- [미확인] ${'가'.repeat(RESUME_ITEM_CHARS + 50)}`,
    '## 다음 행동',
    '1. [판단] 러너 한 번',
    '## 결정 (선택)',
    '- 결정은 다섯 줄에 안 나온다',
  ].join('\n');

  it('no handoff on record: null, never a made-up one', () => {
    const h = tmp();
    expect(resumeHandoff(h, 'alpha')).toBeNull();
    fs.writeFileSync(path.join(inbox(h, 'alpha'), '20261106-100000.md'), '[사장 · 메신저] not a handoff');
    expect(resumeHandoff(h, 'alpha')).toBeNull();
  });

  it('the four sections, tags kept, caps, masking, the renew time; the newest handoff wins', () => {
    const h = tmp();
    const d = inbox(h, 'alpha');
    fs.writeFileSync(path.join(d, 'old.md'), renewText('## 완료\n- 옛것'));
    fs.utimesSync(path.join(d, 'old.md'), new Date(T0 - 60_000), new Date(T0 - 60_000));
    fs.writeFileSync(path.join(d, 'new.md'), renewText(HANDOFF));
    fs.utimesSync(path.join(d, 'new.md'), new Date(T0), new Date(T0));
    const ended = T0 + 5_000;
    fs.writeFileSync(renewHistoryPath(h), JSON.stringify({ v: RENEW_HISTORY_VERSION, terms: [{ name: 'alpha', sessionId: 'o', next: 'n', transcript: '/x', bytes: 1, endedAt: ended }] }));
    const r = resumeHandoff(h, 'alpha')!;
    expect(r.at).toBe(new Date(ended).toISOString());
    // A handoff newer than the last renew record (still waiting, or a failed renew) shows its own time.
    fs.utimesSync(path.join(d, 'new.md'), new Date(T0 + 60_000), new Date(T0 + 60_000));
    expect(resumeHandoff(h, 'alpha')!.at).toBe(new Date(T0 + 60_000).toISOString());
    expect(r.format).toBe('ok');
    expect(r.goal.items).toEqual([{ text: 'K5 다섯 줄을 개요 맨 위에 둔다', tag: 'fact' }]);
    expect(r.done.total).toBe(7);
    expect(r.done.items).toHaveLength(RESUME_SECTION_ITEMS);
    expect(r.done.items[0]).toEqual({ text: '완료 1', tag: 'fact' });
    expect(r.open.items[0]).toEqual({ text: '폰 줄바꿈이 깨질 것 같다', tag: 'judgement' });
    // An untagged line has no tag (the screen reads it as 미확인, K1's rule); the planted token is gone.
    expect(r.open.items[1].tag).toBeUndefined();
    expect(r.open.items[1].text).toContain('token=***');
    expect(JSON.stringify(r)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(r.open.items[2].tag).toBe('unverified');
    expect(r.open.items[2].text).toHaveLength(RESUME_ITEM_CHARS + 1); // cut, with '…'
    expect(r.next.items).toEqual([{ text: '러너 한 번', tag: 'judgement' }]);
    expect(JSON.stringify(r)).not.toContain('결정은');
    expect(JSON.stringify(r)).not.toContain('작업 기준');
  });

  it('a free-form handoff is free with what it has; English headings read too', () => {
    const h = tmp();
    fs.writeFileSync(path.join(inbox(h, 'alpha', ''), 'a.md'), renewText('그냥 줄글로 쓴 인수인계'));
    expect(resumeHandoff(h, 'alpha')).toMatchObject({ format: 'free', done: { items: [], total: 0 }, next: { items: [] } });
    fs.writeFileSync(path.join(inbox(h, 'beta'), 'b.md'), renewText('## Goal\ng\n## Done\n- d\n## Open\n## Next\n- n'));
    expect(resumeHandoff(h, 'beta')).toMatchObject({ format: 'ok', done: { items: [{ text: 'd' }] }, next: { items: [{ text: 'n' }] } });
  });

  it('a path outside the Lead\'s own inbox is refused: a name with a path, a linked file, a linked folder', () => {
    const h = tmp();
    const outside = tmp();
    fs.writeFileSync(path.join(outside, 'secret.md'), renewText('## 완료\n- OUTSIDE-SECRET'));
    // beta's real handoff: alpha must never reach it through a name.
    fs.writeFileSync(path.join(inbox(h, 'beta'), 'b.md'), renewText('## 완료\n- BETA-ONLY'));
    expect(resumeHandoff(h, '../inbox/beta')).toBeNull();
    expect(resumeHandoff(h, 'alpha/../beta')).toBeNull();
    expect(resumeHandoff(h, '..')).toBeNull();
    // A file in alpha's inbox that links out.
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(inbox(h, 'alpha'), 'link.md'));
    expect(resumeHandoff(h, 'alpha')).toBeNull();
    // alpha's whole inbox folder a link to elsewhere.
    fs.mkdirSync(path.join(outside, 'delivered'));
    fs.copyFileSync(path.join(outside, 'secret.md'), path.join(outside, 'delivered', 'c.md'));
    fs.symlinkSync(outside, path.join(configDir(h), 'inbox', 'gamma'));
    expect(resumeHandoff(h, 'gamma')).toBeNull();
    // A real one beside the link is still read.
    fs.writeFileSync(path.join(inbox(h, 'alpha'), 'real.md'), renewText('## 완료\n- 진짜'));
    fs.utimesSync(path.join(inbox(h, 'alpha'), 'real.md'), new Date(T0), new Date(T0));
    expect(resumeHandoff(h, 'alpha')?.done.items).toEqual([{ text: '진짜' }]);
  });

  it('a FIFO in the inbox is passed over, never opened (it would block the daemon)', () => {
    if (process.platform === 'win32') return;
    const h = tmp();
    execFileSync('mkfifo', [path.join(inbox(h, 'alpha'), 'zz-fifo.md')]);
    fs.writeFileSync(path.join(inbox(h, 'alpha'), 'real.md'), renewText('## 완료\n- 진짜'));
    fs.utimesSync(path.join(inbox(h, 'alpha'), 'real.md'), new Date(T0), new Date(T0));
    expect(resumeHandoff(h, 'alpha')?.done.items).toEqual([{ text: '진짜' }]);
  });

  it('CRLF headings read; an emoji at the cut keeps its pair whole', () => {
    const h = tmp();
    const long = `${'가'.repeat(RESUME_ITEM_CHARS - 1)}😀끝`;
    fs.writeFileSync(path.join(inbox(h, 'alpha'), 'a.md'), renewText(`## 목표\r\n- g\r\n## 완료\r\n- ${long}\r\n## 미해결\r\n## 다음 행동\r\n- n`));
    const r = resumeHandoff(h, 'alpha');
    expect(r?.format).toBe('ok');
    expect(r?.next.items).toEqual([{ text: 'n' }]);
    const text = r?.done.items[0].text ?? '';
    expect(text.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF]…$/.test(text)).toBe(false);
  });
});
