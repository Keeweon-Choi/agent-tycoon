/**
 * U-48 phase 2a budget: one DocTracker refresh over the largest project the limits allow
 * (DOCS_MAX documents of ITEMS_MAX entries each: checkboxes under headings and a status
 * table with ids, under 256 KB each), in a temp folder of invented files. Prints the cold
 * refresh (every file read and parsed), the warm one (mtime cache) as medians in ms, and
 * the heap/RSS the index holds.
 *
 *   node --expose-gc --import tsx cld/test/measure-tracking-docs.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { ITEMS_MAX } from '../../server/src/cld/tracking/docs.js';
import { DOCS_MAX, DocTracker } from '../../server/src/cld/tracking/docTracker.js';
import { NO_SETTINGS } from '../../server/src/cld/tracking/settings.js';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-measure-docs-'));
fs.mkdirSync(path.join(folder, 'tasks'));
let bytes = 0;
for (let n = 0; n < DOCS_MAX; n++) {
  const lines: string[] = [`# Plan ${n}`];
  const half = ITEMS_MAX / 2;
  for (let h = 0; h < half / 25; h++) {
    lines.push(`## Section ${h}`);
    for (let i = 0; i < 24; i++) lines.push(`- [${i % 3 ? ' ' : 'x'}] step ${h}.${i} of plan ${n} with some words to be a realistic title`);
  }
  lines.push('', '| ID | What | 상태 |', '|---|---|---|');
  for (let i = 0; i < half; i++) lines.push(`| AB-${n * 1000 + i} | row ${i} of plan ${n}, see AB-${i} | ${['완료', '진행 중', '예정', '배포됨(10-24)'][i % 4]} |`);
  const text = lines.join('\n');
  bytes += text.length;
  fs.writeFileSync(path.join(folder, 'tasks', `plan-${String(n).padStart(2, '0')}.md`), text);
}
const projects = [{ name: 'p', folder, settings: NO_SETTINGS }];
const taskIds = new Set(Array.from({ length: 200 }, (_, i) => `AB-${i}`));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with node --expose-gc --import tsx (tsx alone starts a child without gc)');
const fill = (t: DocTracker, budget?: number) => {
  const times: number[] = [];
  do {
    const t0 = performance.now();
    t.refresh(projects, taskIds, Date.now(), budget);
    times.push(performance.now() - t0);
  } while (t.pending);
  return times;
};
fill(new DocTracker(), Infinity); // code compiled, fs caches warm
gc();
const before = process.memoryUsage();
const rounds: number[] = [];
const perRefresh: number[] = [];
const unbudgeted: number[] = [];
for (let r = 0; r < 5; r++) unbudgeted.push(fill(new DocTracker(), Infinity)[0]);
let t: DocTracker | null = null;
for (let r = 0; r < 5; r++) {
  t = new DocTracker();
  const times = fill(t);
  rounds.push(times.length);
  perRefresh.push(...times);
}
const warm: number[] = [];
let sent = 0;
for (let r = 0; r < 30; r++) {
  const t0 = performance.now();
  sent = t!.refresh(projects, taskIds, Date.now()).get('p')?.items.length ?? 0;
  warm.push(performance.now() - t0);
}
gc();
const held = process.memoryUsage();
t = null;
gc();
const after = process.memoryUsage();
console.log(`documents: ${DOCS_MAX} x ${ITEMS_MAX} entries (${(bytes / 1024).toFixed(0)} kB of Markdown); items sent: ${sent}`);
console.log(`cold, no budget (all 50 read in one refresh): median ${median(unbudgeted).toFixed(1)} ms`);
console.log(`cold, budgeted: ${median(rounds)} refreshes to read everything; per refresh median ${median(perRefresh).toFixed(1)} ms, max ${Math.max(...perRefresh).toFixed(1)} ms`);
console.log(`warm (mtime cache): median ${median(warm).toFixed(1)} ms, max ${Math.max(...warm).toFixed(1)} ms`);
console.log(`index held: heapUsed +${((held.heapUsed - after.heapUsed) / 1024).toFixed(0)} kB; rss before ${(before.rss / 1048576).toFixed(0)} MB, holding ${(held.rss / 1048576).toFixed(0)} MB`);
fs.rmSync(folder, { recursive: true, force: true });
