// SPT-P4C: requirement ↔ component. The label rule (whole words, stop list, short labels), the
// module column, manual realizes links through the Link Store (confirm, reject, unlink), the
// project boundary, the missing end, the candidates route with type=component, the 아키텍처
// counts, the caps and TOKEN-GUARD.
import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TraceArch, TraceItem } from '../../../../core/src/agent-tycoon/spec/trace.js';
import { SPEC_LINK_LABELS_MAX, SPEC_LINK_MODULE_PATHS_MAX, SPEC_LINK_PER_REQ_MAX, SPEC_SCAN_MIN_MS, SPEC_SETTLE_MS } from '../../constants.js';
import { GIT_AVAILABLE, makeTempRepo, type TempRepo } from '../engine/git/testRepo.js';
import { idsOf } from '../tracking/docs.js';
import { labelIndex, moduleRows, namedLabels, pathOwners, pathsOf, type TraceComp, wordsOf } from './compLinks.js';
import { emptyLinks, linksFile, readLinks } from './links.js';
import { registerSpecRoutes } from './routes.js';
import { type SpecProject, SpecService } from './service.js';
import type { SpecRegistry } from './store.js';
import { buildIndex, type ItemText } from './trace.js';

const comp = (uid: string, label: string, folder?: string): TraceComp => ({ uid, label, ...(folder && { folder }) });
const named = (text: string, comps: TraceComp[]) => namedLabels(wordsOf(text, 300).join(' '), labelIndex(comps)).flatMap((k) => labelIndex(comps).get(k)!);

describe('the label rule (pure)', () => {
  it('whole words, case folded; a Latin word ends at Hangul; short labels and stop words are skipped', () => {
    const cs = [comp('c_1', 'Scheduler'), comp('c_2', 'Task Store'), comp('c_3', 'DB'), comp('c_4', 'Data'), comp('c_5', 'Queue')];
    expect(named('The scheduler splits work', cs)).toEqual(['c_1']);
    expect(named('Scheduler가 작업을 나눈다', cs)).toEqual(['c_1']);
    expect(named('Schedulers and rescheduler', cs)).toEqual([]); // not a whole word
    expect(named('saved in the task  store, data in DB', cs)).toEqual(['c_2']); // DB: 2 chars; Data: a stop word
    expect(named('queue<br>later', [comp('c_6', 'Job<br>Queue')])).toEqual([]);
    expect(named('the job queue', [comp('c_6', 'Job<br>Queue')])).toEqual(['c_6']);
  });

  it('a Korean particle at the end of a word is stripped before the lookup (the last word of a run)', () => {
    const cs = [comp('c_1', '스케줄러'), comp('c_2', '작업 큐'), comp('c_3', '게이트웨이')];
    expect(named('스케줄러가 작업을 나눈다', cs)).toEqual(['c_1']);
    expect(named('스케줄러에서 나눈다', cs)).toEqual(['c_1']);
    expect(named('스케줄러입니다', cs)).toEqual(['c_1']);
    expect(named('작업 큐로 보낸다', cs)).toEqual(['c_2']);
    expect(named('게이트웨이 앞', cs)).toEqual(['c_3']); // '이' is no particle of a bare match
    expect(named('스케줄러링 큐에', cs)).toEqual([]);
  });

  it('a long word names nothing and the text is read up to 4 KB: 1.8 MB of words stays fast', () => {
    const labels = labelIndex([comp('c_1', 'Scheduler')]);
    const huge = `${'x'.repeat(1_800_000)} scheduler`;
    const t0 = performance.now();
    expect(wordsOf(huge, 300)).toEqual([]);
    expect(namedLabels(wordsOf(`${'word '.repeat(2_000)}scheduler`, 300).join(' '), labels)).toEqual([]); // past 4 KB
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('caps: labels per index, components per label; a label of more than the word cap is skipped', () => {
    const many = Array.from({ length: SPEC_LINK_LABELS_MAX + 50 }, (_, i) => comp(`c_${i}`, `label${i}`));
    expect(labelIndex(many).size).toBe(SPEC_LINK_LABELS_MAX);
    expect(labelIndex(Array.from({ length: 9 }, (_, i) => comp(`c_${i}`, 'Worker'))).get('worker')!.length).toBe(4);
    expect(labelIndex([comp('c_1', 'one two three four five')]).size).toBe(0);
  });

  it('the match is linear in the text: 2,000 requirements of 300 words against 500 labels stay fast', () => {
    const labels = labelIndex(Array.from({ length: 500 }, (_, i) => comp(`c_${i}`, `alpha${i} beta`)));
    const words = Array.from({ length: 300 }, (_, i) => `w${i}`).join(' ');
    const t0 = performance.now();
    for (let r = 0; r < 2000; r++) namedLabels(words, labels);
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});

describe('the module column (pure)', () => {
  it('reads the paths of 구현 모듈 / UI 컴포넌트 / Module / Component in an ID row; not in a fence, not without a folder, no ..', () => {
    const doc =
      '| ID | 요구 | 구현 모듈 |\n|---|---|---|\n| FR-ARC-002 | 큐 | `server/queue.ts`, ./webview-ui/App.tsx<br>queue.ts |\n| FR-ARC-003 | x | ../etc/passwd /abs/x |\n\n' +
      '| ID | Component |\n|---|---|\n| FR-ARC-004 | core/ |\n\n```\n| ID | Module |\n|---|---|\n| FR-ARC-005 | server/x.ts |\n```\n';
    const rows = moduleRows(doc, 'SRS.md', { shortIds: false, idPatterns: [] });
    expect(rows).toEqual([
      { id: 'FR-ARC-002', paths: ['server/queue.ts', 'webview-ui/App.tsx'], line: 3 },
      { id: "FR-ARC-004", paths: ["core/"], line: 8 },
    ]);
    expect(pathsOf(Array.from({ length: 20 }, (_, i) => `a/${i}.ts`).join(' ')).length).toBe(SPEC_LINK_MODULE_PATHS_MAX);
    expect(pathsOf('(`server/x.ts`):')).toEqual(['server/x.ts']);
  });

  it('a 2 MB document of 521 rows whose cell is `)`×4000+`x` reads in well under a second (was 3-15 s: a backtracking trim)', () => {
    const cell = ')'.repeat(4000) + 'x';
    const rows = Array.from({ length: 521 }, (_, i) => `| FR-ARC-${i + 1} | t | ${cell} |`);
    const doc = `| ID | 요구 | 구현 모듈 |\n|---|---|---|\n${rows.join('\n')}\n`;
    const t0 = performance.now();
    expect(moduleRows(doc, 'SRS.md', { shortIds: false, idPatterns: [] })).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(pathsOf(`${'a/'.repeat(300)}!`)).toEqual([]); // past SPEC_PATH_MAX: dropped before any regex
  });

  it('a path belongs to an approved skeleton folder (the longest), else to the component whose label is its first folder', () => {
    const owners = pathOwners([comp('c_s', 'server'), comp('c_f', 'Engine', 'server/engine'), comp('c_g', 'Srv', 'server/')]);
    expect(owners('server/engine/run.ts')).toEqual(['c_f']);
    expect(owners('server/queue.ts')).toEqual(['c_g']);
    expect(pathOwners([comp('c_s', 'Server')])('server/queue.ts')).toEqual(['c_s']);
    expect(pathOwners([comp('c_s', 'server')])('core/x.ts')).toEqual([]);
  });

  it('the folder Map stays linear: 50,000 folders and 20,000 deep paths look up their prefixes only', () => {
    const comps = Array.from({ length: 50_000 }, (_, i) => comp(`c_${i}`, `F${i}`, `top${i % 100}/sub${i}/`));
    const t0 = performance.now();
    const owners = pathOwners(comps);
    let hits = 0;
    for (let i = 0; i < 20_000; i++) hits += owners(`top${i % 100}/sub${i}/a/b/c/d/e/f.ts`).length;
    expect(hits).toBe(20_000);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });
});

/** A Registry of `docs` documents of `rows` rows each, every row the same display ID (what buildIndex reads of it). */
function dupRegistry(docs: number, rows: number) {
  const reg = { docs: {}, items: {}, components: {} } as unknown as SpecRegistry;
  const words = new Map<string, ItemText>();
  for (let d = 0; d < docs; d++) {
    reg.docs[`d_${d}`] = { path: `docs/SRS${d}.md`, tracked: true, state: 'active', mode: 'auto' } as SpecRegistry['docs'][string];
    for (let r = 0; r < rows; r++) {
      const u = `r_${d}_${r}`;
      reg.items[u] = { doc: `d_${d}`, state: 'active', locator: { line: r + 3 }, displayIds: [{ id: 'FR-ARC-001' }], decisions: [], textHash: 'h' } as unknown as SpecRegistry['items'][string];
      words.set(u, { title: 't', section: '', refs: [], words: 't' });
    }
  }
  return { reg, words };
}
const indexOf = (reg: SpecRegistry, words: Map<string, ItemText>, modRows: Parameters<typeof buildIndex>[0]['modRows'], comps: TraceComp[], links = emptyLinks()) =>
  buildIndex({ reg, text: (u) => words.get(u), refRows: [], links, acceptance: [], tasks: [], jobs: [], commits: [], known: () => undefined, ids: idsOf(false, []), comps, modRows });

describe('module rows × duplicate IDs (pure)', () => {
  it('8 documents of 500 rows with one ID and 8 paths each: each row links only its own item; the build is linear (was 31.5 s)', () => {
    const { reg, words } = dupRegistry(8, 500);
    const cell = Array.from({ length: 8 }, (_, k) => `a/${k}`);
    const modRows = Object.values(reg.docs).flatMap((d) => Array.from({ length: 500 }, (_, r) => ({ path: d.path, id: 'FR-ARC-001', paths: cell, line: r + 3 })));
    const t0 = performance.now();
    const ix = indexOf(reg, words, modRows, [comp('c_aaaaaaaaaa', 'a')]);
    expect(performance.now() - t0).toBeLessThan(3_000);
    const realizes = ix.edges.filter((e) => e.rel === 'realizes');
    expect(realizes).toHaveLength(4_000); // one per item, its own row's
    expect(realizes.every((e) => e.status === 'observed' && e.source?.line === reg.items[e.from].locator.line && e.source?.path === reg.docs[reg.items[e.from].doc].path)).toBe(true);
  });

  it('a 참조만 하는 표 row names every item with its ID; the rows of one ID merge (paths capped) before the items are walked', () => {
    const { reg, words } = dupRegistry(2, 3);
    const rows = Array.from({ length: 50 }, (_, k) => ({ path: 'docs/trace.md', id: 'FR-ARC-001', paths: [`b/${k}`, 'a/x'], line: k + 3, refs: true as const }));
    const ix = indexOf(reg, words, rows, [comp('c_aaaaaaaaaa', 'a'), comp('c_bbbbbbbbbb', 'b')]);
    const realizes = ix.edges.filter((e) => e.rel === 'realizes');
    expect(realizes).toHaveLength(12); // 6 items × (b, a)
    expect(new Set(realizes.map((e) => e.source?.line))).toEqual(new Set([3])); // the first row's place
  });

  it('pairs the owner rejected do not count against the per-requirement cap', () => {
    const { reg, words } = dupRegistry(1, 1);
    const names = Array.from({ length: SPEC_LINK_PER_REQ_MAX + 3 }, (_, i) => `part${i}`);
    words.set('r_0_0', { title: '', section: '', refs: [], words: names.join(' ') });
    const comps = names.map((n, i) => comp(`c_${String(i).padStart(10, 'a')}`, n));
    const links = emptyLinks();
    for (const c of comps.slice(0, SPEC_LINK_PER_REQ_MAX))
      links.links.push({ id: `l_${c.uid.slice(2)}`, from: { t: 'req', uid: 'r_0_0' }, to: { t: 'comp', uid: c.uid }, rel: 'realizes', status: 'rejected', by: { kind: 'owner', name: 'owner' }, at: 'x', basis: { textHash: 'h', docBlob: '' } });
    const edges = indexOf(reg, words, [], comps, links).edges.filter((e) => e.rel === 'realizes');
    expect(edges.filter((e) => e.status === 'rejected')).toHaveLength(SPEC_LINK_PER_REQ_MAX);
    expect(edges.filter((e) => e.status === 'suggested').map((e) => e.to)).toEqual(comps.slice(SPEC_LINK_PER_REQ_MAX).map((c) => c.uid));
  });
});

const PROJECT_ID = 'p_abcdefghij';
const SRS =
  '# SRS\n\n| ID | 요구 | 구현 모듈 |\n|---|---|---|\n' +
  '| FR-ARC-001 | The Scheduler splits the jobs | |\n' +
  '| FR-ARC-002 | 작업을 줄 세운다 | server/queue.ts |\n' +
  '| FR-ARC-003 | 작업을 실행한다 | |\n';
const DESIGN = (worker = true) => `# 설계\n\n\`\`\`mermaid\nflowchart LR\n  S[Scheduler] --> Q[Queue]\n${worker ? '  Q --> W[Worker]\n' : ''}  Q --> V[server]\n\`\`\`\n`;

let repo: TempRepo | null = null;
const homes: string[] = [];
afterEach(() => {
  repo?.cleanup();
  repo = null;
  for (const h of homes.splice(0)) fs.rmSync(h, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setup() {
  repo = makeTempRepo();
  repo.write('docs/requirements/SRS.md', SRS);
  repo.write('docs/design/arch.md', DESIGN());
  repo.write('server/queue.ts', 'export {};\n');
  repo.write('server/engine/run.ts', 'export {};\n');
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs']);
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-p4c-home-')));
  homes.push(home);
  const project: SpecProject = { name: 'alpha', folder: repo.folder, projectId: PROJECT_ID };
  let clock = Date.now() + SPEC_SETTLE_MS * 2;
  const s = new SpecService({ home, projects: () => [project], broadcast: () => undefined, run: repo.run, now: () => clock, later: () => undefined, idle: () => undefined, tasks: () => [], jobs: () => [] });
  expect(await s.enable(project, ['docs/requirements/SRS.md', 'docs/design/arch.md'])).toMatchObject({ ok: true });
  const uid: Record<string, string> = {};
  for (const i of ((await s.items(project, {})) as { ok: true; value: { items: Array<{ uid: string; displayId?: string }> } }).value.items) if (i.displayId) uid[i.displayId] = i.uid;
  const arch = async () => ((await s.arch(project, {})) as { ok: true; value: TraceArch }).value;
  const compOf = async (label: string) => (await arch()).nodes.find((n) => n.label === label)!.id;
  const item = async (u: string) => ((await s.item(project, u)) as { ok: true; value: TraceItem }).value;
  const edge = (it: TraceItem, to: string) => it.edges.find((e) => e.to === to && e.rel === 'realizes');
  const tick = (ms = SPEC_SCAN_MIN_MS) => (clock += ms);
  return { repo, home, project, s, uid, arch, compOf, item, edge, tick };
}

describe.skipIf(!GIT_AVAILABLE)('requirement ↔ component', () => {
  it('suggested by label, observed from the module column; nothing stored until the owner decides', async () => {
    const t = await setup();
    const scheduler = await t.compOf('Scheduler');
    const server = await t.compOf('server');
    expect(t.edge(await t.item(t.uid['FR-ARC-001']), scheduler)).toMatchObject({ status: 'suggested', reason: 'label', source: { path: 'docs/requirements/SRS.md', line: 5 } });
    const b = await t.item(t.uid['FR-ARC-002']);
    expect(t.edge(b, server)).toMatchObject({ status: 'observed', reason: 'server/queue.ts', source: { path: 'docs/requirements/SRS.md', line: 6 } });
    expect(b.nodes.find((n) => n.id === server)).toMatchObject({ type: 'comp', label: 'server', source: { path: 'docs/design/arch.md' } });
    expect((await t.item(t.uid['FR-ARC-003'])).edges).toEqual([]);
    expect(fs.existsSync(linksFile(t.home, PROJECT_ID))).toBe(false);
    // The 아키텍처 view counts confirmed and observed ones (a suggestion is not one yet).
    const a = await t.arch();
    expect(a.nodes.find((n) => n.id === server)!.reqs).toEqual({ count: 1, list: [{ uid: t.uid['FR-ARC-002'], label: 'FR-ARC-002', status: 'observed' }] });
    expect(a.nodes.find((n) => n.id === scheduler)!.reqs).toBeUndefined();
    // The neighbourhood includes it.
    const g = await t.s.graph(t.project, { level: 'neighbourhood', center: t.uid['FR-ARC-001'] });
    expect(g.ok && g.value.nodes.map((n) => n.type)).toContain('comp');
  });

  it('confirm, reject (it sticks), add and unlink a realizes link; another project’s component is refused', async () => {
    const t = await setup();
    const scheduler = await t.compOf('Scheduler');
    const worker = await t.compOf('Worker');
    const [a, c] = [t.uid['FR-ARC-001'], t.uid['FR-ARC-003']];
    expect(await t.s.confirmLinks(t.project, { edges: [{ from: a, to: scheduler, rel: 'realizes' }] }, 'phone')).toMatchObject({ ok: true });
    expect(t.edge(await t.item(a), scheduler)).toMatchObject({ status: 'confirmed', reason: 'label', by: { kind: 'owner' } });
    expect(await t.s.rejectLink(t.project, { from: a, to: scheduler, rel: 'realizes' }, 'phone')).toMatchObject({ ok: true });
    t.tick();
    expect(t.edge(await t.item(a), scheduler)).toMatchObject({ status: 'rejected' });
    // A restart reads it back: the suggestion stays rejected.
    const again = new SpecService({ home: t.home, projects: () => [t.project], broadcast: () => undefined, run: t.repo.run, now: () => Date.now() + SPEC_SETTLE_MS * 2, later: () => undefined, idle: () => undefined, tasks: () => [], jobs: () => [] });
    const r = await again.item(t.project, a);
    expect(r.ok && r.value.edges.find((e) => e.to === scheduler)).toMatchObject({ status: 'rejected' });

    const added = await t.s.addLink(t.project, { from: c, to: worker, rel: 'realizes' }, 'phone');
    expect(added).toMatchObject({ ok: true, value: { to: { t: 'comp', uid: worker }, status: 'confirmed' } });
    expect((await t.arch()).nodes.find((n) => n.id === worker)!.reqs).toMatchObject({ count: 1, list: [{ label: 'FR-ARC-003', status: 'confirmed' }] });
    expect((await t.item(c)).history?.map((h) => h.action)).toContain('added');
    expect(await t.s.unlink(t.project, added.ok ? added.value.id : '', 'phone')).toMatchObject({ ok: true });
    expect(t.edge(await t.item(c), worker)).toBeUndefined();
    expect(readLinks(linksFile(t.home, PROJECT_ID)).links.history.map((h) => h.action)).toEqual(['confirmed', 'rejected', 'added', 'unlinked']);

    // The boundary: a UID that is no component of this project, a requirement UID, garbage.
    for (const to of ['c_aaaaaaaaaa', a, 'Worker']) expect(await t.s.addLink(t.project, { from: c, to, rel: 'realizes' }, 'phone')).toEqual({ ok: false, error: 'boundary' });
  });

  it('a component gone from its diagram leaves its confirmed link missing; nothing is deleted', async () => {
    const t = await setup();
    const worker = await t.compOf('Worker');
    const c = t.uid['FR-ARC-003'];
    expect(await t.s.addLink(t.project, { from: c, to: worker, rel: 'realizes' }, 'phone')).toMatchObject({ ok: true });
    await new Promise((r) => setImmediate(r)); // the link write's queue entry goes (a read meanwhile would wait on it, not scan)
    t.repo.write('docs/design/arch.md', DESIGN(false));
    t.tick(SPEC_SCAN_MIN_MS + SPEC_SETTLE_MS * 2);
    const it = await t.item(c);
    expect(t.edge(it, worker)).toMatchObject({ status: 'confirmed' });
    expect(it.nodes.find((n) => n.id === worker)).toMatchObject({ type: 'comp', state: { freshness: 'missing' } });
    expect(it.node.state?.freshness).toBe('missing');
    expect(readLinks(linksFile(t.home, PROJECT_ID)).links.links).toHaveLength(1);
    expect((await t.arch()).nodes.some((n) => n.id === worker)).toBe(false);
  });

  it('a component held in a refused block keeps its confirmed link (not missing) and stays linkable; it keeps its label', async () => {
    const t = await setup();
    const worker = await t.compOf('Worker');
    const c = t.uid['FR-ARC-003'];
    expect(await t.s.addLink(t.project, { from: c, to: worker, rel: 'realizes' }, 'phone')).toMatchObject({ ok: true });
    await new Promise((r) => setImmediate(r));
    t.repo.write('docs/design/arch.md', DESIGN().replace('  Q --> V[server]\n', '  Q --> V[server]\n  Z@{ typo }\n'));
    t.tick(SPEC_SCAN_MIN_MS + SPEC_SETTLE_MS * 2);
    const it = await t.item(c);
    expect(it.nodes.find((n) => n.id === worker)).toEqual(expect.objectContaining({ type: 'comp', label: 'Worker' }));
    expect(it.nodes.find((n) => n.id === worker)?.state).toBeUndefined();
    expect(it.node.state?.freshness).toBe('current');
    expect(await t.s.rejectLink(t.project, { from: t.uid['FR-ARC-001'], to: worker, rel: 'realizes' }, 'phone')).toMatchObject({ ok: true });
  });

  it('a sensitive document sends no module path', async () => {
    const t = await setup();
    const docs = (await t.s.docs(t.project)).docs;
    const srs = docs.find((d) => d.path === 'docs/requirements/SRS.md')!;
    expect(t.s.setDoc(t.project, srs.uid, { sensitive: true })).toMatchObject({ ok: true });
    await t.s.docs(t.project);
    t.tick(SPEC_SCAN_MIN_MS + SPEC_SETTLE_MS * 2);
    // No observed link, so no path as a reason (the row's own title still names labels: suggestions).
    const edges = (await t.item(t.uid['FR-ARC-002'])).edges.filter((e) => e.rel === 'realizes');
    expect(edges.filter((e) => e.status === 'observed')).toEqual([]);
    expect(edges.every((e) => e.reason === 'label')).toBe(true);
  });

  // ── SPT-P4C over 4b: aliases, components added by hand, approved folders ──
  it('a link to a member shows on the root it was merged into; unmerging gives it back (links.json untouched)', async () => {
    const t = await setup();
    const [worker, queue] = [await t.compOf('Worker'), await t.compOf('Queue')];
    const c = t.uid['FR-ARC-003'];
    const added = await t.s.addLink(t.project, { from: c, to: worker, rel: 'realizes' }, 'phone');
    expect(added.ok).toBe(true);
    const before = fs.readFileSync(linksFile(t.home, PROJECT_ID), 'utf-8');
    expect(await t.s.archAlias(t.project, { uid: worker, into: queue }, 'phone')).toMatchObject({ ok: true });
    const merged = await t.item(c);
    expect(t.edge(merged, queue)).toMatchObject({ status: 'confirmed', id: added.ok ? added.value.id : '' });
    expect(t.edge(merged, worker)).toBeUndefined();
    expect((await t.arch()).nodes.find((n) => n.id === queue)!.reqs).toMatchObject({ count: 1, list: [{ label: 'FR-ARC-003' }] });
    // The picker offers the root only.
    const picks = await t.s.picks(t.project, 'component', '');
    expect(picks.ok && picks.value.candidates.map((x) => x.label)).not.toContain('Worker');
    expect(await t.s.archUnalias(t.project, worker, 'phone')).toMatchObject({ ok: true });
    expect(t.edge(await t.item(c), worker)).toMatchObject({ status: 'confirmed' });
    expect(fs.readFileSync(linksFile(t.home, PROJECT_ID), 'utf-8')).toBe(before);
  });

  it('a rejection stored for the member or for the root hides the same computed pair on the root', async () => {
    const t = await setup();
    const [scheduler, queue] = [await t.compOf('Scheduler'), await t.compOf('Queue')];
    const a = t.uid['FR-ARC-001']; // names Scheduler: suggested
    expect(await t.s.rejectLink(t.project, { from: a, to: scheduler, rel: 'realizes' }, 'phone')).toMatchObject({ ok: true });
    expect(await t.s.archAlias(t.project, { uid: scheduler, into: queue }, 'phone')).toMatchObject({ ok: true });
    expect(t.edge(await t.item(a), queue)).toMatchObject({ status: 'rejected' });
    // The other way: the root rejected, the member's label suggests it.
    expect(await t.s.archUnalias(t.project, scheduler, 'phone')).toMatchObject({ ok: true });
    expect(t.edge(await t.item(a), scheduler)).toMatchObject({ status: 'rejected' });
    const unlink = readLinks(linksFile(t.home, PROJECT_ID)).links.links[0].id;
    expect(await t.s.unlink(t.project, unlink, 'phone')).toMatchObject({ ok: true });
    expect(await t.s.rejectLink(t.project, { from: a, to: queue, rel: 'realizes' }, 'phone')).toMatchObject({ ok: true });
    expect(await t.s.archAlias(t.project, { uid: scheduler, into: queue }, 'phone')).toMatchObject({ ok: true });
    expect((await t.item(a)).edges.filter((e) => e.rel === 'realizes').map((e) => [e.to, e.status])).toEqual([[queue, 'rejected']]);
  });

  it('a component added by hand is pickable and linkable; deleted, its link stays and shows missing', async () => {
    const t = await setup();
    const made = await t.s.archAddComp(t.project, { label: 'Cache', kind: 'store' }, 'phone');
    const cache = made.ok ? made.value.uid : '';
    const picks = await t.s.picks(t.project, 'component', 'cach');
    expect(picks.ok && picks.value.candidates.map((x) => x.id)).toEqual([cache]);
    const c = t.uid['FR-ARC-003'];
    expect(await t.s.addLink(t.project, { from: c, to: cache, rel: 'realizes' }, 'phone')).toMatchObject({ ok: true });
    expect((await t.item(c)).nodes.find((n) => n.id === cache)).toMatchObject({ type: 'comp', label: 'Cache' });
    expect(await t.s.archDeleteComp(t.project, cache, 'phone')).toMatchObject({ ok: true });
    const it = await t.item(c);
    expect(t.edge(it, cache)).toMatchObject({ status: 'confirmed' });
    expect(it.nodes.find((n) => n.id === cache)).toMatchObject({ state: { freshness: 'missing' } });
    expect(it.node.state?.freshness).toBe('missing');
    expect(readLinks(linksFile(t.home, PROJECT_ID)).links.links).toHaveLength(1);
  });

  it('module paths belong to approved folders, the longest first, over the label rule; a renamed folder keeps its UID and its links', async () => {
    const t = await setup();
    t.repo.write('docs/requirements/SRS.md', SRS.replace('| server/queue.ts |', '| server/queue.ts, server/engine/run.ts |'));
    t.tick(SPEC_SCAN_MIN_MS + SPEC_SETTLE_MS * 2);
    const top = await t.s.archSkeleton(t.project, { path: 'server/', action: 'approved' }, 'phone');
    const deep = await t.s.archSkeleton(t.project, { path: 'server/engine/', action: 'renamed', label: 'Engine' }, 'phone');
    expect(top.ok && deep.ok).toBe(true);
    const [topUid, deepUid] = [top.ok ? top.value.uid! : '', deep.ok ? deep.value.uid! : ''];
    const b = t.uid['FR-ARC-002'];
    const observed = (await t.item(b)).edges.filter((e) => e.rel === 'realizes' && e.status === 'observed');
    expect(observed.map((e) => [e.to, e.reason]).sort()).toEqual([[topUid, 'server/queue.ts'], [deepUid, 'server/engine/run.ts']].sort());
    expect(await t.s.confirmLinks(t.project, { edges: [{ from: b, to: topUid, rel: 'realizes' }] }, 'phone')).toMatchObject({ ok: true });
    expect(await t.s.archSkeleton(t.project, { path: 'server/', action: 'renamed', label: 'Backend' }, 'phone')).toMatchObject({ ok: true, value: { uid: topUid } });
    const after = await t.item(b);
    expect(t.edge(after, topUid)).toMatchObject({ status: 'confirmed' });
    expect(after.nodes.find((n) => n.id === topUid)).toMatchObject({ label: 'Backend' });
  });

  it('a requirement naming many components gets at most SPEC_LINK_PER_REQ_MAX computed links', async () => {
    const t = await setup();
    const names = Array.from({ length: SPEC_LINK_PER_REQ_MAX + 5 }, (_, i) => `Part${i}`);
    t.repo.write('docs/design/arch.md', `# 설계\n\n\`\`\`mermaid\nflowchart LR\n${names.map((n, i) => `  N${i}[${n}]\n`).join('')}\`\`\`\n`);
    t.repo.write('docs/requirements/SRS.md', SRS.replace('The Scheduler splits the jobs', names.join(' ')));
    t.tick(SPEC_SCAN_MIN_MS + SPEC_SETTLE_MS * 2);
    expect((await t.item(t.uid['FR-ARC-001'])).edges.filter((e) => e.rel === 'realizes')).toHaveLength(SPEC_LINK_PER_REQ_MAX);
  });

  it('the candidates route with type=component lists this project’s components; q matches the label', async () => {
    const t = await setup();
    const server = Fastify();
    registerSpecRoutes(server, t.s, { auth: async () => undefined, kindOf: () => ({ host: false, remote: false }), actorOf: () => 'Test phone', readOnly: false });
    const get = (q: string) => server.inject({ method: 'GET', url: `/api/agty/spec/alpha/candidates?type=component&q=${q}`, headers: { 'x-session': 'ok' } });
    const all = (await get('')).json().candidates as Array<{ id: string; label: string; title?: string }>;
    expect(all.map((c) => c.label).sort()).toEqual(['Queue', 'Scheduler', 'Worker', 'server']);
    expect(all[0]).toMatchObject({ id: expect.stringMatching(/^c_/), title: 'docs/design/arch.md' });
    expect((await get('work')).json().candidates.map((c: { label: string }) => c.label)).toEqual(['Worker']);
    expect((await server.inject({ method: 'GET', url: '/api/agty/spec/alpha/candidates?type=components' })).statusCode).toBe(400);
  });
});

describe('TOKEN-GUARD', () => {
  it('compLinks.ts imports nothing that reaches an LLM or an agent', () => {
    const src = fs.readFileSync(path.join(__dirname, 'compLinks.ts'), 'utf-8');
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports.filter((i) => /messenger|typist|providers|claude|codex|mcp|openai|anthropic|agents\/|chat|groupMessages|engine\.js/i.test(i))).toEqual([]);
  });
});
