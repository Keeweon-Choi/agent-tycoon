// SPT-P1A: the Registry store, the service (enable, scan, restart, git as evidence), the routes'
// guards, the source-bytes guarantee and the cost when nothing asks.
import * as crypto from 'crypto';
import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as zlib from 'zlib';

import type { SpecChanged } from '../../../../core/src/messages.js';
import { SPEC_FOLLOW_UP_READ_MS, SPEC_SCAN_MIN_MS, SPEC_SETTLE_MS } from '../../constants.js';
import { GIT_AVAILABLE, makeTempRepo, recording, type TempRepo } from '../engine/git/testRepo.js';
import { detachSpecData } from '../projectData.js';
import { cacheFile, keyFile } from './cache.js';
import { normalRemote } from './gitEvidence.js';
import { keyedHasher } from './identity.js';
import { registerSpecRoutes } from './routes.js';
import { type Question, type SpecAlert, type SpecProject, SpecService } from './service.js';
import { DOC_UID_RE, readRegistry, registryFile, specDirectory } from './store.js';

// The file system as it is, with call records the cost test reads.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return { ...real, lstatSync: vi.fn(real.lstatSync), readFileSync: vi.fn(real.readFileSync), readdirSync: vi.fn(real.readdirSync) };
});

const PROJECT_ID = 'p_abcdefghij';
let repo: TempRepo | null = null;
const homes: string[] = [];
afterEach(() => {
  repo?.cleanup();
  repo = null;
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** A repository holding the shapes slice 1a must tell apart. */
function fixture() {
  repo = makeTempRepo();
  repo.write('.gitignore', 'private-plan.md\n');
  repo.write('docs/requirements/SRS.md', '# SRS\n| ID | 요구 |\n|---|---|\n| FR-OFC-001 | x |\n');
  repo.write('docs/design/cockpit.md', '# Cockpit\n');
  repo.write('docs/adr/0001-x.md', '# ADR\n');
  repo.write('HANDOFF.md', '# log\n');
  repo.write('private-plan.md', '# secret plan\n');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs']);
  repo.write('docs/design/cockpit.md', '# Cockpit v2\n'); // modified
  repo.write('docs/TODO.md', '- [ ] a\n'); // untracked
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-spec-home-')));
  homes.push(home);
  return { repo, home, project: { name: 'alpha', folder: repo.folder, projectId: PROJECT_ID } as SpecProject };
}

function service(home: string, project: SpecProject, run = repo!.run) {
  // Files written by the fixture are "now"; the clock runs ahead so they are settled.
  let clock = Date.now() + SPEC_SETTLE_MS * 2;
  const sent: SpecChanged[] = [];
  const later: Array<{ fn: () => void; ms: number }> = []; // the settle follow-ups, run by hand
  const s = new SpecService({ home, projects: () => [project], broadcast: (m) => sent.push(m), run, now: () => clock, later: (fn, ms) => later.push({ fn, ms }) });
  return { s, sent, later, tick: (ms = SPEC_SCAN_MIN_MS) => (clock += ms), clock: () => clock };
}

/** sha256 of every file under `root`, `.git` included. */
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of fs.readdirSync(root, { recursive: true }).map(String).sort()) {
    const abs = path.join(root, rel);
    const st = fs.lstatSync(abs);
    if (st.isFile()) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
    else if (st.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(abs)}`;
  }
  return out;
}

describe.skipIf(!GIT_AVAILABLE)('the service', () => {
  it('offers the working tree: kinds, git states, the ignored and log ones unticked', async () => {
    const { home, project } = fixture();
    const { s } = service(home, project);
    const c = await s.candidates(project);
    const row = (p: string) => c.docs.find((d) => d.path === p);
    expect(row('docs/requirements/SRS.md')).toMatchObject({ kind: 'requirements', git: 'committed', preselect: true });
    expect(row('docs/design/cockpit.md')).toMatchObject({ kind: 'design', git: 'modified', preselect: true });
    expect(row('docs/TODO.md')).toMatchObject({ kind: 'plan', git: 'untracked', preselect: true });
    expect(row('private-plan.md')).toMatchObject({ git: 'ignored', preselect: false });
    expect(row('HANDOFF.md')).toMatchObject({ kind: 'log', preselect: false });
  });

  it('enable gives every picked document a UID, kept across a restart, a commit and a turn off and on; no repository byte changes', async () => {
    const { repo, home, project } = fixture();
    const before = hashTree(repo.folder);
    const { s, sent } = service(home, project);
    const picked = ['docs/requirements/SRS.md', 'docs/design/cockpit.md', 'docs/TODO.md', 'private-plan.md'];
    const r = await s.enable(project, picked);
    expect(r).toEqual({ ok: true, value: { docs: 4, byKind: { requirements: 1, design: 1, plan: 1, other: 1 } } });
    const docs = (await s.docs(project)).docs;
    expect(docs.map((d) => [d.path, d.git])).toEqual([
      ['docs/TODO.md', 'untracked'],
      ['docs/design/cockpit.md', 'modified'],
      ['docs/requirements/SRS.md', 'committed'],
      ['private-plan.md', 'ignored'],
    ]);
    expect(docs.every((d) => DOC_UID_RE.test(d.uid))).toBe(true);
    expect(sent.at(-1)).toMatchObject({ type: 'specChanged', project: 'alpha' });
    // The Registry holds no text: neither a body line nor a title (display IDs are evidence it keeps).
    const file = registryFile(home, PROJECT_ID);
    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).not.toMatch(/secret plan|Cockpit|요구/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['match-cache.json.gz', 'registry.json']); // no tmp left
    const uids = Object.fromEntries(docs.map((d) => [d.path, d.uid]));

    // A restart: a new service reads the same file.
    const again = service(home, project);
    const after = (await again.s.docs(project)).docs;
    expect(Object.fromEntries(after.map((d) => [d.path, d.uid]))).toEqual(uids);
    expect(hashTree(repo.folder)).toEqual(before);

    // The untracked one is committed: the same UID, now committed.
    repo.git(['add', 'docs/TODO.md']);
    repo.git(['commit', '-q', '-m', 'todo']);
    again.tick();
    const committed = (await again.s.docs(project)).docs.find((d) => d.path === 'docs/TODO.md');
    expect(committed).toMatchObject({ uid: uids['docs/TODO.md'], git: 'committed' });

    // Off and on again: every UID stays.
    expect(again.s.disable(project)).toEqual({ ok: true, value: null });
    expect((await again.s.summary(project)).enabled).toBe(false);
    await again.s.enable(project, picked);
    expect(Object.fromEntries((await again.s.docs(project)).docs.map((d) => [d.path, d.uid]))).toEqual(uids);
  });

  it('a file written in the last few seconds waits for the next scan; a deleted one retires and its path brings it back', async () => {
    const { repo, home, project } = fixture();
    const { s, tick, clock } = service(home, project);
    await s.enable(project, ['docs/TODO.md']);
    const reg = () => readRegistry(registryFile(home, PROJECT_ID), PROJECT_ID).registry!;
    const blob = Object.values(reg().docs)[0].blob;
    expect(blob).toMatch(/^[0-9a-f]{40}$/);
    const todo = path.join(repo.folder, 'docs/TODO.md');
    fs.writeFileSync(todo, '- [x] a\n');
    tick();
    const fresh = new Date(clock() - 1_000);
    fs.utimesSync(todo, fresh, fresh);
    await s.docs(project);
    expect(Object.values(reg().docs)[0].blob).toBe(blob); // being written: not read yet
    tick();
    await s.docs(project);
    expect(Object.values(reg().docs)[0].blob).not.toBe(blob);
    fs.rmSync(todo);
    tick();
    await s.docs(project);
    expect(Object.values(reg().docs)[0].state).toBe('retired');
    fs.writeFileSync(todo, 'back\n');
    tick();
    await s.docs(project);
    const back = Object.values(reg().docs)[0];
    expect([back.state, back.decisions.map((d) => d.how)]).toEqual(['active', ['new', 'retired', 'D0']]);
  });

  it('a Registry it cannot read is corrupt: reported, never written over, every write refused', async () => {
    const { home, project } = fixture();
    const file = registryFile(home, PROJECT_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"v": 1, "projectId": "p_abcdefghij", "docs": ');
    const bytes = fs.readFileSync(file);
    const { s } = service(home, project);
    expect(await s.summary(project)).toMatchObject({ enabled: false, corrupt: true });
    expect(await s.enable(project, ['docs/TODO.md'])).toEqual({ ok: false, error: 'corrupt' });
    expect(s.disable(project)).toEqual({ ok: false, error: 'corrupt' });
    expect(fs.readFileSync(file)).toEqual(bytes);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['registry.json']);
  });

  it('enable takes only Markdown files inside the folder, through no link, not protected', async () => {
    const { repo, home, project } = fixture();
    const outside = path.join(repo.root, 'outside.md');
    fs.writeFileSync(outside, 'x');
    fs.symlinkSync(outside, path.join(repo.folder, 'link.md'));
    repo.write('.claude/plan.md', 'x');
    const { s } = service(home, project);
    for (const bad of ['../outside.md', outside, 'link.md', '.claude/plan.md', 'a.txt', 'docs/../HANDOFF.md', 'nope.md', 3])
      expect(await s.enable(project, [bad])).toEqual({ ok: false, error: 'path' });
    expect(await s.enable(project, 'docs/TODO.md')).toEqual({ ok: false, error: 'value' });
    expect(fs.existsSync(registryFile(home, PROJECT_ID))).toBe(false);
  });
});

describe.skipIf(!GIT_AVAILABLE)('cost', () => {
  it('tracking off: reads walk names only (no stat, no file read, no git status); nobody asking: nothing at all', async () => {
    const { home, project } = fixture();
    const rec = recording(repo!.run);
    const { s, tick } = service(home, project, rec.run);
    const lstat = vi.mocked(fs.lstatSync);
    const read = vi.mocked(fs.readFileSync);
    const readdir = vi.mocked(fs.readdirSync);
    for (const m of [lstat, read, readdir]) m.mockClear();
    const timers = vi.spyOn(globalThis, 'setInterval');
    // Nobody asks: a while passes, nothing runs.
    await new Promise((r) => setTimeout(r, 50));
    expect([rec.calls.length, lstat.mock.calls.length, readdir.mock.calls.length, s.scans]).toEqual([0, 0, 0, 0]);
    // Off, and the 개요 and 문서 tab are read: a names-only count and the commit list, never a scan.
    const sum = await s.summary(project);
    expect(sum).toMatchObject({ enabled: false, candidates: 4 }); // SRS, design, ADR, TODO
    await s.docs(project);
    expect(await s.items(project, {})).toMatchObject({ ok: true, value: { enabled: false, items: [] } });
    expect(s.scans).toBe(0);
    expect(lstat.mock.calls.filter(([p]) => String(p).startsWith(project.folder))).toEqual([]);
    expect(read.mock.calls.filter(([p]) => String(p).startsWith(project.folder))).toEqual([]);
    expect(rec.calls.map((a) => a[0])).toEqual(['rev-parse', 'log']);
    // Read again soon after: nothing new (rate-limited), and no timer was ever set.
    readdir.mockClear();
    await s.summary(project);
    expect([rec.calls.length, readdir.mock.calls.length]).toEqual([2, 0]);
    tick();
    await s.summary(project);
    expect(rec.calls.map((a) => a[0])).toEqual(['rev-parse', 'log', 'rev-parse']); // HEAD unchanged: no second log
    expect(timers).not.toHaveBeenCalled();
  });

  it('tracking on and nobody reading: no scan; a read scans at most once per interval', async () => {
    const { home, project } = fixture();
    const rec = recording(repo!.run);
    const { s, tick } = service(home, project, rec.run);
    await s.enable(project, ['docs/TODO.md']);
    const scans = s.scans;
    const calls = rec.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect([s.scans, rec.calls.length]).toEqual([scans, calls]);
    await s.docs(project);
    await s.docs(project);
    expect(s.scans).toBe(scans);
    tick();
    await s.docs(project);
    expect(s.scans).toBe(scans + 1);
  });
});

describe.skipIf(!GIT_AVAILABLE)('the routes', () => {
  async function app(opts: { readOnly?: boolean; host?: boolean } = {}) {
    const { home, project } = fixture();
    const { s } = service(home, project);
    const server = Fastify();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    registerSpecRoutes(server, s, {
      auth: async (request, reply) => {
        if (request.headers['x-session'] !== 'ok') await reply.code(401).send('unauthorized');
      },
      kindOf: () => ({ host: !!opts.host, remote: false }),
      actorOf: () => 'Test phone',
      readOnly: !!opts.readOnly,
    });
    const same = { origin: 'http://localhost:80', host: 'localhost:80', 'x-session': 'ok' };
    const call = (method: 'GET' | 'POST', url: string, headers: Record<string, string> = same, payload?: object) =>
      server.inject({ method, url, headers, ...(payload && { payload }) });
    const audits = () => log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[agty spec]'));
    return { call, same, audits, home };
  }

  it('no session 401, the host token 403, cross-origin and read-only writes 403, an unknown project 404', async () => {
    const { call, same } = await app();
    expect((await call('GET', '/api/agty/spec/alpha/summary', {})).statusCode).toBe(401);
    expect((await call('POST', '/api/agty/spec/alpha/disable', {})).statusCode).toBe(401);
    const cross = { ...same, origin: 'https://evil.example' };
    expect((await call('POST', '/api/agty/spec/alpha/enable', cross, { docs: [] })).json().errorCode).toBe('origin_mismatch');
    expect((await call('POST', '/api/agty/spec/alpha/enable', { ...same, origin: '' }, { docs: [] })).statusCode).toBe(403);
    expect((await call('GET', '/api/agty/spec/nope/summary')).statusCode).toBe(404);
    expect((await call('POST', '/api/agty/spec/alpha/docs/d_aaaaaaaaaa', same, { tracked: false })).statusCode).toBe(409); // off
    expect((await call('POST', '/api/agty/spec/alpha/docs/..%2Fx', same, { tracked: false })).statusCode).toBe(404);
    const host = await app({ host: true });
    expect((await host.call('GET', '/api/agty/spec/alpha/summary')).json().errorCode).toBe('spec_session_only');
    const ro = await app({ readOnly: true });
    expect((await ro.call('POST', '/api/agty/spec/alpha/enable', ro.same, { docs: [] })).json().errorCode).toBe('read_only_mode');
    expect((await ro.call('GET', '/api/agty/spec/alpha/summary')).statusCode).toBe(200);
  });

  it('every write is audited with the device, and the answers carry no text', async () => {
    const { call, same, audits, home } = await app();
    const r = await call('POST', '/api/agty/spec/alpha/enable', same, { docs: ['docs/requirements/SRS.md'] });
    expect(r.statusCode).toBe(200);
    const { docs } = (await call('GET', '/api/agty/spec/alpha/docs')).json() as { docs: Array<{ uid: string }> };
    expect((await call('POST', `/api/agty/spec/alpha/docs/${docs[0].uid}`, same, { kind: 'design' })).json()).toMatchObject({ kind: 'design' });
    expect((await call('POST', `/api/agty/spec/alpha/docs/${docs[0].uid}`, same, { kind: 'poem' })).statusCode).toBe(400);
    expect((await call('POST', '/api/agty/spec/alpha/disable')).statusCode).toBe(200);
    expect(audits()).toEqual([
      '[agty spec] enable device="Test phone" project="alpha" docs=1',
      `[agty spec] doc device="Test phone" project="alpha" uid=${docs[0].uid} {"kind":"design"}`,
      '[agty spec] disable device="Test phone" project="alpha" ',
    ]);
    // SPT-P1D: the same writes in audit.jsonl, by the device, with the projectId, and no document text or path.
    const jsonl = fs.readFileSync(path.join(home, '.config/agent-tycoon/audit.jsonl'), 'utf-8');
    const lines = jsonl.trim().split('\n').map((l) => JSON.parse(l) as { kind: string; by: string; via: string; detail: string });
    expect(lines.map((l) => [l.kind, l.by, l.via, l.detail])).toEqual([
      ['spec', 'Test phone', 'local', `enable ${PROJECT_ID} docs:1`],
      ['spec', 'Test phone', 'local', `doc ${PROJECT_ID} ${docs[0].uid} kind:design`],
      ['spec', 'Test phone', 'local', `disable ${PROJECT_ID}`],
    ]);
    expect(jsonl).not.toMatch(/SRS|docs\/|FR-OFC|요구|secret plan/);
    expect(fs.statSync(path.join(home, '.config/agent-tycoon/audit.jsonl')).mode & 0o777).toBe(0o600);
    const summary = await call('GET', '/api/agty/spec/alpha/summary');
    expect(summary.headers['cache-control']).toBe('private, no-store');
    expect(summary.json()).toMatchObject({ enabled: false, git: { branch: 'main', recent: [{ subject: 'docs' }, { subject: 'init' }] } });
    expect(JSON.stringify((await call('GET', '/api/agty/spec/alpha/candidates')).json())).not.toMatch(/secret plan|Cockpit/);
  });

  it('1c: questions and decisions read; resolve and undo are writes (same-origin), checked, audited by UID only', async () => {
    const { call, same, audits } = await app();
    await call('POST', '/api/agty/spec/alpha/enable', same, { docs: ['docs/requirements/SRS.md'] });
    expect((await call('GET', '/api/agty/spec/alpha/questions')).json()).toMatchObject({ enabled: true, questions: [], review: [] });
    expect((await call('GET', '/api/agty/spec/alpha/decisions?limit=5')).statusCode).toBe(200);
    expect((await call('GET', '/api/agty/spec/alpha/decisions?limit=0')).statusCode).toBe(400);
    const cross = { ...same, origin: 'https://evil.example' };
    expect((await call('POST', '/api/agty/spec/alpha/resolve', cross, { uid: 'r_aaaaaaaaaa', answer: 'new' })).statusCode).toBe(403);
    expect((await call('POST', '/api/agty/spec/alpha/undo', cross, { action: 'split', uid: 'r_aaaaaaaaaa' })).statusCode).toBe(403);
    expect((await call('POST', '/api/agty/spec/alpha/resolve', same, { uid: 'r_aaaaaaaaaa', answer: 'maybe' })).statusCode).toBe(400);
    expect((await call('POST', '/api/agty/spec/alpha/resolve', same, { uid: 'r_aaaaaaaaaa', answer: 'new' })).json().errorCode).toBe('spec_item_unknown');
    expect((await call('POST', '/api/agty/spec/alpha/undo', same, { action: 'split', uid: 'r_aaaaaaaaaa' })).statusCode).toBe(404);
    expect(audits().filter((l) => / (resolve|undo) /.test(l))).toEqual([]); // refused writes leave no line
  });
});

// ── SPT-P1B: items ───────────────────────────────────────

const SRS = '# SRS\n## 3.1 Office\n| ID | 요구 | 상태 |\n|---|---|---|\n| FR-OFC-001 | 탭마다 방 | 완료 |\n| FR-OFC-002 | 꺼지면 비용 0 | 진행 |\n';
const DESIGN = '# Cockpit\n## D-001 사이드카에 둔다\n이유\n## D-002 화면은 지연 로드\n';
const PLAN = '# Plan\n## 이번 주\n- [ ] 테스트\n- [ ] 개요 탭\n## 다음 주\n- [ ] 테스트\n';
const PRD = '# 설치 안내\n## 1. 목적\n글\n## 2. 첫 실행\n### 2.1 로그인\n';

/** A repository holding the four document shapes the 1b runner uses, committed. */
function itemFixture() {
  repo = makeTempRepo();
  repo.write('.gitignore', 'docs/requirements/private.md\n');
  repo.write('docs/requirements/SRS.md', SRS);
  repo.write('docs/requirements/README.md', '# not a spec\n');
  repo.write('docs/design/cockpit.md', DESIGN);
  repo.write('docs/plan/TODO.md', PLAN);
  repo.write('docs/product/PRD.md', PRD);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs']);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-spec-home-')));
  homes.push(home);
  const project = { name: 'alpha', folder: repo.folder, projectId: PROJECT_ID } as SpecProject;
  return { repo, home, project };
}
const PICKED = ['docs/requirements/SRS.md', 'docs/design/cockpit.md', 'docs/plan/TODO.md', 'docs/product/PRD.md'];

async function list(s: SpecService, project: SpecProject, q: Record<string, string> = {}) {
  const r = await s.items(project, q);
  if (!r.ok) throw new Error(r.error);
  return r.value.items;
}
const byId = (rows: Array<{ displayId?: string; uid: string }>) => Object.fromEntries(rows.filter((r) => r.displayId).map((r) => [r.displayId!, r.uid]));

describe.skipIf(!GIT_AVAILABLE)('items', () => {
  it('every shape gets an item UID with its current title; a restart keeps them all; no body or title in registry.json; no repository byte changes', async () => {
    const { repo, home, project } = itemFixture();
    const before = hashTree(repo.folder);
    const { s } = service(home, project);
    await s.enable(project, PICKED);
    const rows = await list(s, project);
    expect(rows.map((r) => [r.displayId ?? null, r.title, r.kind, r.shape, r.line])).toEqual([
      ['D-001', '사이드카에 둔다', 'design', 'heading', 2],
      ['D-002', '화면은 지연 로드', 'design', 'heading', 4],
      [null, '테스트', 'plan', 'check', 3],
      [null, '개요 탭', 'plan', 'check', 4],
      [null, '테스트', 'plan', 'check', 6],
      ['FR-OFC-001', '탭마다 방', 'requirements', 'row', 5],
      ['FR-OFC-002', '꺼지면 비용 0', 'requirements', 'row', 6],
    ]);
    expect(rows[2].section).toBe('이번 주');
    expect(rows.every((r) => /^r_[a-z2-7]{10}$/.test(r.uid))).toBe(true);
    expect((await list(s, project, { kind: 'requirements' })).map((r) => r.displayId)).toEqual(['FR-OFC-001', 'FR-OFC-002']);
    expect((await list(s, project, { q: '비용' })).map((r) => r.displayId)).toEqual(['FR-OFC-002']);
    expect((await list(s, project, { q: 'd-00' })).length).toBe(2);
    expect((await s.summary(project)) as unknown).toMatchObject({ items: { total: 7, byKind: { design: 2, plan: 3, requirements: 2 } }, alerts: 0 });

    const raw = fs.readFileSync(registryFile(home, PROJECT_ID), 'utf-8');
    for (const text of ['탭마다', '사이드카', '테스트', '개요 탭', '목적', '이번 주', 'Cockpit', '요구', '완료']) expect(raw).not.toContain(text);
    expect(Object.keys(readRegistry(registryFile(home, PROJECT_ID), PROJECT_ID).registry!.items)).toHaveLength(7);

    // A restart: the same UIDs, the two identical checkboxes included, through the same file.
    const again = service(home, project);
    expect((await list(again.s, project)).map((r) => [r.uid, r.title])).toEqual(rows.map((r) => [r.uid, r.title]));
    expect(hashTree(repo.folder)).toEqual(before);
  });

  it('T1 and T2: an edit that keeps the ID or the text keeps the UID; changing both retires it; writing it back revives it', async () => {
    const { repo, home, project } = itemFixture();
    const { s, tick } = service(home, project);
    await s.enable(project, PICKED);
    const first = byId(await list(s, project));
    const srs = path.join(repo.folder, 'docs/requirements/SRS.md');
    const write = async (text: string) => {
      fs.writeFileSync(srs, text);
      tick();
      return list(s, project, { kind: 'requirements', state: 'all' });
    };
    // T2: the text changes, the ID stays.
    let rows = await write(SRS.replace('탭마다 방', '탭마다 큰 방'));
    expect(byId(rows)['FR-OFC-001']).toBe(first['FR-OFC-001']);
    expect(rows.find((r) => r.displayId === 'FR-OFC-001')?.title).toBe('탭마다 큰 방');
    // T1: the ID changes, the text stays.
    rows = await write(SRS.replace('탭마다 방', '탭마다 큰 방').replace('FR-OFC-002', 'FR-OFC-009'));
    expect(byId(rows)['FR-OFC-009']).toBe(first['FR-OFC-002']);
    // Both change: a new UID, the old one retired and never reused.
    rows = await write(SRS.replace('| FR-OFC-001 | 탭마다 방 |', '| FR-OFC-010 | 전혀 다른 요구 |'));
    const now = byId(rows.filter((r) => r.state === 'active'));
    expect(now['FR-OFC-010']).not.toBe(first['FR-OFC-001']);
    expect(rows.find((r) => r.uid === first['FR-OFC-001'])).toMatchObject({ state: 'retired', title: '' });
    expect((await list(s, project, { kind: 'requirements' })).map((r) => r.displayId)).toEqual(['FR-OFC-010', 'FR-OFC-002']);
    // Written back as it last was: the retired UID by its text (T1).
    rows = await write(SRS.replace('탭마다 방', '탭마다 큰 방'));
    expect(byId(rows.filter((r) => r.state === 'active'))['FR-OFC-001']).toBe(first['FR-OFC-001']);
    const rec = readRegistry(registryFile(home, PROJECT_ID), PROJECT_ID).registry!.items[first['FR-OFC-001']];
    expect(rec.decisions.map((d) => d.how)).toEqual(['new', 'T2', 'retired', 'T1']);
    expect(rec.displayIds.map((d) => d.id)).toEqual(['FR-OFC-001']);
  });

  it('a display ID defined twice: two UIDs, one alert, and T2 still inside its own document (R2, SPT §2.5)', async () => {
    const { repo, home, project } = itemFixture();
    const { s, tick } = service(home, project);
    await s.enable(project, PICKED);
    const first = byId(await list(s, project));
    repo.write('docs/design/cockpit.md', `${DESIGN}## FR-OFC-001 같은 ID를 또 씀\n`);
    tick();
    const rows = await list(s, project, { q: 'FR-OFC-001' });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.uid)).size).toBe(2);
    expect(rows.map((r) => r.uid)).toContain(first['FR-OFC-001']); // the SRS row kept its UID by its text
    const { alerts, docs } = await s.docs(project);
    const uidOf = (p: string) => docs.find((d) => d.path === p)!.uid;
    expect(alerts).toEqual([
      {
        type: 'duplicateIds',
        count: 1,
        ids: ['FR-OFC-001'],
        // Neither looks like a table that repeats the other: no 참조만 suggestion.
        docs: [uidOf('docs/design/cockpit.md'), uidOf('docs/requirements/SRS.md')].sort().map((uid) => ({ uid, path: docs.find((d) => d.uid === uid)!.path })),
        places: expect.arrayContaining([
          { uid: first['FR-OFC-001'], doc: 'docs/requirements/SRS.md', line: 5 },
          expect.objectContaining({ doc: 'docs/design/cockpit.md', line: 5 }),
        ]),
      },
    ]);
    expect(((await s.summary(project)) as { alerts: number }).alerts).toBe(1);
    // Defined twice in the project but once in the SRS: a text edit keeps the UID through the ID in the SRS's own lineage.
    repo.write('docs/requirements/SRS.md', SRS.replace('탭마다 방', '전혀 다른 말로 다시 쓴 요구'));
    tick();
    const srsRow = (await list(s, project, { q: 'FR-OFC-001', kind: 'requirements' }))[0];
    expect(srsRow.uid).toBe(first['FR-OFC-001']);
  });

  it('ID-less headings appear only in the headings mode, down to its depth', async () => {
    const { home, project } = itemFixture();
    const { s } = service(home, project);
    await s.enable(project, PICKED);
    const { docs } = await s.docs(project);
    const prd = docs.find((d) => d.path === 'docs/product/PRD.md')!;
    expect(prd).toMatchObject({ mode: 'auto', depth: 2, items: 0 });
    const prdRows = () => list(s, project, { doc: prd.uid });
    expect(await prdRows()).toEqual([]);
    expect(s.setDoc(project, prd.uid, { mode: 'headings' })).toMatchObject({ ok: true });
    await vi.waitFor(async () => expect((await prdRows()).map((r) => r.title)).toEqual(['1. 목적', '2. 첫 실행']));
    expect(s.setDoc(project, prd.uid, { depth: 3 })).toMatchObject({ ok: true });
    await vi.waitFor(async () => expect((await prdRows()).map((r) => r.title)).toEqual(['1. 목적', '2. 첫 실행', '2.1 로그인']));
    for (const bad of [0, 7, 2.5, '9x'] as unknown[]) expect(s.setDoc(project, prd.uid, { depth: bad })).toEqual({ ok: false, error: 'value' });
    expect(s.setDoc(project, prd.uid, { mode: 'off' })).toMatchObject({ ok: true });
    await vi.waitFor(async () => expect(await prdRows()).toEqual([]));
  });

  it('a new file beside tracked documents is tracked and flagged 새 문서; not one git ignores, nor one left unticked', async () => {
    const { repo, home, project } = itemFixture();
    const { s, tick } = service(home, project);
    await s.enable(project, PICKED); // README.md beside SRS.md left unticked
    repo.write('docs/requirements/NFR.md', '| ID | 요구 |\n|---|---|\n| NFR-PERF-001 | 빠르게 |\n');
    repo.write('docs/requirements/private.md', '| ID | 요구 |\n|---|---|\n| NFR-SEC-001 | 비밀 |\n');
    repo.write('docs/elsewhere/SRS.md', '# not beside a tracked one\n');
    tick();
    const { docs, alerts } = await s.docs(project);
    expect(docs.map((d) => d.path)).toEqual([...PICKED, 'docs/requirements/NFR.md'].sort());
    const nfr = docs.find((d) => d.path === 'docs/requirements/NFR.md')!;
    expect(nfr).toMatchObject({ fresh: true, tracked: true, kind: 'requirements', git: 'untracked' });
    expect(alerts).toEqual([{ type: 'newDoc', uid: nfr.uid, path: 'docs/requirements/NFR.md' }]);
    tick();
    expect((await list(s, project, { q: 'NFR' })).map((r) => r.displayId)).toEqual(['NFR-PERF-001']);
    // The owner looks at it: the flag goes; untracking it keeps it untracked.
    expect(s.setDoc(project, nfr.uid, { seen: true })).toMatchObject({ ok: true, value: { fresh: false } });
    expect(s.setDoc(project, nfr.uid, { tracked: false })).toMatchObject({ ok: true });
    tick();
    expect((await s.docs(project)).alerts).toEqual([]);
    expect(await list(s, project, { q: 'NFR' })).toEqual([]);
  });

  it('the list masks secrets in titles and refuses bad filters', async () => {
    const { repo, home, project } = itemFixture();
    repo.write('docs/plan/TODO.md', '- [ ] token=ghp_abcdefghijklmnopqrstuvwxyz0123 넣기\n');
    const { s } = service(home, project);
    await s.enable(project, ['docs/plan/TODO.md']);
    expect((await list(s, project))[0].title).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    for (const q of [{ kind: 'poem' }, { doc: '../x' }, { state: 'gone' }, { limit: '0' }, { limit: '9999' }, { offset: '-1' }, { q: 'x'.repeat(200) }])
      expect(await s.items(project, q)).toEqual({ ok: false, error: 'value' });
    expect((await list(s, project, { limit: '1', offset: '1' })).length).toBe(0);
  });
});

// ── SPT-P1C: the ladder in the daemon, git as evidence, the match cache, questions and undo ──

const OS = (name: string, reqs: Array<[string, string]>) =>
  `# ${name} Specification\n\n## Purpose\nWhat ${name} does.\n\n## Requirements\n` +
  reqs.map(([t, b]) => `### Requirement: ${t}\n${b}\n\n#### Scenario: basic\n- **WHEN** it happens\n- **THEN** it works\n`).join('\n');
const LOGIN = 'The system SHALL allow a registered user to sign in with an email address and a password, and SHALL lock the account for 15 minutes after five failed attempts in a row.';
const RESET = 'The system SHALL email a single-use password reset link that expires after 30 minutes to the address on the account.';
const AUDIT = 'The system SHALL record every sign-in, sign-out and password change in an append-only audit log kept for 90 days.';
const SRS3 =
  '# SRS\n\n## 3.1 Office\n\n| ID | 요구 | 상태 |\n|---|---|---|\n| FR-OFC-001 | 오케스트레이터 탭마다 방이 있고 방마다 이름표가 붙는다 | 완료 |\n| FR-OFC-002 | 방 이름을 바꿀 수 있고 바꾼 이름은 재시작 뒤에도 남는다 | 진행 |\n| NFR-PERF-008 | 꺼진 프로젝트는 읽지도 세지도 않아 비용이 0이다 | 검토 |\n';

/** One requirement under a long purpose: its body replaced by another under the same title is a T3 match only the title backs (0.6-0.7). */
const PURPOSE = '# Auth Specification\n\n## Purpose\nThis document collects what the sign-in service must do for owners, guests and the help desk, how long it keeps what it learns, and which parts other teams may rely on when they build screens on top of it.\n\n## Requirements\n';
const WRONG_BEFORE = `${PURPOSE}### Requirement: Password reset
비밀번호를 잊은 사람에게 한 번만 쓸 수 있는 재설정 링크를 계정의 메일 주소로 보내고, 링크는 삼십 분 뒤에 끝나며 이미 연 링크는 다시 받지 않는다. 링크를 연 기기와 시각은 계정 기록에 남기고, 같은 주소로 하루에 다섯 번 넘게 요청하면 그날은 더 보내지 않으며, 그 사실을 계정 주인에게 따로 알린다. 새 비밀번호는 지난 세 개와 달라야 하고 바뀐 뒤에는 다른 기기의 접속을 모두 끊는다.
`;
const WRONG_AFTER = `${PURPOSE}### Requirement: Password reset
상담원은 전화한 고객에게 개인 질문 두 개를 확인한 뒤 복구 번호를 읽어 줄 수 있고, 그런 통화는 담당자 이름과 시각과 함께 상담 일지에 남긴다. 일지는 매주 월요일 아침 팀장이 훑어보고 이상한 통화가 있으면 보안 담당에게 넘긴다. 주말과 공휴일에는 당직 한 명만 이 일을 하며, 당직표는 사내 게시판 맨 위에 붙여 둔다.
`;

/** Other requirements in the project: their common words are template text the ladder leaves out. */
const OFFICE = OS('office', [
  ['Room signs', 'The office SHALL show every project room with a sign that carries the project name and the number of agents at work.'],
  ['Night mode', 'The office SHALL dim the lights after the owner has been away for an hour and SHALL light them again on the next visit.'],
  ['Floor list', 'The office SHALL list the floors on the left with the rooms of each floor and SHALL scroll to the one the owner picks.'],
  ['Desk names', 'Every desk SHALL carry the name of the agent sitting at it, and the name SHALL follow the agent when it moves.'],
  ['Lobby clock', 'The lobby SHALL hang a clock that shows the host time and the time of the next scheduled job.'],
]);
/** The match cache as JSON text (gunzipped). */
const cacheText = (home: string) => zlib.gunzipSync(fs.readFileSync(cacheFile(home, PROJECT_ID))).toString('utf-8');

function p1cFixture(files: Record<string, string>) {
  repo = makeTempRepo();
  for (const [rel, text] of Object.entries(files)) repo.write(rel, text);
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs']);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-spec-home-')));
  homes.push(home);
  return { repo, home, project: { name: 'alpha', folder: repo.folder, projectId: PROJECT_ID } as SpecProject };
}
const reg = (home: string) => readRegistry(registryFile(home, PROJECT_ID), PROJECT_ID).registry!;
const uidsById = async (s: SpecService, project: SpecProject) => byId(await list(s, project, { kind: '' }));

describe.skipIf(!GIT_AVAILABLE)('SPT-P1C git as evidence', () => {
  it('a committed rename with an edit keeps every UID (D1, chained per commit since lastHead); the scan changes no repository byte', async () => {
    const { repo, home, project } = p1cFixture({ 'docs/requirements/SRS.md': SRS3 });
    const rec = recording(repo.run);
    const { s, tick } = service(home, project, rec.run);
    await s.enable(project, ['docs/requirements/SRS.md']);
    const doc = (await s.docs(project)).docs[0].uid;
    const ids = await uidsById(s, project);
    // Two commits: a rename, then a rename again with an edit (the chain spans both).
    fs.mkdirSync(path.join(repo.folder, 'docs/reqs'));
    repo.git(['mv', 'docs/requirements/SRS.md', 'docs/reqs/SRS.md']);
    repo.git(['commit', '-q', '-m', 'move']);
    repo.git(['mv', 'docs/reqs/SRS.md', 'docs/reqs/requirements.md']);
    repo.write('docs/reqs/requirements.md', SRS3.replace('비용이 0이다', '비용이 0이고 타이머도 없다'));
    repo.git(['commit', '-q', '-am', 'rename + edit']);
    const bytes = hashTree(repo.folder);
    tick();
    const { docs } = await s.docs(project);
    expect(docs.map((d) => [d.path, d.uid])).toEqual([['docs/reqs/requirements.md', doc]]);
    expect(await uidsById(s, project)).toEqual(ids);
    expect(reg(home).docs[doc].pathHistory.at(-1)).toMatchObject({ path: 'docs/reqs/requirements.md', how: 'D1' });
    expect(rec.calls.some((a) => a[0] === 'merge-base')).toBe(true);
    expect(rec.calls.some((a) => a.includes('log') && a.some((x) => x.endsWith('..HEAD')))).toBe(true);
    expect(hashTree(repo.folder)).toEqual(bytes);
  });

  it('a staged rename (not committed) is D1 from git status; an unstaged move to another folder is matched by content', async () => {
    const { repo, home, project } = p1cFixture({ 'docs/requirements/SRS.md': SRS3, 'docs/design/auth.md': OS('auth', [['User login', LOGIN], ['Audit log', AUDIT]]) });
    const { s, tick } = service(home, project);
    await s.enable(project, ['docs/requirements/SRS.md', 'docs/design/auth.md']);
    const before = Object.fromEntries((await s.docs(project)).docs.map((d) => [d.path, d.uid]));
    const items = (await list(s, project, { kind: '' })).map((r) => r.uid);
    repo.git(['mv', 'docs/requirements/SRS.md', 'docs/requirements/srs-v2.md']); // staged
    fs.mkdirSync(path.join(repo.folder, 'notes'));
    fs.renameSync(path.join(repo.folder, 'docs/design/auth.md'), path.join(repo.folder, 'notes/login.md')); // git sees a delete and an untracked file
    const bytes = hashTree(repo.folder);
    tick();
    const after = Object.fromEntries((await s.docs(project)).docs.map((d) => [d.path, d.uid]));
    expect(after).toEqual({ 'docs/requirements/srs-v2.md': before['docs/requirements/SRS.md'], 'notes/login.md': before['docs/design/auth.md'] });
    const how = (u: string) => reg(home).docs[u].pathHistory.at(-1)!.how;
    expect([how(before['docs/requirements/SRS.md']), how(before['docs/design/auth.md'])]).toEqual(['D1', 'D3']);
    expect((await list(s, project, { kind: '' })).map((r) => r.uid).sort()).toEqual([...items].sort());
    expect(hashTree(repo.folder)).toEqual(bytes);
  });

  it('a rebase that drops lastHead: no commit log is read, the content keeps the UIDs', async () => {
    const { repo, home, project } = p1cFixture({ 'docs/requirements/SRS.md': SRS3 });
    repo.write('docs/requirements/SRS.md', `${SRS3}| FR-OFC-003 | 층을 고를 수 있다 |  |\n`);
    repo.git(['commit', '-q', '-am', 'B']);
    const rec = recording(repo.run);
    const { s, tick } = service(home, project, rec.run);
    await s.enable(project, ['docs/requirements/SRS.md']);
    const doc = (await s.docs(project)).docs[0].uid;
    const ids = await uidsById(s, project);
    // lastHead is B; history is rewritten from A with the rename in a new commit C.
    repo.git(['reset', '-q', '--hard', 'HEAD~1']);
    fs.mkdirSync(path.join(repo.folder, 'spec'));
    repo.git(['mv', 'docs/requirements/SRS.md', 'spec/SRS.md']);
    repo.write('spec/SRS.md', `${SRS3}| FR-OFC-003 | 층을 고를 수 있다 |  |\n`);
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'C']);
    rec.calls.length = 0;
    tick();
    const { docs } = await s.docs(project);
    expect(docs.map((d) => [d.path, d.uid])).toEqual([['spec/SRS.md', doc]]);
    expect(await uidsById(s, project)).toEqual(ids);
    expect(rec.calls.some((a) => a[0] === 'merge-base')).toBe(true);
    expect(rec.calls.some((a) => a.includes('log') && a.some((x) => x.endsWith('..HEAD')))).toBe(false);
    expect(reg(home).docs[doc].pathHistory.at(-1)!.how).toMatch(/^D[23]$/);
  });

  it('an untracked document, then committed: the same document and item UIDs', async () => {
    const { repo, home, project } = p1cFixture({ 'docs/requirements/SRS.md': SRS3 });
    repo.write('docs/requirements/NFR.md', '| ID | 요구 |\n|---|---|\n| NFR-SEC-001 | 비밀은 가린다 |\n');
    const { s, tick } = service(home, project);
    await s.enable(project, ['docs/requirements/SRS.md', 'docs/requirements/NFR.md']);
    const docs = (await s.docs(project)).docs.map((d) => [d.path, d.uid, d.git]);
    const ids = await uidsById(s, project);
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'nfr']);
    tick();
    expect((await s.docs(project)).docs.map((d) => [d.path, d.uid, d.git])).toEqual(docs.map(([p, u]) => [p, u, 'committed']));
    expect(await uidsById(s, project)).toEqual(ids);
  });
});

describe.skipIf(!GIT_AVAILABLE)('SPT-P1C the match cache (SPT §4.1)', () => {
  it('0600 in 0700, masked, no plaintext of an ignored document, gone when tracking goes off, rebuilt with the same UIDs', async () => {
    const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const { home, project } = p1cFixture({
      '.gitignore': 'docs/private/\n',
      'docs/requirements/SRS.md': SRS3.replace('방마다 이름표가 붙는다', `방마다 이름표가 붙는다 token=${TOKEN}`),
      'docs/private/plan.md': OS('secret', [['Launch plan', 'The launch happens on the blue moon with the hidden partner list.']]),
    });
    const { s } = service(home, project);
    await s.enable(project, ['docs/requirements/SRS.md', 'docs/private/plan.md']);
    const file = cacheFile(home, PROJECT_ID);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    const text = cacheText(home);
    expect(text).toContain('오케스트레이터 탭마다 방이 있고'); // the SRS keeps its text, masked
    expect(text).not.toContain(TOKEN);
    expect(text).not.toMatch(/blue moon|hidden partner|Launch plan/); // ignored: hashes only
    const ids = await uidsById(s, project);

    // Deleted while stopped: a restart reads every document again and writes it back; nothing changed, the same UIDs.
    fs.rmSync(file);
    const again = service(home, project);
    expect(await uidsById(again.s, project)).toEqual(ids);
    expect(fs.existsSync(file)).toBe(true);
    expect(cacheText(home)).toContain('오케스트레이터 탭마다 방이 있고');

    // Off: the cache goes, the Registry stays.
    expect(again.s.disable(project)).toEqual({ ok: true, value: null });
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(registryFile(home, PROJECT_ID))).toBe(true);
  });

  it('a document marked 민감 loses its text from the cache at once, and an edit still matches through the hash sets (T3)', async () => {
    const { repo, home, project } = p1cFixture({ 'docs/specs/auth.md': OS('auth', [['User login', LOGIN], ['Password reset', RESET], ['Audit log', AUDIT]]) });
    const { s, tick } = service(home, project);
    await s.enable(project, ['docs/specs/auth.md']);
    const before = (await list(s, project, { kind: '' })).map((r) => r.uid);
    expect(cacheText(home)).toContain('registered user');
    const uid = (await s.docs(project)).docs[0].uid;
    expect(s.setDoc(project, uid, { sensitive: true })).toMatchObject({ ok: true, value: { sensitive: true } });
    expect(cacheText(home)).not.toMatch(/registered user|password reset link|append-only/);
    // Retitled and reworded a little: no T1 (text changed), no T2 (no display ID): T3 on hashes.
    repo.write('docs/specs/auth.md', OS('auth', [['Sign-in with email', LOGIN.replace('15 minutes', '20 minutes')], ['Password reset', RESET], ['Audit log', AUDIT]]));
    tick();
    const after = await list(s, project, { kind: '' });
    expect(after.map((r) => r.uid)).toEqual(before);
    expect(reg(home).items[before[0]].decisions.at(-1)).toMatchObject({ how: 'T3', by: 'engine' });
    expect(cacheText(home)).not.toMatch(/registered user|Sign-in with email/);
  });

  it('no cache text in a log or an answer but a question\'s', async () => {
    const { home, project } = p1cFixture({ 'docs/specs/auth.md': OS('auth', [['User login', LOGIN], ['Audit log', AUDIT]]) });
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    const { s } = service(home, project);
    await s.enable(project, ['docs/specs/auth.md']);
    const answers = JSON.stringify([await s.summary(project), await s.docs(project), await s.items(project, {}), await s.decisions(project, undefined), await s.questions(project)]);
    expect(answers).not.toMatch(/registered user|append-only audit/); // bodies: only in the cache
    expect(JSON.stringify(logs.map((l) => l.mock.calls))).not.toMatch(/registered user|append-only audit/);
  });
});

describe.skipIf(!GIT_AVAILABLE)('SPT-P1C questions, review and undo', () => {
  it('a requirement moved out and pasted twice elsewhere: two questions with the old text; 같아요 on one, 새것 on the other', async () => {
    const { repo, home, project } = p1cFixture({
      'docs/specs/auth.md': OS('auth', [['User login', LOGIN], ['Audit log', AUDIT]]),
      'docs/specs/admin.md': OS('admin', [['Password reset', RESET]]),
    });
    const { s, tick } = service(home, project);
    await s.enable(project, ['docs/specs/auth.md', 'docs/specs/admin.md']);
    const audit = (await list(s, project, { kind: '', q: 'Audit' }))[0].uid;
    repo.write('docs/specs/auth.md', OS('auth', [['User login', LOGIN]]));
    repo.write('docs/specs/admin.md', OS('admin', [['Password reset', RESET], ['Audit log', AUDIT], ['Audit log', AUDIT]]));
    tick();
    const { questions } = await s.questions(project);
    expect(questions.map((q) => q.kind)).toEqual(['item', 'item']);
    const q0 = questions[0] as Exclude<Question, { kind: 'doc' }>;
    expect(q0.cands.map((c) => [c.uid, c.state])).toEqual([[audit, 'retired']]);
    expect(q0.cands[0].text).toContain('append-only audit log');
    expect(Buffer.byteLength(q0.cands[0].text!)).toBeLessThanOrEqual(4096);
    expect(((await s.summary(project)) as { questions: number }).questions).toBe(2);
    // One UID in two places is never an answer.
    expect(s.resolve(project, { uid: q0.uid, answer: 'same', target: audit })).toEqual({ ok: true, value: null });
    expect(s.resolve(project, { uid: questions[1].uid, answer: 'same', target: audit })).toEqual({ ok: false, error: 'stale' });
    expect(s.resolve(project, { uid: questions[1].uid, answer: 'new' })).toEqual({ ok: true, value: null });
    const rows = await list(s, project, { kind: '', q: 'Audit' });
    expect(rows.map((r) => r.state)).toEqual(['active', 'active']);
    expect(rows.map((r) => r.uid)).toContain(audit);
    expect(reg(home).items[audit]).toMatchObject({ aliases: [q0.uid], decisions: expect.arrayContaining([expect.objectContaining({ how: 'owner-same', by: 'owner' })]) });
    // The answer holds on the next scans (nothing asked again).
    tick();
    expect((await s.questions(project)).questions).toEqual([]);
    for (const bad of [{ uid: audit, answer: 'maybe' }, { uid: 'r_zzzzzzzzzz', answer: 'new' }, { answer: 'new' }] as Array<Record<string, unknown>>)
      expect(s.resolve(project, bad).ok).toBe(false);
  });

  it('a T3 match under 0.7 is listed for review; 나누기 gives the item a new UID and retires the old one; 합치기 joins them again', async () => {
    // One requirement whose body is replaced under the same title: only the title and the document back it (0.6-0.7).
    const { repo, home, project } = p1cFixture({ 'docs/specs/auth.md': WRONG_BEFORE, 'docs/specs/office.md': OFFICE });
    const { s, tick } = service(home, project);
    await s.enable(project, ['docs/specs/auth.md', 'docs/specs/office.md']);
    const old = (await list(s, project, { kind: '', doc: (await s.docs(project)).docs.find((d) => d.path.endsWith('auth.md'))!.uid }))[0].uid;
    repo.write('docs/specs/auth.md', WRONG_AFTER);
    tick();
    const { review } = await s.questions(project);
    expect(review).toHaveLength(1);
    expect(review[0]).toMatchObject({ uid: old, title: 'Requirement: Password reset' });
    expect(review[0].score).toBeGreaterThanOrEqual(0.6);
    expect(review[0].score).toBeLessThan(0.7);
    const dec = await s.decisions(project, '5');
    expect(dec.ok && dec.value.decisions[0]).toMatchObject({ uid: old, how: 'T3', canSplit: true });
    const split = s.undo(project, { action: 'split', uid: old });
    expect(split.ok).toBe(true);
    const fresh = split.ok ? split.value.uid : '';
    const all = await list(s, project, { kind: '', state: 'all' });
    expect(all.map((r) => [r.uid, r.state])).toEqual(expect.arrayContaining([[fresh, 'active'], [old, 'retired']]));
    expect((await s.questions(project)).review).toEqual([]);
    tick();
    const authRows = async () => (await list(s, project, { kind: '', q: 'Password' })).map((r) => r.uid);
    expect(await authRows()).toEqual([fresh]); // the split holds
    const d2 = await s.decisions(project, undefined);
    const row = d2.ok ? d2.value.decisions.find((d) => d.uid === fresh) : undefined;
    expect(row?.mergeInto?.map((x) => x.uid)).toContain(old);
    expect(s.undo(project, { action: 'merge', uid: fresh, into: old })).toEqual({ ok: true, value: { uid: old } });
    expect(await authRows()).toEqual([old]);
    expect(s.undo(project, { action: 'merge', uid: old, into: old }).ok).toBe(false);
  });

  it('the same path wholly rewritten asks "same document?"; 같은 문서 gives the old UID back', async () => {
    const { repo, home, project } = p1cFixture({ 'docs/requirements/SRS.md': SRS3 });
    const { s, tick } = service(home, project);
    await s.enable(project, ['docs/requirements/SRS.md']);
    const doc = (await s.docs(project)).docs[0].uid;
    repo.write('docs/requirements/SRS.md', '# 회의록\n\n## M-001 점심 메뉴\n\n오늘은 김밥과 라면으로 정했고 다음 주에는 비빔밥을 먹기로 했다.\n');
    tick();
    const { questions } = await s.questions(project);
    expect(questions).toEqual([expect.objectContaining({ kind: 'doc', doc: 'docs/requirements/SRS.md', items: 1, cands: [expect.objectContaining({ uid: doc, why: ['path'] })] })]);
    expect((await list(s, project, { kind: '' })).map((r) => r.state)).toEqual(['unresolved']);
    expect(s.resolve(project, { uid: questions[0].uid, answer: 'same', target: doc })).toEqual({ ok: true, value: null });
    expect((await s.docs(project)).docs.map((d) => [d.uid, d.state])).toEqual([[doc, 'active']]);
    expect((await list(s, project, { kind: '' })).map((r) => r.state)).toEqual(['active']);
    tick();
    expect((await s.questions(project)).questions).toEqual([]);
  });

  it('a trace table repeating the SRS IDs is one grouped alert; 참조만 하는 표 clears it and makes no items', async () => {
    const trace = `# 추적표\n\n| ID | 설계 | 시험 |\n|---|---|---|\n| FR-OFC-001 | a.md | TC-1 |\n| FR-OFC-002 | a.md | TC-2 |\n| NFR-PERF-008 | b.md | TC-3 |\n`;
    const { home, project } = p1cFixture({ 'docs/requirements/SRS.md': SRS3, 'docs/requirements/traceability.md': trace });
    const { s } = service(home, project);
    await s.enable(project, ['docs/requirements/SRS.md', 'docs/requirements/traceability.md']);
    const { alerts, docs } = await s.docs(project);
    const t = docs.find((d) => d.path.endsWith('traceability.md'))!;
    expect(alerts).toEqual([expect.objectContaining({ type: 'duplicateIds', count: 3, repeater: { uid: t.uid, path: t.path } })]);
    expect(s.setDoc(project, t.uid, { mode: 'refs' })).toMatchObject({ ok: true, value: { mode: 'refs' } });
    await vi.waitFor(async () => expect((await s.docs(project)).alerts).toEqual([]));
    expect((await s.docs(project)).docs.find((d) => d.uid === t.uid)).toMatchObject({ items: 0, mode: 'refs' });
  });
});

describe.skipIf(!GIT_AVAILABLE)('SPT-P1C review fixes', () => {
  /** The keyed hash of every 3-gram of `text` normalised as the ladder does, under this home's key. */
  const trigramHashes = (home: string, text: string) => {
    const h = keyedHasher(Buffer.from(fs.readFileSync(keyFile(home), 'utf-8').trim(), 'hex'));
    const n = text.toLowerCase().replace(/[\s|#>*_`~[\]()\-:.,;!?'"“”‘’·…/\\]+/g, '');
    return new Set(Array.from({ length: n.length - 2 }, (_, i) => h.tri(n.slice(i, i + 3))));
  };
  const numbersIn = (json: string) => new Set((json.match(/\d+/g) ?? []).map(Number));

  it('a secret leaves no 3-gram hash in the cache: not in the sketch, not in a 민감 document\'s sets; the key is 0600 outside spec/', async () => {
    const TOKEN = 'ghp_qzxjvkwqzxjvkwqzxjvkwqzxjvkwqzxjvkw';
    const { home, project } = p1cFixture({ 'docs/specs/keys.md': OS('keys', [['Deploy key', `The deploy uses token=${TOKEN} for pushes.`]]) });
    const { s } = service(home, project);
    await s.enable(project, ['docs/specs/keys.md']);
    const uid = (await s.docs(project)).docs[0].uid;
    expect(s.setDoc(project, uid, { sensitive: true })).toMatchObject({ ok: true });
    expect(fs.statSync(keyFile(home)).mode & 0o777).toBe(0o600);
    expect(keyFile(home).includes(`${path.sep}spec${path.sep}`)).toBe(false); // outside spec/ (1d backs spec/ up)
    const secret = trigramHashes(home, TOKEN.slice(4)); // its own 3-grams (qzx, zxj, ...): nowhere else in the document
    const inCache = numbersIn(cacheText(home));
    expect([...secret].filter((v) => inCache.has(v))).toEqual([]);
    // The same document's ordinary words are there, as keyed hashes (the sets are what T3 works on).
    expect([...trigramHashes(home, 'deploy')].some((v) => inCache.has(v))).toBe(true);
  });

  it('another key gives other hashes; a lost key makes the cache unusable: rebuilt, the same UIDs', async () => {
    expect(keyedHasher(Buffer.alloc(32, 1)).tri('abc')).not.toBe(keyedHasher(Buffer.alloc(32, 2)).tri('abc'));
    expect(keyedHasher(Buffer.alloc(32, 1)).kid).not.toBe(keyedHasher(Buffer.alloc(32, 2)).kid);
    const { home, project } = p1cFixture({ 'docs/specs/auth.md': OS('auth', [['User login', LOGIN], ['Audit log', AUDIT]]) });
    const { s } = service(home, project);
    await s.enable(project, ['docs/specs/auth.md']);
    const uids = (await list(s, project, { kind: '' })).map((r) => r.uid);
    const kid = JSON.parse(cacheText(home)).kid;
    fs.rmSync(keyFile(home));
    const again = service(home, project);
    expect((await list(again.s, project, { kind: '' })).map((r) => r.uid)).toEqual(uids);
    const rebuilt = JSON.parse(cacheText(home));
    expect(rebuilt.kid).not.toBe(kid);
    expect(Object.keys(rebuilt.items)).toHaveLength(2);
    expect(fs.existsSync(keyFile(home))).toBe(true);
  });

  it('민감 after a restart rewrites the cache on disk; leftover temp files go on load and on turning off', async () => {
    const { home, project } = p1cFixture({ 'docs/specs/auth.md': OS('auth', [['User login', LOGIN]]) });
    const { s } = service(home, project);
    await s.enable(project, ['docs/specs/auth.md']);
    const uid = (await s.docs(project)).docs[0].uid;
    expect(cacheText(home)).toContain('registered user');
    const restarted = service(home, project); // no scan yet: its cache is not in memory
    expect(restarted.s.setDoc(project, uid, { sensitive: true })).toMatchObject({ ok: true });
    expect(cacheText(home)).not.toContain('registered user');
    const tmp = `${cacheFile(home, PROJECT_ID)}.12345.tmp`;
    fs.writeFileSync(tmp, 'left by a crash');
    const third = service(home, project);
    await third.s.docs(project); // loads the cache
    expect(fs.existsSync(tmp)).toBe(false);
    fs.writeFileSync(tmp, 'again');
    expect(third.s.disable(project)).toEqual({ ok: true, value: null });
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('a moved document still being written: the scan stops early, HEAD stays, one follow-up scan reads it', async () => {
    const { repo, home, project } = p1cFixture({ 'docs/requirements/SRS.md': SRS3 });
    const { s, tick, clock, later } = service(home, project);
    await s.enable(project, ['docs/requirements/SRS.md']);
    const doc = (await s.docs(project)).docs[0].uid;
    const head0 = reg(home).repo.lastHead;
    repo.write('notes.txt', 'x');
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'HEAD moves']);
    fs.mkdirSync(path.join(repo.folder, 'spec'));
    fs.renameSync(path.join(repo.folder, 'docs/requirements/SRS.md'), path.join(repo.folder, 'spec/SRS.md'));
    tick();
    const fresh = new Date(clock() - 1_000);
    fs.utimesSync(path.join(repo.folder, 'spec/SRS.md'), fresh, fresh);
    await s.docs(project);
    expect(reg(home).repo.lastHead).toBe(head0);
    expect(reg(home).docs[doc].state).toBe('active'); // not retired while its new place is being written
    expect(later).toHaveLength(1);
    expect(later[0].ms).toBeLessThanOrEqual(SPEC_SETTLE_MS + 1_000);
    tick(SPEC_SETTLE_MS); // the window passes; the follow-up runs (no route read in between)
    later[0].fn();
    await vi.waitFor(() => expect(reg(home).docs[doc].path).toBe('spec/SRS.md'));
    expect(reg(home).repo.lastHead).not.toBe(head0);
    expect(later).toHaveLength(1); // nothing left being written: no more follow-ups
  });

  it('a follow-up needs a reader in the last minute', async () => {
    const { repo, home, project } = p1cFixture({ 'docs/requirements/SRS.md': SRS3 });
    const { s, tick, clock, later } = service(home, project);
    await s.enable(project, ['docs/requirements/SRS.md']);
    const uid = (await s.docs(project)).docs[0].uid;
    tick(SPEC_FOLLOW_UP_READ_MS + 1);
    const writing = () => {
      repo.write('docs/requirements/SRS.md', SRS3.replace('비용이 0이다', `비용이 없다 ${clock()}`));
      const fresh = new Date(clock() - 1_000);
      fs.utimesSync(path.join(repo.folder, 'docs/requirements/SRS.md'), fresh, fresh);
    };
    writing();
    const scans = s.scans;
    expect(s.setDoc(project, uid, { kind: 'design' })).toMatchObject({ ok: true }); // a write scans, nobody reads
    await vi.waitFor(() => expect(s.scans).toBe(scans + 1));
    expect(later).toEqual([]);
    tick();
    writing();
    await s.docs(project); // a read: the deferred file gets its follow-up
    expect(later).toHaveLength(1);
  });
});

// ── SPT-P1D: lifecycle ───────────────────────────────────

/** A credential remote's `@`, kept apart so the public release check does not read the remote as an email. */
const AT = '@';

describe.skipIf(!GIT_AVAILABLE)('SPT-P1D 이어받기 (SPT §2.8)', () => {
  const P2 = 'p_bbbbbbbbbb';
  /** P1 tracked and then removed without the purge box (its cache gone, registry.json kept). */
  async function removed() {
    const f = itemFixture();
    f.repo.git(['remote', 'add', 'up', 'https://someone:sekret-token@GitHub.com/acme/alpha.git']);
    f.repo.git(['remote', 'add', 'bad1', 'https://u:pa/ss@host.example/x']); // unparseable: left out
    f.repo.git(['remote', 'add', 'bad2', `u:tok3n${AT}github.com:a/b.git`]);
    const a = service(f.home, f.project);
    await a.s.enable(f.project, PICKED);
    const all = await list(a.s, f.project, { kind: '' });
    const uids = byId(all);
    const count = all.length;
    const docs = Object.fromEntries((await a.s.docs(f.project)).docs.map((d) => [d.path, d.uid]));
    expect(detachSpecData(f.home, f.project.projectId)).toEqual([]);
    expect(fs.readdirSync(path.dirname(registryFile(f.home, PROJECT_ID)))).toEqual(['registry.json']);
    return { ...f, uids, docs, count };
  }
  const offersOf = async (s: SpecService, p: SpecProject) => ((await s.summary(p)) as { inherit?: Array<{ from: string; why: string; name: string; items: number }> }).inherit ?? [];

  it('the Registry keeps the repository evidence: first-parent root, roots, remotes without credentials, HEAD, folder', async () => {
    const { repo, home } = await removed();
    const raw = fs.readFileSync(registryFile(home, PROJECT_ID), 'utf-8');
    const reg = JSON.parse(raw) as { name: string; repo: Record<string, unknown> };
    const root = repo.git(['rev-list', '--max-parents=0', 'HEAD']).trim();
    expect(reg.repo).toMatchObject({ firstParentRoot: root, roots: [root], lastPath: repo.folder });
    expect(repo.git(['rev-parse', 'HEAD']).trim().startsWith(String(reg.repo.lastHead))).toBe(true);
    expect(reg.repo.remotes).toEqual([repo.remote.replace(/\.git$/, ''), 'github.com/acme/alpha']);
    expect(reg.name).toBe('alpha');
    expect(raw).not.toMatch(/sekret|someone|pa\/ss|tok3n|@/);
  });

  it('normalRemote: credentials go; a URL it cannot clean is left out (null)', () => {
    expect(normalRemote('https://user:tok@GitHub.com/a/b.git')).toBe('github.com/a/b');
    expect(normalRemote('git@github.com:a/b.git')).toBe('github.com/a/b');
    expect(normalRemote('ssh://git@github.com/a/b')).toBe('github.com/a/b');
    expect(normalRemote('/srv/git/r.git')).toBe('/srv/git/r');
    expect(normalRemote('https://u:pa/ss@host/x')).toBeNull();
    expect(normalRemote(`u:tok${AT}github.com:a/b.git`)).toBeNull();
    expect(normalRemote('tok@host/x')).toBeNull();
  });

  it('the same folder registered again: offered, nothing moved until accepted; 이어받기 gives the same UIDs; never automatic', async () => {
    const { repo, home, uids, docs, count } = await removed();
    const p2 = { name: 'alpha', folder: repo.folder, projectId: P2 } as SpecProject;
    const b = service(home, p2);
    const offers = await offersOf(b.s, p2);
    expect(offers).toMatchObject([{ from: PROJECT_ID, why: 'samePath', name: 'alpha', items: count }]);
    // Offered only: no Registry for the new project, the old one where it was.
    await b.s.docs(p2);
    expect(fs.existsSync(registryFile(home, P2))).toBe(false);
    expect(fs.existsSync(registryFile(home, PROJECT_ID))).toBe(true);
    expect(await b.s.inherit(p2, { from: 'p_cccccccccc', answer: 'accept' })).toEqual({ ok: false, error: 'stale' });
    expect(await b.s.inherit(p2, { from: '../x', answer: 'accept' })).toEqual({ ok: false, error: 'value' });
    expect(await b.s.inherit(p2, { from: PROJECT_ID, answer: 'accept' })).toMatchObject({ ok: true });
    expect(fs.existsSync(specDirectory(home, PROJECT_ID))).toBe(false);
    expect(readRegistry(registryFile(home, P2), P2).registry).toMatchObject({ projectId: P2, enabled: true });
    expect(byId(await list(b.s, p2, { kind: '' }))).toEqual(uids);
    expect(Object.fromEntries((await b.s.docs(p2)).docs.map((d) => [d.path, d.uid]))).toEqual(docs);
    expect(fs.existsSync(cacheFile(home, P2))).toBe(true); // rebuilt on the read
    expect(await offersOf(b.s, p2)).toEqual([]);
  });

  it('이어받기 runs on the project queue: an enable that lands while it waits on git wins, and nothing of either is lost', async () => {
    const { repo, home, uids } = await removed();
    const p2 = { name: 'alpha', folder: repo.folder, projectId: P2 } as SpecProject;
    const b = service(home, p2);
    const taking = b.s.inherit(p2, { from: PROJECT_ID, answer: 'accept' });
    await new Promise((r) => setImmediate(r)); // its offer check is waiting on git now
    const enabling = b.s.enable(p2, ['docs/requirements/SRS.md']);
    expect(await taking).toEqual({ ok: false, error: 'stale' });
    expect(await enabling).toMatchObject({ ok: true });
    expect(readRegistry(registryFile(home, P2), P2).registry).toMatchObject({ projectId: P2, enabled: true });
    expect(readRegistry(registryFile(home, PROJECT_ID), PROJECT_ID).registry?.items).toBeDefined(); // the orphan, untouched
    expect(Object.values(byId(await list(b.s, p2, { kind: '' })))).not.toContain(uids['FR-OFC-001']); // new UIDs: no merge
  });

  it('an orphan whose 1d fields have the wrong shape: they are dropped on read, the offer still works, nothing throws', async () => {
    const { repo, home } = await removed();
    const file = registryFile(home, PROJECT_ID);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as { repo: Record<string, unknown>; items: Record<string, Record<string, unknown>>; [k: string]: unknown };
    raw.repo.remotes = 'github.com/acme/alpha';
    raw.repo.roots = 5;
    raw.repo.lastSeenAt = { at: 1 };
    raw.name = ['alpha'];
    raw.dismissed = [1, '../x', 'p_cccccccccc'];
    const first = Object.keys(raw.items)[0];
    raw.items[first].maybe = 'nope';
    fs.writeFileSync(file, JSON.stringify(raw));
    const reg = readRegistry(file, PROJECT_ID).registry!;
    expect(reg).toBeTruthy();
    expect([reg.repo.remotes, reg.repo.roots, reg.repo.lastSeenAt, reg.name, reg.dismissed, reg.items[first].maybe]).toEqual([undefined, undefined, '', undefined, ['p_cccccccccc'], undefined]);
    const p2 = { name: 'alpha', folder: repo.folder, projectId: P2 } as SpecProject;
    expect(await offersOf(service(home, p2).s, p2)).toMatchObject([{ from: PROJECT_ID, why: 'samePath', name: '' }]);
  });

  it('a clone in another folder while the old one is still there: offered (history), no merge; the old folder gone: offered (moved)', async () => {
    const { repo, home } = await removed();
    const clone = path.join(repo.root, 'second');
    repo.git(['clone', '-q', repo.folder, clone], repo.root);
    const p2 = { name: 'alpha-2', folder: clone, projectId: P2 } as SpecProject;
    const b = service(home, p2);
    expect(await offersOf(b.s, p2)).toMatchObject([{ from: PROJECT_ID, why: 'history' }]);
    await b.s.items(p2, {});
    expect(fs.existsSync(specDirectory(home, P2))).toBe(false);
    expect(readRegistry(registryFile(home, PROJECT_ID), PROJECT_ID).registry?.projectId).toBe(PROJECT_ID);
    // The original folder moved away: this clone is offered it as a move.
    fs.renameSync(repo.folder, path.join(repo.root, 'gone'));
    b.tick();
    expect(await offersOf(b.s, p2)).toMatchObject([{ from: PROJECT_ID, why: 'moved' }]);
  });

  it('a fork (same root, another remote, the old HEAD not in its history, the old folder alive): no offer', async () => {
    const f = itemFixture();
    const fork = path.join(f.repo.root, 'fork');
    f.repo.git(['clone', '-q', f.repo.folder, fork], f.repo.root);
    f.repo.git(['remote', 'set-url', 'origin', 'https://example.com/someone/fork.git'], fork);
    fs.writeFileSync(path.join(fork, 'docs/fork.md'), '# fork\n');
    f.repo.git(['add', '-A'], fork);
    f.repo.git(['commit', '-q', '-m', 'fork'], fork);
    f.repo.write('docs/later.md', '# later\n');
    f.repo.git(['add', '-A']);
    f.repo.git(['commit', '-q', '-m', 'later']);
    const a = service(f.home, f.project);
    await a.s.enable(f.project, PICKED);
    detachSpecData(f.home, PROJECT_ID);
    const p2 = { name: 'fork', folder: fork, projectId: P2 } as SpecProject;
    expect(await offersOf(service(f.home, p2).s, p2)).toEqual([]);
  });

  it('새로 시작 dismisses the offer for good (a restart too); a folder that is no repository is offered by its unchanged documents', async () => {
    const { repo, home } = await removed();
    const p2 = { name: 'alpha', folder: repo.folder, projectId: P2 } as SpecProject;
    const b = service(home, p2);
    expect(await offersOf(b.s, p2)).toHaveLength(1);
    expect(await b.s.inherit(p2, { from: PROJECT_ID, answer: 'dismiss' })).toMatchObject({ ok: true });
    expect(await offersOf(service(home, p2).s, p2)).toEqual([]);
    expect(fs.existsSync(registryFile(home, PROJECT_ID))).toBe(true); // still there for another project
    expect(readRegistry(registryFile(home, P2), P2).registry).toMatchObject({ enabled: false, dismissed: [PROJECT_ID] });

    // No repository: the documents decide.
    const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-spec-plain-')));
    homes.push(plain);
    const h2 = path.join(plain, 'home');
    const dir = path.join(plain, 'docs-folder');
    fs.cpSync(path.join(repo.folder, 'docs'), path.join(dir, 'docs'), { recursive: true });
    const old = new Date(Date.now() - 60_000);
    for (const rel of PICKED) fs.utimesSync(path.join(dir, rel), old, old);
    const q1 = { name: 'notes', folder: dir, projectId: PROJECT_ID } as SpecProject;
    await service(h2, q1).s.enable(q1, PICKED);
    detachSpecData(h2, PROJECT_ID);
    const moved = path.join(plain, 'moved');
    fs.renameSync(dir, moved);
    const q2 = { name: 'notes', folder: moved, projectId: P2 } as SpecProject;
    expect(await offersOf(service(h2, q2).s, q2)).toMatchObject([{ from: PROJECT_ID, why: 'docs', share: 1 }]);
    for (const rel of PICKED.slice(0, 3)) fs.appendFileSync(path.join(moved, rel), '\nchanged\n');
    expect(await offersOf(service(h2, q2).s, q2)).toEqual([]);
  });
});

describe.skipIf(!GIT_AVAILABLE)('SPT-P1D alerts left over from 1c (확인할 것)', () => {
  const MAYBE_BEFORE = `${PURPOSE}### Requirement: Password reset
비밀번호를 잊은 사람에게 한 번만 쓸 수 있는 재설정 링크를 계정의 메일 주소로 보내고, 링크는 삼십 분 뒤에 끝나며 이미 연 링크는 다시 받지 않는다. 링크를 연 기기와 시각은 계정 기록에 남기고, 같은 주소로 하루에 다섯 번 넘게 요청하면 그날은 더 보내지 않으며, 그 사실을 계정 주인에게 따로 알린다.
`;
  // Rewritten under another title: one sentence kept, the rest new (scores in 0.3-0.45: a new UID).
  const MAYBE_AFTER = `${PURPOSE}### Requirement: Account recovery
비밀번호를 잊은 사람에게 한 번만 쓸 수 있는 재설정 링크를 계정의 메일 주소로 보낸다. 상담원은 전화한 고객에게 개인 질문 두 개를 확인한 뒤 복구 번호를 읽어 줄 수 있고, 그런 통화는 담당자 이름과 시각과 함께 상담 일지에 남긴다.
`;
  type Maybe = Extract<SpecAlert, { type: 'maybeSame' }>;

  it("'어쩌면 같은 것': a new item while a retired one scored 0.3-0.45; 같아요 makes it the old UID, 아니요 keeps it new", async () => {
    for (const answer of ['same', 'new'] as const) {
      const { repo, home, project } = p1cFixture({ 'docs/specs/auth.md': MAYBE_BEFORE });
      const { s, tick } = service(home, project);
      await s.enable(project, ['docs/specs/auth.md']);
      const [old] = await list(s, project, { kind: '' });
      repo.write('docs/specs/auth.md', MAYBE_AFTER);
      tick();
      const alerts = (await s.docs(project)).alerts.filter((a): a is Maybe => a.type === 'maybeSame');
      expect(alerts).toHaveLength(1);
      const [a] = alerts;
      expect(a.cand.uid).toBe(old.uid);
      expect(a.cand.score).toBeGreaterThanOrEqual(0.3);
      expect(a.cand.score).toBeLessThan(0.45);
      expect(s.resolve(project, { uid: a.uid, answer: 'same', target: 'r_aaaaaaaaaa' })).toEqual({ ok: false, error: 'stale' });
      expect(s.resolve(project, { uid: a.uid, answer, ...(answer === 'same' && { target: old.uid }) })).toEqual({ ok: true, value: null });
      expect((await s.docs(project)).alerts.filter((x) => x.type === 'maybeSame')).toEqual([]);
      expect((await list(s, project, { kind: '' })).map((r) => r.uid)).toEqual([answer === 'same' ? old.uid : a.uid]);
      repo.cleanup();
    }
  });

  it("아니요 through the route: audited with the UIDs only, a stray target never in the record", async () => {
    const { repo, home, project } = p1cFixture({ 'docs/specs/auth.md': MAYBE_BEFORE });
    const { s, tick } = service(home, project);
    await s.enable(project, ['docs/specs/auth.md']);
    repo.write('docs/specs/auth.md', MAYBE_AFTER);
    tick();
    const [a] = (await s.docs(project)).alerts.filter((x): x is Maybe => x.type === 'maybeSame');
    const server = Fastify();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    registerSpecRoutes(server, s, { auth: async () => undefined, kindOf: () => ({ host: false, remote: false }), actorOf: () => 'Test phone', readOnly: false });
    const r = await server.inject({
      method: 'POST',
      url: '/api/agty/spec/alpha/resolve',
      headers: { origin: 'http://localhost:80', host: 'localhost:80' },
      payload: { uid: a.uid, answer: 'new', target: 'Account recovery <b>' },
    });
    expect(r.statusCode).toBe(200);
    const jsonl = fs.readFileSync(path.join(home, '.config/agent-tycoon/audit.jsonl'), 'utf-8');
    expect(jsonl).toContain(`"detail":"resolve ${PROJECT_ID} ${a.uid} new"`);
    expect(jsonl).not.toMatch(/Account|recovery|<b>/);
  });

  it('a retired UID taken back is one 되살아남 alert until the owner looks', async () => {
    const { repo, home, project } = itemFixture();
    const { s, tick } = service(home, project);
    await s.enable(project, PICKED);
    const ids = byId(await list(s, project, { kind: '' }));
    repo.write('docs/requirements/SRS.md', SRS.replace('| FR-OFC-002 | 꺼지면 비용 0 | 진행 |\n', ''));
    tick();
    expect((await s.docs(project)).alerts.filter((a) => a.type === 'revived')).toEqual([]); // retired: nothing to say yet
    repo.write('docs/requirements/SRS.md', SRS);
    tick();
    expect(byId(await list(s, project, { kind: '' }))).toEqual(ids);
    expect((await s.docs(project)).alerts.filter((a) => a.type === 'revived')).toMatchObject([{ type: 'revived', count: 1, places: [{ uid: ids['FR-OFC-002'], displayId: 'FR-OFC-002' }] }]);
    expect(s.resolve(project, { uid: 'revived', answer: 'seen' })).toEqual({ ok: true, value: null });
    expect((await s.docs(project)).alerts.filter((a) => a.type === 'revived')).toEqual([]);
    expect(s.resolve(project, { uid: 'revived', answer: 'seen' })).toEqual({ ok: false, error: 'stale' });
    expect(s.resolve(project, { uid: ids['FR-OFC-002'], answer: 'seen' })).toEqual({ ok: false, error: 'value' });
  });
});

describe.skipIf(!GIT_AVAILABLE)('SPT-P1D small left-overs from 1a', () => {
  it('front-matter words (type, kind, category) name the kind before the name and folders do', async () => {
    const { repo, home, project } = fixture();
    repo.write('notes/why-sidecar.md', '---\ntype: ADR\ntitle: x\n---\n# Why\n');
    repo.write('notes/login.md', '---\nkind: Requirements, draft\n---\n# Login\n');
    repo.write('docs/design/plan-b.md', '---\ncategory: plan\n---\n# B\n');
    repo.write('notes/plain.md', '---\ntype: poem\n---\n# not a kind word\n');
    const { s } = service(home, project);
    const kind = Object.fromEntries((await s.candidates(project)).docs.map((d) => [d.path, d.kind]));
    expect(kind).toMatchObject({ 'notes/why-sidecar.md': 'decision', 'notes/login.md': 'requirements', 'docs/design/plan-b.md': 'plan', 'notes/plain.md': 'other' });
    expect(await s.enable(project, ['notes/why-sidecar.md', 'notes/login.md'])).toMatchObject({ ok: true, value: { byKind: { decision: 1, requirements: 1 } } });
  });

  it('a git read cut at its byte cap: each document past it is asked about by itself (check-ignore), not taken as ignored', async () => {
    const { home, project } = fixture();
    const cut: typeof repo extends null ? never : TempRepo['run'] = async (cwd, args, opts) => {
      const r = await repo!.run(cwd, args, opts);
      const bulk = args.includes('status') || (args.includes('ls-files') && !args.includes('--literal-pathspecs'));
      if (!bulk) return r;
      const head = args.includes('status') ? `${r.stdout.toString('utf-8').split('\0').filter((l) => l.startsWith('# ')).join('\0')}\0` : '';
      return { ...r, code: null, stdout: Buffer.from(head), capped: true };
    };
    const rec = recording(cut);
    const { s } = service(home, project, rec.run);
    const git = Object.fromEntries((await s.candidates(project)).docs.map((d) => [d.path, d.git]));
    expect(git).toMatchObject({ 'docs/requirements/SRS.md': 'committed', 'docs/TODO.md': 'untracked', 'private-plan.md': 'ignored' });
    expect(rec.calls.some((a) => a.includes('check-ignore'))).toBe(true);
    // Not cut: no per-path question at all.
    const plain = recording(repo!.run);
    await service(home, project, plain.run).s.candidates(project);
    expect(plain.calls.some((a) => a.includes('check-ignore'))).toBe(false);
  });
});
