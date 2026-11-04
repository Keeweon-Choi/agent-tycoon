/**
 * SPT-P4A budget: the architecture read on a temp copy of this repository's cld/docs, tracking on
 * with the preselected documents plus every document holding a Mermaid block. Prints readArch over
 * every cld/docs file (the parse alone), the enable's scan, the first architecture query (built from
 * the scan's reads), a held read, a rebuild after the idle drop, and the result's size.
 *
 *   npx tsx cld/test/measure-spec-arch.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { readArch } from '../../server/src/cld/spec/arch.js';
import { SpecService } from '../../server/src/cld/spec/service.js';
import { REPO_ROOT } from '../../server/src/cld/testHome.js';
import { SPEC_SETTLE_MS, SPEC_TRACE_IDLE_MS } from '../../server/src/constants.js';

const RUNS = 21;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function time(f: () => Promise<unknown> | unknown, n = RUNS): Promise<number> {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await f();
    xs.push(performance.now() - t0);
  }
  return median(xs);
}
const md = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? md(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []));

async function main() {
  const files = md(path.join(REPO_ROOT, 'cld/docs'));
  const texts = files.map((f) => fs.readFileSync(f, 'utf-8'));
  const parse = await time(() => texts.forEach((t) => readArch(t)));
  const repo = makeTempRepo({ commit: false });
  fs.cpSync(path.join(REPO_ROOT, 'cld/docs'), path.join(repo.folder, 'cld/docs'), { recursive: true });
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs']);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-arch-measure-'));
  const project = { name: 'p', folder: repo.folder, projectId: 'p_aaaaaaaaaa' };
  let clock = Date.now() + SPEC_SETTLE_MS * 2;
  const idle: Array<() => void> = [];
  const s = new SpecService({ home, projects: () => [project], broadcast: () => undefined, run: repo.run, now: () => clock, idle: (fn) => idle.push(fn) });
  const c = await s.candidates(project);
  const withMermaid = files.filter((_, i) => texts[i].includes('```mermaid')).map((f) => path.relative(REPO_ROOT, f));
  const picked = [...new Set([...c.docs.filter((d) => d.preselect).map((d) => d.path), ...withMermaid])];
  let t0 = performance.now();
  await s.enable(project, picked);
  const enable = performance.now() - t0;
  t0 = performance.now();
  const first = await s.arch(project, {});
  const firstMs = performance.now() - t0;
  if (!first.ok) throw new Error(first.error);
  const held = await time(() => s.arch(project, { layer: 'interaction' }));
  const rebuild = await time(async () => {
    clock += SPEC_TRACE_IDLE_MS + 1;
    for (const fn of idle.splice(0)) fn();
    await s.arch(project, {});
  }, 5);
  const a = first.value;
  console.log(`readArch over ${files.length} cld/docs files (${(texts.join('').length / 1024).toFixed(0)} KB): median ${parse.toFixed(1)} ms`);
  console.log(`enable (${picked.length} documents, the scan reading them all): ${enable.toFixed(0)} ms`);
  console.log(`first architecture query: ${firstMs.toFixed(2)} ms; held: median ${held.toFixed(3)} ms; rebuilt after the idle drop: median ${rebuild.toFixed(2)} ms (builds ${s.archBuilds})`);
  console.log(`result: ${a.counts.fromDocs} components, ${a.groups.length} groups, ${a.edges.length} composition edges, ${a.unsupported.length} unsupported; ${JSON.stringify(a).length} bytes`);
  fs.rmSync(home, { recursive: true, force: true });
  repo.cleanup();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
