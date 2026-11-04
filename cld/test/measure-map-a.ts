/**
 * MAP-A: what the existing code reads from this repository. A temp git copy of cld/docs plus the
 * repository's top folders and one level below (one empty file each); spec tracking on with the
 * preselected documents plus every document holding a Mermaid block. Prints the architecture (nodes
 * by origin and standing, groups, edges by layer), the requirements and their component links by
 * status, the folder proposals, and the Mermaid blocks with and without subgraphs.
 *
 *   npx tsx cld/test/measure-map-a.ts
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { buildMapModel, mapView } from '../../server/src/cld/spec/map.js';
import { SpecService } from '../../server/src/cld/spec/service.js';
import type { TraceIndex } from '../../server/src/cld/spec/trace.js';
import { REPO_ROOT } from '../../server/src/cld/testHome.js';
import { SPEC_SETTLE_MS } from '../../server/src/constants.js';

const md = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? md(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []));
const tally = (xs: string[]) => Object.fromEntries([...new Set(xs)].sort().map((k) => [k, xs.filter((x) => x === k).length]));

async function main() {
  const files = md(path.join(REPO_ROOT, 'cld/docs'));
  const texts = files.map((f) => fs.readFileSync(f, 'utf-8'));
  const repo = makeTempRepo({ commit: false });
  fs.cpSync(path.join(REPO_ROOT, 'cld/docs'), path.join(repo.folder, 'cld/docs'), { recursive: true });
  // The repository's folders (top and one below, as git has them), one empty file each.
  const tree = (args: string[]) => execFileSync('git', ['ls-tree', '-d', '--name-only', 'HEAD', ...args], { cwd: REPO_ROOT, encoding: 'utf-8' }).split('\n').filter(Boolean);
  const tops = tree([]);
  const subs = tree(['--', ...tops.map((t) => `${t}/`)]);
  for (const d of [...tops, ...subs]) {
    fs.mkdirSync(path.join(repo.folder, d), { recursive: true });
    if (!fs.existsSync(path.join(repo.folder, d, 'keep.txt'))) fs.writeFileSync(path.join(repo.folder, d, 'keep.txt'), '');
  }
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs and folders']);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-map-measure-'));
  const project = { name: 'p', folder: repo.folder, projectId: 'p_aaaaaaaaaa' };
  const s = new SpecService({ home, projects: () => [project], broadcast: () => undefined, run: repo.run, now: () => Date.now() + SPEC_SETTLE_MS * 2, idle: () => undefined });
  const c = await s.candidates(project);
  const withMermaid = files.filter((_, i) => texts[i].includes('```mermaid')).map((f) => path.relative(REPO_ROOT, f));
  const picked = [...new Set([...c.docs.filter((d) => d.preselect).map((d) => d.path), ...withMermaid])];
  await s.enable(project, picked);
  const r = await s.arch(project, {});
  const ri = await s.arch(project, { layer: 'interaction' });
  if (!r.ok || !ri.ok) throw new Error('arch');
  const a = r.value;
  const all: Array<{ uid: string; state: string }> = [];
  for (let offset = 0; ; offset += 100) {
    const page = await s.items(project, { limit: '100', offset: String(offset) });
    if (!page.ok) throw new Error('items');
    all.push(...page.value.items);
    if (all.length >= page.value.total || !page.value.items.length) break;
  }
  const reqs = all.filter((i) => i.state !== 'retired');
  const links: string[] = [];
  const compLinks: string[] = [];
  for (const i of reqs) {
    const d = await s.item(project, i.uid);
    if (!d.ok) continue;
    for (const e of d.value.edges) {
      links.push(`${e.rel}:${e.status}`);
      if (e.rel === 'realizes') compLinks.push(e.status);
    }
  }
  const blocks = texts.flatMap((t) => [...t.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]));
  const firstLine = (b: string) => b.trim().split('\n')[0].trim().split(/\s/)[0];
  console.log(`cld/docs: ${files.length} Markdown files, ${blocks.length} Mermaid blocks ${JSON.stringify(tally(blocks.map(firstLine)))}; with a subgraph: ${blocks.filter((b) => /^\s*subgraph\b/m.test(b)).length}`);
  console.log(`tracked: ${picked.length} documents; folders made: ${tops.length} top + ${subs.length} below`);
  console.log(`arch nodes: ${a.nodes.length} by origin ${JSON.stringify(tally(a.nodes.map((n) => n.from)))} by standing ${JSON.stringify(tally(a.nodes.map((n) => n.standing)))}; counts ${JSON.stringify(a.counts)}; hidden ${a.hidden ?? 0}`);
  console.log(`groups (subgraphs): ${a.groups.length}; nodes in a group: ${a.nodes.filter((n) => n.group).length}; nested groups: ${a.groups.filter((g) => g.parent).length}`);
  console.log(`edges: composition ${a.edges.length}; with interaction ${ri.value.edges.length}; labelled composition ${a.edges.filter((e) => e.label).length}`);
  const deg = new Map<string, number>();
  for (const e of a.edges) for (const x of [e.from, e.to]) deg.set(x, (deg.get(x) ?? 0) + 1);
  const docNodes = a.nodes.filter((n) => n.from === 'doc');
  console.log(`doc components with no composition edge: ${docNodes.filter((n) => !deg.has(n.id)).length} of ${docNodes.length}; diagrams ${a.diagrams.length} ${JSON.stringify(tally(a.diagrams.map((d) => d.type)))}; unsupported ${a.unsupported.length}`);
  console.log(`per diagram nodes: ${JSON.stringify(tally(docNodes.map((n) => n.diagram ?? '')).constructor === Object ? Object.values(tally(docNodes.map((n) => n.diagram ?? ''))).sort((x, y) => y - x) : [])}`);
  console.log(`requirements: ${reqs.length}; links ${JSON.stringify(tally(links))}`);
  console.log(`requirement → component: ${JSON.stringify(tally(compLinks))}; components with any confirmed/observed requirement: ${a.nodes.filter((n) => n.reqs).length}`);
  console.log(`folder proposals: ${a.nodes.filter((n) => n.standing === 'proposed').length}`);
  // The 지도 on this repository through the service: the first build (index included) and a held read.
  let t0 = performance.now();
  await s.map(project, {});
  const first = performance.now() - t0;
  t0 = performance.now();
  for (let i = 0; i < 100; i++) await s.map(project, {});
  console.log(`map query (this repository): first ${first.toFixed(1)} ms, held ${((performance.now() - t0) / 100).toFixed(2)} ms`);
  // 150 synthetic modules: 10 subgraphs of 10, 50 loose, 200 edges, 1000 requirements each linked to 3 modules.
  type ArchIn = Parameters<typeof buildMapModel>[0];
  const nodes: ArchIn['nodes'] = Array.from({ length: 150 }, (_, i) => ({ id: `c_${String(i).padStart(10, 'a')}`, label: `M${i}`, kind: 'component', from: 'doc', standing: 'doc', sources: [{ path: 'd.md', line: i }], ...(i < 100 && { group: `g:d_x:0:${Math.floor(i / 10)}` }) }));
  const groups = Array.from({ length: 10 }, (_, g) => ({ id: `g:d_x:0:${g}`, label: `G${g}`, source: { path: 'd.md', line: g } }));
  const edges: ArchIn['edges'] = Array.from({ length: 200 }, (_, i) => ({ id: `e${i}`, from: nodes[i % 150].id, to: nodes[(i * 7 + 3) % 150].id, layer: 'composition', label: 'x' }));
  const synth = Array.from({ length: 1000 }, (_, i) => `r_${i}`);
  const tes = synth.flatMap((u, i) => [0, 1, 2].map((k) => ({ id: `${u}${k}`, from: u, to: nodes[(i * 3 + k) % 150].id, rel: 'realizes' as const, status: (['confirmed', 'observed', 'suggested'] as const)[k] })));
  const adj = new Map<string, number[]>();
  tes.forEach((e, i) => [e.from, e.to].forEach((n) => adj.set(n, [...(adj.get(n) ?? []), i])));
  const ix = { nodes: new Map(synth.map((u) => [u, { id: u, type: 'req' as const, label: u }])), edges: tes, adj, states: new Map(), reqs: synth, groupOf: new Map(), groups: new Map(), history: new Map(), unlinked: 0, deployed: new Set<string>() } as TraceIndex;
  const arch = { layer: 'composition' as const, nodes, groups, edges, unsupported: [], counts: { approved: 0, proposed: 0, fromDocs: 150 }, diagrams: [] };
  const runs: number[] = [];
  let model = buildMapModel(arch, [], ix);
  for (let i = 0; i < 21; i++) {
    t0 = performance.now();
    model = buildMapModel(arch, [], ix);
    runs.push(performance.now() - t0);
  }
  t0 = performance.now();
  for (let i = 0; i < 100; i++) mapView(model, groups[i % 10].id);
  console.log(`150 synthetic modules, 200 edges, 1000 requirements × 3 links: build median ${[...runs].sort((x, y) => x - y)[10].toFixed(2)} ms, one view ${((performance.now() - t0) / 100).toFixed(3)} ms, root view ${JSON.stringify(mapView(model, 'root')).length} bytes`);
  fs.rmSync(home, { recursive: true, force: true });
  repo.cleanup();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
