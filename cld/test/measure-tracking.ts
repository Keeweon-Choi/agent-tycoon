/**
 * U-48 phase 1 budget: one Tracker refresh over the largest tree the limits allow
 * (SESSIONS_MAX sessions x 25 list files, CODEX_MAX worktrees with a checklist), in a
 * temp HOME of invented files. Prints the cold refresh (every file read), the warm one
 * (mtime cache, nothing re-read) as medians in ms, and the heap/RSS the index holds.
 *
 *   node --expose-gc node_modules/.bin/tsx cld/test/measure-tracking.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { CODEX_MAX, SESSIONS_MAX, Tracker, type TrackSession } from '../../server/src/cld/tracking/tracker.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-measure-'));
const sessions: TrackSession[] = [];
for (let n = 0; n < SESSIONS_MAX; n++) {
  const sid = `m${String(n).padStart(7, '0')}-aaaa`;
  sessions.push({ sessionId: sid, name: `agent ${n}`, project: `p${n % 4}`, live: true, busy: n % 2 === 0 });
  const dir = path.join(home, '.claude/tasks', sid);
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= 25; i++)
    fs.writeFileSync(
      path.join(dir, `${i}.json`),
      JSON.stringify({ id: String(i), subject: `item ${i} of ${n} with some words to be a realistic title`, description: 'x'.repeat(300), status: i % 3 ? 'pending' : 'completed', blocks: [], blockedBy: i > 1 ? [String(i - 1)] : [] }),
    );
}
const codex = Array.from({ length: CODEX_MAX }, (_, n) => {
  const dir = path.join(home, `wt${n}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'CODEX_PROGRESS.md'), Array.from({ length: 12 }, (_, i) => `- [${i < 6 ? 'x' : ' '}] step ${i} of task ${n}`).join('\n'));
  return { id: `c${n}`, project: 'p0', state: 'running', dir, ended: null };
});
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const gc = (globalThis as { gc?: () => void }).gc;
new Tracker(home).refresh({ sessions, codex, now: Date.now() }); // code compiled, fs caches warm
gc?.();
const before = process.memoryUsage();
const cold: number[] = [];
const warm: number[] = [];
let t: Tracker | null = null;
for (let r = 0; r < 15; r++) {
  t = null;
  t = new Tracker(home);
  const t0 = performance.now();
  t.refresh({ sessions, codex, now: Date.now() });
  cold.push(performance.now() - t0);
}
for (let r = 0; r < 30; r++) {
  const t0 = performance.now();
  t!.refresh({ sessions, codex, now: Date.now() });
  warm.push(performance.now() - t0);
}
gc?.();
const after = process.memoryUsage();
console.log(`files: ${SESSIONS_MAX * 25} list files + ${CODEX_MAX} checklists`);
console.log(`refresh cold (every file read): median ${median(cold).toFixed(1)} ms, max ${Math.max(...cold).toFixed(1)} ms`);
console.log(`refresh warm (mtime cache):     median ${median(warm).toFixed(1)} ms, max ${Math.max(...warm).toFixed(1)} ms`);
console.log(`heapUsed +${((after.heapUsed - before.heapUsed) / 1024).toFixed(0)} kB, rss +${((after.rss - before.rss) / 1024).toFixed(0)} kB (one index held)`);
fs.rmSync(home, { recursive: true, force: true });
