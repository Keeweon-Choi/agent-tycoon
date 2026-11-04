/**
 * SPT-P1A/P1B/P1C budget (NFR-PERF-010): spec tracking on a temp copy of this repository's cld/docs,
 * committed once (git's config pinned). Prints the candidate walk, the first enable (records,
 * read and hash of every preselected document, item extraction, UIDs, the match cache), a rescan
 * with nothing changed, a restart's first list (every document read again for its titles), and
 * (1c) a rescan after the requirements folder is renamed, in a folder that is no repository and
 * in a repository with the rename committed, as medians in ms; (1d) the same rounds on a copy that is
 * no repository; the items and alerts, the
 * Registry's and the match cache's size and the heap the service holds.
 *
 *   node --expose-gc --import tsx cld/test/measure-spec-docs.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { cacheFile } from '../../server/src/cld/spec/cache.js';
import { SpecService } from '../../server/src/cld/spec/service.js';
import { registryFile } from '../../server/src/cld/spec/store.js';
import { REPO_ROOT } from '../../server/src/cld/testHome.js';
import { SPEC_SCAN_MIN_MS, SPEC_SETTLE_MS } from '../../server/src/constants.js';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc --import tsx');
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ID = 'p_aaaaaaaaaa';

/** A copy of cld/docs: in a committed repository, or (git false) in a plain folder. */
function copy(git: boolean) {
  const repo = makeTempRepo({ commit: false });
  fs.cpSync(path.join(REPO_ROOT, 'cld/docs'), path.join(repo.folder, 'cld/docs'), { recursive: true });
  if (git) {
    repo.git(['add', '-A']);
    repo.git(['commit', '-q', '-m', 'docs']);
  } else fs.rmSync(path.join(repo.folder, '.git'), { recursive: true, force: true });
  return { repo, project: { name: 'p', folder: repo.folder, projectId: ID } };
}

async function round(git = true) {
  const { repo, project } = copy(git);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-spec-measure-'));
  let clock = Date.now() + SPEC_SETTLE_MS * 2;
  const make = () => new SpecService({ home, projects: () => [project], broadcast: () => undefined, run: repo.run, now: () => clock });
  const s = make();
  let t0 = performance.now();
  const c = await s.candidates(project);
  const walk = performance.now() - t0;
  const picked = c.docs.filter((d) => d.preselect).map((d) => d.path);
  t0 = performance.now();
  await s.enable(project, picked);
  const enable = performance.now() - t0;
  clock += SPEC_SCAN_MIN_MS;
  t0 = performance.now();
  await s.docs(project);
  const rescan = performance.now() - t0;
  const restarted = make();
  t0 = performance.now();
  const listed = await restarted.items(project, { limit: '1' });
  const restart = performance.now() - t0;
  const items = listed.ok ? listed.value.total : -1;
  return { s, home, repo, project, walk, enable, rescan, restart, items, found: c.docs.length, picked: picked.length, tick: () => (clock += SPEC_SCAN_MIN_MS * 2) };
}

type Row = { uid: string; doc: string; line: number };
/** Every item, page by page. */
async function allItems(s: SpecService, project: { name: string; folder: string; projectId: string }): Promise<Row[]> {
  const out: Row[] = [];
  for (let offset = 0; ; offset += 500) {
    const r = await s.items(project, { limit: '500', offset: String(offset), kind: '' });
    if (!r.ok || !r.value.items.length) return out;
    out.push(...r.value.items);
  }
}

/** Rename cld/docs/requirements to cld/docs/reqs (committed with git, a plain move without), rescan; time and what kept its UID. */
async function renameRound(git: boolean) {
  const r = await round(git);
  const before = new Map((await allItems(r.s, r.project)).map((i) => [`${i.doc.replace('/requirements/', '/reqs/')}:${i.line}`, i.uid]));
  const docsBefore = new Set((await r.s.docs(r.project)).docs.map((d) => d.uid));
  if (git) {
    r.repo.git(['mv', 'cld/docs/requirements', 'cld/docs/reqs']);
    r.repo.git(['commit', '-q', '-m', 'rename']);
  } else fs.renameSync(path.join(r.repo.folder, 'cld/docs/requirements'), path.join(r.repo.folder, 'cld/docs/reqs'));
  r.tick();
  const t0 = performance.now();
  const { docs } = await r.s.docs(r.project);
  const ms = performance.now() - t0;
  const after = await allItems(r.s, r.project);
  const moved = docs.filter((d) => d.path.startsWith('cld/docs/reqs/'));
  const res = {
    ms,
    docsKept: moved.filter((d) => docsBefore.has(d.uid)).length,
    docsMoved: moved.length,
    itemsKept: after.filter((i) => before.get(`${i.doc}:${i.line}`) === i.uid).length,
    items: after.length,
    questions: (await r.s.questions(r.project)).questions.length,
  };
  fs.rmSync(r.home, { recursive: true, force: true });
  r.repo.cleanup();
  return res;
}

async function main() {
  await round(); // code compiled, fs and git caches warm
  const rounds: Awaited<ReturnType<typeof round>>[] = [];
  for (let i = 0; i < 5; i++) rounds.push(await round());
  for (const r of rounds) {
    fs.rmSync(r.home, { recursive: true, force: true });
    r.repo.cleanup();
  }
  rounds.length = 0;
  gc!();
  const before = process.memoryUsage().heapUsed;
  const held = await round();
  gc!();
  const holding = process.memoryUsage().heapUsed;
  const times = [held];
  for (let i = 0; i < 4; i++) times.push(await round());
  const reg = fs.statSync(registryFile(held.home, ID)).size;
  const cache = fs.statSync(cacheFile(held.home, ID)).size;
  const sum = (await held.s.summary(held.project)) as { items?: { byKind: object }; alerts?: number; questions?: number; review?: number };
  console.log(`documents found: ${held.found}, tracked (preselected): ${held.picked}, registry ${reg} B, match cache ${cache} B (gzip)`);
  console.log(`items: ${held.items} ${JSON.stringify(sum.items?.byKind)}, alerts: ${sum.alerts}, questions: ${sum.questions}, review: ${sum.review}`);
  const groups = (await held.s.docs(held.project)).alerts.flatMap((a) => (a.type === 'duplicateIds' ? [a] : []));
  const top = groups[0];
  console.log(`duplicate IDs: ${groups.reduce((n, g) => n + g.count, 0)} in ${groups.length} grouped alerts; the biggest: ${top ? `${top.repeater?.path ?? '(no repeater)'} repeats ${top.count} of ${top.docs.map((d) => d.path).join(', ')}` : '-'}`);
  console.log(`candidates walk + git: median ${median(times.map((t) => t.walk)).toFixed(1)} ms`);
  console.log(`first enable (records, read + hash, git status, cache): median ${median(times.map((t) => t.enable)).toFixed(1)} ms`);
  console.log(`rescan, nothing changed: median ${median(times.map((t) => t.rescan)).toFixed(1)} ms`);
  console.log(`restart, first list (read, extract, map by place): median ${median(times.map((t) => t.restart)).toFixed(1)} ms`);
  console.log(`heap held by one service with tracking on: +${((holding - before) / 1024).toFixed(0)} kB; rss ${(process.memoryUsage().rss / 1048576).toFixed(0)} MB`);
  for (const t of times) {
    fs.rmSync(t.home, { recursive: true, force: true });
    t.repo.cleanup();
  }
  // SPT-P1D: the same on a copy that is no repository (no git status, no evidence: hashes only).
  const plain = [];
  for (let i = 0; i < 5; i++) plain.push(await round(false));
  const preg = fs.statSync(registryFile(plain[0].home, ID)).size;
  const pcache = fs.statSync(cacheFile(plain[0].home, ID)).size;
  console.log(
    `no repository: ${plain[0].items} items; first enable median ${median(plain.map((t) => t.enable)).toFixed(1)} ms, rescan ${median(plain.map((t) => t.rescan)).toFixed(1)} ms, restart first list ${median(plain.map((t) => t.restart)).toFixed(1)} ms; registry ${preg} B, match cache ${pcache} B`,
  );
  for (const t of plain) {
    fs.rmSync(t.home, { recursive: true, force: true });
    t.repo.cleanup();
  }
  for (const git of [false, true]) {
    const rs = [];
    for (let i = 0; i < 3; i++) rs.push(await renameRound(git));
    const last = rs.at(-1)!;
    console.log(
      `requirements folder renamed ${git ? 'and committed (git: D1)' : 'in a folder that is no repository (content: D2/D3)'}: rescan median ${median(rs.map((r) => r.ms)).toFixed(1)} ms; documents ${last.docsKept}/${last.docsMoved} kept, items ${last.itemsKept}/${last.items} kept, questions ${last.questions}`,
    );
  }
}

void main();
