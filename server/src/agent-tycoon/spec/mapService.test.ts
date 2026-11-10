// SPT C1 (TC-233): the 지도 through the service and the route, the code scan faked (no child
// process): tracking off runs nothing, the same key never scans again, a changed structure is one
// specChanged, the LEDs light from the index; and [제안 모두 승인]·[되돌리기], whose head moved from the
// old map to the design drawing (ArchGraph): the arch read now carries `pending` and `lastBatch`.
// TOKEN-GUARD (trace.test.ts) scans this folder.
import * as crypto from 'crypto';
import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TraceArch, TraceMap } from '../../../../core/src/agent-tycoon/spec/trace.js';
import { SPEC_MAP_MIN_MS, SPEC_MAP_PATHS_ON, SPEC_SCAN_MIN_MS, SPEC_SETTLE_MS, SPEC_TRACE_IDLE_MS } from '../../constants.js';
import { GIT_AVAILABLE, makeTempRepo, recording, type TempRepo } from '../engine/git/testRepo.js';
import { archFile, readArchFile, writeArchFile } from './archOwner.js';
import type { CodeScan } from './mapWorker.js';
import { registerSpecRoutes } from './routes.js';
import { type SpecProject, SpecService } from './service.js';
import type { TraceTask } from './trace.js';

const PROJECT_ID = 'p_abcdefghij';
const DESIGN = ['# Design', '', '```mermaid', 'flowchart LR', '  subgraph back[Backend]', '    api["API server"] --> db[(Main DB)]', '  end', '  web["Web app"] --> api', '```', ''].join('\n');
const SRS = '# SRS\n\n### 3.1 지도(MAP)\n\n| ID | 요구 |\n|---|---|\n| FR-MAP-001 | The API server answers |\n| FR-MAP-002 | 아무것도 부르지 않는다 |\n\n### 3.2 성능\n\n| ID | 요구 |\n|---|---|\n| NFR-PERF-001 | 빠르다 |\n';
let repo: TempRepo | null = null;
const homes: string[] = [];
afterEach(() => {
  repo?.cleanup();
  repo = null;
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  vi.restoreAllMocks();
});
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of fs.readdirSync(root, { recursive: true }).map(String).sort()) {
    const st = fs.lstatSync(path.join(root, rel));
    if (st.isFile()) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
  }
  return out;
}
const scanOf = (files: string[], edges: number[] = []): CodeScan => ({ files, edges, unresolved: 0, workspaces: [], big: 0, at: '2026-11-04T00:00:00.000Z', ms: 1, rssKb: 1 });

async function setup(enable = true) {
  repo = makeTempRepo();
  repo.write('docs/design/system.md', DESIGN);
  repo.write('docs/requirements/SRS.md', SRS);
  repo.write('server/src/main.ts', "import { x } from '../../core/x.js';");
  repo.write('webview-ui/src/App.tsx', 'x');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'feat(FR-MAP-001): init']);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-map-')));
  homes.push(home);
  const project: SpecProject = { name: 'alpha', folder: repo.folder, projectId: PROJECT_ID };
  const sent: Array<{ rev: number }> = [];
  const rec = recording(repo.run);
  const clock = { now: Date.now() + SPEC_SETTLE_MS * 2 };
  const spawned: string[] = [];
  // 진행 comes from the scan's own commit read (C2): one recent commit naming FR-MAP-001.
  const recent = { sha: 'a'.repeat(40), t: Math.floor(Date.now() / 1000), s: 'feat(FR-MAP-001): init', ids: ['FR-MAP-001'], tags: [], f: [0] };
  let answer: CodeScan = { ...scanOf(['server/src/main.ts', 'webview-ui/src/App.tsx']), links: { body: {}, names: {}, tags: {}, tasks: {}, commits: [recent], capped: false } };
  let spawn: (folder: string) => Promise<CodeScan | null> = async () => answer;
  const laters: Array<{ fn: () => void; ms: number }> = [];
  const idles: Array<() => void> = [];
  const tasks: Array<TraceTask & { project: string }> = [{ id: 'T-0001', project: 'alpha', title: 'FR-MAP-002 is stuck', status: 'blocked' }];
  const s = new SpecService({
    home,
    projects: () => [project],
    broadcast: (m) => sent.push(m),
    run: rec.run,
    now: () => clock.now,
    later: (fn, ms) => void laters.push({ fn, ms }),
    idle: (fn) => void idles.push(fn),
    tasks: () => tasks,
    jobs: () => [],
    specMap: (folder) => (spawned.push(folder), spawn(folder)),
  });
  if (enable) expect(await s.enable(project, ['docs/design/system.md', 'docs/requirements/SRS.md'])).toMatchObject({ ok: true });
  const map = async (q: { feature?: string; in?: string } = {}): Promise<TraceMap> => {
    const r = await s.map(project, q);
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const arch = async (): Promise<TraceArch> => {
    const r = await s.arch(project, {});
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  return { repo, home, project, s, sent, rec, map, arch, clock, spawned, laters, idles, setAnswer: (a: CodeScan) => (answer = a), setSpawn: (f: typeof spawn) => (spawn = f) };
}

describe.skipIf(!GIT_AVAILABLE)('the 지도 through the service', () => {
  it('tracking off: an empty map; no child process, no scan, no git, nothing written', async () => {
    const t = await setup(false);
    const before = hashTree(t.repo.folder);
    t.rec.calls.length = 0;
    expect(await t.map()).toEqual({ enabled: false, features: [], common: [], reqTotal: 0, changed: 0, structure: null, linked: 0, pathsOn: [...SPEC_MAP_PATHS_ON], commits: 0, tagOnly: 0 });
    expect([t.spawned.length, t.s.mapScans, t.s.scans, t.rec.calls.length, t.s.traceBuilds]).toEqual([0, 0, 0, 0, 0]);
    expect(t.sent).toEqual([]);
    expect(fs.existsSync(path.join(t.home, '.config'))).toBe(false);
    expect(hashTree(t.repo.folder)).toEqual(before);
  });

  it('features with their LEDs, common criteria apart, the structure from one scan; the same key never scans again; reads write nothing', async () => {
    const t = await setup();
    const before = hashTree(t.repo.folder);
    const sent = t.sent.length;
    const v = await t.map();
    expect(v.features).toEqual([{ key: 'FR-MAP', short: 'MAP', name: '지도', rule: 'prefix', reqs: 2, progress: true, blocked: true, changed: 0, linked: 0 }]);
    expect(v.common).toEqual([{ key: 'NFR-PERF', reqs: 1, changed: 0 }]);
    expect(v.reqTotal).toBe(3);
    expect(v.structure!.bands.map((b) => b.id).sort()).toEqual(['server', 'webview-ui']);
    expect(t.spawned).toEqual([t.repo.folder]);
    t.clock.now += SPEC_SCAN_MIN_MS; // the key is looked at again: unchanged
    await t.map();
    expect(t.s.mapScans).toBe(1);
    const f = await t.map({ feature: 'FR-MAP' });
    expect(f.feature).toMatchObject({ key: 'FR-MAP', name: '지도', reqs: [{ label: 'FR-MAP-001' }, { label: 'FR-MAP-002' }], more: 0 });
    expect((await t.map({ feature: 'NFR-PERF' })).feature!.reqs.map((r) => r.label)).toEqual(['NFR-PERF-001']);
    expect(await t.s.map(t.project, { feature: 'FR-NONE' })).toEqual({ ok: false, error: 'item' });
    expect((await t.map({ in: 'server' })).structure!.crumbs).toEqual([{ id: 'server', name: 'server' }]);
    expect(await t.s.map(t.project, { in: 'nowhere' })).toEqual({ ok: false, error: 'comp' });
    expect(await t.s.map(t.project, { in: 5 })).toEqual({ ok: false, error: 'value' });
    expect(t.sent.length).toBe(sent);
    expect(hashTree(t.repo.folder)).toEqual(before);
    expect(fs.existsSync(archFile(t.home, PROJECT_ID))).toBe(false);
  });

  it('nobody reading for SPEC_TRACE_IDLE_MS: the code scan is let go with the index, the next look runs the child again', async () => {
    const t = await setup();
    await t.map();
    t.clock.now += SPEC_SCAN_MIN_MS + 1;
    await t.map();
    expect(t.spawned.length).toBe(1); // same key: kept
    t.clock.now += SPEC_TRACE_IDLE_MS;
    for (const fn of t.idles.splice(0)) fn();
    expect(t.s.traceHeld(t.project)).toBe(false);
    await t.map();
    expect(t.spawned.length).toBe(2);
  });
  it('a changed key past SPEC_MAP_MIN_MS scans again; a changed answer is one specChanged with a higher rev, the same answer none', async () => {
    const t = await setup();
    await t.map();
    const rev = (await t.s.summary(t.project)) && t.sent.length;
    t.repo.write('server/src/more.ts', 'x');
    t.clock.now += SPEC_SCAN_MIN_MS; // looked at, changed, but too soon: the old answer, no scan
    await t.map();
    expect(t.s.mapScans).toBe(1);
    t.clock.now += SPEC_MAP_MIN_MS;
    await t.map(); // scanned, the same answer: no specChanged
    expect([t.s.mapScans, t.sent.length]).toEqual([2, rev]);
    t.repo.write('server/src/more2.ts', 'x');
    t.setAnswer(scanOf(['server/src/main.ts', 'server/src/more.ts', 'webview-ui/src/App.tsx']));
    t.clock.now += SPEC_MAP_MIN_MS;
    const before = t.sent.at(-1)?.rev ?? 0;
    const v = await t.map();
    expect(t.s.mapScans).toBe(3);
    expect(t.sent.length).toBe(rev + 1);
    expect(t.sent.at(-1)!.rev).toBeGreaterThan(before);
    expect(v.structure!.files).toBe(3);
  });

  it('a change seen 25 s after a run is scanned when the interval ends (5 s later), not held off by that look', async () => {
    for (const [first, second] of [
      [25_000, 5_000],
      [15_000, 15_000],
    ]) {
      const t = await setup();
      await t.map();
      t.laters.length = 0;
      t.repo.write(`server/src/more${first}.ts`, 'x');
      t.clock.now += first;
      await t.map(); // changed, too soon: the old answer and one run booked
      const booked = t.laters.filter((l) => l.ms === SPEC_MAP_MIN_MS - first);
      expect(booked).toHaveLength(1);
      t.clock.now += second;
      booked[0].fn();
      await vi.waitFor(() => expect(t.s.mapScans).toBe(2));
      t.repo.cleanup();
    }
  });

  it('a failed scan is kept under no key: 세지 못함 (structure null), tried again past SPEC_MAP_MIN_MS', async () => {
    const t = await setup();
    t.setSpawn(async () => null);
    expect((await t.map()).structure).toBeNull();
    t.clock.now += SPEC_SCAN_MIN_MS;
    await t.map(); // the same key, but the failure holds none: booked for the interval's end, not run now
    expect(t.s.mapScans).toBe(1);
    t.setSpawn(async () => scanOf(['server/src/main.ts']));
    t.clock.now += SPEC_MAP_MIN_MS;
    expect((await t.map()).structure!.files).toBe(1);
    expect(t.s.mapScans).toBe(2);
  });

  it('two projects scan one after the other: at most one spec-map child process at a time', async () => {
    const t = await setup();
    let running = 0;
    let most = 0;
    t.setSpawn(async () => {
      most = Math.max(most, ++running);
      await new Promise((r) => setTimeout(r, 30));
      running--;
      return scanOf(['server/src/main.ts']);
    });
    const other = makeTempRepo();
    other.write('docs/requirements/SRS.md', SRS);
    other.git(['add', '-A']);
    other.git(['commit', '-q', '-m', 'srs']);
    const beta: SpecProject = { name: 'beta', folder: other.folder, projectId: 'p_bbbbbbbbbb' };
    try {
      expect(await t.s.enable(beta, ['docs/requirements/SRS.md'])).toMatchObject({ ok: true });
      const [a, b] = await Promise.all([t.map(), t.s.map(beta, {})]);
      expect(a.structure).not.toBeNull();
      expect(b.ok && b.value.structure).not.toBeNull();
      expect([t.s.mapScans, most]).toEqual([2, 1]);
    } finally {
      other.cleanup();
    }
  });

  it('원문 바뀜: a requirement whose text changed is counted on its feature and in the total', async () => {
    const t = await setup();
    t.repo.write('docs/requirements/SRS.md', SRS.replace('The API server answers', 'The API server answers fast'));
    t.clock.now += SPEC_SCAN_MIN_MS + SPEC_SETTLE_MS * 2;
    const v = await t.map();
    expect(v.features[0].changed).toBe(1);
    expect(v.changed).toBe(1);
    expect((await t.map({ feature: 'FR-MAP' })).feature!.reqs.filter((r) => r.changed).map((r) => r.label)).toEqual(['FR-MAP-001']);
  });

  it('GET map: session only, a bad query 400, an unknown feature 404', async () => {
    const t = await setup();
    const server = Fastify();
    registerSpecRoutes(server, t.s, {
      auth: async (request, reply) => {
        if (request.headers['x-session'] !== 'ok') await reply.code(401).send('unauthorized');
      },
      kindOf: () => ({ host: false, remote: false }),
      actorOf: () => 'Test phone',
      readOnly: false,
    });
    const same = { origin: 'http://localhost:80', host: 'localhost:80', 'x-session': 'ok' };
    const get = (url: string, headers: Record<string, string> = same) => server.inject({ method: 'GET', url: `/api/agty/spec/alpha/${url}`, headers });
    expect((await get('map', {})).statusCode).toBe(401);
    expect(((await get('map')).json() as TraceMap).features).toHaveLength(1);
    expect((await get('map?feature=FR-NONE')).statusCode).toBe(404);
    expect((await get(`map?in=${'a>'.repeat(20)}a`)).statusCode).toBe(400);
  });
});

// ── [제안 모두 승인] and [되돌리기] (MAP-A's, now the design drawing's head) ──
describe.skipIf(!GIT_AVAILABLE)('[제안 모두 승인] through the arch read', () => {
  const file = (t: { home: string }) => readArchFile(archFile(t.home, PROJECT_ID)).file;
  const restart = (t: { home: string; project: SpecProject; repo: TempRepo }) =>
    new SpecService({ home: t.home, projects: () => [t.project], broadcast: () => undefined, run: t.repo.run, now: () => Date.now() + SPEC_SETTLE_MS * 2, later: () => undefined, idle: () => undefined });

  it('one write approves the diagram and the proposed folders by their own names; a stale version refuses it all; [되돌리기] takes it back', async () => {
    const t = await setup();
    const v0 = await t.arch();
    expect(v0.pending!.diagrams).toHaveLength(1);
    expect(v0.pending!.folders).toEqual(['docs/', 'docs/design/', 'docs/requirements/', 'server/', 'server/src/', 'sub/', 'webview-ui/', 'webview-ui/src/']);
    const stale = { diagrams: [{ ...v0.pending!.diagrams[0], version: '0123456789abcdef' }], folders: v0.pending!.folders };
    expect(await t.s.archApproveAll(t.project, stale, 'x')).toEqual({ ok: false, error: 'stale' });
    expect(await t.s.archApproveAll(t.project, { diagrams: [], folders: ['gone/'] }, 'x')).toEqual({ ok: false, error: 'stale' });
    expect(await t.s.archApproveAll(t.project, { diagrams: [], folders: [] }, 'x')).toEqual({ ok: false, error: 'value' });
    const sent = t.sent.length;
    const r = await t.s.archApproveAll(t.project, v0.pending!, 'x');
    expect(r).toMatchObject({ ok: true, value: { diagrams: 1, folders: 8 } });
    expect(t.sent.length).toBe(sent + 1); // one save, one specChanged
    const v1 = await t.arch();
    expect(v1.pending).toEqual({ diagrams: [], folders: [] });
    expect(v1.lastBatch).toMatchObject({ diagrams: 1, folders: 8 });
    expect(v1.nodes.filter((n) => n.folder).every((n) => n.standing === 'approved')).toBe(true);
    expect(await t.s.archUndoBatch(t.project, { batch: v1.lastBatch!.id }, 'x')).toMatchObject({ ok: true });
    const v2 = await t.arch();
    expect(v2.lastBatch).toBeUndefined();
    expect([v2.pending!.folders.length, v2.pending!.diagrams.length]).toEqual([8, 1]);
    expect(await t.s.archUndoBatch(t.project, { batch: v1.lastBatch!.id }, 'x')).toEqual({ ok: false, error: 'stale' });
    expect(file(t).history.map((h) => h.action)).toEqual(['approved-all', 'unapproved-all']);
  });

  it('[되돌리기] keeps a folder a later decision names (kind, relation, confirmed link) approved; [제안 모두 승인] of what is shown after it is not stale', async () => {
    const t = await setup();
    const r = await t.s.archApproveAll(t.project, (await t.arch()).pending!, 'x');
    if (!r.ok) throw new Error(r.error);
    const v = await t.arch();
    const id = (folder: string) => v.nodes.find((n) => n.folder === folder)!.id;
    const web = v.nodes.find((n) => n.label === 'Web app')!.id;
    expect(await t.s.archEditComp(t.project, id('server/'), { kind: 'store' }, 'x')).toMatchObject({ ok: true });
    expect(await t.s.archAddRel(t.project, { from: web, to: id('docs/') }, 'x')).toMatchObject({ ok: true });
    const items = await t.s.items(t.project, {});
    if (!items.ok) throw new Error(items.error);
    expect(await t.s.addLink(t.project, { from: items.value.items[0].uid, to: id('sub/'), rel: 'realizes' }, 'x')).toMatchObject({ ok: true });
    expect(await t.s.archUndoBatch(t.project, { batch: r.value.batch }, 'x')).toEqual({ ok: true, value: { batch: r.value.batch, kept: 3 } });
    expect(file(t).skeleton.map((d) => [d.path, d.action]).sort()).toEqual([['docs/', 'approved'], ['server/', 'approved'], ['sub/', 'approved']]);
    expect(await t.s.archApproveAll(t.project, (await t.arch()).pending!, 'x')).toMatchObject({ ok: true });
  });

  it('[되돌리기] stays offered when the history has moved on (read from the records); [제안 모두 승인] prunes approvals of documents no longer tracked', async () => {
    const t = await setup();
    const v0 = await t.arch();
    writeArchFile(archFile(t.home, PROJECT_ID), { ...file(t), approvals: [{ doc: 'd_zzzzzzzzzz', block: 0, version: '0123456789abcdef', at: '2026-01-01T00:00:00.000Z', by: { kind: 'owner', name: 'x' } }] });
    const r = await restart(t).archApproveAll(t.project, v0.pending!, 'x');
    if (!r.ok) throw new Error(r.error);
    expect(file(t).approvals.map((x) => x.doc)).not.toContain('d_zzzzzzzzzz');
    writeArchFile(archFile(t.home, PROJECT_ID), { ...file(t), history: [] });
    const v = await restart(t).arch(t.project, {});
    expect(v.ok && v.value.lastBatch).toMatchObject({ id: r.value.batch, diagrams: 1, folders: 8 });
  });

  it('routes: approve-all and its undo are same-origin and audited by counts; the parent write is gone', async () => {
    const t = await setup();
    const server = Fastify();
    registerSpecRoutes(server, t.s, { auth: async () => undefined, kindOf: () => ({ host: false, remote: false }), actorOf: () => 'Test phone', readOnly: false });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const same = { origin: 'http://localhost:80', host: 'localhost:80' };
    const post = (url: string, payload: object, headers: Record<string, string> = same) => server.inject({ method: 'POST', url: `/api/agty/spec/alpha/arch/${url}`, headers, payload });
    const pending = (await t.arch()).pending!;
    expect((await post('approve-all', pending, { ...same, origin: 'https://evil.example' })).json().errorCode).toBe('origin_mismatch');
    const all = await post('approve-all', pending);
    expect(all.statusCode).toBe(200);
    expect((await post('approve-all/undo', { batch: all.json().batch })).statusCode).toBe(200);
    expect((await post('parent', { uid: 'c_aaaaaaaaaa', parent: null })).statusCode).toBe(404);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[agty spec]'));
    expect(lines.map((l) => l.split(' ')[2])).toEqual(['arch-approve-all', 'arch-undo-all']);
    expect(lines[0]).toMatch(/arch-approve-all device="Test phone" project="alpha" b_[a-z2-7]{10} d:1 f:8$/);
  });
});

describe.skipIf(!GIT_AVAILABLE)('BRN K8: the design map through the service and the route', () => {
  it("?design=1 only: the owner's pairs (a folder merged into a diagram's component) count, an arrow against the import is 반대 방향; the route is behind the gate", async () => {
    const t = await setup();
    // server imports webview-ui; the design draws Web app → API server.
    t.setAnswer(scanOf(['server/src/main.ts', 'webview-ui/src/App.tsx'], [0, 1]));
    const plain = await t.map();
    expect([plain.design, plain.drift]).toEqual([undefined, undefined]);
    expect(await t.s.map(t.project, { design: 'yes' })).toEqual({ ok: false, error: 'value' });
    // Names alone (the Mermaid nodes have no path): nothing counted.
    const guess = await t.s.map(t.project, { design: '1' });
    if (!guess.ok) throw new Error(guess.error);
    expect(guess.value.drift!.counts).toEqual({ reversed: 0, undesigned: 0, designOnly: 0, codeOnly: 0 });
    const a = await t.arch();
    const id = (label: string) => a.nodes.find((n) => n.label === label)!.id;
    expect(await t.s.archSkeleton(t.project, { path: 'server/', action: 'merged', into: id('API server') }, 'x')).toMatchObject({ ok: true });
    expect(await t.s.archSkeleton(t.project, { path: 'webview-ui/', action: 'merged', into: id('Web app') }, 'x')).toMatchObject({ ok: true });
    const r = await t.s.map(t.project, { design: '1' });
    if (!r.ok) throw new Error(r.error);
    expect(r.value.drift).toEqual({ counts: { reversed: 1, undesigned: 0, designOnly: 0, codeOnly: 0 }, items: [{ kind: 'reversed', from: 'server', to: 'webview-ui', imports: 1 }], more: 0 });
    expect(r.value.design!.modules.find((m) => m.label === 'API server')).toMatchObject({ paths: ['server'], cells: ['server'], by: 'confirmed' });
    expect(r.value.design!.structure!.bands.map((b) => b.id).sort()).toEqual(['server', 'webview-ui']);

    const server = Fastify();
    let allowed = false;
    registerSpecRoutes(server, t.s, {
      auth: async (_q, reply) => void (allowed || reply.code(401).send({ errorCode: 'unauthorized' })),
      kindOf: () => ({ host: false, remote: false }),
      actorOf: () => 'x',
      readOnly: false,
    });
    const get = () => server.inject({ method: 'GET', url: '/api/agty/spec/alpha/map?design=1' });
    expect((await get()).statusCode).toBe(401);
    allowed = true;
    expect((await get()).json().drift.counts.reversed).toBe(1);
  });
});
