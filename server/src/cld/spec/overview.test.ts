// SPT-P3-OVERVIEW: the 개요's summary counts (each the size of the 요구사항 list it opens), 최근 근거
// (bounds, confirmed vs observed chips, merges, masking, the cache by HEAD, nothing while nobody
// reads), the route's session gate, and TOKEN-GUARD for the new code.
import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TraceRecent, TraceResume } from '../../../../core/src/cld/spec/trace.js';
import type { RepoMerge } from '../../../../core/src/messages.js';
import { SPEC_SCAN_MIN_MS, SPEC_SETTLE_MS, SPEC_TRACE_IDLE_MS } from '../../constants.js';
import { GIT_AVAILABLE, makeTempRepo, recording, type TempRepo } from '../engine/git/testRepo.js';
import { registerSpecRoutes } from './routes.js';
import { type SpecProject, SpecService } from './service.js';
import { SHOW_FILTERS, type TraceJob, type TraceTask } from './trace.js';

const SRS =
  '# SRS\n\n## 3.1 엔진\n\n| ID | 요구 |\n|---|---|\n' +
  '| FR-ENG-001 | 엔진이 세션을 이어 받는다 (FR-ENG-002 참고) |\n' +
  '| FR-ENG-002 | 엔진이 작업을 기록한다 |\n' +
  '| FR-ENG-003 | 엔진이 꺼진 프로젝트를 건너뛴다 |\n' +
  '| FR-REM-001 | 바깥에서 사무실을 연다 |\n';

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
const task = (id: string, title: string, status: string, project = 'alpha'): Task => ({ id, project, title, status });
const hh = (n: number) => String(n).padStart(2, '0');
const job = (id: string, desc: string, n: number, exit: number | null = 0, project: string | null = 'alpha'): Job => ({
  id,
  project,
  desc,
  cmd: 'npm test',
  started: `2026-11-03T${hh(n)}:00:00Z`,
  ended: exit === null ? null : `2026-11-03T${hh(n)}:30:00Z`,
  exit,
});
const merge = (n: number, extra: Partial<RepoMerge> = {}): RepoMerge => ({ ok: true, at: `2026-11-03T${hh(n)}:00:00Z`, target: 'main', auto: true, task: `T-${n}`, branch: `task/t-${n}`, kind: 'ff', sha: 'a'.repeat(40), ...extra });

async function setup(opts: { commits?: number } = {}) {
  repo = makeTempRepo();
  repo.write('docs/requirements/SRS.md', SRS);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs: SRS']);
  for (let i = 0; i < (opts.commits ?? 0); i++) repo.git(['commit', '-q', '--allow-empty', '-m', `chore ${i}`]);
  repo.git(['commit', '-q', '--allow-empty', '-m', 'FR-ENG-001: resume the session']);
  repo.git(['commit', '-q', '--allow-empty', '-m', 'T-2 follow-up token=abc123secretvalue']);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-overview-home-')));
  homes.push(home);
  const project: SpecProject = { name: 'alpha', folder: repo.folder, projectId: 'p_abcdefghij' };
  const tasks: Task[] = [task('T-1', 'FR-ENG-002 기록 정리', 'doing'), task('T-2', '세션 이어 받기', 'review'), task('T-3', '막힌 일', 'blocked'), task('T-4', '끝난 일', 'done'), task('T-9', 'FR-ENG-003 beta', 'doing', 'beta')];
  const jobs: Job[] = [
    ...Array.from({ length: 11 }, (_, i) => job(`1103-${hh(i)}0000-u${i}`, `unit ${i}`, i)),
    job('1103-110000-unit', 'unit FR-ENG-002 password=hunter2', 11, 1),
    job('1103-120000-run', 'still running', 12, null),
    job('1103-130000-beta', 'FR-ENG-003 beta', 13, 0, 'beta'),
  ];
  const merges = vi.fn((_project: string, n: number) => [merge(1, { ok: false, error: 'conflict: password=hunter2 in .env', kind: undefined, sha: 'not a sha' }), ...Array.from({ length: 11 }, (_, i) => merge(i + 2))].slice(0, n));
  let clock = Date.now() + SPEC_SETTLE_MS * 2;
  const idle: Array<() => void> = [];
  const rec = recording(repo.run);
  const s = new SpecService({ home, projects: () => [project], broadcast: () => undefined, run: rec.run, now: () => clock, later: () => undefined, idle: (fn) => idle.push(fn), tasks: () => tasks, jobs: () => jobs, merges });
  expect(await s.enable(project, ['docs/requirements/SRS.md'])).toMatchObject({ ok: true });
  const uid: Record<string, string> = {};
  const listed = (await s.items(project, {})) as { ok: true; value: { items: Array<{ uid: string; displayId?: string }> } };
  for (const i of listed.value.items) uid[i.displayId!] = i.uid;
  const tick = (ms = SPEC_SCAN_MIN_MS) => (clock += ms);
  const recent = async () => {
    const r = await s.recent(project);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  return { repo, home, project, s, idle, rec, merges, uid, tick, recent };
}

describe.skipIf(!GIT_AVAILABLE)('SPT-P3-OVERVIEW', () => {
  it('summary counts on a fixture repo; each count is the size of the 요구사항 list its filter opens', async () => {
    const t = await setup();
    const u = t.uid['FR-ENG-001'];
    for (const body of [
      { from: u, to: 'T-2', rel: 'implements' },
      { from: u, to: '1103-000000-u0', rel: 'verifies', kind: 'unit' },
      { from: u, to: '1103-010000-u1', rel: 'verifies', kind: 'deploy' },
    ])
      expect(await t.s.addLink(t.project, body, 'phone')).toMatchObject({ ok: true });
    // GAME-UI-0: 최근 근거 marks the deploy job's exit 0 as only its word (no 배포 확인), the unit job not.
    expect(await t.s.addLink(t.project, { from: u, to: '1103-090000-u9', rel: 'verifies', kind: 'deploy' }, 'phone')).toMatchObject({ ok: true });
    const jobs = (await t.recent()).jobs;
    expect([jobs.find((j) => j.id === '1103-090000-u9')?.reported, jobs.find((j) => j.id === '1103-080000-u8')?.reported]).toEqual([true, undefined]);
    const sum = (await t.s.summary(t.project)) as unknown as Record<string, unknown> & {
      evidence: Record<string, number>;
      evidenceReported: Record<string, number>;
      work: { linked: number; total: number };
    };
    // FR-ENG-001: confirmed T-2 (its commit suggested: change and integration ✔), a unit job ✔, a deploy job ◐.
    // FR-ENG-002: observed only (T-1's title, FR-ENG-001's text). FR-ENG-003 and FR-REM-001: nothing.
    expect(sum).toMatchObject({ unlinked: 2, observedOnly: 1, reviewNeeded: 0, missing: 0, newDocs: 0, work: { linked: 1, total: 4 } });
    expect(sum.evidence).toEqual({ change: 1, integration: 1, test: 1, deploy: 0 });
    expect(sum.evidenceReported).toEqual({ change: 0, integration: 0, test: 0, deploy: 1 });
    const expected: Record<string, number> = {
      unlinked: 2,
      observed: 1,
      linked: 1,
      review: 0,
      missing: 0,
      ...Object.fromEntries(Object.entries(sum.evidence).map(([k, n]) => [`ev:${k}`, n])),
      ...Object.fromEntries(Object.entries(sum.evidenceReported).map(([k, n]) => [`evr:${k}`, n])),
    };
    expect(Object.keys(expected).sort()).toEqual([...SHOW_FILTERS].sort());
    for (const show of SHOW_FILTERS) {
      const r = await t.s.items(t.project, { show });
      expect([show, r.ok && r.value.total]).toEqual([show, expected[show]]);
    }
    const unlinked = await t.s.items(t.project, { show: 'unlinked' });
    expect(unlinked.ok && unlinked.value.items.map((i) => i.displayId)).toEqual(['FR-ENG-003', 'FR-REM-001']);
    expect(await t.s.items(t.project, { show: 'nope' })).toEqual({ ok: false, error: 'value' });
    // SPT-P3-ACCEPT: acceptance is its own dimension (`acceptance=`), one definition for its count and its list; it combines with `show`.
    const acc = (sum as unknown as { acceptance: Record<string, number> }).acceptance;
    expect(acc).toEqual({ none: 4, validate: 0, accepted: 0, rejected: 0, review: 0 });
    // GAME-UI-1: 이번 주 수락 rides on the summary (no record yet: empty days, five empty past weeks).
    expect((sum as unknown as { week: { days: unknown[]; weeks: number[] } }).week).toMatchObject({ days: Array(7).fill({ accepted: 0, rejected: 0 }), weeks: [0, 0, 0, 0, 0] });
    for (const [a, n] of Object.entries(acc)) {
      const r = await t.s.items(t.project, { acceptance: a });
      expect([a, r.ok && r.value.total]).toEqual([a, n]);
    }
    const both = await t.s.items(t.project, { show: 'unlinked', acceptance: 'none' });
    expect(both.ok && both.value.items.map((i) => i.displayId)).toEqual(['FR-ENG-003', 'FR-REM-001']);
    expect(await t.s.items(t.project, { show: 'acc:none' })).toEqual({ ok: false, error: 'value' });
  });

  it('최근 근거: bounded lists, chips confirmed vs observed, merges, masked text', async () => {
    const t = await setup({ commits: 25 });
    expect(await t.s.addLink(t.project, { from: t.uid['FR-ENG-002'], to: '1103-110000-unit', rel: 'verifies', kind: 'unit' }, 'phone')).toMatchObject({ ok: true });
    const r = await t.recent();
    expect([r.commits.length, r.jobs.length, r.merges.length]).toEqual([20, 10, 10]);
    expect(r.commits[0].subject).toBe('T-2 follow-up token=***');
    expect(r.commits[1]).toMatchObject({ subject: 'FR-ENG-001: resume the session', reqs: [{ uid: t.uid['FR-ENG-001'], label: 'FR-ENG-001', status: 'observed' }] });
    expect(r.commits.every((c) => /^[0-9a-f]{40}$/.test(c.sha) && !!c.at)).toBe(true);
    // Newest ended first; the running job and beta's are not there; the failed one carries its exit and a confirmed chip.
    expect(r.jobs[0]).toEqual({ id: '1103-110000-unit', desc: 'unit FR-ENG-002 password=***', exit: 1, at: '2026-11-03T11:30:00Z', reqs: [{ uid: t.uid['FR-ENG-002'], label: 'FR-ENG-002', status: 'confirmed' }] });
    expect(r.jobs.map((j) => j.id)).not.toContain('1103-120000-run');
    expect(r.jobs.map((j) => j.id)).not.toContain('1103-130000-beta');
    expect(t.merges).toHaveBeenCalledWith('alpha', 10);
    expect(r.merges[0]).toEqual({ ok: false, at: '2026-11-03T01:00:00Z', target: 'main', auto: true, task: 'T-1', branch: 'task/t-1', error: 'conflict: password=*** in .env' });
    expect(r.merges[1]).toMatchObject({ ok: true, kind: 'ff', sha: 'a'.repeat(40) });
    expect(JSON.stringify(r)).not.toMatch(/hunter2|abc123secret/);
  });

  it('cache by HEAD and rev; nothing runs while nobody reads; dropped with the index', async () => {
    const t = await setup();
    await t.recent();
    const [builds, calls, reads] = [t.s.recentBuilds, t.rec.calls.length, t.merges.mock.calls.length];
    await new Promise((r) => setTimeout(r, 50));
    expect([t.s.recentBuilds, t.rec.calls.length, t.merges.mock.calls.length]).toEqual([builds, calls, reads]);
    await t.recent();
    expect([t.s.recentBuilds, t.merges.mock.calls.length]).toEqual([builds, reads]); // the same HEAD and rev
    t.repo.git(['commit', '-q', '--allow-empty', '-m', 'FR-REM-001 open from outside']);
    t.tick();
    const r = await t.recent();
    expect(t.s.recentBuilds).toBe(builds + 1);
    expect(r.commits[0]).toMatchObject({ subject: 'FR-REM-001 open from outside', reqs: [{ label: 'FR-REM-001', status: 'observed' }] });
    expect(await t.s.addLink(t.project, { from: t.uid['FR-ENG-003'], to: 'T-3', rel: 'implements' }, 'phone')).toMatchObject({ ok: true });
    await t.recent();
    expect(t.s.recentBuilds).toBe(builds + 2); // a link write is a new rev
    t.tick(SPEC_TRACE_IDLE_MS);
    for (const fn of t.idle.splice(0)) fn();
    expect(t.s.traceHeld(t.project)).toBe(false);
    const after = t.rec.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(t.rec.calls.length).toBe(after);
    await t.recent();
    expect(t.s.recentBuilds).toBe(builds + 3); // its cache went with the index
  });

  it('tracking off: commits and jobs without chips, merges; the route is session only', async () => {
    const t = await setup();
    expect(t.s.disable(t.project)).toMatchObject({ ok: true });
    const r = await t.recent();
    expect(r.commits[0]).toMatchObject({ subject: 'T-2 follow-up token=***', reqs: [] });
    expect(r.jobs[0].reqs).toEqual([]);
    expect(r.merges).toHaveLength(10);
    const server = Fastify();
    registerSpecRoutes(server, t.s, {
      auth: async (request, reply) => {
        if (request.headers['x-session'] !== 'ok') await reply.code(401).send('unauthorized');
      },
      kindOf: (request) => ({ host: request.headers['x-host'] === '1', remote: false }),
      readOnly: true,
    });
    const get = (headers: Record<string, string>) => server.inject({ method: 'GET', url: '/api/cld/spec/alpha/recent', headers });
    expect((await get({})).statusCode).toBe(401);
    expect((await get({ 'x-session': 'ok', 'x-host': '1' })).json().errorCode).toBe('spec_session_only');
    const ok = await get({ 'x-session': 'ok' });
    expect(ok.statusCode).toBe(200);
    expect((ok.json() as TraceRecent).merges).toHaveLength(10);
    expect((await server.inject({ method: 'GET', url: '/api/cld/spec/nope/recent', headers: { 'x-session': 'ok' } })).statusCode).toBe(404);
  });
});

describe('BRN K5: the 개요\'s handoff route', () => {
  it('session only, tracking off too, the injected reader asked by the Lead\'s name on each read; none or a throw reads as no handoff', async () => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-resume-home-')));
    homes.push(home);
    const project: SpecProject = { name: 'alpha', folder: home, projectId: 'p_abcdefghij' };
    const handoff: TraceResume['handoff'] = { at: '2026-11-06T01:00:00.000Z', format: 'ok', goal: { items: [], total: 0 }, done: { items: [{ text: 'd', tag: 'fact' }], total: 1 }, open: { items: [], total: 0 }, next: { items: [], total: 0 } };
    const resume = vi.fn((name: string) => (name === 'alpha' ? handoff : null));
    const s = new SpecService({ home, projects: () => [project], broadcast: () => undefined, resume });
    const server = Fastify();
    registerSpecRoutes(server, s, {
      auth: async (request, reply) => {
        if (request.headers['x-session'] !== 'ok') await reply.code(401).send('unauthorized');
      },
      kindOf: (request) => ({ host: request.headers['x-host'] === '1', remote: false }),
      readOnly: false,
    });
    const get = (headers: Record<string, string>) => server.inject({ method: 'GET', url: '/api/cld/spec/alpha/resume', headers });
    expect((await get({})).statusCode).toBe(401);
    expect((await get({ 'x-session': 'ok', 'x-host': '1' })).json().errorCode).toBe('spec_session_only');
    expect(resume).not.toHaveBeenCalled();
    const ok = await get({ 'x-session': 'ok' });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['cache-control']).toBe('private, no-store');
    expect(ok.json()).toEqual({ handoff });
    expect(resume).toHaveBeenCalledWith('alpha');
    expect((await server.inject({ method: 'GET', url: '/api/cld/spec/nope/resume', headers: { 'x-session': 'ok' } })).statusCode).toBe(404);
    resume.mockImplementation(() => {
      throw new Error('disk');
    });
    expect((await get({ 'x-session': 'ok' })).json()).toEqual({ handoff: null });
    expect(new SpecService({ home, projects: () => [project], broadcast: () => undefined }).resume(project)).toEqual({ handoff: null });
  });
});

describe('TOKEN-GUARD (SPT-P3-OVERVIEW)', () => {
  it('the 개요 route reads the trace index and the injected readers only: no LLM, agent or engine import in the spec code', () => {
    const dir = __dirname;
    const sources = fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    const imports = sources.flatMap((f) => [...fs.readFileSync(path.join(dir, f), 'utf-8').matchAll(/from '([^']+)'/g)].map((m) => m[1]));
    expect(imports.filter((i) => /messenger|typist|providers|claude|codex|mcp|openai|anthropic|agents\/|chat|groupMessages|engine\.js|mergeHistory|repoManager/i.test(i))).toEqual([]);
    expect(fs.readFileSync(path.join(dir, 'service.ts'), 'utf-8')).toMatch(/async recent\(p: SpecProject\)/);
  });
});
