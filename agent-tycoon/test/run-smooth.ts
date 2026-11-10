/**
 * SMOOTH-1104 (owner 11-04 17:29 "쓰면서 렉이 안 걸리고 부드럽게"): how smooth the office is while it is used.
 * dist/cli.js in a temp HOME (the engine fake as `claude-pty`, never a real agent), headless Chromium
 * (--disable-gpu, CPU drawing), the owner's window 1282x832, the isometric view.
 * The scene: 6 Leads + 12 test characters (half typing at a desk, half walking), the 메신저 open on
 * alpha while long replies keep typing in, the other Leads' states change every 2 s (the party
 * frame), 3 running jobs whose tqdm logs climb; meanwhile the pointer drags the messenger, zooms the
 * office with the wheel, pans it with the middle button and clicks a contact.
 * Per round (MEASURE_MS, default 30 s) at each CPU slowdown (RATES, default "4,1", CDP
 * Emulation.setCPUThrottlingRate), ROUNDS times (default 2):
 *   rAF interval p50/p95/p99, frames over 50 ms, long tasks (count, sum), input -> next frame
 *   latency (pointerdown/move/up, wheel: p50/p95/max), WebSocket messages in (count, bytes, top
 *   types), JS heap.
 * PROFILE=1 adds a 10 s CPU profile at the first rate (top self time, written next to the results);
 * REACT=1 counts React commits and the components rendered (names need an unminified build:
 * `cd webview-ui && npx vite build --minify false`).
 * TRACE=1 adds 6 s of the timeline (main-thread and compositor time by event). CLI=<path> runs
 * another build's dist/cli.js (a baseline worktree's, for before/after).
 * Output: agent-tycoon/artifacts/smooth-1104/<LABEL>.json (+ <LABEL>.png, <LABEL>-end.png, -profile/-trace).
 * BOOT=1 (BOOT-LOAD 11-04): the same office opened fresh with the lobby at launch, per case of
 * BOOT_CASES (default "desk:4:iso,desk:1:iso,phone:4:iso,phone:1:iso,desk:4:top": viewport, CPU
 * slowdown, view), a new browser context each (a cold cache, a new session): the time until the
 * lobby's 사무실 입장 shows (the first view usable), what the page says is still pending at that
 * moment (queued sprite builds against their peak, sheets, iso drawn: the loading screen's claim; twice each, BOOT_REPEAT),
 * then 사무실 입장 and 10 s of wheel and pan: long tasks and frames over 50 ms; the renderer + GPU
 * processes' RSS (peak from navigation to the end, idle after 10 s untouched), the JS heap and the
 * picture budget's use (at the claim and when idle).
 * SHOTS=1 adds a picture mid-load and of the lobby after it per viewport (at 10x, so the bar is caught on its way) (<LABEL>-<view>-loading.png,
 * -lobby.png). Output: <LABEL>-boot.json.
 *
 *   taskset -c 0-3 npx tsx agent-tycoon/test/run-smooth.ts <port 18500-18559> [LABEL]
 */
import type { Browser, CDPSession, Page } from '@playwright/test';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { transcriptPath } from '../../server/src/agent-tycoon/providers/claudeProvider.js';
import {
  assertPortFree,
  type Daemon,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (!((port >= 18500 && port <= 18559) || (port >= 18450 && port <= 18459))) throw new Error('port 18500-18559 or 18450-18459');
const LABEL = process.argv[3] ?? 'run';
const OUT = path.join(REPO_ROOT, process.env.OUT_DIR ?? 'agent-tycoon/artifacts/smooth-1104');
const MEASURE_MS = Number(process.env.MEASURE_MS ?? 30_000);
const ROUNDS = Number(process.env.ROUNDS ?? 2);
const RATES = (process.env.RATES ?? '4,1').split(',').map(Number);
const BOOT_CASES = (process.env.BOOT_CASES ?? 'desk:4:iso,desk:1:iso,phone:4:iso,phone:1:iso,desk:4:top').split(',');
const DEADLINE_MS =
  process.env.BOOT === '1'
    ? 180_000 + (BOOT_CASES.length * Number(process.env.BOOT_REPEAT ?? 2) + 2) * 120_000
    : 120_000 + RATES.length * ROUNDS * (MEASURE_MS + 20_000) + 60_000;
const LEADS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
const EXTRA = 12;
const MODEL = 'claude-sonnet-4-5';
const VIEW = { viewport: { width: 1282, height: 832 }, deviceScaleFactor: 1 };
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const BOOT_AFTER_MS = 10_000;
const BOOT_PENDING_SHARE = 0.1;
const BOOT_REPEAT = Number(process.env.BOOT_REPEAT ?? 2);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => unknown, ms = 60_000): Promise<void> {
  for (const end = Date.now() + ms; !(await ok()); await wait(200)) if (Date.now() > end) throw new Error(`timed out: ${what}`);
}
type Rec = Record<string, unknown>;
const stamp = (r: Rec): Rec => ({ uuid: `u-${Math.random().toString(16).slice(2, 10)}`, timestamp: new Date().toISOString(), ...r });
const pct = (a: number[], p: number) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(1);
};

// Page side: rAF, long tasks, input -> next frame, WebSocket messages in; REACT=1 a devtools hook.
const INIT = `
  globalThis.__name = (fn) => fn;
  window.__AGENT_TYCOON_E2E = true;
  const M = (window.__smooth = { rec: false, raf: [], long: [], input: {}, ws: {}, wsBytes: 0, commits: 0, renders: {} });
  new PerformanceObserver((l) => { if (M.rec) for (const e of l.getEntries()) M.long.push(e.duration); }).observe({ type: 'longtask', buffered: false });
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'wheel'])
    window.addEventListener(type, (e) => {
      if (!M.rec) return;
      const t0 = e.timeStamp;
      requestAnimationFrame(() => (M.input[type] ??= []).push(performance.now() - t0));
    }, { capture: true, passive: true });
  const WS = window.WebSocket;
  window.WebSocket = class extends WS {
    constructor(...a) {
      super(...a);
      this.addEventListener('message', (ev) => {
        if (!M.rec || typeof ev.data !== 'string') return;
        const m = /"type":"([^"]+)"/.exec(ev.data.slice(0, 200));
        const k = m ? m[1] : '?';
        const s = (M.ws[k] ??= [0, 0]);
        s[0]++; s[1] += ev.data.length; M.wsBytes += ev.data.length;
      });
    }
  };
  if (${process.env.REACT === '1'}) {
    let last = new Set();
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true, renderers: new Map(), inject() { return 1; },
      onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {},
      onCommitFiberRoot(_id, root) {
        if (!M.rec) return;
        M.commits++;
        const seen = new Set();
        const stack = [root.current];
        while (stack.length) {
          const f = stack.pop();
          seen.add(f);
          const t = f.type;
          const fn = typeof t === 'function' ? t : t && (t.type || t.render);
          if (fn && (f.flags & 1) && !last.has(f)) {
            const n = fn.displayName || fn.name || '?';
            M.renders[n] = (M.renders[n] || 0) + 1;
          }
          if (f.sibling) stack.push(f.sibling);
          if (f.child) stack.push(f.child);
        }
        last = seen;
      },
    };
  }
`;


// BOOT=1, page side: the loading screen's bar as it moves, the moment the lobby's button shows and
// what the page has still pending then, long tasks and rAF after 사무실 입장.
const BOOT_INIT = `
  const B = (window.__boot = { pcts: [], firstBoot: null, usable: null, facts: null, rec: false, raf: [], long: [], peakPending: 0 });
  const peek = setInterval(() => {
    const h = window.__agentTycoonTestHooks;
    if (B.usable !== null) return clearInterval(peek);
    if (h && h.warmState) B.peakPending = Math.max(B.peakPending, h.warmState().pending);
  }, 100);
  new PerformanceObserver((l) => { if (B.rec) for (const e of l.getEntries()) B.long.push(e.duration); }).observe({ type: 'longtask', buffered: false });
  const look = () => {
    const boot = document.querySelector('[data-testid="boot-screen"]');
    if (boot) {
      if (B.firstBoot === null) B.firstBoot = performance.now();
      const pct = Number(boot.getAttribute('data-pct'));
      if (B.pcts[B.pcts.length - 1]?.[1] !== pct) B.pcts.push([Math.round(performance.now()), pct, boot.getAttribute('data-step')]);
    }
    // The claim is read when the bar says 100 (then the lobby takes over), or without a loading
    // screen when the lobby's button shows.
    const full = boot && boot.getAttribute('data-pct') === '100';
    const enter = document.querySelector('[data-testid="title-enter"]');
    if (B.usable === null && enter) B.usable = performance.now();
    if (B.facts === null && (full || enter)) {
      const h = window.__agentTycoonTestHooks || {};
      B.facts = {
        bootShown: !!boot,
        lastPct: B.pcts.length ? B.pcts[B.pcts.length - 1][1] : null,
        warmPending: h.warmState ? h.warmState().pending : null,
        peakPending: B.peakPending,
        sheets: h.sheetLoads ? h.sheetLoads() : null,
        fonts: document.fonts.status,
        isoDrawn: h.getIso ? h.getIso().drawn : null,
        pictures: h.pictures ? h.pictures() : null,
      };
    }
  };
  new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-pct'] });
`;

/** A live job record (a `sleep` stands for the process) with a tqdm log the runner climbs. */
function addJob(home: string, tag: string): { proc: ChildProcess; log: string } {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore', detached: true });
  proc.unref();
  const pid = proc.pid!;
  const dir = path.join(home, '.local/state/agent-tycoon/jobs');
  fs.mkdirSync(dir, { recursive: true });
  const id = `1104-${String(pid).padStart(6, '0')}-${tag}`;
  const log = path.join(dir, `${id}.log`);
  fs.writeFileSync(log, 'loading data\n');
  fs.writeFileSync(
    path.join(dir, `${id}.json`),
    JSON.stringify({
      id,
      pid,
      pstart: fs.readFileSync(`/proc/${pid}/stat`, 'utf-8').split(') ').pop()!.split(' ')[19],
      boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf-8').trim(),
      project: LEADS[0],
      cmd: `python ${tag}.py`,
      desc: tag,
      dir: '/work',
      tab: null,
      tty: false,
      log,
      started: new Date(Date.now() - 60_000).toISOString(),
      ended: null,
      exit: null,
      source: 'cli',
    }) + '\n',
  );
  return { proc, log };
}

const LONG_REPLY = Array.from(
  { length: 14 },
  (_, i) => `${i + 1}번째로 바꾼 곳은 \`server/src/agent-tycoon/file${i}.ts\` 이고, 상태를 따로 세도록 고쳤어요.`,
).join(' ');

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const ids = LEADS.map((_, i) => String.fromCharCode(97 + i).repeat(10));
  const folders = LEADS.map((l) => fs.mkdtempSync(path.join(home, `${l}-`)));
  put('projects.json', { v: 2, projects: LEADS.map((l, i) => ({ projectId: `p_${ids[i]}`, name: l, folder: folders[i], room: `${l}-room`, leadAssignmentId: `a_${ids[i]}` })) });
  put('assignments.json', { v: 1, assignments: LEADS.map((_, i) => ({ assignmentId: `a_${ids[i]}`, projectId: `p_${ids[i]}`, role: 'lead', provider: 'claude-pty', model: MODEL, wantRunning: true })) });
  put('building.json', { version: 1, perProject: false, floors: [{ id: '1', name: '1층', rooms: LEADS.map((l) => `${l}-room`), characters: [] }] });
  const jobs = ['train', 'eval', 'build'].map((t) => addJob(home, t));

  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--no-terminal'], {
    FAKE_TURN_MS: '240000',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  }, false, process.env.CLI ? path.resolve(process.env.CLI) : undefined);
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const timers: ReturnType<typeof setInterval>[] = [];
  const cleanup = () => {
    for (const t of timers) clearInterval(t);
    for (const j of jobs) j.proc.kill('SIGKILL'); // our own sleeps
  };
  const deadline = setTimeout(() => {
    console.error('deadline');
    cleanup();
    daemon.child.kill('SIGKILL'); // our own daemon only
    process.exit(2);
  }, DEADLINE_MS);

  const sessionOf = (name: string) => {
    for (const file of fs.readdirSync(path.join(home, '.claude/sessions'))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as { name: string; sessionId: string; cwd: string };
        if (s.name === name) return s;
      } catch {
        /* written as we read */
      }
    }
    return undefined;
  };
  const append = (name: string, ...records: Rec[]) => {
    const s = sessionOf(name);
    if (!s) return;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const r of records) fs.appendFileSync(file, `${JSON.stringify(stamp(r))}\n`);
  };
  const said = (content: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', model: MODEL, content, usage: { input_tokens: 10, cache_read_input_tokens: 40_000, output_tokens: 100 } } });
  const turnEnd = { type: 'system', subtype: 'turn_duration', durationMs: 1200 };

  // The office keeps living: states every 2 s, a long reply to alpha every 6 s, jobs climb every 1 s.
  let tick = 0;
  const startActivity = () => {
    timers.push(
      setInterval(() => {
        tick++;
        LEADS.slice(1).forEach((l, i) => {
          const st = (tick + i) % 3;
          const tid = `toolu_${l}${tick}`;
          if (st === 0) append(l, { type: 'user', message: { content: '읽어 주세요' } }, said([{ type: 'tool_use', id: tid, name: 'Bash', input: { command: 'cat a.ts', description: '읽기' } }]));
          else if (st === 1) append(l, said([{ type: 'text', text: '마이그레이션 먼저 돌릴까요?' }]), turnEnd);
          else append(l, said([{ type: 'text', text: '정리했어요.' }]), turnEnd);
        });
      }, 2_000),
      setInterval(() => append(LEADS[0], { type: 'user', message: { content: '정리해 주세요' } }, said([{ type: 'text', text: LONG_REPLY }]), turnEnd), 6_000),
      setInterval(() => {
        const n = tick % 100;
        for (const j of jobs) fs.appendFileSync(j.log, `\rtrain: ${n}%|${'█'.repeat(n / 10)}| ${n * 10}/1000 [00:${String(n).padStart(2, '0')}<01:40,  5.41it/s]`);
      }, 1_000),
    );
  };

  // The pointer keeps using the app until `stop` says so.
  const drive = async (page: Page, stop: () => boolean) => {
    const title = page.getByTestId('hud-title-messenger');
    const canvas = page.getByTestId('office-canvas');
    const contact = page.locator('[data-hud-window="messenger"]').getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ });
    while (!stop()) {
      const tb = await title.boundingBox();
      if (tb) {
        const x = tb.x + 60;
        const y = tb.y + tb.height / 2;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x - 160, y + 40, { steps: 20 });
        await page.mouse.move(x, y, { steps: 20 });
        await page.mouse.up();
      }
      if (stop()) break;
      const cb = (await canvas.boundingBox())!;
      const cx = cb.x + cb.width * 0.4;
      const cy = cb.y + cb.height * 0.5;
      await page.mouse.move(cx, cy, { steps: 5 });
      for (const d of [-120, -120, -120, 120, 120, 120]) {
        await page.mouse.wheel(0, d);
        await wait(120);
      }
      if (stop()) break;
      await page.mouse.down({ button: 'middle' });
      await page.mouse.move(cx + 150, cy + 80, { steps: 15 });
      await page.mouse.move(cx, cy, { steps: 15 });
      await page.mouse.up({ button: 'middle' });
      if (stop()) break;
      await contact.click({ timeout: 5_000 }).catch(() => undefined);
      await wait(300);
    }
  };

  const measure = async (page: Page, cdp: CDPSession, rate: number, round: number) => {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await wait(1_500);
    await page.evaluate(() => {
      const M = (window as unknown as { __smooth: Record<string, unknown> & { rec: boolean; raf: number[] } }).__smooth;
      Object.assign(M, { raf: [], long: [], input: {}, ws: {}, wsBytes: 0, commits: 0, renders: {}, rec: true });
      const t = (now: number) => {
        if (!M.rec) return;
        M.raf.push(now);
        requestAnimationFrame(t);
      };
      requestAnimationFrame(t);
    });
    const metrics = async () => Object.fromEntries(((await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }).metrics.map((m) => [m.name, m.value]));
    const m0 = await metrics();
    const t0 = Date.now();
    const stopAt = t0 + MEASURE_MS;
    await drive(page, () => Date.now() > stopAt);
    const secs = (Date.now() - t0) / 1000;
    const M = (await page.evaluate(() => {
      const m = (window as unknown as { __smooth: { rec: boolean } }).__smooth;
      m.rec = false;
      return m;
    })) as { raf: number[]; long: number[]; input: Record<string, number[]>; ws: Record<string, [number, number]>; wsBytes: number; commits: number; renders: Record<string, number> };
    const m1 = await metrics();
    const perSec = (k: string) => Math.round(((m1[k] - m0[k]) / secs) * 1000); // ms of main thread per second
    const iv = M.raf.slice(1).map((v, i) => v - M.raf[i]);
    const inputs = Object.values(M.input).flat();
    const row = {
      rate,
      round,
      secs: +secs.toFixed(1),
      fps: +(M.raf.length / secs).toFixed(1),
      rafP50: pct(iv, 0.5),
      rafP95: pct(iv, 0.95),
      rafP99: pct(iv, 0.99),
      rafMax: pct(iv, 1),
      over50: iv.filter((v) => v > 50).length,
      longTasks: M.long.length,
      longMs: Math.round(M.long.reduce((a, b) => a + b, 0)),
      longMax: Math.round(Math.max(0, ...M.long)),
      inputN: inputs.length,
      inputP50: pct(inputs, 0.5),
      inputP95: pct(inputs, 0.95),
      inputMax: pct(inputs, 1),
      byInput: Object.fromEntries(Object.entries(M.input).map(([k, v]) => [k, { n: v.length, p50: pct(v, 0.5), p95: pct(v, 0.95), max: pct(v, 1) }])),
      wsMsgs: Object.values(M.ws).reduce((a, [n]) => a + n, 0),
      wsKB: Math.round(M.wsBytes / 1024),
      wsTop: Object.entries(M.ws).sort((a, b) => b[1][1] - a[1][1]).slice(0, 8).map(([k, [n, b]]) => `${k} ${n}x ${Math.round(b / 1024)}KB`),
      taskMsPerS: perSec('TaskDuration'),
      scriptMsPerS: perSec('ScriptDuration'),
      styleMsPerS: perSec('RecalcStyleDuration'),
      layoutMsPerS: perSec('LayoutDuration'),
      layouts: Math.round((m1.LayoutCount - m0.LayoutCount) / secs),
      styles: Math.round((m1.RecalcStyleCount - m0.RecalcStyleCount) / secs),
      heapMB: +(m1.JSHeapUsedSize / 1048576).toFixed(1),
      ...(process.env.REACT === '1' && {
        commits: M.commits,
        renders: Object.entries(M.renders).sort((a, b) => b[1] - a[1]).slice(0, 25),
      }),
    };
    console.log(JSON.stringify(row));
    return row;
  };

  const profile = async (page: Page, cdp: CDPSession, rate: number) => {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
    const stopAt = Date.now() + 10_000;
    await drive(page, () => Date.now() > stopAt);
    const { profile: p } = (await cdp.send('Profiler.stop')) as {
      profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }; children?: number[] }[]; samples: number[]; timeDeltas: number[] };
    };
    const self = new Map<number, number>();
    p.samples.forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (p.timeDeltas[i] ?? 0)));
    const parent = new Map<number, number>();
    for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const byId = new Map(p.nodes.map((n) => [n.id, n]));
    const key = (n: (typeof p.nodes)[number]) => `${n.callFrame.functionName || '(anon)'} ${path.basename(n.callFrame.url)}:${n.callFrame.lineNumber + 1}:${n.callFrame.columnNumber + 1}`;
    const selfBy = new Map<string, number>();
    const totalBy = new Map<string, number>();
    let all = 0;
    for (const [id, us] of self) {
      const n = byId.get(id)!;
      all += us;
      selfBy.set(key(n), (selfBy.get(key(n)) ?? 0) + us);
      const seen = new Set<string>();
      for (let cur: number | undefined = id; cur !== undefined; cur = parent.get(cur)) {
        const k = key(byId.get(cur)!);
        if (seen.has(k)) continue;
        seen.add(k);
        totalBy.set(k, (totalBy.get(k) ?? 0) + us);
      }
    }
    const top = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([k, us]) => `${(us / 1000).toFixed(0).padStart(6)}ms ${((us / all) * 100).toFixed(1).padStart(5)}% ${k}`);
    const out = { rate, totalMs: Math.round(all / 1000), self: top(selfBy), total: top(totalBy) };
    fs.writeFileSync(path.join(OUT, `${LABEL}-profile.json`), JSON.stringify(out, null, 1));
    fs.writeFileSync(path.join(OUT, `${LABEL}.cpuprofile`), JSON.stringify(p));
    console.log(out.self.slice(0, 25).join('\n'));
  };

  /** TRACE=1: 6 s of the timeline; main-thread time by event name (self time: children subtracted). */
  const trace = async (page: Page, cdp: CDPSession, rate: number) => {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate });
    const events: { name: string; ph: string; ts: number; dur?: number; tid: number; pid: number; args?: { name?: string } }[] = [];
    cdp.on('Tracing.dataCollected', (d: { value: typeof events }) => events.push(...d.value));
    const done = new Promise<void>((r) => cdp.once('Tracing.tracingComplete', () => r()));
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' });
    const stopAt = Date.now() + 6_000;
    await drive(page, () => Date.now() > stopAt);
    await cdp.send('Tracing.end');
    await done;
    const names = new Map<string, string>();
    for (const e of events) if (e.name === 'thread_name' && e.args?.name) names.set(`${e.pid}:${e.tid}`, e.args.name);
    const byThread = new Map<string, typeof events>();
    for (const e of events) if (e.ph === 'X' && e.dur) {
      const k = `${e.pid}:${e.tid}`;
      (byThread.get(k) ?? byThread.set(k, []).get(k)!).push(e);
    }
    const out: Record<string, string[]> = {};
    for (const [k, list] of byThread) {
      const tn = names.get(k) ?? k;
      if (!/CrRendererMain|Compositor|Raster|VizCompositor|CrGpuMain/.test(tn)) continue;
      list.sort((a, b) => a.ts - b.ts || b.dur! - a.dur!);
      const self = new Map<string, number>();
      const stack: { end: number; name: string }[] = [];
      for (const e of list) {
        while (stack.length && stack[stack.length - 1].end <= e.ts) stack.pop();
        const parent = stack[stack.length - 1];
        if (parent) self.set(parent.name, (self.get(parent.name) ?? 0) - e.dur!);
        self.set(e.name, (self.get(e.name) ?? 0) + e.dur!);
        stack.push({ end: e.ts + e.dur!, name: e.name });
      }
      const key = `${tn} ${k}`;
      out[key] = [...self].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([n, us]) => `${(us / 6000).toFixed(1)}ms/s ${n}`);
    }
    fs.writeFileSync(path.join(OUT, `${LABEL}-trace.json`), JSON.stringify(out, null, 1));
    console.log(JSON.stringify(out, null, 1));
  };


  /** BOOT=1: each case in a fresh context; the daemon and its office stay as they are. */
  const bootRuns = async () => {
    browser = await launchBrowser({ partyFrame: true });
    const bcdp = await browser.newBrowserCDPSession();
    /** The renderer and GPU processes' resident memory (MB), from /proc. */
    const rss = async () => {
      const { processInfo } = (await bcdp.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; id: number }[] };
      let kb = 0;
      for (const p of processInfo)
        if (p.type === 'renderer' || p.type === 'GPU')
          try {
            kb += Number(/VmRSS:\s+(\d+)/.exec(fs.readFileSync(`/proc/${p.id}/status`, 'utf8'))?.[1] ?? 0);
          } catch {
            /* gone */
          }
      return kb / 1024;
    };
    // The changelog's "updated" notice would sit over the lobby: its version is marked seen first.
    let seen: string | null = null;
    {
      const ctx = await browser.newContext(VIEW);
      const page = await ctx.newPage();
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      const toast = await page.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 6_000 }).catch(() => null);
      seen = toast?.match(/v([\d.]+)/)?.[1] ?? null;
      await ctx.close();
    }
    const results: unknown[] = [];
    const one = async (c: string, shots: boolean) => {
      const [view, rateS, mode] = c.split(':');
      const rate = Number(rateS);
      const ctx = await browser!.newContext(view === 'phone' ? PHONE : VIEW);
      await ctx.addInitScript(INIT);
      await ctx.addInitScript(BOOT_INIT);
      await ctx.addInitScript(
        ([iso, v]) => {
          const set: Array<[string, string]> = [['agty.title-scene', 'on'], ['agty.office-iso', iso], ['agty.backdrop', 'off'], ['agty.floor', '1']];
          if (v) set.push(['agty.changelogSeen', v]);
          for (const [k, x] of set)
            try {
              localStorage.setItem(k, x);
            } catch {
              /* about:blank */
            }
        },
        [mode === 'top' ? 'off' : 'on', seen] as const,
      );
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('Performance.enable');
      await cdp.send('Emulation.setCPUThrottlingRate', { rate });
      let peak = 0;
      let heapPeak = 0;
      let sampling = true;
      // A case that fails (a picture's timeout) stops sampling with its page.
      const sampler = (async () => {
        while (sampling && !page.isClosed()) {
          peak = Math.max(peak, await rss().catch(() => 0));
          const m = (await cdp.send('Performance.getMetrics').catch(() => null)) as { metrics: { name: string; value: number }[] } | null;
          const heap = m?.metrics.find((x) => x.name === 'JSHeapUsedSize')?.value ?? 0;
          heapPeak = Math.max(heapPeak, heap / 1048576);
          await wait(250);
        }
      })();
      try {
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      const tag = `${LABEL}-${view}`;
      if (shots) {
        // A picture while the bar is on its way (the page keeps loading under the screenshot).
        for (let k = 0; k < 600; k++) {
          const pct = Number(await page.getByTestId('boot-screen').getAttribute('data-pct', { timeout: 50 }).catch(() => -1));
          if (pct >= 30 && pct < 100) {
            await page.screenshot({ path: path.join(OUT, `${tag}-loading.png`), timeout: 120_000 });
            break;
          }
          if (pct === -1 && (await page.getByTestId('title-enter').count())) break;
          await wait(50);
        }
      }
      const enter = page.getByTestId('title-enter');
      await enter.waitFor({ timeout: 90_000 });
      if (shots) {
        await wait(1_000); // the lobby's picture and cast in
        await page.screenshot({ path: path.join(OUT, `${tag}-lobby.png`), timeout: 120_000 });
      }
      await page.evaluate(() => {
        const B = (window as unknown as { __boot: { rec: boolean; raf: number[] } }).__boot;
        B.rec = true;
        const t = (now: number) => {
          if (!B.rec) return;
          B.raf.push(now);
          requestAnimationFrame(t);
        };
        requestAnimationFrame(t);
      });
      await enter.click();
      const canvas = page.getByTestId('office-canvas');
      const stopAt = Date.now() + BOOT_AFTER_MS;
      while (Date.now() < stopAt) {
        const cb = await canvas.boundingBox();
        if (!cb) break;
        const cx = cb.x + cb.width * 0.5;
        const cy = cb.y + cb.height * 0.5;
        await page.mouse.move(cx, cy, { steps: 3 });
        for (const d of [-120, 120]) {
          await page.mouse.wheel(0, d);
          await wait(150);
        }
        await page.mouse.down({ button: 'middle' });
        await page.mouse.move(cx + 80, cy + 40, { steps: 10 });
        await page.mouse.move(cx, cy, { steps: 10 });
        await page.mouse.up({ button: 'middle' });
      }
      const B = (await page.evaluate(() => {
        const b = (window as unknown as { __boot: { rec: boolean } }).__boot;
        b.rec = false;
        return b;
      })) as unknown as { pcts: [number, number, string][]; firstBoot: number | null; usable: number; facts: Record<string, unknown>; raf: number[]; long: number[] };
      await wait(10_000); // untouched: what the page keeps
      const idle = await rss();
      const picturesIdle = await page.evaluate(() => {
        const h = (window as unknown as { __agentTycoonTestHooks?: { pictures?: () => unknown } }).__agentTycoonTestHooks;
        return h?.pictures ? h.pictures() : null;
      });
      sampling = false;
      await sampler;
      const iv = B.raf.slice(1).map((v, i) => v - B.raf[i]);
      const f = B.facts as { bootShown: boolean; lastPct: number | null; warmPending: number | null; peakPending: number; sheets: [number, number] | null; fonts: string; isoDrawn: boolean | null };
      // What the first view needs is in: the sheets, the iso drawn, and the queue drained to at most a
      // tenth of its peak (walking characters keep queueing new turns, built in the office's slices).
      const ready =
        f.warmPending !== null &&
        f.warmPending <= BOOT_PENDING_SHARE * f.peakPending &&
        (!f.sheets || f.sheets[0] === f.sheets[1]) &&
        (mode === 'top' || f.isoDrawn === true);
      const row = {
        case: c,
        usableMs: Math.round(B.usable),
        bootFirstMs: B.firstBoot === null ? null : Math.round(B.firstBoot),
        pcts: B.pcts,
        pctMonotonic: B.pcts.every((p, i) => i === 0 || p[1] >= B.pcts[i - 1][1]),
        facts: f,
        // the loading screen's claim: nothing pending when the lobby shows
        readyAtLobby: ready,
        claimHeld: B.firstBoot === null ? null : f.lastPct === 100 && ready,
        after: {
          frames: B.raf.length,
          over50: iv.filter((v) => v > 50).length,
          rafMax: pct(iv, 1),
          longTasks: B.long.length,
          longMs: Math.round(B.long.reduce((a, b) => a + b, 0)),
          longMax: Math.round(Math.max(0, ...B.long)),
        },
        rssPeakMB: Math.round(peak),
        rssIdleMB: Math.round(idle),
        // PAGE-MEM: the picture budget (bytes, pictures, limit, evicted) at the claim and when idle
        picturesIdle,
        heapPeakMB: +heapPeak.toFixed(1),
        errors: errors.slice(0, 3),
      };
      console.log(JSON.stringify(row));
      return row;
      } finally {
        sampling = false;
        await ctx.close();
        await wait(2_000); // the closed context's renderer gone before the next one is measured
      }
    };
    for (let k = 0; k < BOOT_REPEAT; k++) for (const c of BOOT_CASES) results.push(await one(c, false));
    if (results.length)
      fs.writeFileSync(path.join(OUT, `${LABEL}-boot.json`), JSON.stringify({ label: LABEL, cli: process.env.CLI ?? 'dist/cli.js', results }, null, 1));
    // The pictures are not measurements: one that fails is reported and the next is taken.
    if (process.env.SHOTS === '1')
      for (const c of ['desk:10:iso', 'phone:10:iso'])
        await one(c, true).catch((e: unknown) => console.error(`shot ${c}: ${String(e).split('\n')[0]}`));
  };

  const rows: unknown[] = [];
  try {
    await daemon.loginUrl();
    for (const l of LEADS) await until(`${l} revived`, () => !!sessionOf(l), 90_000);
    if (process.env.BOOT === '1') {
      startActivity();
      await bootRuns();
      return;
    }
    browser = await launchBrowser({ partyFrame: true });
    const ctx = await browser.newContext(VIEW);
    await ctx.addInitScript(INIT);
    await ctx.addInitScript(() => {
      for (const [k, v] of [['agty.office-iso', 'on'], ['agty.backdrop', 'off'], ['agty.floor', '1']])
        try {
          localStorage.setItem(k, v);
        } catch {
          /* about:blank */
        }
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const toast = await page.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 4_000 }).catch(() => null);
    const v = toast?.match(/v([\d.]+)/)?.[1];
    if (v) {
      await page.evaluate((x) => localStorage.setItem('agty.changelogSeen', x), v);
      await page.reload();
    }
    await until('six portraits', async () => (await page.locator('[data-portrait]').count()) === LEADS.length, 60_000);
    await page.evaluate(`window.__agentTycoonTestHooks.spawnLook({ palette: 0 }, ${EXTRA}, 9000)`);
    await page.locator('[data-hud-id="icon:messenger"]').getByRole('button').click();
    const msgr = page.locator('[data-hud-window="messenger"]');
    await msgr.waitFor({ timeout: 10_000 });
    await msgr.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }).click();
    startActivity();
    await wait(4_000);
    if (process.env.SHOT === '1') {
      // SMOOTH2-1104: where every overlay sits (SHOT=1 skips the measuring): two samples 800 ms apart, so a
      // walking character is told from a seated one; a picture of the same moment.
      const sample = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('[data-agent-id]')].map((e) => {
            const r = e.getBoundingClientRect();
            return { t: e.getAttribute('data-testid'), id: e.getAttribute('data-agent-id'), x: +r.x.toFixed(2), y: +r.y.toFixed(2), w: +r.width.toFixed(2), h: +r.height.toFixed(2) };
          }),
        );
      await page.locator('[data-hud-id="icon:messenger"]').getByRole('button').click(); // the office in view
      await wait(3_000);
      const a = await sample();
      await page.screenshot({ path: path.join(OUT, `${LABEL}.png`) });
      await wait(800);
      const b = await sample();
      fs.writeFileSync(path.join(OUT, `${LABEL}-pos.json`), JSON.stringify({ a, b }, null, 1));
      console.log(`shot: ${a.length} overlay elements`);
      return;
    }
    const iso = (await page.evaluate(`window.__agentTycoonTestHooks.getIso().drawn`)) as boolean;
    const characters = (await page.evaluate(`window.__agentTycoonTestHooks.getCharacters().length`)) as number;
    console.log(`iso drawn ${iso}, ${characters} characters`);
    await page.screenshot({ path: path.join(OUT, `${LABEL}.png`) });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    for (let round = 1; round <= ROUNDS; round++)
      for (const rate of round % 2 ? RATES : [...RATES].reverse()) rows.push(await measure(page, cdp, rate, round));
    if (process.env.PROFILE === '1') await profile(page, cdp, RATES[0]);
    if (process.env.TRACE === '1') await trace(page, cdp, RATES[0]);
    await page.screenshot({ path: path.join(OUT, `${LABEL}-end.png`) });
    fs.writeFileSync(path.join(OUT, `${LABEL}.json`), JSON.stringify({ label: LABEL, iso, characters, errors, rows }, null, 1));
    if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  } finally {
    clearTimeout(deadline);
    cleanup();
    await browser?.close().catch(() => undefined);
    killFakeSessions(home);
    await daemon.stop();
    removeTestHome(home);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
