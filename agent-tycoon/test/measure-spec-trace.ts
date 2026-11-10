/**
 * SPT-P2 budget: the trace on a temp copy of this repository's agent-tycoon/docs (git's config pinned),
 * tracking on with the preselected documents, plus synthetic sources: TASKS Tasks and JOBS jobs
 * whose titles name display IDs, and COMMITS commits whose messages do (1-3 IDs each, a few IDs
 * named far more often, as real work does; every 7th also names a Task). Prints the first index
 * build (with the one git log), a rebuild with the same HEAD, the neighbourhood of the most linked
 * requirement at depth 1 and 2 (index held), the item detail, and the heap the index holds.
 *
 *   node --expose-gc --import tsx agent-tycoon/test/measure-spec-trace.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
import { SpecService } from '../../server/src/agent-tycoon/spec/service.js';
import type { TraceJob, TraceTask } from '../../server/src/agent-tycoon/spec/trace.js';
import { REPO_ROOT } from '../../server/src/agent-tycoon/testHome.js';
import { SPEC_SCAN_MIN_MS, SPEC_SETTLE_MS, SPEC_TRACE_IDLE_MS } from '../../server/src/constants.js';

const TASKS = 1_000;
const JOBS = 100;
const COMMITS = 500;
const RUNS = 21;
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc --import tsx');
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function time(f: () => Promise<unknown>, n = RUNS): Promise<number> {
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await f();
    xs.push(performance.now() - t0);
  }
  return median(xs);
}
let seed = 7;
const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
/** Zipf-ish: a few IDs named far more often. */
const pick = (ids: string[]) => ids[Math.floor(ids.length * (rand(1000) / 1000) ** 3)];
const kb = (b: number) => `${(b / 1024).toFixed(0)} kB`;

async function main() {
  const repo = makeTempRepo({ commit: false });
  fs.cpSync(path.join(REPO_ROOT, 'agent-tycoon/docs'), path.join(repo.folder, 'agent-tycoon/docs'), { recursive: true });
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'docs']);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-trace-measure-'));
  const project = { name: 'p', folder: repo.folder, projectId: 'p_aaaaaaaaaa' };
  let clock = Date.now() + SPEC_SETTLE_MS * 2;
  const tasks: Array<TraceTask & { project: string }> = [];
  const jobs: Array<TraceJob & { project: string }> = [];
  const idle: Array<() => void> = [];
  const s = new SpecService({ home, projects: () => [project], broadcast: () => undefined, run: repo.run, now: () => clock, idle: (fn) => idle.push(fn), tasks: () => tasks, jobs: () => jobs });
  const c = await s.candidates(project);
  await s.enable(project, c.docs.filter((d) => d.preselect).map((d) => d.path));
  const byId = new Map<string, string>();
  for (let offset = 0; ; offset += 500) {
    const r = await s.items(project, { limit: '500', offset: String(offset) });
    if (!r.ok || !r.value.items.length) break;
    for (const i of r.value.items) if (i.displayId && !byId.has(i.displayId)) byId.set(i.displayId, i.uid);
  }
  const ids = [...byId.keys()];
  for (let i = 0; i < TASKS; i++) tasks.push({ id: `T-${9000 + i}`, title: `${pick(ids)} synthetic work ${i}`, status: ['todo', 'doing', 'done'][i % 3], project: 'p' });
  for (let i = 0; i < JOBS; i++) jobs.push({ id: `1103-${String(i).padStart(6, '0')}-j`, desc: `check ${pick(ids)}`, cmd: 'npm test', started: '2026-11-03T00:00:00Z', ended: '2026-11-03T00:01:00Z', exit: 0, project: 'p' });
  for (let i = 0; i < COMMITS; i++) {
    const msg = `${Array.from({ length: 1 + rand(3) }, () => pick(ids)).join(' ')}: synthetic change ${i}${i % 7 ? '' : ` (T-${9000 + rand(TASKS)})`}`;
    repo.git(['commit', '-q', '--allow-empty', '-m', msg]);
  }
  clock += SPEC_SCAN_MIN_MS; // the scan sees the new HEAD
  await s.docs(project);

  gc!();
  const before = process.memoryUsage().heapUsed;
  let t0 = performance.now();
  const ov = await s.graph(project, { level: 'overview' });
  const first = performance.now() - t0;
  if (!ov.ok) throw new Error(ov.error);
  gc!();
  const holding = process.memoryUsage().heapUsed;
  const rebuild = await time(async () => {
    clock += SPEC_SCAN_MIN_MS;
    await s.graph(project, { level: 'overview' });
  }, 5);
  // The most linked requirement: the one the most sources name.
  const sum = await s.summary(project);
  let best = { uid: '', n: -1 };
  for (const id of ids.slice(0, 50)) {
    const it = await s.item(project, byId.get(id)!);
    if (it.ok && it.value.edges.length > best.n) best = { uid: byId.get(id)!, n: it.value.edges.length };
  }
  const q = (depth: string) => s.graph(project, { level: 'neighbourhood', center: best.uid, depth });
  const d1 = await q('1');
  const d2 = await q('2');
  const t1 = await time(() => q('1'));
  const t2 = await time(() => q('2'));
  const td = await time(() => s.item(project, best.uid));
  t0 = performance.now();
  await s.items(project, { limit: '500' });
  const list = performance.now() - t0;
  clock += SPEC_TRACE_IDLE_MS;
  for (const fn of idle.splice(0)) fn();
  gc!();
  const dropped = process.memoryUsage().heapUsed;
  const n = (g: typeof d1) => (g.ok ? `${g.value.nodes.length} nodes, ${g.value.edges.length} edges, folded ${JSON.stringify(g.value.folded ?? {})}, hidden ${g.value.hidden ?? 0}` : g.error);
  console.log(`agent-tycoon/docs: ${byId.size} display IDs; synthetic: ${TASKS} Tasks, ${JOBS} jobs, ${COMMITS} commits; summary ${JSON.stringify({ unlinked: (sum as { unlinked?: number }).unlinked })}`);
  console.log(`first index build (one git log of ${COMMITS} commits): ${first.toFixed(1)} ms; rebuild, same HEAD: median ${rebuild.toFixed(1)} ms`);
  console.log(`most linked requirement: ${best.n} links`);
  console.log(`neighbourhood depth 1: median ${t1.toFixed(2)} ms (${n(d1)})`);
  console.log(`neighbourhood depth 2: median ${t2.toFixed(2)} ms (${n(d2)})`);
  console.log(`item detail: median ${td.toFixed(2)} ms; items list (500 rows with states): ${list.toFixed(1)} ms`);
  console.log(`heap held by the index: +${kb(holding - before)}; after the idle drop: ${kb(dropped - before)} over the start; rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB; index held: ${s.traceHeld(project)}`);
  fs.rmSync(home, { recursive: true, force: true });
  repo.cleanup();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
