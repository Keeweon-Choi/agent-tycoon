// SPT-P4B: arch.json (round trip, 0600, atomic, caps, corrupt left as it is, purged with the spec
// folder), approval per diagram and 재검토 필요 after the block changes, kinds, components and
// relations added by hand, '같은 구성요소' (and unmerge keeping the history), the folder skeleton (names
// and counts only, bounded, by HEAD), the routes' guards, boundary, 409 on a stale version and the
// audit lines, the repository bytes. TOKEN-GUARD (trace.test.ts) scans this folder; the git commands
// run here are read-only ones.
import * as crypto from 'crypto';
import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ArchNode, TraceArch } from '../../../../core/src/cld/spec/trace.js';
import { SPEC_ARCH_FILE_MAX_BYTES, SPEC_ARCH_OWNER_COMPS_MAX, SPEC_ARCH_SKELETON_MAX, SPEC_SCAN_MIN_MS, SPEC_SETTLE_MS, SPEC_WALK_FILES_MAX } from '../../constants.js';
import { GIT_AVAILABLE, makeTempRepo, recording, type TempRepo } from '../engine/git/testRepo.js';
import { purgeSpecData } from '../projectData.js';
import { aliasRoot, applyOwner, archFile, archFits, dirsOf, emptyArch, foldersOf, readArchFile, walkFiles, writeArchFile } from './archOwner.js';
import { registerSpecRoutes } from './routes.js';
import { type SpecProject, SpecService } from './service.js';

// The file system as it is, with call records: the skeleton opens no file.
vi.mock('fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('fs')>();
  return { ...real, readFileSync: vi.fn(real.readFileSync), openSync: vi.fn(real.openSync) };
});

const PROJECT_ID = 'p_abcdefghij';
const TOKEN = `ghp_${'a1B2c3D4e5'.repeat(4).slice(0, 36)}`;
const fence = (body: string) => '```mermaid\n' + body + '\n```\n';
const FLOW = fence(['flowchart LR', '  api["API server"] --> db[(Main DB)]', '  web["Web app"] --> api'].join('\n'));
const TABLE = '| 구성요소 | 의존 |\n|---|---|\n| Scheduler | Queue |\n| Queue | |\n';
const DESIGN = `# Design\n\n${FLOW}\n## Parts\n\n${TABLE}`;

let repo: TempRepo | null = null;
const homes: string[] = [];
afterEach(() => {
  repo?.cleanup();
  repo = null;
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  vi.restoreAllMocks();
});
const tempHome = () => {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cld-archown-')));
  homes.push(h);
  return h;
};
function hashTree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rel of fs.readdirSync(root, { recursive: true }).map(String).sort()) {
    const st = fs.lstatSync(path.join(root, rel));
    if (st.isFile()) out[rel] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex');
  }
  return out;
}

describe('arch.json', () => {
  it('round trips, 0600 in 0700, atomic; a bad record, a list past its cap or a file past the size cap is corrupt', () => {
    const file = archFile(tempHome(), PROJECT_ID);
    expect(readArchFile(file)).toEqual({ file: emptyArch(), corrupt: null });
    const a = { ...emptyArch(), rev: 3, components: [{ uid: 'c_aaaaaaaaaa', label: 'Queue', kind: 'store' as const }], kinds: [{ uid: 'c_bbbbbbbbbb', kind: 'external' as const }] };
    writeArchFile(file, a);
    expect(readArchFile(file)).toEqual({ file: a, corrupt: null });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(file))).toEqual(['arch.json']); // no tmp left
    fs.writeFileSync(file, JSON.stringify({ ...a, components: [{ uid: 'c_aaaaaaaaaa', label: 'x'.repeat(201), kind: 'store' }] }));
    expect(readArchFile(file).corrupt).toMatch(/bad components record/);
    fs.writeFileSync(file, JSON.stringify({ ...a, aliases: [{ uid: 'not-a-uid', into: 'c_aaaaaaaaaa' }] }));
    expect(readArchFile(file).corrupt).toMatch(/bad aliases/);
    fs.writeFileSync(file, `{"v":1,"rev":1,"history":[],"pad":"${'x'.repeat(SPEC_ARCH_FILE_MAX_BYTES)}"}`);
    expect(readArchFile(file)).toEqual({ file: emptyArch(), corrupt: 'too big' }); // never read into memory
    // The caps: a list past its own, or the whole file past the bytes, is refused before it is written.
    const many = { ...emptyArch(), components: Array.from({ length: SPEC_ARCH_OWNER_COMPS_MAX + 1 }, (_, i) => ({ uid: `c_${String(i).padStart(10, 'a')}`, label: 'x', kind: 'component' as const })) };
    expect(archFits(many)).toBe(false);
    const big = many.components.slice(0, SPEC_ARCH_OWNER_COMPS_MAX).map((c) => ({ ...c, label: '가'.repeat(200), note: '나'.repeat(500) }));
    expect(archFits({ ...emptyArch(), components: big })).toBe(false); // 500 at their longest: past the bytes
    expect(archFits(a)).toBe(true);
  });
});

describe('the folder skeleton (pure)', () => {
  it('top folders and one level below, file counts, hidden and skipped folders left out, bounded', () => {
    const files = ['README.md', 'server/a.ts', 'server/src/b.ts', 'server/src/c/d.ts', '.github/x.yml', 'node_modules/p/i.js', 'core/.hidden/x', 'docs/a.md'];
    expect(foldersOf(dirsOf(files), files)).toEqual([
      { path: 'core/', files: 1 },
      { path: 'docs/', files: 1 },
      { path: 'server/', files: 3 },
      { path: 'server/src/', files: 2 },
    ]);
    const lots = Array.from({ length: 5_000 }, (_, i) => `t${i % 100}/s${i}/f.ts`);
    const out = foldersOf(dirsOf(lots), lots);
    expect(out).toHaveLength(SPEC_ARCH_SKELETON_MAX);
    expect(out.filter((f) => f.path.split('/').length === 2)).toHaveLength(SPEC_ARCH_SKELETON_MAX); // the top folders first
  });

  it('review M3: the folders come from their own listing, never cut with the files; a cut file listing marks the counts partial', () => {
    // A file listing that stops inside the first folder: every top folder is still there, counts partial.
    const dirs = ['a', 'a/x', 'b', 'c', 'z'];
    expect(foldersOf(dirs, ['a/x/1', 'a/x/2'], true)).toEqual([
      { path: 'a/', files: 2, partial: true },
      { path: 'a/x/', files: 2, partial: true },
      { path: 'b/', files: 0, partial: true },
      { path: 'c/', files: 0, partial: true },
      { path: 'z/', files: 0, partial: true },
    ]);
    // A tree past the walk's file cap: its last top folder is still proposed, the counts partial.
    const dir = tempHome();
    for (const t of ['a', 'zz']) fs.mkdirSync(path.join(dir, t, 'sub'), { recursive: true });
    for (let i = 0; i < SPEC_WALK_FILES_MAX + 10; i++) fs.writeFileSync(path.join(dir, 'a', `f${i}`), '');
    fs.writeFileSync(path.join(dir, 'zz', 'sub', 'last'), '');
    const w = walkFiles(dir);
    expect(w.capped).toBe(true);
    expect(foldersOf(w.dirs, w.files, w.capped).map((f) => [f.path, !!f.partial])).toEqual([
      ['a/', true],
      ['a/sub/', true],
      ['zz/', true],
      ['zz/sub/', true],
    ]);
  });

  it('a folder that is no repository: directory entries only, no file opened', () => {
    const dir = tempHome();
    fs.mkdirSync(path.join(dir, 'app/src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app/src/main.ts'), TOKEN);
    fs.writeFileSync(path.join(dir, 'top.md'), 'x');
    const read = vi.mocked(fs.readFileSync);
    const open = vi.mocked(fs.openSync);
    read.mockClear();
    open.mockClear();
    const w = walkFiles(dir);
    expect(foldersOf(w.dirs, w.files, w.capped)).toEqual([
      { path: 'app/', files: 1 },
      { path: 'app/src/', files: 1 },
    ]);
    expect(read).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

async function setup() {
  repo = makeTempRepo();
  repo.write('docs/design/system.md', DESIGN);
  repo.write('server/src/main.ts', `const key = '${TOKEN}';\n`);
  repo.write('server/index.ts', 'x');
  repo.write('webview-ui/src/App.tsx', 'x');
  repo.write('core/index.ts', 'x');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'init']);
  const home = tempHome();
  const project: SpecProject = { name: 'alpha', folder: repo.folder, projectId: PROJECT_ID };
  let clock = Date.now() + SPEC_SETTLE_MS * 2;
  const sent: unknown[] = [];
  const rec = recording(repo.run);
  const s = new SpecService({ home, projects: () => [project], broadcast: (m) => sent.push(m), run: rec.run, now: () => clock, later: () => undefined, idle: () => undefined });
  expect(await s.enable(project, ['docs/design/system.md'])).toMatchObject({ ok: true });
  const arch = async (svc = s): Promise<TraceArch> => {
    const r = await svc.arch(project, {});
    if (!r.ok) throw new Error(r.error);
    return r.value;
  };
  const node = (a: TraceArch, label: string) => a.nodes.find((n) => n.label === label)!;
  const edit = async (from: string, to: string) => {
    await new Promise((r) => setImmediate(r));
    const f = path.join(repo!.folder, 'docs/design/system.md');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf-8').replace(from, to));
    clock += SPEC_SCAN_MIN_MS;
  };
  return { repo, home, project, s, sent, rec, arch, node, edit, tick: (ms: number) => (clock += ms) };
}

describe.skipIf(!GIT_AVAILABLE)('the owner architecture through the service', () => {
  it('approve a diagram; after its block changes it is 재검토 필요; approved again; a stale version is refused; counts are real', async () => {
    const t = await setup();
    const before = hashTree(t.repo.folder);
    const a0 = await t.arch();
    const flow = a0.diagrams.find((d) => d.type === 'flowchart')!;
    expect(a0.diagrams.map((d) => [d.type, d.standing])).toEqual([
      ['flowchart', 'doc'],
      ['table', 'doc'],
    ]);
    expect(a0.counts).toMatchObject({ approved: 0, fromDocs: 5 });
    expect(await t.s.archApprove(t.project, { doc: flow.doc, block: flow.block, version: flow.version }, 'x')).toMatchObject({ ok: true });
    const a1 = await t.arch();
    expect(a1.diagrams[0]).toMatchObject({ standing: 'approved', approvedAt: expect.any(String) });
    expect(t.node(a1, 'API server').standing).toBe('approved');
    expect(t.node(a1, 'Queue').standing).toBe('doc');
    expect(a1.counts).toMatchObject({ approved: 3, fromDocs: 2 });

    await t.edit('Web app', 'Web client');
    const a2 = await t.arch();
    expect(a2.diagrams[0]).toMatchObject({ standing: 'review' });
    expect(t.node(a2, 'API server').standing).toBe('review');
    expect(a2.counts).toMatchObject({ approved: 0, fromDocs: 5 });
    // The version the owner saw before the edit: stale; the one shown now: approved again.
    expect(await t.s.archApprove(t.project, { doc: flow.doc, block: flow.block, version: flow.version }, 'x')).toEqual({ ok: false, error: 'stale' });
    expect(await t.s.archApprove(t.project, { doc: flow.doc, block: flow.block, version: a2.diagrams[0].version }, 'x')).toMatchObject({ ok: true });
    expect((await t.arch()).diagrams[0].standing).toBe('approved');
    expect(readArchFile(archFile(t.home, PROJECT_ID)).file.approvals).toHaveLength(1); // replaced, not piled up
    // Changed back to the first version: that approval was replaced, so it is 재검토 필요 again.
    await t.edit('Web client', 'Web app');
    expect((await t.arch()).diagrams[0].standing).toBe('review');
    expect(await t.s.archApprove(t.project, { doc: 'd_zzzzzzzzzz', block: 0, version: flow.version }, 'x')).toEqual({ ok: false, error: 'boundary' });
    expect(await t.s.archApprove(t.project, { doc: flow.doc, block: 9, version: flow.version }, 'x')).toEqual({ ok: false, error: 'stale' });
    expect(await t.s.archApprove(t.project, { doc: flow.doc, block: '0', version: flow.version }, 'x')).toEqual({ ok: false, error: 'value' });
    expect(t.sent.length).toBeGreaterThan(0);
    t.repo.write('docs/design/system.md', DESIGN); // the test's own edits undone
    fs.utimesSync(path.join(t.repo.folder, 'docs/design/system.md'), new Date(), new Date());
    expect(hashTree(t.repo.folder)).toEqual(before);
  });

  it('kinds, components and relations by hand, aliases applied in the query; unmerge keeps the history; UIDs are never lost', async () => {
    const t = await setup();
    const a0 = await t.arch();
    const api = t.node(a0, 'API server').id;
    const queue = t.node(a0, 'Queue').id;
    const sched = t.node(a0, 'Scheduler').id;
    expect(await t.s.archEditComp(t.project, api, { kind: 'store' }, 'x')).toEqual({ ok: true, value: { uid: api } });
    expect(await t.s.archEditComp(t.project, api, { label: 'renamed' }, 'x')).toEqual({ ok: false, error: 'value' }); // the document's label
    expect(await t.s.archEditComp(t.project, api, { kind: 'pipe' }, 'x')).toEqual({ ok: false, error: 'value' });
    expect(await t.s.archEditComp(t.project, 'c_zzzzzzzzzz', { kind: 'store' }, 'x')).toEqual({ ok: false, error: 'comp' });
    expect(t.node(await t.arch(), 'API server').kind).toBe('store');

    const added = await t.s.archAddComp(t.project, { label: `  Payments ${TOKEN} `, kind: 'external', note: '외부 결제' }, 'x');
    if (!added.ok) throw new Error(added.error);
    expect(added.value).toMatchObject({ uid: expect.stringMatching(/^c_[a-z2-7]{10}$/), label: 'Payments ***', kind: 'external', note: '외부 결제' });
    const pay = added.value.uid;
    expect(await t.s.archAddComp(t.project, { label: '   ' }, 'x')).toEqual({ ok: false, error: 'value' });
    expect(await t.s.archAddComp(t.project, { label: 'x'.repeat(201) }, 'x')).toEqual({ ok: false, error: 'value' });
    const rel = await t.s.archAddRel(t.project, { from: api, to: pay, label: '결제 요청' }, 'x');
    if (!rel.ok) throw new Error(rel.error);
    expect(await t.s.archAddRel(t.project, { from: api, to: 'c_zzzzzzzzzz' }, 'x')).toEqual({ ok: false, error: 'boundary' });
    expect(await t.s.archAddRel(t.project, { from: api, to: api }, 'x')).toEqual({ ok: false, error: 'value' });
    let a = await t.arch();
    expect(t.node(a, 'Payments ***')).toMatchObject({ from: 'owner', standing: 'approved', kind: 'external', sources: [] });
    expect(a.edges.find((e) => e.id === rel.value.id)).toMatchObject({ from: api, to: pay, owner: true, label: '결제 요청', layer: 'composition' });
    expect(a.counts.approved).toBe(1);

    // '같은 구성요소': Scheduler shown as Queue; its sources and edges move; no cycle; unmerge brings it back.
    expect(await t.s.archAlias(t.project, { uid: sched, into: queue }, 'x')).toMatchObject({ ok: true });
    expect(await t.s.archAlias(t.project, { uid: queue, into: sched }, 'x')).toEqual({ ok: false, error: 'value' }); // a cycle
    expect(await t.s.archAlias(t.project, { uid: sched, into: 'c_zzzzzzzzzz' }, 'x')).toEqual({ ok: false, error: 'boundary' });
    a = await t.arch();
    expect(a.nodes.some((n) => n.id === sched)).toBe(false);
    expect(t.node(a, 'Queue').merged).toEqual([{ id: sched, label: 'Scheduler' }]);
    expect(t.node(a, 'Queue').sources).toHaveLength(2);
    expect(a.edges.some((e) => e.from === sched || e.to === sched)).toBe(false); // Scheduler --> Queue became a self loop: gone
    expect(await t.s.archUnalias(t.project, sched, 'x')).toMatchObject({ ok: true });
    expect(await t.s.archUnalias(t.project, sched, 'x')).toEqual({ ok: false, error: 'comp' });
    a = await t.arch();
    expect(t.node(a, 'Scheduler').id).toBe(sched);
    const hist = readArchFile(archFile(t.home, PROJECT_ID)).file.history;
    expect(hist.map((h) => h.action)).toEqual(['edited', 'added', 'related', 'merged', 'unmerged']);
    expect(JSON.stringify(hist)).not.toMatch(/Payments|결제|외부/); // ids and words only

    // Only a component added by hand is deleted; its relations go with it.
    expect(await t.s.archDeleteComp(t.project, api, 'x')).toEqual({ ok: false, error: 'value' });
    expect(await t.s.archDeleteComp(t.project, pay, 'x')).toMatchObject({ ok: true });
    a = await t.arch();
    expect(a.edges.some((e) => e.owner)).toBe(false);
    expect(readArchFile(archFile(t.home, PROJECT_ID)).file.relations).toEqual([]);
    expect(await t.s.archDeleteRel(t.project, rel.value.id, 'x')).toEqual({ ok: false, error: 'link' });
    // The documents' UIDs are as they were.
    expect([api, queue, sched].every((u) => a.nodes.some((n) => n.id === u))).toBe(true);
  });

  it('the skeleton: names and counts only, by HEAD; approve, rename, merge, remove; a folder keeps its UID through decisions', async () => {
    const t = await setup();
    const read = vi.mocked(fs.readFileSync);
    read.mockClear();
    const a0 = await t.arch();
    const proposed = a0.nodes.filter((n) => n.standing === 'proposed');
    expect(proposed.map((n) => [n.label, n.files])).toEqual([
      ['core/', 1],
      ['docs/', 1],
      ['docs/design/', 1],
      ['server/', 2],
      ['server/src/', 1],
      ['sub/', 1], // makeTempRepo's own
      ['webview-ui/', 1],
      ['webview-ui/src/', 1],
    ]);
    expect(a0.counts.proposed).toBe(8);
    expect(JSON.stringify(a0)).not.toContain(TOKEN.slice(4));
    expect(read.mock.calls.map((c) => String(c[0])).filter((f) => f.startsWith(t.repo.folder) && !f.endsWith('.md'))).toEqual([]); // no code file opened
    expect(t.rec.calls.filter((c) => c.includes('ls-files') && !c.includes('--'))).toEqual([['ls-files', '-z']]);
    const builds = t.s.skeletonBuilds;
    await t.arch();
    expect(t.s.skeletonBuilds).toBe(builds); // the same HEAD: kept

    const ok = async (b: Record<string, unknown>) => {
      const r = await t.s.archSkeleton(t.project, b, 'x');
      if (!r.ok) throw new Error(r.error);
      return r.value;
    };
    const server = await ok({ path: 'server/', action: 'approved' });
    expect(server.uid).toMatch(/^c_/);
    const web = await ok({ path: 'webview-ui/', action: 'renamed', label: 'Web UI' });
    await ok({ path: 'docs/', action: 'removed' });
    await ok({ path: 'core/', action: 'merged', into: server.uid });
    expect(await t.s.archSkeleton(t.project, { path: 'nowhere/', action: 'approved' }, 'x')).toEqual({ ok: false, error: 'stale' });
    expect(await t.s.archSkeleton(t.project, { path: 'core/', action: 'merged', into: 'c_zzzzzzzzzz' }, 'x')).toEqual({ ok: false, error: 'boundary' });
    expect(await t.s.archSkeleton(t.project, { path: 'core/', action: 'renamed' }, 'x')).toEqual({ ok: false, error: 'value' });
    let a = await t.arch();
    expect(t.node(a, 'server/')).toMatchObject({ id: server.uid, from: 'folder', standing: 'approved', kind: 'component', folder: 'server/', files: 2, folders: ['core/'] });
    expect(t.node(a, 'Web UI')).toMatchObject({ id: web.uid, standing: 'approved', folder: 'webview-ui/' });
    expect(a.nodes.filter((n) => n.standing === 'proposed').map((n) => n.label)).toEqual(['server/src/', 'sub/', 'webview-ui/src/']); // docs/ and below hidden
    expect(a.counts).toMatchObject({ approved: 2, proposed: 3 });
    // An approved folder's kind and label can change; removed then approved again: the same UID.
    expect(await t.s.archEditComp(t.project, server.uid!, { kind: 'system', label: 'Server' }, 'x')).toMatchObject({ ok: true });
    expect(t.node(await t.arch(), 'Server')).toMatchObject({ id: server.uid, kind: 'system' });
    await ok({ path: 'server/', action: 'removed' });
    expect((await ok({ path: 'server/', action: 'approved' })).uid).toBe(server.uid);
    // A new commit: listed again.
    t.repo.write('lib/x.ts', 'x');
    t.repo.git(['add', '-A']);
    t.repo.git(['commit', '-q', '-m', 'lib']);
    t.tick(SPEC_SCAN_MIN_MS);
    a = await t.arch();
    expect(t.s.skeletonBuilds).toBe(builds + 1);
    expect(a.nodes.some((n) => n.label === 'lib/' && n.standing === 'proposed')).toBe(true);
    // Only read-only git commands ran.
    expect(t.rec.calls.map((c) => c.find((x) => !x.startsWith('-') && !x.includes('=')) ?? '').filter((c) => !['rev-parse', 'status', 'ls-files', 'ls-tree', 'log', 'diff', 'for-each-ref', 'merge-base', 'cat-file', 'rev-list', 'config'].includes(c))).toEqual([]);
  });

  it('a corrupt arch.json is never written; past its cap a write is refused (409 archFull); purged with the spec data', async () => {
    const t = await setup();
    const file = archFile(t.home, PROJECT_ID);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'nope');
    const again = new SpecService({ home: t.home, projects: () => [t.project], broadcast: () => undefined, run: t.repo.run });
    expect(await again.archAddComp(t.project, { label: 'X' }, 'x')).toEqual({ ok: false, error: 'corrupt' });
    expect(fs.readFileSync(file, 'utf-8')).toBe('nope');
    expect((await again.arch(t.project, {})).ok).toBe(true); // the documents' architecture still shows
    writeArchFile(file, { ...emptyArch(), components: Array.from({ length: SPEC_ARCH_OWNER_COMPS_MAX }, (_, i) => ({ uid: `c_${String(i).padStart(10, 'a').replace(/[0189]/g, 'b')}`, label: 'x', kind: 'component' as const })) });
    const third = new SpecService({ home: t.home, projects: () => [t.project], broadcast: () => undefined, run: t.repo.run });
    expect(readArchFile(file).corrupt).toBeNull();
    expect(await third.archAddComp(t.project, { label: 'one more' }, 'x')).toEqual({ ok: false, error: 'archFull' });
    expect(readArchFile(file).file.components).toHaveLength(SPEC_ARCH_OWNER_COMPS_MAX);
    expect(purgeSpecData(t.home, PROJECT_ID)).toEqual([]);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('review fixes (pure)', () => {
  const C = (n: number) => `c_${'abcdefghij'[n]}aaaaaaaaa`;
  const node = (id: string, label: string): ArchNode => ({ id, label, kind: 'component', from: 'doc', standing: 'doc', sources: [{ path: 'd.md', line: 1 }] });
  const base = (nodes: ArchNode[]): TraceArch => ({ layer: 'composition', nodes, groups: [], edges: [], unsupported: [], counts: { approved: 0, proposed: 0, fromDocs: nodes.length }, diagrams: [] });

  it('H1 root rule: archFits refuses any record read would refuse (a label past 200 after masking)', () => {
    expect(archFits({ ...emptyArch(), components: [{ uid: C(0), label: 'x'.repeat(201), kind: 'store' }] })).toBe(false);
    expect(archFits({ ...emptyArch(), relations: [{ id: 'e_aaaaaaaaaa', from: C(0), to: C(1), label: 'x'.repeat(201) }] })).toBe(false);
    expect(archFits({ ...emptyArch(), skeleton: [{ path: 'a/', action: 'renamed', uid: C(0), label: 'x'.repeat(201) }] })).toBe(false);
    expect(archFits({ ...emptyArch(), components: [{ uid: C(0), label: 'ok', kind: 'store', note: 'n'.repeat(501) }] })).toBe(false);
    expect(archFits({ ...emptyArch(), components: [{ uid: C(0), label: 'ok', kind: 'store', note: 'n'.repeat(500) }] })).toBe(true);
  });

  it('L2: an alias chain A→B→C holds when B or C is gone (the last component along it that is there)', () => {
    const aliases = [
      { uid: C(0), into: C(1) },
      { uid: C(1), into: C(2) },
    ];
    // B gone: A goes into C.
    let out = applyOwner(base([node(C(0), 'A'), node(C(2), 'C')]), { ...emptyArch(), aliases }, []);
    expect(out.nodes.map((n) => n.id)).toEqual([C(2)]);
    expect(out.nodes[0].merged).toEqual([{ id: C(0), label: 'A' }]);
    // C gone: A goes into B.
    out = applyOwner(base([node(C(0), 'A'), node(C(1), 'B')]), { ...emptyArch(), aliases }, []);
    expect(out.nodes.map((n) => n.id)).toEqual([C(1)]);
    // All there: both into C, sources together.
    out = applyOwner(base([node(C(0), 'A'), node(C(1), 'B'), node(C(2), 'C')]), { ...emptyArch(), aliases }, []);
    expect(out.nodes.map((n) => [n.id, n.merged?.map((m) => m.label), n.sources.length])).toEqual([[C(2), ['A', 'B'], 3]]);
    expect(aliasRoot(new Map([[C(0), C(1)], [C(1), C(0)]]), C(0))).toBe(C(0)); // a cycle ends
  });

  it('L3: a folder merged into a component that is gone is proposed again; L1: folder names are masked', () => {
    const a = { ...emptyArch(), skeleton: [{ path: 'core/', action: 'merged' as const, into: C(5) }] };
    const out = applyOwner(base([]), a, [{ path: 'core/', files: 2 }]);
    expect(out.nodes).toEqual([expect.objectContaining({ id: 'f:core/', standing: 'proposed', folder: 'core/', files: 2 })]);
    expect(out.counts.proposed).toBe(1);
    const masked = applyOwner(base([]), emptyArch(), [{ path: `${TOKEN}/`, files: 1, partial: true }]);
    expect(JSON.stringify(masked)).not.toContain(TOKEN);
    expect(masked.nodes[0]).toMatchObject({ standing: 'proposed', files: 1, filesPartial: true });
  });
});

describe.skipIf(!GIT_AVAILABLE)('review fixes (service)', () => {
  it('H1: a label, note, relation label or folder name that masking lengthens is cut, saved, and read back after a restart', async () => {
    const t = await setup();
    const label = 'y'.repeat(193) + 'token=a'; // 200 characters, 202 once masked
    const added = await t.s.archAddComp(t.project, { label, kind: 'store', note: 'n'.repeat(490) + 'password=x' }, 'x');
    if (!added.ok) throw new Error(added.error);
    expect(added.value.label).toHaveLength(200);
    expect(added.value.note).toHaveLength(500);
    const api = (await t.arch()).nodes.find((n) => n.label === 'API server')!.id;
    expect(await t.s.archAddRel(t.project, { from: api, to: added.value.uid, label }, 'x')).toMatchObject({ ok: true });
    const server = await t.s.archSkeleton(t.project, { path: 'server/', action: 'renamed', label }, 'x');
    if (!server.ok) throw new Error(server.error);
    expect(await t.s.archEditComp(t.project, server.value.uid!, { label: 'z'.repeat(193) + 'token=b' }, 'x')).toMatchObject({ ok: true });
    expect(await t.s.archEditComp(t.project, added.value.uid, { label, note: 'q'.repeat(490) + 'password=y' }, 'x')).toMatchObject({ ok: true });
    const file = archFile(t.home, PROJECT_ID);
    expect(readArchFile(file).corrupt).toBeNull();
    // A restart: everything is there and a write still lands.
    const again = new SpecService({ home: t.home, projects: () => [t.project], broadcast: () => undefined, run: t.repo.run });
    expect(await again.archAddComp(t.project, { label: 'Z' }, 'x')).toMatchObject({ ok: true });
    const r = readArchFile(file);
    expect(r.corrupt).toBeNull();
    expect([r.file.components.length, r.file.relations.length, r.file.skeleton.length]).toEqual([2, 1, 1]);
  });

  it('M1: a diagram inserted above an approved one: the old stays approved, the new is 문서에서 읽음; approving the new keeps both', async () => {
    const t = await setup();
    const flow = (await t.arch()).diagrams[0];
    expect(await t.s.archApprove(t.project, { doc: flow.doc, block: flow.block, version: flow.version }, 'x')).toMatchObject({ ok: true });
    const NEW = fence(['flowchart LR', '  q["Queue"] --> w["Worker"]'].join('\n'));
    await t.edit('# Design\n\n', `# Design\n\n${NEW}\n`);
    const a1 = await t.arch();
    expect(a1.diagrams.map((d) => [d.block, d.standing])).toEqual([
      [0, 'doc'],
      [1, 'approved'],
      [2, 'doc'],
    ]);
    const n0 = a1.diagrams[0];
    expect(await t.s.archApprove(t.project, { doc: n0.doc, block: n0.block, version: n0.version }, 'x')).toMatchObject({ ok: true });
    expect((await t.arch()).diagrams.map((d) => d.standing)).toEqual(['approved', 'approved', 'doc']);
    expect(readArchFile(archFile(t.home, PROJECT_ID)).file.approvals).toHaveLength(2);
  });

  it('M2: a project whose arch.json exists is not offered 이어받기, and inherit refuses it (its arch.json stays)', async () => {
    const t = await setup(); // p_abcdefghij, enabled: its Registry is the orphan once p2 exists
    const p2: SpecProject = { name: 'beta', folder: t.repo.folder, projectId: 'p_bbbbbbbbbb' };
    const s2 = new SpecService({ home: t.home, projects: () => [p2], broadcast: () => undefined, run: t.repo.run });
    expect(await s2.enable(p2, [])).toMatchObject({ ok: true });
    expect(await s2.archAddComp(p2, { label: 'Owner thing' }, 'x')).toMatchObject({ ok: true });
    expect(s2.disable(p2)).toMatchObject({ ok: true });
    expect(((await s2.summary(p2)) as { inherit?: unknown[] }).inherit ?? []).toEqual([]);
    expect(await s2.inherit(p2, { from: PROJECT_ID, answer: 'accept' })).toEqual({ ok: false, error: 'stale' });
    expect(readArchFile(archFile(t.home, p2.projectId)).file.components.map((c) => c.label)).toEqual(['Owner thing']);
  });

  it('M3: the skeleton lists folders with ls-tree (never cut by the file listing); L1: a token-like folder is masked and still decided', async () => {
    const t = await setup();
    t.repo.write(`${TOKEN}/x.ts`, 'x');
    t.repo.git(['add', '-A']);
    t.repo.git(['commit', '-q', '-m', 'odd folder']);
    t.tick(SPEC_SCAN_MIN_MS);
    const a = await t.arch();
    expect(t.rec.calls.some((c) => c.includes('ls-tree'))).toBe(true);
    expect(JSON.stringify(a)).not.toContain(TOKEN);
    const odd = a.nodes.find((n) => n.standing === 'proposed' && n.folder === '***/')!;
    expect(odd).toBeDefined();
    expect(await t.s.archSkeleton(t.project, { path: odd.folder, action: 'approved' }, 'x')).toMatchObject({ ok: true, value: { path: `${TOKEN}/` } });
    expect((await t.arch()).nodes.find((n) => n.folder === odd.folder)?.standing).toBe('approved');
  });

  it('L4: approving prunes approvals of documents no longer tracked; a kind write prunes kinds of components gone', async () => {
    const t = await setup();
    const file = archFile(t.home, PROJECT_ID);
    const by = { kind: 'owner' as const, name: 'owner' };
    writeArchFile(file, { ...emptyArch(), approvals: [{ doc: 'd_zzzzzzzzzz', block: 0, version: '0123456789abcdef', at: 'x', by }], kinds: [{ uid: 'c_zzzzzzzzzz', kind: 'store' }] });
    const s = new SpecService({ home: t.home, projects: () => [t.project], broadcast: () => undefined, run: t.repo.run, now: () => Date.now() + SPEC_SETTLE_MS * 2 });
    const a = (await s.arch(t.project, {})) as { ok: true; value: TraceArch };
    const flow = a.value.diagrams[0];
    expect(await s.archApprove(t.project, { doc: flow.doc, block: flow.block, version: flow.version }, 'x')).toMatchObject({ ok: true });
    expect(await s.archEditComp(t.project, a.value.nodes.find((n) => n.label === 'Queue')!.id, { kind: 'store' }, 'x')).toMatchObject({ ok: true });
    const r = readArchFile(file).file;
    expect(r.approvals.map((x) => x.doc)).toEqual([flow.doc]);
    expect(r.kinds.map((k) => k.uid)).not.toContain('c_zzzzzzzzzz');
  });
});

describe.skipIf(!GIT_AVAILABLE)('the arch routes', () => {
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
    const call = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object, headers: Record<string, string> = same) =>
      server.inject({ method, url: `/api/cld/spec/alpha/arch/${url}`, headers, ...(payload && { payload }) });
    const audits = () => log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[cld spec]'));
    return { ...t, call, same, audits };
  }

  it('session only, same-origin, read-only refused; another project 403; stale 409; audited by ids and words only', async () => {
    const t = await app();
    const a = await t.arch();
    const flow = a.diagrams[0];
    const body = { doc: flow.doc, block: flow.block, version: flow.version };
    expect((await t.call('POST', 'approve', body, {})).statusCode).toBe(401);
    expect((await t.call('POST', 'approve', body, { ...t.same, origin: 'https://evil.example' })).json().errorCode).toBe('origin_mismatch');
    expect((await t.call('POST', 'approve', { ...body, version: '0123456789abcdef' })).json()).toMatchObject({ errorCode: 'spec_stale' });
    expect((await t.call('POST', 'approve', { ...body, version: '0123456789abcdef' })).statusCode).toBe(409);
    expect((await t.call('POST', 'approve', { ...body, doc: 'd_zzzzzzzzzz' })).statusCode).toBe(403);
    expect((await t.call('POST', 'approve', body)).statusCode).toBe(200);
    const c = await t.call('POST', 'components', { label: 'Secret label', kind: 'store', note: 'secret note' });
    expect(c.statusCode).toBe(200);
    const uid = c.json().uid as string;
    expect((await t.call('PATCH', `components/${uid}`, { kind: 'external', note: 'other secret' })).statusCode).toBe(200);
    expect((await t.call('PATCH', 'components/c_zzzzzzzzzz', { kind: 'external' })).statusCode).toBe(404);
    const api = a.nodes.find((n) => n.label === 'API server')!.id;
    const r = await t.call('POST', 'relations', { from: api, to: uid, label: 'secret rel' });
    expect(r.statusCode).toBe(200);
    expect((await t.call('POST', 'relations', { from: api, to: 'c_zzzzzzzzzz' })).statusCode).toBe(403);
    expect((await t.call('DELETE', `relations/${r.json().id}`)).statusCode).toBe(200);
    expect((await t.call('POST', 'alias', { uid, into: api })).statusCode).toBe(200);
    expect((await t.call('DELETE', `alias/${uid}`)).statusCode).toBe(200);
    expect((await t.call('POST', 'skeleton', { path: 'server/', action: 'renamed', label: 'secret name' })).statusCode).toBe(200);
    expect((await t.call('POST', 'skeleton', { path: 'gone/', action: 'approved' })).statusCode).toBe(409);
    expect((await t.call('DELETE', `components/${uid}`)).statusCode).toBe(200);
    expect((await t.call('DELETE', `components/${api}`)).statusCode).toBe(400);
    const lines = t.audits();
    expect(lines.map((l) => l.split(' ')[2])).toEqual(['arch-approve', 'arch-add', 'arch-edit', 'arch-relate', 'arch-unrelate', 'arch-merge', 'arch-unmerge', 'arch-skeleton', 'arch-delete']);
    expect(lines[0]).toBe(`[cld spec] arch-approve device="Test phone" project="alpha" ${flow.doc} ${flow.block} ${flow.version}`);
    const jsonl = fs.readFileSync(path.join(t.home, '.config/agent-tycoon/audit.jsonl'), 'utf-8');
    for (const text of [lines.join('\n'), jsonl]) expect(text).not.toMatch(/secret/i);
    const host = await app({ host: true });
    expect((await host.call('POST', 'components', { label: 'X' })).json().errorCode).toBe('spec_session_only');
    const ro = await app({ readOnly: true });
    expect((await ro.call('POST', 'components', { label: 'X' })).json().errorCode).toBe('read_only_mode');
  });
});
