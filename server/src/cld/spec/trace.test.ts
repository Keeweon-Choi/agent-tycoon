// SPT-P2: the Link Store, observed and suggested links from every source, evidence, freshness and
// link review, traceQuery's levels, cap and folding, the link routes' guards, project boundary and
// audit, the source bytes, the cost spies and TOKEN-GUARD.
import * as crypto from 'crypto';
import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TraceGraph, TraceItem, TraceTaskReqs } from '../../../../core/src/cld/spec/trace.js';
import type { SpecChanged } from '../../../../core/src/messages.js';
import { SPEC_ITEM_TITLE_MAX, SPEC_SCAN_MIN_MS, SPEC_SETTLE_MS, SPEC_TRACE_IDLE_MS, SPEC_TRACE_NODES_MAX } from '../../constants.js';
import { GIT_AVAILABLE, makeTempRepo, recording, type TempRepo } from '../engine/git/testRepo.js';
import { emptyLinks, linksFile, readLinks, writeLinks } from './links.js';
import { registerSpecRoutes } from './routes.js';
import { type SpecProject, SpecService } from './service.js';
import type { TraceJob, TraceTask } from './trace.js';

const PROJECT_ID = 'p_abcdefghij';
const SRS =
  '# SRS\n\n## 3.1 엔진\n\n| ID | 요구 | 출처 |\n|---|---|---|\n' +
  '| FR-ENG-001 | 엔진이 세션을 이어 받는다 (FR-ENG-002 참고) | T-2 |\n' +
  '| FR-ENG-002 | 엔진이 작업을 기록한다 | |\n' +
  '| FR-ENG-003 | 엔진이 꺼진 프로젝트를 건너뛴다 | |\n';
const TRACE = '# 추적표\n\n| 요구 | 작업 |\n|---|---|\n| FR-ENG-003 | T-3 |\n';

let repo: TempRepo | null = null;
const homes: string[] = [];
afterEach(() => {
  repo?.cleanup();
  repo = null;
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  vi.restoreAllMocks();
});

type Task = TraceTask & { project: string };
type Job = TraceJob & { project: string | null };
const task = (id: string, title: string, project = 'alpha', extra: Partial<Task> = {}): Task => ({ id, project, title, status: 'doing', ...extra });
const job = (id: string, desc: string, project: string | null = 'alpha', exit: number | null = 0): Job => ({ id, project, desc, cmd: 'npm test', started: `2026-11-03T0${id.length % 9}:00:00Z`, ended: '2026-11-03T09:00:00Z', exit });

/** A repository with the SRS, a 참조만 하는 표, commits naming a requirement and a Task; Tasks and jobs in memory. */
async function setup(opts: { commits?: string[]; tasks?: Task[]; jobs?: Job[] } = {}) {
  repo = makeTempRepo();
  repo.write('docs/requirements/SRS.md', SRS);
  repo.write('docs/trace.md', TRACE);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: SRS']);
  for (const m of opts.commits ?? ['FR-ENG-001: resume the session', 'T-2 follow-up']) repo.git(['commit', '-q', '--allow-empty', '-m', m]);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-trace-home-')));
  homes.push(home);
  const project: SpecProject = { name: 'alpha', folder: repo.folder, projectId: PROJECT_ID };
  const tasks: Task[] = opts.tasks ?? [task('T-1', 'FR-ENG-002 기록 정리'), task('T-2', '세션 이어 받기'), task('T-3', '건너뛰기'), task('T-9', 'FR-ENG-001 다른 프로젝트', 'beta')];
  const jobs: Job[] = opts.jobs ?? [job('1103-100000-unit', 'unit FR-ENG-002'), job('1103-110000-deploy', 'deploy main'), job('1103-120000-beta', 'FR-ENG-001 beta', 'beta')];
  let clock = Date.now() + SPEC_SETTLE_MS * 2;
  const sent: SpecChanged[] = [];
  const idle: Array<() => void> = [];
  const rec = recording(repo.run);
  const reads = { jobs: 0 };
  const s = new SpecService({ home, projects: () => [project], broadcast: (m) => sent.push(m), run: rec.run, now: () => clock, later: () => undefined, idle: (fn) => idle.push(fn), tasks: () => tasks, jobs: () => (reads.jobs++, jobs) });
  expect(await s.enable(project, ['docs/requirements/SRS.md', 'docs/trace.md'])).toMatchObject({ ok: true });
  const items = (await s.items(project, {})) as { ok: true; value: { items: Array<{ uid: string; displayId?: string; docUid: string; doc: string }> } };
  const traceDoc = items.value.items.find((i) => i.doc === 'docs/trace.md')!.docUid;
  expect(s.setDoc(project, traceDoc, { mode: 'refs' })).toMatchObject({ ok: true });
  await s.docs(project); // the rescan setDoc started
  const uid: Record<string, string> = {};
  for (const i of ((await s.items(project, {})) as typeof items).value.items) uid[i.displayId!] = i.uid;
  const tick = (ms = SPEC_SCAN_MIN_MS) => (clock += ms);
  const graph = async (q: Record<string, string>) => {
    const r = await s.graph(project, q);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const item = async (u: string): Promise<TraceItem> => {
    const r = await s.item(project, u);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const edge = (it: TraceItem, to: string, rel?: string) => it.edges.find((e) => (e.to === to || e.from === to) && (!rel || e.rel === rel));
  const sha = (subject: string) => repo!.git(['log', '--format=%H %s']).split('\n').find((l) => l.endsWith(` ${subject}`))!.split(' ')[0];
  return { repo, home, project, s, sent, idle, rec, reads, tasks, jobs, uid, tick, graph, item, edge, sha };
}

function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of fs.readdirSync(root, { recursive: true }).map(String).sort()) {
    const st = fs.lstatSync(path.join(root, rel));
    if (st.isFile()) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
  }
  return out;
}

describe('the Link Store', () => {
  it('round trips, 0600 in 0700, atomic (no temp file left); an unreadable file is corrupt and never written', () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-links-')));
    homes.push(home);
    const file = linksFile(home, PROJECT_ID);
    expect(readLinks(file)).toEqual({ links: emptyLinks(), corrupt: null });
    const links = emptyLinks();
    links.rev = 3;
    links.links.push({ id: 'l_aaaaaaaaaa', from: { t: 'req', uid: 'r_aaaaaaaaaa' }, to: { t: 'task', id: 'T-1' }, rel: 'implements', status: 'confirmed', by: { kind: 'owner', name: 'owner' }, at: 'x', basis: { textHash: 'h', docBlob: 'b' } });
    writeLinks(file, links);
    expect(readLinks(file)).toEqual({ links, corrupt: null });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['links.json']);
    fs.writeFileSync(file, '{"v":1,"rev":1,"links":[{"id":"bad"}]}');
    expect(readLinks(file).corrupt).toMatch(/bad link/);
  });
});

describe.skipIf(!GIT_AVAILABLE)('the trace', () => {
  it('observed from every source: Task title, a Task ID in the row, the requirement text, a refs table, a commit message, a job desc; nothing of another project', async () => {
    const t = await setup();
    const one = await t.item(t.uid['FR-ENG-001']);
    expect(t.edge(one, 'T-2', 'implements')).toMatchObject({ status: 'observed', source: { path: 'docs/requirements/SRS.md', line: 7 } });
    expect(t.edge(one, t.uid['FR-ENG-002'], 'refs')).toMatchObject({ status: 'observed', rel: 'refs' });
    expect(t.edge(one, t.sha('FR-ENG-001: resume the session'), 'changes')).toMatchObject({ status: 'observed', source: { sha: t.sha('FR-ENG-001: resume the session') } });
    expect(t.edge(one, 'T-9')).toBeUndefined(); // beta's Task names FR-ENG-001
    expect(t.edge(one, '1103-120000-beta')).toBeUndefined();
    const two = await t.item(t.uid['FR-ENG-002']);
    expect(t.edge(two, 'T-1', 'implements')).toMatchObject({ status: 'observed', reason: 'title', source: { taskId: 'T-1' } });
    expect(t.edge(two, '1103-100000-unit', 'verifies')).toMatchObject({ status: 'observed', source: { jobId: '1103-100000-unit' } });
    const three = await t.item(t.uid['FR-ENG-003']);
    expect(t.edge(three, 'T-3', 'implements')).toMatchObject({ status: 'observed', source: { path: 'docs/trace.md', line: 5 } });
    expect(one.nodes.find((n) => n.id === 'T-2')).toMatchObject({ type: 'task', label: 'T-2', title: '세션 이어 받기' });
    // Nothing observed or suggested is stored: no links.json until the owner decides.
    expect(fs.existsSync(linksFile(t.home, PROJECT_ID))).toBe(false);
  });

  it("suggested: a confirmed Task's commits; a rejection sticks across rebuilds and restarts", async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-001'];
    const follow = t.sha('T-2 follow-up');
    expect(t.edge(await t.item(u), follow)).toBeUndefined();
    expect(await t.s.confirmLinks(t.project, { edges: [{ from: u, to: 'T-2', rel: 'implements' }] }, 'Test phone')).toMatchObject({ ok: true });
    expect(t.edge(await t.item(u), follow, 'changes')).toMatchObject({ status: 'suggested', reason: 'T-2' });
    expect(t.edge(await t.item(u), 'T-2')).toMatchObject({ status: 'confirmed', by: { kind: 'owner' } });
    expect(await t.s.rejectLink(t.project, { from: u, to: follow, rel: 'changes' }, 'Test phone')).toMatchObject({ ok: true });
    const msg = t.sha('FR-ENG-001: resume the session');
    expect(await t.s.rejectLink(t.project, { from: u, to: msg, rel: 'changes' }, 'Test phone')).toMatchObject({ ok: true });
    t.tick();
    const again = new SpecService({ home: t.home, projects: () => [t.project], broadcast: () => undefined, run: t.repo.run, tasks: () => t.tasks, jobs: () => t.jobs });
    const it2 = (await again.item(t.project, u)) as { ok: true; value: TraceItem };
    expect(t.edge(it2.value, follow)).toMatchObject({ status: 'rejected' });
    expect(t.edge(it2.value, msg)).toMatchObject({ status: 'rejected', source: { sha: msg } }); // still shown, dimmed, with where the ID is
    const stored = readLinks(linksFile(t.home, PROJECT_ID)).links.links;
    expect(stored.map((l) => l.status).sort()).toEqual(['confirmed', 'rejected', 'rejected']);
  });

  it('evidence: a deploy job exit 0 is only reported; 배포 확인 makes it observed; a commit, its ancestry and a unit job are observed', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-001'];
    const state = async () => (await t.item(u)).node.state!;
    expect((await state()).evidence).toEqual({ change: 'none', integration: 'none', test: 'none', deploy: 'none', reported: false });
    expect(await t.s.addLink(t.project, { from: u, to: '1103-110000-deploy', rel: 'verifies', kind: 'deploy' }, 'Test phone')).toMatchObject({ ok: true });
    expect((await state()).evidence?.deploy).toBe('reported');
    expect(await t.s.deployConfirm(t.project, { jobId: '1103-110000-deploy', note: 'v1.2 live' }, 'Test phone')).toEqual({ ok: true, value: { requirements: 1 } });
    expect((await state()).evidence?.deploy).toBe('observed');
    await t.s.confirmLinks(t.project, { edges: [{ from: u, to: t.sha('FR-ENG-001: resume the session'), rel: 'changes' }, { from: u, to: '1103-100000-unit', rel: 'verifies', kind: 'unit' }] }, 'Test phone');
    t.tasks.find((x) => x.id === 'T-2')!.reportedDone = { value: true, source: 'reported', at: 'x' };
    await t.s.confirmLinks(t.project, { edges: [{ from: u, to: 'T-2', rel: 'implements' }] }, 'Test phone');
    expect((await state()).evidence).toEqual({ change: 'observed', integration: 'observed', test: 'observed', deploy: 'observed', reported: true });
    expect((await state()).work).toEqual({ total: 1, byStatus: { doing: 1 } });
    // A job that is not a confirmed deploy check cannot be confirmed as deployed.
    expect(await t.s.deployConfirm(t.project, { jobId: '1103-100000-unit' }, 'Test phone')).toEqual({ ok: false, error: 'stale' });
  });

  it('freshness: a text change is link review; 연결 검토함 moves only the basis, acceptance untouched; a missing end keeps its link', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-002'];
    await t.s.confirmLinks(t.project, { edges: [{ from: u, to: 'T-1', rel: 'implements' }] }, 'Test phone');
    expect((await t.item(u)).node.state).toMatchObject({ freshness: 'current', acceptance: { current: 'none' } });
    t.repo.write('docs/requirements/SRS.md', SRS.replace('엔진이 작업을 기록한다', '엔진이 모든 작업을 빠짐없이 기록한다'));
    t.tick();
    const before = (await t.item(u)).node.state!;
    expect(before).toMatchObject({ freshness: 'review', linkReview: true });
    expect(((await t.s.summary(t.project)) as { linkReview?: number }).linkReview).toBe(1);
    expect(await t.s.reviewLinks(t.project, { uid: u }, 'Test phone')).toEqual({ ok: true, value: { links: 1 } });
    const after = (await t.item(u)).node.state!;
    expect(after).toMatchObject({ freshness: 'current', acceptance: { current: 'none' } });
    expect(after.linkReview).toBeUndefined();
    expect(fs.readdirSync(path.dirname(linksFile(t.home, PROJECT_ID))).sort()).toEqual(['links.json', 'match-cache.json.gz', 'registry.json']); // no acceptance.json
    expect(await t.s.reviewLinks(t.project, { uid: u }, 'Test phone')).toEqual({ ok: false, error: 'stale' });
    expect((await t.item(u)).history?.map((h) => h.action)).toEqual(expect.arrayContaining(['created', 'confirmed', 'textChanged', 'reviewed']));
    // The Task goes: the requirement is missing a source, the link stays.
    t.tasks.splice(t.tasks.findIndex((x) => x.id === 'T-1'), 1);
    t.tick();
    const gone = await t.item(u);
    expect(gone.node.state?.freshness).toBe('missing');
    expect(t.edge(gone, 'T-1')).toMatchObject({ status: 'confirmed' });
    expect(gone.nodes.find((n) => n.id === 'T-1')?.state?.freshness).toBe('missing');
    expect(readLinks(linksFile(t.home, PROJECT_ID)).links.links).toHaveLength(1);
    expect(((await t.s.summary(t.project)) as { missing?: number }).missing).toBe(1);
  });

  it('edit and unlink: a rejected record unlinked is observed again; the relation must keep its kind of end', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-002'];
    const r = await t.s.addLink(t.project, { from: u, to: '1103-100000-unit', rel: 'verifies' }, 'Test phone');
    if (!r.ok) throw new Error(r.error);
    expect(r.value.kind).toBe('other');
    expect(await t.s.editLink(t.project, r.value.id, { kind: 'integration', note: 'ci' }, 'Test phone')).toMatchObject({ ok: true, value: { kind: 'integration', basis: { note: 'ci' } } });
    expect(await t.s.editLink(t.project, r.value.id, { rel: 'implements' }, 'Test phone')).toEqual({ ok: false, error: 'value' });
    expect(await t.s.unlink(t.project, r.value.id, 'Test phone')).toEqual({ ok: true, value: { id: r.value.id } });
    expect(t.edge(await t.item(u), '1103-100000-unit')).toMatchObject({ status: 'observed' });
    expect(await t.s.unlink(t.project, r.value.id, 'Test phone')).toEqual({ ok: false, error: 'link' });
  });

  it('project boundary: another project’s Task or job, a commit not in this repository, an unknown requirement are refused', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-001'];
    const add = (b: Record<string, unknown>) => t.s.addLink(t.project, { from: u, ...b }, 'Test phone');
    expect(await add({ to: 'T-9', rel: 'implements' })).toEqual({ ok: false, error: 'boundary' });
    expect(await add({ to: '1103-120000-beta', rel: 'verifies' })).toEqual({ ok: false, error: 'boundary' });
    expect(await add({ to: 'a'.repeat(40), rel: 'changes' })).toEqual({ ok: false, error: 'boundary' });
    expect(await add({ to: 'r_zzzzzzzzzz', rel: 'refs' })).toEqual({ ok: false, error: 'boundary' });
    expect(await t.s.addLink(t.project, { from: 'r_zzzzzzzzzz', to: 'T-1', rel: 'implements' }, 'x')).toEqual({ ok: false, error: 'boundary' });
    expect(await add({ to: 'T-1', rel: 'discusses' })).toEqual({ ok: false, error: 'value' });
    expect(await add({ to: 'T-1', rel: 'implements', kind: 'unit' })).toEqual({ ok: false, error: 'value' });
    // A bulk confirm is all or none: one foreign end refuses the lot.
    expect(await t.s.confirmLinks(t.project, { edges: [{ from: u, to: 'T-2', rel: 'implements' }, { from: u, to: 'T-9', rel: 'implements' }] }, 'x')).toEqual({ ok: false, error: 'boundary' });
    expect(fs.existsSync(linksFile(t.home, PROJECT_ID))).toBe(false);
  });

  it('traceQuery: overview groups by prefix, group clusters by section, neighbourhood depth 1 and 2, the type filter counted as hidden', async () => {
    const t = await setup();
    const ov = await t.graph({ level: 'overview' });
    expect(ov.nodes).toEqual([expect.objectContaining({ type: 'group', label: 'FR-ENG', count: 3, group: 'docs/requirements/SRS.md' })]);
    const grp = await t.graph({ level: 'group', group: ov.nodes[0].id });
    expect(grp.nodes.map((n) => [n.label, n.group])).toEqual([
      ['FR-ENG-001', 'SRS.md · 3.1 엔진'],
      ['FR-ENG-002', 'SRS.md · 3.1 엔진'],
      ['FR-ENG-003', 'SRS.md · 3.1 엔진'],
    ]);
    expect(grp.edges.map((e) => e.rel)).toEqual(['refs']);
    const c = t.uid['FR-ENG-001'];
    const d1 = await t.graph({ level: 'neighbourhood', center: c, depth: '1' });
    expect(d1.nodes.map((n) => n.id).sort()).toEqual([c, t.uid['FR-ENG-002'], 'T-2', t.sha('FR-ENG-001: resume the session')].sort());
    const d2 = await t.graph({ level: 'neighbourhood', center: c, depth: '2' });
    expect(d2.nodes.map((n) => n.id)).toEqual(expect.arrayContaining(['T-1', '1103-100000-unit'])); // FR-ENG-002's
    const tasksOnly = await t.graph({ level: 'neighbourhood', center: c, depth: '1', types: 'task' });
    expect([tasksOnly.nodes.map((n) => n.id).sort(), tasksOnly.hidden]).toEqual([[c, 'T-2'].sort(), 2]);
    expect(await t.s.graph(t.project, { level: 'neighbourhood', center: c, depth: '3' })).toEqual({ ok: false, error: 'value' });
    expect(await t.s.graph(t.project, { level: 'neighbourhood', center: 'r_zzzzzzzzzz' })).toEqual({ ok: false, error: 'item' });
    // The items list carries the four states; the summary counts the unlinked (FR-ENG-003 has its refs-table Task: linked).
    const rows = ((await t.s.items(t.project, {})) as { ok: true; value: { items: Array<{ trace?: unknown }> } }).value.items;
    expect(rows.every((r) => r.trace)).toBe(true);
    expect(await t.s.summary(t.project)).toMatchObject({ unlinked: 0, linkReview: 0, missing: 0 });
  });

  it('traceQuery: at most 150 nodes, commits past 20 per node folded into +N, the rest counted as hidden', async () => {
    const commits = Array.from({ length: 30 }, (_, i) => `FR-ENG-003 step ${i}`);
    const many = Array.from({ length: 200 }, (_, i) => task(`T-${100 + i}`, `FR-ENG-001 part ${i}`));
    const t = await setup({ commits, tasks: [...many, task('T-3', 'x')] });
    const folded = await t.graph({ level: 'neighbourhood', center: t.uid['FR-ENG-003'], depth: '1' });
    expect(folded.folded).toEqual({ commit: 10 });
    expect(folded.nodes.filter((n) => n.type === 'commit' && !n.count)).toHaveLength(20);
    expect(folded.nodes.find((n) => n.id === `more:${t.uid['FR-ENG-003']}`)).toMatchObject({ label: '+10', count: 10 });
    expect(folded.edges.find((e) => e.to === `more:${t.uid['FR-ENG-003']}`)).toMatchObject({ rel: 'changes', status: 'observed' });
    const capped = await t.graph({ level: 'neighbourhood', center: t.uid['FR-ENG-001'], depth: '1' });
    expect(capped.nodes).toHaveLength(SPEC_TRACE_NODES_MAX);
    expect(capped.nodes[0].id).toBe(t.uid['FR-ENG-001']);
    expect(capped.hidden).toBe(201 - (SPEC_TRACE_NODES_MAX - 1)); // 200 Tasks and FR-ENG-002 (refs), 149 shown
  });

  it('cost: nothing runs while nobody reads; one commit log per HEAD; the index goes when nobody reads', async () => {
    const t = await setup();
    await t.graph({ level: 'overview' });
    const [builds, scans, calls] = [t.s.traceBuilds, t.s.commitScans, t.rec.calls.length];
    await new Promise((r) => setTimeout(r, 50));
    expect([t.s.traceBuilds, t.s.commitScans, t.rec.calls.length]).toEqual([builds, scans, calls]);
    await t.graph({ level: 'overview' });
    expect(t.s.traceBuilds).toBe(builds); // the same revs, within the interval
    t.tick();
    await t.graph({ level: 'overview' });
    expect([t.s.traceBuilds, t.s.commitScans]).toEqual([builds + 1, scans]); // rebuilt, the same HEAD: no git log
    t.repo.git(['commit', '-q', '--allow-empty', '-m', 'FR-ENG-002 more']);
    t.tick();
    await t.graph({ level: 'overview' });
    expect(t.s.commitScans).toBe(scans + 1);
    expect(t.s.traceHeld(t.project)).toBe(true);
    t.tick(SPEC_TRACE_IDLE_MS);
    for (const fn of t.idle.splice(0)) fn();
    expect(t.s.traceHeld(t.project)).toBe(false);
  });

  it('review fixes: a failed deploy job is never confirmed; the device name is masked; a tag is no commit', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-001'];
    t.jobs.push(job('1103-130000-failed', 'deploy again', 'alpha', 1));
    t.s.sourcesChanged();
    expect(await t.s.addLink(t.project, { from: u, to: '1103-130000-failed', rel: 'verifies', kind: 'deploy' }, 'x')).toMatchObject({ ok: true });
    expect(await t.s.deployConfirm(t.project, { jobId: '1103-130000-failed' }, 'x')).toEqual({ ok: false, error: 'value' });
    expect((await t.item(u)).node.state?.evidence?.deploy).toBe('none');
    const token = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
    const r = await t.s.addLink(t.project, { from: u, to: 'T-2', rel: 'implements' }, `Phone ${token}`);
    expect(r.ok && r.value.by.device).toMatch(/^Phone /);
    expect(JSON.stringify(r)).not.toContain(token);
    expect(fs.readFileSync(linksFile(t.home, PROJECT_ID), 'utf-8')).not.toContain(token);
    t.repo.git(['tag', '-a', 'v1', '-m', 'release', t.sha('T-2 follow-up')]);
    const tagSha = t.repo.git(['rev-parse', 'v1']).trim();
    expect(tagSha).not.toBe(t.sha('T-2 follow-up'));
    expect(await t.s.addLink(t.project, { from: u, to: tagSha, rel: 'changes' }, 'x')).toEqual({ ok: false, error: 'boundary' });
  });

  it('review fix: a commit only on a branch counts while the branch is there; deleted, its link is kept and missing, its evidence none', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-002'];
    t.repo.git(['checkout', '-q', '-b', 'side']);
    t.repo.git(['commit', '-q', '--allow-empty', '-m', 'side work']);
    const side = t.sha('side work');
    t.repo.git(['checkout', '-q', 'main']);
    expect(await t.s.addLink(t.project, { from: u, to: side, rel: 'changes' }, 'x')).toMatchObject({ ok: true });
    expect((await t.item(u)).node.state).toMatchObject({ freshness: 'current', evidence: { change: 'observed', integration: 'none' } });
    t.repo.git(['branch', '-q', '-D', 'side']);
    t.tick();
    const gone = await t.item(u);
    expect(gone.node.state).toMatchObject({ freshness: 'missing', evidence: { change: 'none', integration: 'none' } });
    expect(t.edge(gone, side)).toMatchObject({ status: 'confirmed' });
    expect(gone.nodes.find((n) => n.id === side)?.state?.freshness).toBe('missing');
    expect(await t.s.addLink(t.project, { from: t.uid['FR-ENG-003'], to: side, rel: 'changes' }, 'x')).toEqual({ ok: false, error: 'boundary' });
  });

  it('review fix: a Task or job change the held index read sends specChanged (no poll); job records are read once, not per build', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-003'];
    expect(t.edge(await t.item(u), 'T-1')).toBeUndefined();
    const reads = t.reads.jobs;
    t.tick();
    await t.item(u); // rebuilt (the interval passed): the job records are not read again
    expect(t.reads.jobs).toBe(reads);
    const n = t.sent.length;
    t.tasks.push(task('T-50', 'other project', 'beta')); // not this project's: nothing to tell
    t.s.sourcesChanged();
    expect(t.sent.length).toBe(n);
    t.tasks.find((x) => x.id === 'T-1')!.title = 'FR-ENG-003 도 같이';
    t.s.sourcesChanged();
    expect(t.sent.length).toBe(n + 1);
    expect(t.sent.at(-1)!.rev).toBeGreaterThan(t.sent[n - 1].rev);
    expect(t.s.traceHeld(t.project)).toBe(false);
    expect(t.edge(await t.item(u), 'T-1')).toMatchObject({ status: 'observed', reason: 'title' });
    expect(t.reads.jobs).toBe(reads + 2); // once per change while an index is held, none for the rebuild
  });

  it('link writes change no repository byte and no .git byte; every write bumps the rev specChanged carries', async () => {
    const t = await setup();
    const before = hashTree(t.repo.folder);
    const u = t.uid['FR-ENG-001'];
    const revs = () => t.sent.map((m) => m.rev);
    const n = t.sent.length;
    await t.s.addLink(t.project, { from: u, to: t.sha('T-2 follow-up'), rel: 'changes' }, 'x');
    await t.s.rejectLink(t.project, { from: u, to: 'T-2', rel: 'implements' }, 'x');
    await t.item(u);
    expect(hashTree(t.repo.folder)).toEqual(before);
    expect(t.sent.length).toBe(n + 2);
    expect(revs().slice(n)).toEqual([revs()[n - 1] + 1, revs()[n - 1] + 2]);
  });
});

describe.skipIf(!GIT_AVAILABLE)('the trace routes', () => {
  async function app(opts: { readOnly?: boolean; host?: boolean } = {}) {
    const t = await setup();
    const server = Fastify();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    registerSpecRoutes(server, t.s, {
      auth: async (request, reply) => {
        if (request.headers['x-session'] !== 'ok') await reply.code(401).send('unauthorized');
      },
      kindOf: () => ({ host: !!opts.host, remote: false }),
      actorOf: () => 'Test phone',
      readOnly: !!opts.readOnly,
    });
    const same = { origin: 'http://localhost:80', host: 'localhost:80', 'x-session': 'ok' };
    const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = same) =>
      server.inject({ method, url: `/api/cld/spec/alpha/${url}`, headers, ...(payload && { payload }) });
    const audits = () => log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[cld spec]'));
    return { ...t, call, same, audits };
  }

  it('reads: graph, item and pickers; the 켜기 candidates without type still answer', async () => {
    const t = await app();
    const g = (await t.call('GET', 'graph?level=overview')).json() as TraceGraph;
    expect(g.level).toBe('overview');
    const it = (await t.call('GET', `item/${t.uid['FR-ENG-001']}`)).json() as TraceItem;
    expect(it.node.label).toBe('FR-ENG-001');
    expect((await t.call('GET', 'item/nope')).statusCode).toBe(404);
    expect((await t.call('GET', 'candidates?type=task&q=')).json().candidates.map((c: { id: string }) => c.id)).toEqual(['T-1', 'T-2', 'T-3']);
    expect((await t.call('GET', 'candidates?type=commit&q=follow')).json().candidates).toEqual([expect.objectContaining({ id: t.sha('T-2 follow-up'), title: 'T-2 follow-up' })]);
    expect((await t.call('GET', 'candidates?type=job&q=unit')).json().candidates.map((c: { id: string }) => c.id)).toEqual(['1103-100000-unit']);
    expect((await t.call('GET', 'candidates?type=poem')).statusCode).toBe(400);
    expect((await t.call('GET', 'candidates')).json().docs.length).toBeGreaterThan(0);
  });

  it('writes: no session 401, the host token 403, cross-origin and read-only 403, a foreign end 403; audited by ids only', async () => {
    const t = await app();
    const u = t.uid['FR-ENG-001'];
    const body = { from: u, to: 'T-2', rel: 'implements', note: 'secret-ish note' };
    expect((await t.call('POST', 'links', body, {})).statusCode).toBe(401);
    expect((await t.call('POST', 'links', body, { ...t.same, origin: 'https://evil.example' })).json().errorCode).toBe('origin_mismatch');
    expect((await t.call('DELETE', 'links/l_aaaaaaaaaa', undefined, { ...t.same, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await t.call('POST', 'links', { ...body, to: 'T-9' })).json().errorCode).toBe('spec_boundary');
    const added = (await t.call('POST', 'links', body)).json() as { id: string };
    expect((await t.call('POST', 'links/confirm', { edges: [{ from: u, to: t.uid['FR-ENG-002'], rel: 'refs' }] })).json()).toEqual({ ok: true, links: 1 });
    expect((await t.call('POST', 'links/reject', { from: u, to: t.sha('T-2 follow-up'), rel: 'changes' })).statusCode).toBe(200);
    expect((await t.call('PATCH', `links/${added.id}`, { note: 'x' })).statusCode).toBe(200);
    expect((await t.call('POST', 'review', { uid: u })).json().errorCode).toBe('spec_stale');
    expect((await t.call('POST', 'deploy-confirm', { jobId: '1103-120000-beta' })).json().errorCode).toBe('spec_boundary');
    expect((await t.call('DELETE', `links/${added.id}`)).statusCode).toBe(200);
    const a = t.audits();
    expect(a).toHaveLength(5);
    expect(a[0]).toBe(`[cld spec] link device="Test phone" project="alpha" ${added.id} ${u} implements T-2`);
    expect(a.join('\n')).not.toMatch(/secret-ish|SRS|요구/);
    const jsonl = fs.readFileSync(path.join(t.home, '.config/agent-tycoon/audit.jsonl'), 'utf-8');
    expect(jsonl.trim().split('\n').map((l) => (JSON.parse(l) as { detail: string }).detail.split(' ')[0]).slice(-5)).toEqual(['link', 'confirm', 'reject', 'link-edit', 'unlink']);
    const host = await app({ host: true });
    expect((await host.call('GET', 'graph?level=overview')).json().errorCode).toBe('spec_session_only');
    const ro = await app({ readOnly: true });
    expect((await ro.call('POST', 'links', body)).json().errorCode).toBe('read_only_mode');
    expect((await ro.call('GET', 'graph?level=overview')).statusCode).toBe(200);
  });
});

// SPT-P3-ISSUES: a Task's requirements (the 이슈 tab's Task detail).
describe.skipIf(!GIT_AVAILABLE)('the Task route', () => {
  it('confirmed, observed and rejected requirements of one Task; another project’s Task 404; masked, capped; off says so', async () => {
    const t = await setup();
    const server = Fastify();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    registerSpecRoutes(server, t.s, { auth: async () => undefined, kindOf: () => ({ host: false, remote: false }), readOnly: false });
    const get = async (id: string) => {
      const r = await server.inject({ method: 'GET', url: `/api/cld/spec/alpha/task/${encodeURIComponent(id)}` });
      return { code: r.statusCode, body: r.json() as TraceTaskReqs };
    };
    const one = t.uid['FR-ENG-001'];
    const two = t.uid['FR-ENG-002'];
    // observed: the SRS row names T-2 (where: the document line); T-1's title names FR-ENG-002.
    expect((await get('T-2')).body).toMatchObject({ enabled: true, edges: [{ from: one, to: 'T-2', rel: 'implements', status: 'observed', source: { path: 'docs/requirements/SRS.md', line: 7 } }], nodes: [{ id: one, type: 'req', label: 'FR-ENG-001' }] });
    expect(await t.s.confirmLinks(t.project, { edges: [{ from: one, to: 'T-2', rel: 'implements' }] }, 'Test phone')).toMatchObject({ ok: true });
    expect(await t.s.rejectLink(t.project, { from: two, to: 'T-1', rel: 'implements' }, 'Test phone')).toMatchObject({ ok: true });
    expect((await get('T-2')).body.edges).toEqual([expect.objectContaining({ status: 'confirmed', by: { kind: 'owner' } })]);
    expect((await get('T-1')).body.edges).toEqual([expect.objectContaining({ from: two, status: 'rejected', reason: 'title' })]);
    // Only the Task's own requirement links: the suggested commit of T-2 is FR-ENG-001's, not a Task end.
    expect((await get('T-2')).body.edges.every((e) => e.rel === 'implements' && e.to === 'T-2')).toBe(true);
    expect((await get('T-9')).code).toBe(404); // beta's
    expect((await get('T-404')).code).toBe(404);
    // A requirement's text with a secret, longer than the cap, naming T-3: masked and capped.
    t.repo.write('docs/requirements/SRS.md', SRS + `| FR-ENG-004 | api_key=sk-ant-abcdefgh12345678 ${'긴 글 '.repeat(80)} | T-3 |\n`);
    t.tick();
    const three = (await get('T-3')).body;
    const four = three.nodes.find((n) => n.label === 'FR-ENG-004')!;
    expect(four.title).toBeTruthy();
    expect(JSON.stringify(three)).not.toContain('sk-ant-abcdefgh12345678');
    expect(four.title!.length).toBeLessThanOrEqual(SPEC_ITEM_TITLE_MAX);
    expect(t.s.disable(t.project)).toMatchObject({ ok: true });
    expect(await get('T-2')).toEqual({ code: 200, body: { enabled: false, edges: [], nodes: [] } });
  });
});

describe('TOKEN-GUARD', () => {
  it('the spec tracking code reaches no LLM and no agent: it imports nothing that types, sends or runs one', () => {
    const dir = __dirname;
    const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const imports = sources.flatMap((f) => [...fs.readFileSync(path.join(dir, f), 'utf-8').matchAll(/from '([^']+)'/g)].map((m) => m[1]));
    expect(imports.filter((i) => /messenger|typist|providers|claude|codex|mcp|openai|anthropic|agents\/|chat|groupMessages|engine\.js/i.test(i))).toEqual([]);
  });
});
