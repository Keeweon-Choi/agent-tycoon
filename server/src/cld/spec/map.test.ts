// MAP-A: the 지도's module tree (pure: three parent sources never mixed, cycles, caps, requirement
// counts kept apart, active Tasks, the 불확실 bundle) and through the service and the routes: the
// owner's parent write (guards, boundary, cycle refused, audit), [제안 모두 승인] in one write and its
// [되돌리기], a project with tracking off reading nothing, and nothing but arch.json ever written.
// TOKEN-GUARD (trace.test.ts) scans this folder, map.ts included.
import * as crypto from 'crypto';
import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ArchNode, LinkStatus, TraceArch, TraceEdge, TraceMap, TraceNode } from '../../../../core/src/cld/spec/trace.js';
import { SPEC_MAP_CARDS_MAX, SPEC_SCAN_MIN_MS, SPEC_SETTLE_MS } from '../../constants.js';
import { GIT_AVAILABLE, makeTempRepo, recording, type TempRepo } from '../engine/git/testRepo.js';
import { archFile, readArchFile, writeArchFile } from './archOwner.js';
import { buildMapModel, MAP_ROOT, mapView } from './map.js';
import { registerSpecRoutes } from './routes.js';
import { type SpecProject, SpecService } from './service.js';
import type { TraceIndex } from './trace.js';

const node = (id: string, label: string, more: Partial<ArchNode> = {}): ArchNode => ({ id, label, kind: 'component', from: 'doc', standing: 'doc', sources: [{ path: 'd.md', line: 1 }], ...more });
const arch = (nodes: ArchNode[], more: Partial<TraceArch> = {}): TraceArch => ({ layer: 'composition', nodes, groups: [], edges: [], unsupported: [], counts: { approved: 0, proposed: 0, fromDocs: 0 }, diagrams: [], ...more });
/** A trace index with these requirements, realizes edges (req, comp, status), Tasks (id, status) and implements edges (req, task, status). */
function index(reqs: string[], realizes: Array<[string, string, LinkStatus]>, tasks: Array<[string, string]> = [], implementsE: Array<[string, string, LinkStatus]> = []): TraceIndex {
  const nodes = new Map<string, TraceNode>(reqs.map((u) => [u, { id: u, type: 'req', label: u.toUpperCase() }]));
  for (const [id, status] of tasks) nodes.set(id, { id, type: 'task', label: id, state: { work: { total: 1, byStatus: { [status]: 1 } } } });
  const edges: TraceEdge[] = [
    ...realizes.map(([from, to, status], i) => ({ id: `r${i}`, from, to, rel: 'realizes' as const, status })),
    ...implementsE.map(([from, to, status], i) => ({ id: `i${i}`, from, to, rel: 'implements' as const, status })),
  ];
  const adj = new Map<string, number[]>();
  edges.forEach((e, i) => {
    for (const n of [e.from, e.to]) adj.set(n, [...(adj.get(n) ?? []), i]);
  });
  return { nodes, edges, adj, states: new Map(), reqs, groupOf: new Map(), groups: new Map(), history: new Map(), unlinked: 0, deployed: new Set() };
}
const ids = (v: TraceMap | null) => v!.cards.map((c) => c.id);

describe('the module tree (pure)', () => {
  it('a parent from the owner, else the document subgraph, else the folder above; each card says which', () => {
    const a = arch(
      [
        node('c_aaaaaaaaaa', 'API', { group: 'g:d_x:0:0' }),
        node('c_bbbbbbbbbb', 'DB', { group: 'g:d_x:0:0' }),
        node('f:server/', 'server/', { from: 'folder', standing: 'proposed', folder: 'server/', sources: [] }),
        node('f:server/src/', 'server/src/', { from: 'folder', standing: 'proposed', folder: 'server/src/', sources: [] }),
        node('c_cccccccccc', 'Core', { from: 'owner', standing: 'approved', sources: [] }),
      ],
      { groups: [{ id: 'g:d_x:0:0', label: 'Backend', source: { path: 'd.md', line: 3 } }], diagrams: [{ id: 'd_x:0', doc: 'd_x', block: 0, path: 'd.md', line: 1, type: 'flowchart', version: '0123456789abcdef', standing: 'approved' }] },
    );
    const m = buildMapModel(a, [{ uid: 'c_bbbbbbbbbb', parent: 'c_cccccccccc' }], index([], []));
    const at = (id: string) => m.mods.get(id)!;
    expect([at('c_aaaaaaaaaa').parent, at('c_aaaaaaaaaa').parentFrom]).toEqual(['g:d_x:0:0', 'doc']);
    expect([at('c_bbbbbbbbbb').parent, at('c_bbbbbbbbbb').parentFrom]).toEqual(['c_cccccccccc', 'owner']); // the owner's over its subgraph
    expect([at('f:server/src/').parent, at('f:server/src/').parentFrom]).toEqual(['f:server/', 'folder']);
    expect(at('g:d_x:0:0')).toMatchObject({ kind: 'group', standing: 'approved' }); // a subgraph stands as its diagram does
    const root = mapView(m, MAP_ROOT)!;
    expect(ids(root)).toEqual(['g:d_x:0:0', 'c_cccccccccc', 'f:server/']); // approved first (ties: children, then name), then proposed
    expect(root.cards.map((c) => c.origin)).toEqual(['owner_confirmed', 'owner_confirmed', 'algorithm_suggested']);
    const inner = mapView(m, 'f:server/src/')!;
    expect(inner.crumbs.map((c) => c.id)).toEqual([MAP_ROOT, 'f:server/', 'f:server/src/']);
    expect(inner.selected).toMatchObject({ parentFrom: 'folder', origin: 'algorithm_suggested' });
    expect(mapView(m, 'c_zzzzzzzzzz')).toBeNull();
  });

  it('a cycle in a hand-made arch.json is dropped at read; caps: 8 cards and the rest counted', () => {
    const many = Array.from({ length: SPEC_MAP_CARDS_MAX + 3 }, (_, i) => node(`c_${String.fromCharCode(97 + i).repeat(10)}`, `M${i}`));
    const [x, y] = many;
    const m = buildMapModel(arch(many), [{ uid: x.id, parent: y.id }, { uid: y.id, parent: x.id }], index([], []));
    expect(m.mods.get(x.id)!.parent).toBe(y.id);
    expect(m.mods.get(y.id)!.parent).toBeUndefined(); // the second closes a cycle: not taken
    const root = mapView(m, MAP_ROOT)!;
    expect(root.cards).toHaveLength(SPEC_MAP_CARDS_MAX);
    expect(root.more).toBe(many.length - 1 - SPEC_MAP_CARDS_MAX);
    expect(root.tree).toHaveLength(many.length); // the tree lists every module
  });

  it('requirement counts: confirmed, observed and suggested apart, each requirement once at its strongest, the modules below included; active Tasks only through confirmed Task links of non-suggested requirements', () => {
    const a = arch([node('c_aaaaaaaaaa', 'Parent', { standing: 'approved' }), node('c_bbbbbbbbbb', 'Child', { standing: 'approved' }), node('c_cccccccccc', 'Guess', { standing: 'approved' })]);
    const ix = index(
      ['r_1', 'r_2', 'r_3', 'r_4'],
      [
        ['r_1', 'c_aaaaaaaaaa', 'suggested'],
        ['r_1', 'c_bbbbbbbbbb', 'confirmed'], // r_1 at its strongest under Parent: confirmed
        ['r_2', 'c_bbbbbbbbbb', 'observed'],
        ['r_3', 'c_aaaaaaaaaa', 'rejected'], // never counted
        ['r_4', 'c_cccccccccc', 'suggested'],
      ],
      [
        ['T-1', 'doing'],
        ['T-2', 'done'],
        ['T-3', 'review'],
        ['T-4', 'blocked'],
      ],
      [
        ['r_1', 'T-1', 'confirmed'],
        ['r_1', 'T-2', 'confirmed'], // done: not active
        ['r_2', 'T-3', 'observed'], // not confirmed: not counted
        ['r_4', 'T-4', 'confirmed'], // r_4 only suggested for Guess: not counted
      ],
    );
    const m = buildMapModel(a, [{ uid: 'c_bbbbbbbbbb', parent: 'c_aaaaaaaaaa' }], ix);
    const root = mapView(m, MAP_ROOT)!;
    const parent = root.cards.find((c) => c.id === 'c_aaaaaaaaaa')!;
    expect(parent.reqs).toEqual({ confirmed: 1, observed: 1, suggested: 0 });
    expect(parent.activeTasks).toBe(1);
    expect(parent.children).toBe(1);
    const guess = root.cards.find((c) => c.id === 'c_cccccccccc')!;
    expect([guess.reqs, guess.activeTasks]).toEqual([{ confirmed: 0, observed: 0, suggested: 1 }, 0]);
    expect(root.selected.reqs).toEqual({ confirmed: 1, observed: 1, suggested: 1 });
    expect(root.reqTotal).toBe(4);
    const v = mapView(m, 'c_aaaaaaaaaa')!;
    expect(v.reqs.map((r) => [r.uid, r.status])).toEqual([
      ['r_1', 'confirmed'],
      ['r_2', 'observed'],
    ]);
    // 불확실: Guess has only a suggestion.
    expect(root.uncertain).toEqual([{ id: 'c_cccccccccc', label: 'Guess', why: 'suggested' }]);
  });

  it('the 불확실 bundle names what is not approved and what has no requirement; dependencies only between shown cards, lifted, with their origin', () => {
    const a = arch(
      [
        node('c_aaaaaaaaaa', 'A', { standing: 'approved' }),
        node('c_bbbbbbbbbb', 'B', { standing: 'review' }),
        node('c_cccccccccc', 'C'),
        node('c_dddddddddd', 'D', { standing: 'approved' }),
        node('f:lib/', 'lib/', { standing: 'proposed', folder: 'lib/', from: 'folder', sources: [] }),
      ],
      {
        edges: [
          { id: 'e1', from: 'c_dddddddddd', to: 'c_bbbbbbbbbb', layer: 'composition', label: 'reads', source: { path: 'd.md', line: 5 } },
          { id: 'e_aaaaaaaaaa', from: 'c_aaaaaaaaaa', to: 'c_cccccccccc', layer: 'composition', owner: true },
        ],
      },
    );
    const m = buildMapModel(a, [{ uid: 'c_dddddddddd', parent: 'c_aaaaaaaaaa' }], index([], []));
    const root = mapView(m, MAP_ROOT)!;
    expect(root.uncertain.map((u) => [u.label, u.why])).toEqual([
      ['B', 'review'], // a changed one first
      ['A', 'unlinked'],
      ['C', 'doc'],
      ['lib/', 'proposed'],
    ]);
    expect(root.deps).toEqual([
      { from: 'c_aaaaaaaaaa', to: 'c_bbbbbbbbbb', label: 'reads', origin: 'document_explicit', count: 1 }, // D's edge lifted to A
      { from: 'c_aaaaaaaaaa', to: 'c_cccccccccc', origin: 'owner_confirmed', count: 1 },
    ]);
    expect(root.pending).toEqual({ diagrams: [], folders: ['lib/'] });
  });
});

// ── through the service and the routes ──

const PROJECT_ID = 'p_abcdefghij';
const DESIGN = ['# Design', '', '```mermaid', 'flowchart LR', '  subgraph back[Backend]', '    api["API server"] --> db[(Main DB)]', '  end', '  web["Web app"] --> api', '```', ''].join('\n');
const SRS = '# SRS\n\n| ID | 요구 |\n|---|---|\n| FR-MAP-001 | The API server answers |\n| FR-MAP-002 | 아무것도 부르지 않는다 |\n';
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
async function setup(enable = true) {
  repo = makeTempRepo();
  repo.write('docs/design/system.md', DESIGN);
  repo.write('docs/requirements/SRS.md', SRS);
  repo.write('server/src/main.ts', 'x');
  repo.write('webview-ui/src/App.tsx', 'x');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'init']);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-map-')));
  homes.push(home);
  const project: SpecProject = { name: 'alpha', folder: repo.folder, projectId: PROJECT_ID };
  const sent: unknown[] = [];
  const rec = recording(repo.run);
  const s = new SpecService({ home, projects: () => [project], broadcast: (m) => sent.push(m), run: rec.run, now: () => Date.now() + SPEC_SETTLE_MS * 2, later: () => undefined, idle: () => undefined });
  if (enable) expect(await s.enable(project, ['docs/design/system.md', 'docs/requirements/SRS.md'])).toMatchObject({ ok: true });
  const map = async (uid?: string): Promise<TraceMap> => {
    const r = await s.map(project, uid ? { uid } : {});
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  return { repo, home, project, s, sent, rec, map };
}

describe.skipIf(!GIT_AVAILABLE)('the map through the service', () => {
  it('tracking off: an empty map, nothing scanned, no git, no index, no file written', async () => {
    const t = await setup(false);
    const before = hashTree(t.repo.folder);
    t.rec.calls.length = 0;
    const v = await t.map();
    expect(v).toMatchObject({ enabled: false, cards: [], reqs: [], tree: [], reqTotal: 0 });
    expect([t.s.scans, t.rec.calls.length, t.s.traceBuilds, t.s.mapBuilds, t.s.archBuilds]).toEqual([0, 0, 0, 0, 0]);
    expect(t.sent).toEqual([]);
    expect(fs.existsSync(path.join(t.home, '.config'))).toBe(false);
    expect(hashTree(t.repo.folder)).toEqual(before);
  });

  it('the subgraph as a card, its components below; the label suggestion counted as suggested only; built once per rev; reads write nothing and wake nobody', async () => {
    const t = await setup();
    const before = hashTree(t.repo.folder);
    const sentBefore = t.sent.length;
    const root = await t.map();
    const back = root.cards.find((c) => c.label === 'Backend')!;
    expect(back).toMatchObject({ kind: 'group', standing: 'doc', origin: 'document_explicit', children: 2, reqs: { confirmed: 0, observed: 0, suggested: 1 } });
    expect(root.cards.map((c) => c.label)).toEqual(['Backend', 'Web app', 'docs/', 'server/', 'webview-ui/', 'sub/']); // proposed folders last, the fullest first
    expect(root.reqTotal).toBe(2);
    const inside = await t.map(back.id);
    expect(inside.cards.map((c) => [c.label, c.parentFrom])).toEqual([
      ['API server', 'doc'],
      ['Main DB', 'doc'],
    ]);
    expect(inside.reqs.map((r) => [r.label, r.status])).toEqual([['FR-MAP-001', 'suggested']]);
    expect(t.s.mapBuilds).toBe(1);
    await t.map(back.id);
    expect(t.s.mapBuilds).toBe(1); // held for the same rev
    expect(t.sent.length).toBe(sentBefore);
    expect(hashTree(t.repo.folder)).toEqual(before);
    expect(fs.existsSync(archFile(t.home, PROJECT_ID))).toBe(false); // a read writes no arch.json
  });

  it('the owner parent: set, shown with its source, a cycle refused, a gone or foreign UID refused, cleared with null; deleting a component drops its parents', async () => {
    const t = await setup();
    const root = await t.map();
    const web = root.cards.find((c) => c.label === 'Web app')!.id;
    const api = root.tree.find((r) => r.label === 'API server')!.id;
    expect(await t.s.archParent(t.project, { uid: web, parent: api }, 'x')).toEqual({ ok: true, value: { uid: web, parent: api } });
    const inApi = await t.map(api);
    expect(inApi.cards.map((c) => [c.label, c.parentFrom, c.origin])).toEqual([['Web app', 'owner', 'document_explicit']]);
    expect(inApi.crumbs.map((c) => c.label)).toEqual(['', 'Backend', 'API server']);
    expect(await t.s.archParent(t.project, { uid: api, parent: web }, 'x')).toEqual({ ok: false, error: 'value' }); // a cycle
    expect(await t.s.archParent(t.project, { uid: web, parent: 'c_zzzzzzzzzz' }, 'x')).toEqual({ ok: false, error: 'boundary' });
    expect(await t.s.archParent(t.project, { uid: web, parent: web }, 'x')).toEqual({ ok: false, error: 'value' });
    expect(await t.s.archParent(t.project, { uid: 'g:x', parent: api }, 'x')).toEqual({ ok: false, error: 'value' }); // a subgraph is no UID
    const own = await t.s.archAddComp(t.project, { label: 'Platform' }, 'x');
    if (!own.ok) throw new Error(own.error);
    expect(await t.s.archParent(t.project, { uid: api, parent: own.value.uid }, 'x')).toMatchObject({ ok: true });
    expect(readArchFile(archFile(t.home, PROJECT_ID)).file.parents).toEqual([
      { uid: web, parent: api },
      { uid: api, parent: own.value.uid },
    ]);
    expect(await t.s.archDeleteComp(t.project, own.value.uid, 'x')).toMatchObject({ ok: true });
    expect(readArchFile(archFile(t.home, PROJECT_ID)).file.parents).toEqual([{ uid: web, parent: api }]);
    expect(await t.s.archParent(t.project, { uid: web, parent: null }, 'x')).toMatchObject({ ok: true });
    expect((await t.map()).cards.some((c) => c.id === web)).toBe(true); // back at the top
    const history = readArchFile(archFile(t.home, PROJECT_ID)).file.history.map((h) => h.action);
    expect(history.filter((h) => h.endsWith('parented'))).toEqual(['parented', 'parented', 'unparented']);
  });

  it('[제안 모두 승인]: one write approves the diagram and the proposed folders by their own names; a stale version refuses it all; [되돌리기] takes it back', async () => {
    const t = await setup();
    const v0 = await t.map();
    expect(v0.pending.diagrams).toHaveLength(1);
    expect(v0.pending.folders).toEqual(['docs/', 'docs/design/', 'docs/requirements/', 'server/', 'server/src/', 'sub/', 'webview-ui/', 'webview-ui/src/']);
    const stale = { diagrams: [{ ...v0.pending.diagrams[0], version: '0123456789abcdef' }], folders: v0.pending.folders };
    expect(await t.s.archApproveAll(t.project, stale, 'x')).toEqual({ ok: false, error: 'stale' });
    expect(await t.s.archApproveAll(t.project, { diagrams: [], folders: ['gone/'] }, 'x')).toEqual({ ok: false, error: 'stale' });
    expect(await t.s.archApproveAll(t.project, { diagrams: [], folders: [] }, 'x')).toEqual({ ok: false, error: 'value' });
    const sent = t.sent.length;
    const r = await t.s.archApproveAll(t.project, v0.pending, 'x');
    expect(r).toMatchObject({ ok: true, value: { diagrams: 1, folders: 8 } });
    expect(t.sent.length).toBe(sent + 1); // one save, one specChanged
    const a = readArchFile(archFile(t.home, PROJECT_ID)).file;
    expect(a.rev).toBe(1);
    const v1 = await t.map();
    expect(v1.cards.every((c) => c.standing === 'approved')).toBe(true);
    expect(v1.cards.map((c) => c.label)).toContain('server/'); // the folder's own name, nothing typed
    expect(v1.pending).toEqual({ diagrams: [], folders: [] });
    expect(v1.lastBatch).toMatchObject({ diagrams: 1, folders: 8 });
    expect((await t.map(v1.cards.find((c) => c.label === 'server/')!.id)).cards.map((c) => [c.label, c.parentFrom])).toEqual([['server/src/', 'folder']]);
    expect(await t.s.archUndoBatch(t.project, { batch: v1.lastBatch!.id }, 'x')).toMatchObject({ ok: true });
    const v2 = await t.map();
    expect(v2.lastBatch).toBeUndefined();
    expect(v2.pending.folders).toHaveLength(8);
    expect(v2.pending.diagrams).toHaveLength(1);
    expect(await t.s.archUndoBatch(t.project, { batch: v1.lastBatch!.id }, 'x')).toEqual({ ok: false, error: 'stale' });
    expect(readArchFile(archFile(t.home, PROJECT_ID)).file.history.map((h) => h.action)).toEqual(['approved-all', 'unapproved-all']);
  });

  it('a corrupt arch.json: the map reads as none, every write refused and the file left as it is', async () => {
    const t = await setup();
    writeArchFile(archFile(t.home, PROJECT_ID), { ...readArchFile(archFile(t.home, PROJECT_ID)).file });
    fs.writeFileSync(archFile(t.home, PROJECT_ID), '{"v":1,"rev":1,"parents":[{"uid":"x"}]}');
    const t2 = new SpecService({ home: t.home, projects: () => [t.project], broadcast: () => undefined, run: t.repo.run, now: () => Date.now() + SPEC_SETTLE_MS * 2 });
    expect((await t2.map(t.project, {})).ok).toBe(true);
    const web = (await t.map()).cards.find((c) => c.label === 'Web app')!.id;
    expect(await t2.archParent(t.project, { uid: web, parent: null }, 'x')).toEqual({ ok: false, error: 'corrupt' });
    expect(fs.readFileSync(archFile(t.home, PROJECT_ID), 'utf-8')).toBe('{"v":1,"rev":1,"parents":[{"uid":"x"}]}');
  });
});

describe.skipIf(!GIT_AVAILABLE)('the map routes', () => {
  it('GET map: session only, unknown module 404; parent and approve-all: same-origin, read-only refused, boundary 403, audited by UIDs and counts only', async () => {
    const t = await setup();
    const app = async (o: { readOnly?: boolean; host?: boolean } = {}) => {
      const server = Fastify();
      registerSpecRoutes(server, t.s, {
        auth: async (request, reply) => {
          if (request.headers['x-session'] !== 'ok') await reply.code(401).send('unauthorized');
        },
        kindOf: () => ({ host: !!o.host, remote: false }),
        actorOf: () => 'Test phone',
        readOnly: !!o.readOnly,
      });
      return server;
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const server = await app();
    const same = { origin: 'http://localhost:80', host: 'localhost:80', 'x-session': 'ok' };
    const get = (url: string, headers: Record<string, string> = same) => server.inject({ method: 'GET', url: `/api/cld/spec/alpha/${url}`, headers });
    const post = (url: string, payload: object, headers: Record<string, string> = same) => server.inject({ method: 'POST', url: `/api/cld/spec/alpha/arch/${url}`, headers, payload });
    expect((await get('map', {})).statusCode).toBe(401);
    expect((await get('map?uid=c_zzzzzzzzzz')).statusCode).toBe(404);
    const root = (await get('map')).json() as TraceMap;
    const web = root.cards.find((c) => c.label === 'Web app')!.id;
    const api = root.tree.find((r) => r.label === 'API server')!.id;
    expect((await post('parent', { uid: web, parent: api }, { ...same, origin: 'https://evil.example' })).json().errorCode).toBe('origin_mismatch');
    expect((await post('parent', { uid: web, parent: 'c_zzzzzzzzzz' })).statusCode).toBe(403);
    expect((await post('parent', { uid: web, parent: api })).statusCode).toBe(200);
    expect((await post('parent', { uid: api, parent: web })).statusCode).toBe(400);
    const all = await post('approve-all', root.pending);
    expect(all.statusCode).toBe(200);
    expect((await post('approve-all/undo', { batch: all.json().batch })).statusCode).toBe(200);
    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[cld spec]'));
    expect(lines.map((l) => l.split(' ')[2])).toEqual(['arch-parent', 'arch-approve-all', 'arch-undo-all']);
    expect(lines[0]).toBe(`[cld spec] arch-parent device="Test phone" project="alpha" ${web} ${api}`);
    expect(lines[1]).toMatch(/arch-approve-all device="Test phone" project="alpha" b_[a-z2-7]{10} d:1 f:8$/);
    expect(((await (await app({ host: true })).inject({ method: 'GET', url: '/api/cld/spec/alpha/map', headers: same })).json() as { errorCode: string }).errorCode).toBe('spec_session_only');
    const ro = await app({ readOnly: true });
    expect((await ro.inject({ method: 'POST', url: '/api/cld/spec/alpha/arch/parent', headers: same, payload: { uid: web, parent: null } })).json().errorCode).toBe('read_only_mode');
  });
});

// ── the review's findings (MAP-A review, 11-03), one regression each ──
describe.skipIf(!GIT_AVAILABLE)('review fixes', () => {
  const file = (t: { home: string }) => readArchFile(archFile(t.home, PROJECT_ID)).file;
  const restart = (t: { home: string; project: SpecProject; repo: TempRepo }, now = () => Date.now() + SPEC_SETTLE_MS * 2) =>
    new SpecService({ home: t.home, projects: () => [t.project], broadcast: () => undefined, run: t.repo.run, now, later: () => undefined, idle: () => undefined });

  it('M1: [되돌리기] keeps a folder a later decision names (kind, parent, relation, confirmed link) approved, and says so in the history', async () => {
    const t = await setup();
    const r = await t.s.archApproveAll(t.project, (await t.map()).pending, 'x');
    if (!r.ok) throw new Error(r.error);
    const v = await t.map();
    const id = (label: string) => v.tree.find((c) => c.label === label)!.id;
    const web = id('Web app');
    expect(await t.s.archEditComp(t.project, id('server/'), { kind: 'store' }, 'x')).toMatchObject({ ok: true });
    expect(await t.s.archParent(t.project, { uid: web, parent: id('webview-ui/') }, 'x')).toMatchObject({ ok: true });
    expect(await t.s.archAddRel(t.project, { from: web, to: id('docs/') }, 'x')).toMatchObject({ ok: true });
    const items = await t.s.items(t.project, {});
    if (!items.ok) throw new Error(items.error);
    expect(await t.s.addLink(t.project, { from: items.value.items[0].uid, to: id('sub/'), rel: 'realizes' }, 'x')).toMatchObject({ ok: true });
    expect(await t.s.archUndoBatch(t.project, { batch: r.value.batch }, 'x')).toEqual({ ok: true, value: { batch: r.value.batch, kept: 4 } });
    const a = file(t);
    const kept = ['server/', 'webview-ui/', 'docs/', 'sub/'];
    expect(a.skeleton.map((d) => [d.path, d.action, d.batch]).sort()).toEqual(kept.sort().map((p) => [p, 'approved', undefined]));
    expect([a.kinds.length, a.parents.length, a.relations.length]).toEqual([1, 1, 1]);
    expect(a.history.at(-1)).toMatchObject({ action: 'unapproved-all', detail: expect.stringMatching(/kept:4 c_/) });
    expect((await t.map()).lastBatch).toBeUndefined();
  });

  it('M2: after [되돌리기], [제안 모두 승인] of what the map shows is not stale; a folder merged into a gone component is overwritten keeping its UID', async () => {
    const t = await setup();
    const r = await t.s.archApproveAll(t.project, { diagrams: [], folders: ['server/'] }, 'x');
    if (!r.ok) throw new Error(r.error);
    const server = (await t.map()).cards.find((c) => c.label === 'server/')!.id;
    expect(await t.s.archSkeleton(t.project, { path: 'docs/', action: 'merged', into: server }, 'x')).toMatchObject({ ok: true });
    expect(await t.s.archUndoBatch(t.project, { batch: r.value.batch }, 'x')).toMatchObject({ ok: true, value: { kept: 1 } });
    expect(await t.s.archApproveAll(t.project, (await t.map()).pending, 'x')).toMatchObject({ ok: true });
    // A hand-made record merged into a component that is no more: proposed again, and approved over.
    const a = file(t);
    writeArchFile(archFile(t.home, PROJECT_ID), { ...a, skeleton: [...a.skeleton.filter((d) => d.path !== 'sub/'), { path: 'sub/', action: 'merged', uid: 'c_keepkeepke', into: 'c_zzzzzzzzzz' }] });
    const s2 = restart(t);
    const v = await s2.map(t.project, {});
    if (!v.ok) throw new Error(v.error);
    expect(v.value.pending.folders).toEqual(['sub/']);
    expect(await s2.archApproveAll(t.project, v.value.pending, 'x')).toMatchObject({ ok: true, value: { folders: 1 } });
    expect(file(t).skeleton.filter((d) => d.path === 'sub/')).toEqual([expect.objectContaining({ action: 'approved', uid: 'c_keepkeepke' })]);
  });

  it('M3a: two parent writes at once never store a cycle', async () => {
    const t = await setup();
    const web = (await t.map()).cards.find((c) => c.label === 'Web app')!.id;
    const own = await t.s.archAddComp(t.project, { label: 'Platform' }, 'x');
    if (!own.ok) throw new Error(own.error);
    const out = await Promise.all([t.s.archParent(t.project, { uid: web, parent: own.value.uid }, 'x'), t.s.archParent(t.project, { uid: own.value.uid, parent: web }, 'x')]);
    expect(out.map((x) => x.ok).sort()).toEqual([false, true]);
    expect(file(t).parents).toHaveLength(1);
  });

  it('M3b: a component merged into another (on no map) is refused as a child or a parent', async () => {
    const t = await setup();
    const v = await t.map();
    const web = v.cards.find((c) => c.label === 'Web app')!.id;
    const api = v.tree.find((r) => r.label === 'API server')!.id;
    const own = await t.s.archAddComp(t.project, { label: 'Platform' }, 'x');
    if (!own.ok) throw new Error(own.error);
    expect(await t.s.archAlias(t.project, { uid: web, into: api }, 'x')).toMatchObject({ ok: true });
    expect(await t.s.archParent(t.project, { uid: own.value.uid, parent: web }, 'x')).toEqual({ ok: false, error: 'boundary' });
    expect(await t.s.archParent(t.project, { uid: web, parent: own.value.uid }, 'x')).toEqual({ ok: false, error: 'boundary' });
    expect(file(t).parents).toEqual([]);
  });

  it('L6: a parent write prunes the parents of components no longer there', async () => {
    const t = await setup();
    const v = await t.map();
    const web = v.cards.find((c) => c.label === 'Web app')!.id;
    const api = v.tree.find((r) => r.label === 'API server')!.id;
    writeArchFile(archFile(t.home, PROJECT_ID), { ...file(t), parents: [{ uid: 'c_zzzzzzzzzz', parent: api }] });
    const s2 = restart(t);
    expect(await s2.archParent(t.project, { uid: web, parent: api }, 'x')).toMatchObject({ ok: true });
    expect(file(t).parents).toEqual([{ uid: web, parent: api }]);
  });

  it('L7: [되돌리기] stays offered when the history has moved on (read from the records); L8: [제안 모두 승인] prunes approvals of documents no longer tracked', async () => {
    const t = await setup();
    const v0 = await t.map();
    writeArchFile(archFile(t.home, PROJECT_ID), { ...file(t), approvals: [{ doc: 'd_zzzzzzzzzz', block: 0, version: '0123456789abcdef', at: '2026-01-01T00:00:00.000Z', by: { kind: 'owner', name: 'x' } }] });
    const s2 = restart(t);
    const r = await s2.archApproveAll(t.project, v0.pending, 'x');
    if (!r.ok) throw new Error(r.error);
    expect(file(t).approvals.map((x) => x.doc)).not.toContain('d_zzzzzzzzzz');
    writeArchFile(archFile(t.home, PROJECT_ID), { ...file(t), history: [] });
    const v = await restart(t).map(t.project, {});
    expect(v.ok && v.value.lastBatch).toMatchObject({ id: r.value.batch, diagrams: 1, folders: 8 });
  });

  it('L9: forget() drops the map; a folder that is no repository is listed again past SPEC_SCAN_MIN_MS', async () => {
    const t = await setup();
    await t.map();
    t.s.forget(PROJECT_ID);
    await t.map();
    expect(t.s.mapBuilds).toBe(2);
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-map-plain-')));
    homes.push(dir);
    fs.mkdirSync(path.join(dir, 'docs/design'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'docs/design/system.md'), DESIGN);
    let clock = Date.now() + SPEC_SETTLE_MS * 2;
    const plain: SpecProject = { name: 'plain', folder: dir, projectId: 'p_plainplain' };
    const s = new SpecService({ home: t.home, projects: () => [plain], broadcast: () => undefined, run: t.repo.run, now: () => clock, later: () => undefined, idle: () => undefined });
    expect(await s.enable(plain, ['docs/design/system.md'])).toMatchObject({ ok: true });
    const folders = async () => {
      const r = await s.map(plain, {});
      if (!r.ok) throw new Error(r.error);
      return r.value.pending.folders;
    };
    expect(await folders()).not.toContain('lib/');
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'lib/x.ts'), 'x');
    clock += SPEC_SCAN_MIN_MS;
    expect(await folders()).toContain('lib/');
  });
});

describe('review fixes (pure)', () => {
  it('M4: 40,000 document subgraphs build without a search per group', () => {
    const groups = Array.from({ length: 40_000 }, (_, i) => ({ id: `g:d_x:0:${i}`, label: `G${i}`, ...(i && { parent: `g:d_x:0:${Math.floor((i - 1) / 10)}` }), source: { path: 'd.md', line: i } }));
    const t0 = performance.now();
    const m = buildMapModel(arch([], { groups }), [], index([], []));
    expect(performance.now() - t0).toBeLessThan(1_500); // a find per group (O(G²)) took seconds
    expect(m.mods.get('g:d_x:0:39999')!.parent).toBe('g:d_x:0:3999');
    expect(mapView(m, MAP_ROOT)!.treeMore).toBe(40_000 - 300);
  });

  it('L5: a deep chain keeps each requirement once (its own module), the counts made when a view asks', () => {
    const n = 1_000;
    const nodes = Array.from({ length: n }, (_, i) => node(`c_${String(i).padStart(10, 'a')}`, `M${i}`, { standing: 'approved' }));
    const owner = nodes.slice(1).map((x, i) => ({ uid: x.id, parent: nodes[i].id }));
    const reqs = nodes.map((_, i) => `r_${i}`);
    const m = buildMapModel(arch(nodes), owner, index(reqs, nodes.map((x, i) => [reqs[i], x.id, 'confirmed'] as [string, string, LinkStatus])));
    expect([...m.own.values()].reduce((s, x) => s + x.size, 0)).toBe(n); // linear, never depth × requirements
    expect(mapView(m, MAP_ROOT)!.cards[0].reqs).toEqual({ confirmed: n, observed: 0, suggested: 0 });
    expect(mapView(m, nodes[n - 2].id)!.cards[0].reqs.confirmed).toBe(1);
  });
});
