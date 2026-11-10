// SPT-P4A: a document's architecture (Mermaid blocks, component tables, participants), component
// identity across a rescan, a moved block and a label change, and the architecture query (groups,
// the layers, the counts, unsupported entries, masking, caching, the route) with the repository bytes.
import * as crypto from 'crypto';
import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { TraceArch } from '../../../../core/src/agent-tycoon/spec/trace.js';
import { SPEC_ARCH_PROJECT_COMPS_MAX, SPEC_ARCH_SOURCE_MAX, SPEC_SCAN_MIN_MS, SPEC_SETTLE_MS, SPEC_TRACE_IDLE_MS } from '../../constants.js';
import { makeTempRepo, type TempRepo } from '../engine/git/testRepo.js';
import { archGraph, type DocArch, matchComponents, nodeKey, readArch } from './arch.js';
import { registerSpecRoutes } from './routes.js';
import { type SpecProject, SpecService } from './service.js';
import { createCompUid, emptyRegistry, registryFile, type SpecRegistry } from './store.js';

const fence = (body: string) => '```mermaid\n' + body + '\n```\n';
const FLOW = fence(
  [
    'flowchart LR',
    '  subgraph sys["System"]',
    '    subgraph core["Core"]',
    '      api["API server"]',
    '      db[(Main DB)]',
    '    end',
    '    web["Web app"]',
    '  end',
    '  web --> api',
    '  api -- reads --> db',
    '  user((Owner)) --> web',
    '  user --> sys',
  ].join('\n'),
);
const SEQ = fence(['sequenceDiagram', '  participant U as Owner', '  participant W as Web app', '  participant A as API server', '  U->>W: open the page', '  W->>A: GET /items', '  A-->>W: items', '  W->>A: GET /more'].join('\n'));
const TABLE = '| 구성요소 | 설명 | 의존 |\n|---|---|---|\n| Scheduler | runs jobs | Queue, Worker |\n| Queue | holds jobs | |\n| Worker | does a job | Queue · Nowhere |\n';
const ER = fence('erDiagram\n  A ||--o{ B : has');
const BAD = fence('flowchart TD\n  X --> Y\n  Z@{ shape: rect }');
const DESIGN = `# Design\n\n${FLOW}\nText.\n\n${SEQ}\n## Parts\n\n${TABLE}\n${ER}\n${BAD}`;
const lineOf = (text: string, needle: string) => text.split('\n').findIndex((l) => l.includes(needle)) + 1;

describe('readArch', () => {
  it('flowchart nodes, nested groups, a cylinder, an edge to a subgraph; participants that are those components; a component table and its 의존 column', () => {
    const a = readArch(DESIGN);
    // Node IDs only as hashes; groups keyed by their place in the block, never by their text.
    expect(a.comps.map((c) => `${c.block}:${c.label}:${c.kind}${c.group ? `@${c.group}` : ''}`)).toEqual([
      '0:API server:component@0:1',
      '0:Main DB:store@0:1',
      '0:Web app:component@0:0',
      '0:Owner:component',
      '2:Scheduler:component',
      '2:Queue:component',
      '2:Worker:component',
    ]);
    expect(a.comps.map((c) => c.node)).toEqual(['api', 'db', 'web', 'user', '#1', '#2', '#3'].map(nodeKey));
    expect(a.groups).toEqual([
      { key: '0:0', label: 'System', line: lineOf(DESIGN, 'subgraph sys') },
      { key: '0:1', label: 'Core', parent: '0:0', line: lineOf(DESIGN, 'subgraph core') },
    ]);
    const name = (e: number | string) => (typeof e === 'number' ? a.comps[e].label : e);
    expect(a.links.map((l) => `${l.layer[0]}:${name(l.from)}>${name(l.to)}:${l.label}`)).toEqual([
      'c:Web app>API server:',
      'c:API server>Main DB:reads',
      'c:Owner>Web app:',
      'c:Owner>0:0:',
      'c:Scheduler>Queue:',
      'c:Scheduler>Worker:',
      'c:Worker>Queue:', // 'Nowhere' names no row
      'i:Owner>Web app:open the page',
      'i:Web app>API server:GET /items',
      'i:API server>Web app:items',
      'i:Web app>API server:GET /more',
    ]);
    expect(a.comps[0].line).toBe(lineOf(DESIGN, 'api["API server"]'));
    expect(a.comps[0].also).toEqual([lineOf(DESIGN, 'participant A as')]);
    expect(a.comps[4].line).toBe(lineOf(DESIGN, '| Scheduler'));
    expect(a.unsupported).toEqual([
      { line: lineOf(DESIGN, 'erDiagram') - 1, type: 'erDiagram', firstBlockedLine: lineOf(DESIGN, 'erDiagram'), text: 'erDiagram', source: 'erDiagram\n  A ||--o{ B : has' },
      { line: lineOf(DESIGN, 'Z@{') - 3, type: 'flowchart', firstBlockedLine: lineOf(DESIGN, 'Z@{'), text: 'Z@{ shape: rect }', source: 'flowchart TD\n  X --> Y\n  Z@{ shape: rect }' },
    ]);
  });
  it('a participant whose label two components share, or none, is its own component (one per label)', () => {
    const a = readArch(fence('flowchart LR\n a[Same]\n b[Same]') + fence('sequenceDiagram\n participant X as Same\n X->>Y: hi\n Y->>Z: hi') + fence('sequenceDiagram\n Y->>X: back'));
    expect(a.comps.map((c) => `${c.block}:${c.label}`)).toEqual(['0:Same', '0:Same', '1:Same', '1:Y', '1:Z', '2:X']);
    // Y in the second sequence is the first one's Y (same label); its X is labelled X, another one.
    expect(a.links.filter((l) => l.layer === 'interaction').map((l) => `${l.from}>${l.to}`)).toEqual(['2>3', '3>4', '3>5']);
  });
  it('masks labels and the source, caps the source at 4 KB, ignores a Mermaid example inside another fence', () => {
    const secret = 'api_key=sk-ant-abcdefgh12345678';
    const big = fence(`erDiagram\n  %% ${secret}\n${'  A ||--o{ B : has\n'.repeat(400)}`);
    const a = readArch(fence(`flowchart LR\n  A["${secret}"] --> B`) + big + '````md\n```mermaid\nflowchart LR\n  Q --> R\n```\n````\n');
    expect(JSON.stringify(a)).not.toContain('sk-ant-abcdefgh12345678');
    expect(Buffer.byteLength(a.unsupported[0].source)).toBeLessThanOrEqual(SPEC_ARCH_SOURCE_MAX);
    expect(a.comps.map((c) => c.node)).toEqual(['A', 'B'].map(nodeKey));
  });
});

const REV = 'r1';
const uid = createCompUid;
function regWith(docs: string[]): SpecRegistry {
  const reg = emptyRegistry('p_abcdefghij', '/x', new Date());
  for (const d of docs)
    reg.docs[d] = { path: `${d}.md`, kind: 'design', mode: 'auto', tracked: true, state: 'active', git: 'committed', blob: 'b', size: 1, mtimeMs: 1, changedAt: '', pathHistory: [], decisions: [] };
  return reg;
}
const ids = (reg: SpecRegistry, docs: Record<string, string>) => {
  const read = new Map(Object.entries(docs).map(([d, t]) => [d, readArch(t)] as const));
  const out = matchComponents(reg, read, REV, uid);
  return Object.fromEntries([...out].map(([d, us]) => [d, Object.fromEntries(us.map((u, i) => [read.get(d)!.comps[i].label, u]))]));
};

describe('component identity', () => {
  it('a rescan keeps every UID; a block moved inside the document keeps them; a label changed in place keeps its UID', () => {
    const reg = regWith(['d_aaaaaaaaaa']);
    const first = ids(reg, { d_aaaaaaaaaa: DESIGN });
    expect(Object.values(first).flatMap(Object.values).every((u) => /^c_[a-z2-7]{10}$/.test(u))).toBe(true);
    expect(ids(reg, { d_aaaaaaaaaa: DESIGN })).toEqual(first);
    // The table moved to the top, a new block before everything: other block numbers, same labels.
    const moved = ids(reg, { d_aaaaaaaaaa: `${TABLE}\n${fence('flowchart LR\n n1[New one]')}${FLOW}${SEQ}` }).d_aaaaaaaaaa;
    for (const l of ['API server', 'Main DB', 'Web app', 'Owner', 'Scheduler', 'Queue', 'Worker']) expect(moved[l], l).toBe(first.d_aaaaaaaaaa[l]);
    expect(Object.values(first.d_aaaaaaaaaa)).not.toContain(moved['New one']);
    // A renamed node in the same place keeps its UID; a renamed row too (back to the first layout, then renamed).
    expect(ids(reg, { d_aaaaaaaaaa: DESIGN })).toEqual(first);
    const renamed = ids(reg, { d_aaaaaaaaaa: DESIGN.replace('db[(Main DB)]', 'db[(Primary DB)]').replace('| Queue |', '| Job queue |') }).d_aaaaaaaaaa;
    expect(renamed['Primary DB']).toBe(first.d_aaaaaaaaaa['Main DB']);
    expect(renamed['Job queue']).toBe(first.d_aaaaaaaaaa.Queue);
  });
  it('a block moved to another document keeps its components when the labels match; a renamed and moved one is new; what is gone retires and comes back', () => {
    const reg = regWith(['d_aaaaaaaaaa', 'd_bbbbbbbbbb']);
    const first = ids(reg, { d_aaaaaaaaaa: FLOW + TABLE, d_bbbbbbbbbb: '# empty\n' });
    const after = ids(reg, { d_aaaaaaaaaa: FLOW, d_bbbbbbbbbb: TABLE.replace('Worker |', 'Runner |').replace('| Worker', '| Runner') });
    expect(after.d_bbbbbbbbbb.Scheduler).toBe(first.d_aaaaaaaaaa.Scheduler);
    expect(after.d_bbbbbbbbbb.Queue).toBe(first.d_aaaaaaaaaa.Queue);
    expect(after.d_bbbbbbbbbb.Runner).not.toBe(first.d_aaaaaaaaaa.Worker); // not sure: new
    expect(reg.components[first.d_aaaaaaaaaa.Worker].state).toBe('retired');
    expect(reg.components[after.d_bbbbbbbbbb.Scheduler]).toMatchObject({ doc: 'd_bbbbbbbbbb', state: 'active' });
    // Worker comes back (a later scan): the retired UID, not a new one.
    expect(ids(reg, { d_bbbbbbbbbb: TABLE }).d_bbbbbbbbbb.Worker).toBe(first.d_aaaaaaaaaa.Worker);
    // A document not read is not touched; one that is gone retires its components.
    reg.docs.d_aaaaaaaaaa.state = 'retired';
    matchComponents(reg, new Map(), REV, uid);
    expect(reg.components[first.d_aaaaaaaaaa['API server']].state).toBe('retired');
    expect(reg.components[first.d_aaaaaaaaaa.Scheduler].state).toBe('active');
  });
});

describe('archGraph', () => {
  it('groups as parents, both layers, merged parallel edges, the counts, the unsupported list, the cap', () => {
    const reg = regWith(['d_aaaaaaaaaa']);
    const arch: DocArch = readArch(DESIGN);
    const uids = matchComponents(reg, new Map([['d_aaaaaaaaaa', arch]]), REV, uid).get('d_aaaaaaaaaa')!;
    const g = archGraph(reg, new Map([['d_aaaaaaaaaa', { arch, uids }]]));
    expect(g.counts).toEqual({ approved: 0, proposed: 0, fromDocs: 7 });
    expect(g.groups.map((x) => `${x.label}<${x.parent ? g.groups.find((y) => y.id === x.parent)!.label : ''}`)).toEqual(['System<', 'Core<System']);
    const label = (id: string) => g.nodes.find((x) => x.id === id)?.label ?? g.groups.find((x) => x.id === id)?.label;
    expect(g.edges.filter((e) => e.layer === 'interaction').map((e) => `${label(e.from)}>${label(e.to)}:${e.label}`)).toEqual([
      'Owner>Web app:open the page',
      'Web app>API server:GET /items · GET /more',
      'API server>Web app:items',
    ]);
    expect(g.edges.find((e) => label(e.to) === 'System')).toMatchObject({ layer: 'composition', source: { path: 'd_aaaaaaaaaa.md', line: lineOf(DESIGN, 'user --> sys') } });
    const api = g.nodes.find((x) => x.label === 'API server')!;
    expect(api).toMatchObject({ kind: 'component', from: 'doc', group: g.groups[1].id });
    expect(api.sources.map((s) => s.line)).toEqual([lineOf(DESIGN, 'api["API server"]'), lineOf(DESIGN, 'participant A as')]);
    expect(g.nodes.find((x) => x.label === 'Main DB')!.kind).toBe('store');
    expect(g.unsupported.map((u) => `${u.doc}:${u.type}:${u.firstBlockedLine}`)).toEqual([`d_aaaaaaaaaa.md:erDiagram:${lineOf(DESIGN, 'erDiagram')}`, `d_aaaaaaaaaa.md:flowchart:${lineOf(DESIGN, 'Z@{')}`]);
    // An untracked document draws nothing.
    reg.docs.d_aaaaaaaaaa.tracked = false;
    expect(archGraph(reg, new Map([['d_aaaaaaaaaa', { arch, uids }]])).nodes).toEqual([]);
  });
});

// ── the service and the route ──
const PROJECT_ID = 'p_abcdefghij';
let repo: TempRepo | null = null;
const homes: string[] = [];
afterEach(() => {
  repo?.cleanup();
  repo = null;
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
});
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of fs.readdirSync(root, { recursive: true }).map(String).sort()) {
    const st = fs.lstatSync(path.join(root, rel));
    if (st.isFile()) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
  }
  return out;
}

async function setup() {
  repo = makeTempRepo();
  repo.write('docs/design/system.md', DESIGN);
  repo.write('docs/design/plain.md', '# Plain\n\nNo pictures here.\n');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs']);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-arch-home-')));
  homes.push(home);
  const project: SpecProject = { name: 'alpha', folder: repo.folder, projectId: PROJECT_ID };
  let clock = Date.now() + SPEC_SETTLE_MS * 2;
  const idle: Array<() => void> = [];
  const make = () => new SpecService({ home, projects: () => [project], broadcast: () => undefined, run: repo!.run, now: () => clock, later: () => undefined, idle: (fn) => idle.push(fn) });
  const s = make();
  expect(await s.enable(project, ['docs/design/system.md', 'docs/design/plain.md'])).toMatchObject({ ok: true });
  const arch = async (svc: SpecService, layer?: string): Promise<TraceArch> => {
    const r = await svc.arch(project, layer ? { layer } : {});
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  return { home, project, s, make, arch, idle, tick: (ms: number) => (clock += ms) };
}

describe('the architecture query', () => {
  it('composition by default, interaction only when asked; UIDs persist in the Registry (v2) across a restart; built once per rev, dropped when nobody reads; no repository byte changes', async () => {
    const t = await setup();
    const before = hashTree(repo!.folder);
    const c = await t.arch(t.s);
    expect(c.layer).toBe('composition');
    expect(c.counts).toMatchObject({ approved: 0, fromDocs: 7 }); // proposed: the temp repository's folders (SPT-P4B)
    expect(c.edges.every((e) => e.layer === 'composition')).toBe(true);
    expect(c.nodes[0].sources[0].path).toBe('docs/design/system.md');
    const i = await t.arch(t.s, 'interaction');
    expect(i.edges.filter((e) => e.layer === 'interaction').map((e) => e.label)).toEqual(['open the page', 'GET /items · GET /more', 'items']);
    expect(t.s.archBuilds).toBe(2); // one build per layer
    await t.arch(t.s, 'interaction');
    expect(t.s.archBuilds).toBe(2); // held
    expect(c.unsupported.map((u) => [u.type, u.firstBlockedLine, u.text])).toEqual([
      ['erDiagram', lineOf(DESIGN, 'erDiagram'), 'erDiagram'],
      ['flowchart', lineOf(DESIGN, 'Z@{'), 'Z@{ shape: rect }'],
    ]);
    const reg = JSON.parse(fs.readFileSync(registryFile(t.home, PROJECT_ID), 'utf-8')) as SpecRegistry;
    expect(reg.v).toBe(2);
    expect(Object.keys(reg.components).sort()).toEqual(c.nodes.filter((x) => x.from === 'doc').map((x) => x.id).sort());
    expect(JSON.stringify(reg.components)).not.toContain('API server'); // a hash, never the label
    // A restart reads the documents again: the same UIDs.
    const again = await t.arch(t.make());
    expect(again.nodes.map((x) => x.id)).toEqual(c.nodes.map((x) => x.id));
    // Nobody reads for SPEC_TRACE_IDLE_MS: dropped, then built again on the next read.
    t.tick(SPEC_TRACE_IDLE_MS + 1);
    for (const fn of t.idle.splice(0)) fn();
    await t.arch(t.s);
    expect(t.s.archBuilds).toBe(3);
    expect(hashTree(repo!.folder)).toEqual(before);
  });

  it('a v1 Registry (no components) is read and written as v2; a project without diagrams is empty', async () => {
    const t = await setup();
    const file = registryFile(t.home, PROJECT_ID);
    const old = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, unknown>;
    delete old.components;
    old.v = 1;
    fs.writeFileSync(file, JSON.stringify(old));
    const svc = t.make();
    expect((await t.arch(svc)).counts.fromDocs).toBe(7);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).v).toBe(2);
    repo!.write('docs/design/system.md', '# Design\n\nNothing drawn.\n');
    t.tick(SPEC_SCAN_MIN_MS + SPEC_SETTLE_MS); // the next read scans, the edit settled
    const empty = await t.arch(svc);
    expect(empty).toMatchObject({ groups: [], edges: [], unsupported: [], counts: { fromDocs: 0 } });
    expect(empty.nodes.filter((n) => n.standing !== 'proposed')).toEqual([]); // only the folder skeleton's proposals (SPT-P4B)
  });

  it('the route: session only, the layer checked, off is refused', async () => {
    const t = await setup();
    const server = Fastify();
    let host = false;
    registerSpecRoutes(server, t.s, { auth: async () => undefined, kindOf: () => ({ host, remote: false }), readOnly: false });
    const get = (q = '') => server.inject({ method: 'GET', url: `/api/agty/spec/alpha/arch${q}` });
    expect((await get()).json()).toMatchObject({ layer: 'composition', counts: { fromDocs: 7 } });
    expect((await get('?layer=interaction')).json().edges.some((e: { layer: string }) => e.layer === 'interaction')).toBe(true);
    expect((await get('?layer=all')).statusCode).toBe(400);
    host = true;
    expect((await get()).statusCode).toBe(403);
    host = false;
    expect(t.s.disable(t.project)).toMatchObject({ ok: true });
    expect((await get()).statusCode).toBe(409);
  });
});

describe('the project-wide cap (re-review N3)', () => {
  it('past SPEC_ARCH_PROJECT_COMPS_MAX components the next documents show as too big, and keep what the Registry held', async () => {
    repo = makeTempRepo();
    const per = 1_000;
    const docs = Math.floor(SPEC_ARCH_PROJECT_COMPS_MAX / per) + 1;
    const table = (d: number) => `| component |\n|---|\n${Array.from({ length: per }, (_, i) => `| d${d}c${i} |`).join('\n')}\n`;
    const names = Array.from({ length: docs }, (_, d) => `docs/design/p${String(d).padStart(2, '0')}.md`);
    names.forEach((n, d) => repo!.write(n, table(d)));
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'docs']);
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-arch-cap-')));
    homes.push(home);
    const project: SpecProject = { name: 'alpha', folder: repo.folder, projectId: PROJECT_ID };
    const s = new SpecService({ home, projects: () => [project], broadcast: () => undefined, run: repo.run, now: () => Date.now() + SPEC_SETTLE_MS * 2, later: () => undefined, idle: () => undefined });
    expect(await s.enable(project, names)).toMatchObject({ ok: true });
    const r = await s.arch(project, {});
    if (!r.ok) throw new Error(r.error);
    expect(r.value.counts.fromDocs).toBe(SPEC_ARCH_PROJECT_COMPS_MAX);
    expect(r.value.unsupported).toEqual([expect.objectContaining({ doc: names.at(-1), type: 'document', big: true })]);
  });
});
