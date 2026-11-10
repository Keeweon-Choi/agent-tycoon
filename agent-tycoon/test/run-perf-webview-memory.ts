/**
 * PERF-WEBVIEW-MEMORY (owner 11-06 20:19: the desktop app at 1.3 GB in Task Manager, the WebView2
 * renderer 818 MB and its GPU process 443 MB, CPU 8 % and GPU 20 % while only looked at). The page's
 * memory and its load at rest in a scene like the owner's: dist/cli.js (or CLI=<path>) in a temp
 * HOME, the engine's fake claude as 8 Leads on 2 floors (never a real agent), the owner and alpha in
 * 2304×3168 iso8 test sheets, two built-in HD bunnies; alpha's conversation 400 turns long, the
 * 전체방 600 posts. The 개발실 lists only agents with a terminal in it (here alpha alone), so its
 * second pane holds a terminal only when another agent has one. Headless Chromium (--disable-gpu: what the GPU process would hold is estimated
 * from the canvases' backing stores and the decoded pictures, which is what fills it), 1600×1000 at
 * each devicePixelRatio of DPRS (default 1.5,2), the iso view, the terminal panes on WebGL when the
 * browser has it (the app's default; the runners' DOM default is undone).
 *
 * Per dpr, two scenes, each `REST_MS` at rest then a sample:
 *  - open: the messenger on alpha's conversation, the 현황판, the 개발실 with two panes in 터미널;
 *  - office: those windows closed, the office alone.
 * At rest: the renderer's CPU (and per frame drawn), the frames the office canvas drew, every
 * requestAnimationFrame call.
 * A sample: the renderer's PSS/RSS, Chrome's memory-infra allocators, the JS heap (+ ArrayBuffers),
 * DOM counters, a census of every live canvas (by context type, in the DOM or not), OffscreenCanvas,
 * ImageBitmap, ImageData and decoded <img> (WeakRefs from an init script, 4 bytes a pixel), the
 * picture budget, the xterms; SNAP=1 adds a heap snapshot's self sizes by constructor (dpr 2, open).
 * PROFILE=1: a CPU profile of the office at rest (dpr 2), self time by function (CLI= an unminified
 * build for names). Output: agent-tycoon/artifacts/perf-webview-memory/<LABEL>.json and <LABEL>-<dpr>-<scene>.png.
 *
 *   taskset -c 14,15 nice -n 10 npx tsx agent-tycoon/test/run-perf-webview-memory.ts <port 19260-19269> [LABEL]
 */
import type { Browser, CDPSession, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { monthFile } from '../../server/src/agent-tycoon/engine/groupLogFiles.js';
import { groupTimelineDir } from '../../server/src/agent-tycoon/engine/groups.js';
import { makeTempRepo } from '../../server/src/agent-tycoon/engine/git/testRepo.js';
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
if (!(port >= 19260 && port <= 19269)) throw new Error('port 19260-19269');
const LABEL = process.argv[3] ?? 'run';
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/perf-webview-memory');
const REST_MS = Number(process.env.REST_MS ?? 30_000);
const DPRS = (process.env.DPRS ?? '1.5,2').split(',').map(Number);
const SNAP = process.env.SNAP === '1';
const PROFILE = process.env.PROFILE === '1';
const DEADLINE_MS = 300_000 + DPRS.length * (4 * REST_MS + 120_000);
const LEADS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
const MODEL = 'claude-sonnet-4-5';
const VIEWPORT = { width: 1600, height: 1000 };
const SHEET_CACHE = path.join(REPO_ROOT, 'node_modules/.cache/perf-webview-memory-sheets');
const SHEETS = ['t-boss', 't-char-1'];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => unknown, ms = 60_000): Promise<void> {
  for (const end = Date.now() + ms; !(await ok()); await wait(250))
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
}
type Rec = Record<string, unknown>;
const stamp = (r: Rec, at: number): Rec => ({
  uuid: `u-${Math.random().toString(16).slice(2, 10)}`,
  timestamp: new Date(at).toISOString(),
  ...r,
});

// Page side: WeakRefs to every canvas, bitmap, ImageData and <img> made; the context each canvas
// took; the office canvas's full clears (frames drawn) and every requestAnimationFrame call.
const INIT = `
  globalThis.__name = (fn) => fn;
  window.__AGENT_TYCOON_E2E = true;
  (() => {
    const live = (window.__pm = { refs: [], frames: [], rec: false, raf: 0 });
    const keep = (kind, o) => live.refs.push({ kind, ref: new WeakRef(o) });
    const ce = Document.prototype.createElement;
    Document.prototype.createElement = function (tag, ...a) {
      const el = ce.call(this, tag, ...a);
      const t = String(tag).toLowerCase();
      if (t === 'canvas') keep('canvas', el);
      else if (t === 'img') keep('img', el);
      return el;
    };
    const I = window.Image;
    window.Image = function (...a) { const el = new I(...a); keep('img', el); return el; };
    window.Image.prototype = I.prototype;
    const gc = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...a) { const c = gc.call(this, type, ...a); if (c) this.__ctx = String(type); return c; };
    if (window.OffscreenCanvas) {
      const O = window.OffscreenCanvas;
      window.OffscreenCanvas = function (w, h) { const c = new O(w, h); keep('offscreen', c); return c; };
      window.OffscreenCanvas.prototype = O.prototype;
      const tib = O.prototype.transferToImageBitmap;
      O.prototype.transferToImageBitmap = function () { const b = tib.call(this); keep('bitmap', b); return b; };
    }
    const cib = window.createImageBitmap;
    window.createImageBitmap = async function (...a) { const b = await cib.apply(this, a); keep('bitmap', b); return b; };
    const gid = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function (...a) { const d = gid.apply(this, a); keep('imagedata', d); return d; };
    const cid = CanvasRenderingContext2D.prototype.createImageData;
    CanvasRenderingContext2D.prototype.createImageData = function (...a) { const d = cid.apply(this, a); keep('imagedata', d); return d; };
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (x, y, w, h) {
      if (live.rec && x === 0 && y === 0 && this.canvas.dataset && this.canvas.dataset.testid === 'office-canvas') live.frames.push(performance.now());
      return clear.call(this, x, y, w, h);
    };
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (fn) => { if (live.rec) live.raf++; return raf(fn); };
    window.__census = () => {
      const by = {};
      const big = {};
      let n = 0;
      live.refs = live.refs.filter((r) => r.ref.deref());
      for (const r of live.refs) {
        const o = r.ref.deref();
        let px = 0;
        let attached = false;
        if (r.kind === 'img') { px = o.complete ? o.naturalWidth * o.naturalHeight : 0; attached = o.isConnected; }
        else if (r.kind === 'imagedata') px = o.data.length / 4;
        else { px = o.width * o.height; attached = !!o.isConnected; }
        if (!px) continue;
        n++;
        const k = r.kind + (r.kind === 'canvas' ? '/' + (o.__ctx || 'none') : '') + (attached ? '(dom)' : '');
        const b = (by[k] ??= { n: 0, mb: 0 });
        b.n++; b.mb += (px * 4) / 1048576;
        const size = (o.naturalWidth || o.width) + 'x' + (o.naturalHeight || o.height);
        const tag = r.kind === 'canvas' && attached ? ' ' + (o.dataset?.testid || o.className || o.parentElement?.className || '').toString().slice(0, 40) : '';
        const a = (big[px * 4 > 1048576 ? k + ' ' + size + tag : k + ' under 1 MB'] ??= { n: 0, mb: 0 });
        a.n++; a.mb += (px * 4) / 1048576;
      }
      const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { n: v.n, mb: +v.mb.toFixed(1) }]).sort((x, y) => y[1].mb - x[1].mb));
      const total = Object.values(by).reduce((t, v) => t + v.mb, 0);
      return { totalMB: +total.toFixed(1), objects: n, byKind: round(by), top: Object.entries(round(big)).slice(0, 25) };
    };
  })();
`;

/** An imported iso8 sheet with its drink row (8 columns of 288×528, 6 rows): a noisy figure per
 *  cell in its own hue, as big as the owner's (run-page-mem-1104.ts's). */
function makeSheet(file: string, hue: number): void {
  const [W, H, FW, FH] = [2304, 3168, 288, 528];
  const png = new PNG({ width: W, height: H });
  const base = [
    [200, 60, 60],
    [60, 160, 70],
  ][hue % 2];
  let seed = hue * 7919 + 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 8) & 63;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [cx, cy] = [(x % FW) - FW / 2, (y % FH) - FH * 0.55];
      if ((cx / 80) ** 2 + (cy / 200) ** 2 > 1) continue;
      const i = (y * W + x) * 4;
      png.data[i] = base[0] + rnd() - 32;
      png.data[i + 1] = base[1] + rnd() - 32;
      png.data[i + 2] = base[2] + rnd() - 32;
      png.data[i + 3] = 255;
    }
  fs.writeFileSync(file, PNG.sync.write(png, { colorType: 6 }));
}

// ── /proc: our own descendants only ──
function descendants(root: number): number[] {
  const parent = new Map<number, number>();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const st = fs.readFileSync(`/proc/${d}/stat`, 'utf-8');
      parent.set(Number(d), Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[1]));
    } catch {
      // gone
    }
  }
  const out: number[] = [];
  const q = [root];
  while (q.length) {
    const p = q.shift()!;
    for (const [c, pp] of parent) if (pp === p) (out.push(c), q.push(c));
  }
  return out;
}
const read = (f: string) => {
  try {
    return fs.readFileSync(f, 'utf-8');
  } catch {
    return '';
  }
};
const kindOf = (pid: number) => {
  const cmd = read(`/proc/${pid}/cmdline`);
  if (!cmd.includes('chrom')) return 'other';
  return /--type=([a-z-]+)/.exec(cmd)?.[1] ?? 'browser';
};
const pssMB = (pid: number) =>
  Number(/^Pss:\s+(\d+)/m.exec(read(`/proc/${pid}/smaps_rollup`))?.[1] ?? 0) / 1024;
const rssMB = (pid: number) =>
  Number(/VmRSS:\s+(\d+)/.exec(read(`/proc/${pid}/status`))?.[1] ?? 0) / 1024;
const cpuSec = (pid: number) => {
  const st = read(`/proc/${pid}/stat`);
  if (!st) return 0;
  const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
  return (Number(f[11]) + Number(f[12])) / 100;
};
/** The office tab's renderer: the renderer with the most memory. */
const tabRenderer = () =>
  descendants(process.pid)
    .filter((p) => kindOf(p) === 'renderer')
    .sort((a, b) => pssMB(b) - pssMB(a))[0];

/** Chrome's own memory dump (memory-infra): the tab renderer's allocators (MB, up to 3 levels). */
async function memDump(browser: Browser): Promise<Record<string, number>> {
  const b = await browser.newBrowserCDPSession();
  const events: Array<{
    ph: string;
    args?: { dumps?: { allocators?: Record<string, { attrs?: Record<string, { value: string }> }> } };
  }> = [];
  b.on('Tracing.dataCollected', (d: { value: typeof events }) => events.push(...d.value));
  const done = new Promise<void>((r) => b.once('Tracing.tracingComplete', () => r()));
  await b.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      includedCategories: ['disabled-by-default-memory-infra'],
      excludedCategories: ['*'],
      memoryDumpConfig: { triggers: [] },
    },
  });
  await b.send('Tracing.requestMemoryDump', { deterministic: true, levelOfDetail: 'detailed' });
  await b.send('Tracing.end');
  await done;
  await b.detach();
  const dumps: Array<Record<string, number>> = [];
  for (const e of events) {
    const al = e.ph === 'v' ? e.args?.dumps?.allocators : undefined;
    if (!al || !('blink_gc' in al)) continue;
    const out: Record<string, number> = {};
    for (const [name, a] of Object.entries(al)) {
      if (name.split('/').length > 3) continue;
      const v = a.attrs?.effective_size?.value ?? a.attrs?.size?.value;
      const mb = v ? parseInt(v, 16) / 1048576 : 0;
      if (mb >= 1) out[name] = +mb.toFixed(1);
    }
    dumps.push(out);
  }
  dumps.sort((x, y) => (y.malloc ?? 0) + (y.partition_alloc ?? 0) - ((x.malloc ?? 0) + (x.partition_alloc ?? 0)));
  return Object.fromEntries(Object.entries(dumps[0] ?? {}).sort((x, y) => y[1] - x[1]));
}

/** A heap snapshot's self sizes by constructor (top 25) and by node type. */
async function heapByConstructor(cdp: CDPSession): Promise<Rec> {
  const chunks: string[] = [];
  const onChunk = (c: { chunk: string }) => chunks.push(c.chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  const snap = JSON.parse(chunks.join('')) as {
    snapshot: { meta: { node_fields: string[]; node_types: [string[]] } };
    nodes: number[];
    strings: string[];
  };
  const f = snap.snapshot.meta.node_fields;
  const [iType, iName, iSelf, n] = [f.indexOf('type'), f.indexOf('name'), f.indexOf('self_size'), f.length];
  const types = snap.snapshot.meta.node_types[0];
  const byName = new Map<string, { n: number; b: number }>();
  const byType = new Map<string, number>();
  for (let i = 0; i < snap.nodes.length; i += n) {
    const type = types[snap.nodes[i + iType]];
    const self = snap.nodes[i + iSelf];
    byType.set(type, (byType.get(type) ?? 0) + self);
    const key = type === 'object' || type === 'native' ? snap.strings[snap.nodes[i + iName]].slice(0, 60) : `(${type})`;
    const e = byName.get(key) ?? { n: 0, b: 0 };
    e.n++;
    e.b += self;
    byName.set(key, e);
  }
  const mb = (b: number) => +(b / 1048576).toFixed(2);
  return {
    byType: Object.fromEntries([...byType].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, mb(v)])),
    top: [...byName].sort((a, b) => b[1].b - a[1].b).slice(0, 25).map(([k, v]) => ({ name: k, n: v.n, mb: mb(v.b) })),
  };
}

async function sample(page: Page, cdp: CDPSession, label: string, snap = false) {
  await cdp.send('HeapProfiler.collectGarbage');
  await wait(1200);
  await cdp.send('HeapProfiler.collectGarbage');
  await wait(600);
  const heap = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number; backingStorageSize?: number };
  const dom = (await cdp.send('Memory.getDOMCounters')) as { documents: number; nodes: number; jsEventListeners: number };
  const census = (await page.evaluate('window.__census()')) as Rec;
  const tab = tabRenderer();
  const app = (await page.evaluate(`(() => {
    const h = window.__agentTycoonTestHooks;
    const c = document.querySelector('[data-testid="office-canvas"]');
    return {
      characters: h.getCharacters?.().length,
      pictures: h.pictures?.(),
      windows: [...document.querySelectorAll('[data-hud-window]')].map((w) => w.getAttribute('data-hud-window') + ':' + w.getElementsByTagName('*').length + (w.getClientRects().length ? '' : '(hidden)')),
      xterm: [...document.querySelectorAll('.xterm')].map((x) => (x.closest('[data-renderer]')?.getAttribute('data-renderer') ?? '?') + ' ' + x.clientWidth + 'x' + x.clientHeight + ' rows ' + (x.querySelector('.xterm-rows')?.children.length ?? '-')),
      elements: document.getElementsByTagName('*').length,
      officeCanvas: c ? c.width + 'x' + c.height + ' css ' + c.clientWidth + 'x' + c.clientHeight : null,
      dpr: devicePixelRatio,
    };
  })()`)) as Rec;
  const allocators = await memDump(page.context().browser()!).catch((e) => ({ failed: String(e) }) as never);
  const row = {
    label,
    rendererPssMB: Math.round(pssMB(tab)),
    rendererRssMB: Math.round(rssMB(tab)),
    jsHeapMB: +(heap.usedSize / 1048576).toFixed(1),
    backingStoreMB: +((heap.backingStorageSize ?? 0) / 1048576).toFixed(1),
    domNodes: dom.nodes,
    listeners: dom.jsEventListeners,
    pictures: census,
    app,
    allocators,
    heap: snap ? await heapByConstructor(cdp) : undefined,
  };
  console.log(
    `[${label}] renderer PSS ${row.rendererPssMB} MB RSS ${row.rendererRssMB} MB, heap ${row.jsHeapMB} MB (+${row.backingStoreMB} buffers), DOM ${row.domNodes}, pictures ${census.totalMB} MB in ${census.objects}, canvas ${app.officeCanvas}`,
  );
  return row;
}

/** `ms` of no input: the renderer's CPU, the frames the office drew, the rAF calls. */
async function rest(page: Page, ms: number, label: string, profile = false) {
  await page.mouse.move(VIEWPORT.width - 2, 2);
  await wait(1500);
  const tab = tabRenderer();
  await page.evaluate('window.__pm.frames = []; window.__pm.raf = 0; window.__pm.rec = true');
  const iso0 = (await page.evaluate('window.__agentTycoonTestHooks.getIso()')) as { frames: number; ms: number };
  const cdp = profile ? await page.context().newCDPSession(page) : null;
  if (cdp) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.start');
  }
  const [c0, t0] = [cpuSec(tab), Date.now()];
  await wait(ms);
  const secs = (Date.now() - t0) / 1000;
  const c1 = cpuSec(tab);
  const [frames, raf] = (await page.evaluate('window.__pm.rec = false; [window.__pm.frames.length, window.__pm.raf]')) as [number, number];
  const iso1 = (await page.evaluate('window.__agentTycoonTestHooks.getIso()')) as { frames: number; ms: number };
  let top: unknown;
  if (cdp) {
    const { profile: prof } = (await cdp.send('Profiler.stop')) as {
      profile: { nodes: Array<{ id: number; callFrame: { functionName: string; url: string; lineNumber: number } }>; samples: number[]; timeDeltas: number[] };
    };
    const by = new Map<number, string>(prof.nodes.map((n) => [n.id, `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`]));
    const self = new Map<string, number>();
    prof.samples.forEach((id, i) => self.set(by.get(id)!, (self.get(by.get(id)!) ?? 0) + (prof.timeDeltas[i] ?? 0)));
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, v]) => `${((v / total) * 100).toFixed(1)}% ${k}`);
    await cdp.detach();
  }
  const row = {
    label,
    zoom: await page.evaluate('window.__agentTycoonTestHooks.getCamera().zoom'),
    isoMsPerFrame: +((iso1.ms - iso0.ms) / Math.max(1, iso1.frames - iso0.frames)).toFixed(2),
    profile: top,
    secs: +secs.toFixed(1),
    rendererCpuPct: +(((c1 - c0) / secs) * 100).toFixed(1),
    cpuMsPerDraw: +(((c1 - c0) * 1000) / Math.max(1, frames)).toFixed(1),
    drawsPerSec: +(frames / secs).toFixed(1),
    rafPerSec: +(raf / secs).toFixed(1),
  };
  console.log(`[${label}] at rest: renderer CPU ${row.rendererCpuPct} %, office draws ${row.drawsPerSec}/s (${row.cpuMsPerDraw} ms CPU each), rAF ${row.rafPerSec}/s, zoom ${row.zoom}, iso ${row.isoMsPerFrame} ms/frame`);
  if (top) console.log(`  ${(top as string[]).slice(0, 15).join('\n  ')}`);
  return row;
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(SHEET_CACHE, { recursive: true });
  SHEETS.forEach((id, i) => {
    const file = path.join(SHEET_CACHE, `${id}.png`);
    if (!fs.existsSync(file)) makeSheet(file, i);
  });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const repos = [makeTempRepo(), makeTempRepo()];
  const ids = LEADS.map((_, i) => String.fromCharCode(97 + i).repeat(10));
  const folders = LEADS.map((l, i) => repos[i]?.folder ?? fs.mkdtempSync(path.join(home, `${l}-`)));
  put('projects.json', {
    v: 2,
    projects: LEADS.map((l, i) => ({ projectId: `p_${ids[i]}`, name: l, folder: folders[i], room: `${l}-room`, leadAssignmentId: `a_${ids[i]}` })),
  });
  put('assignments.json', {
    v: 1,
    assignments: LEADS.map((_, i) => ({ assignmentId: `a_${ids[i]}`, projectId: `p_${ids[i]}`, role: 'lead', provider: 'claude-pty', model: MODEL, wantRunning: true })),
  });
  put('building.json', {
    version: 1,
    perProject: false,
    floors: [0, 1].map((f) => ({ id: String(f + 1), name: `${f + 1}층`, rooms: LEADS.slice(f * 4, f * 4 + 4).map((l) => `${l}-room`), characters: [] })),
  });
  const chars = path.join(cfg, 'characters');
  fs.mkdirSync(chars, { recursive: true });
  for (const id of SHEETS) {
    fs.copyFileSync(path.join(SHEET_CACHE, `${id}.png`), path.join(chars, `${id}.png`));
    fs.writeFileSync(path.join(chars, `${id}.json`), JSON.stringify({ label: id, columns: 'standFirst', walk: 'steps' }));
  }
  put('characters.json', { $meta: { v: 3, pinnedAt: new Date().toISOString() }, owner: { preset: 't-boss' }, alpha: { preset: 't-char-1' } });
  const gdir = groupTimelineDir(home);
  fs.mkdirSync(gdir, { recursive: true });
  const t0 = Date.now() - 3 * 86_400_000;
  fs.writeFileSync(
    monthFile(gdir, 'all', Date.now()),
    Array.from({ length: 600 }, (_, i) =>
      JSON.stringify({
        v: 1,
        kind: 'post',
        post: { id: `g${i}`, at: t0 + i * 60_000, sender: i % 3 ? LEADS[i % 8] : null, text: `${i}번째 글: 오늘 배포 전에 \`server/src/agent-tycoon/file${i % 40}.ts\` 를 같이 봐 주세요.`, targets: [], delivery: {} },
      }),
    ).join('\n') + '\n',
  );

  const PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const daemon: Daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { PATH, FAKE_TURN_MS: '240000', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8' },
    true,
    process.env.CLI ? path.resolve(process.env.CLI) : undefined,
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
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
  const LONG = Array.from({ length: 10 }, (_, i) => `${i + 1}번째로 바꾼 곳은 \`server/src/agent-tycoon/file${i}.ts\` 이고, 상태를 따로 세도록 고쳤어요.`).join(' ');
  const results: Rec = { label: LABEL, cli: process.env.CLI ?? 'dist/cli.js', viewport: VIEWPORT, restMs: REST_MS };
  const runs: Rec[] = [];
  const errors: string[] = [];
  try {
    await daemon.loginUrl();
    for (const l of LEADS) await until(`${l} revived`, () => !!sessionOf(l), 120_000);
    {
      const s = sessionOf('alpha')!;
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const at0 = Date.now() - 400 * 90_000;
      const lines: string[] = [];
      for (let i = 0; i < 400; i++) {
        lines.push(JSON.stringify(stamp({ type: 'user', message: { content: `${i}번 일: 정리해 주세요` } }, at0 + i * 90_000)));
        lines.push(
          JSON.stringify(
            stamp(
              { type: 'assistant', message: { role: 'assistant', model: MODEL, content: [{ type: 'text', text: `${i}. ${LONG}` }], usage: { input_tokens: 10, cache_read_input_tokens: 40_000, output_tokens: 100 } } },
              at0 + i * 90_000 + 30_000,
            ),
          ),
        );
        lines.push(JSON.stringify(stamp({ type: 'system', subtype: 'turn_duration', durationMs: 1200 }, at0 + i * 90_000 + 31_000)));
      }
      fs.appendFileSync(file, lines.join('\n') + '\n');
    }
    browser = await launchBrowser({ partyFrame: true });
    for (const dpr of DPRS) {
      const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: dpr });
      await ctx.addInitScript(INIT);
      await ctx.addInitScript(() => {
        for (const [k, v] of [
          ['agty.office-iso', 'on'],
          ['agty.backdrop', 'on'],
          ['agty.floor', '1'],
          ['agty.camera-mode', 'auto'],
          ['agty.terminal-renderer', 'webgl'], // the app's default (launchBrowser's is the DOM one)
        ])
          try {
            localStorage.setItem(k, v);
          } catch {
            /* about:blank */
          }
      });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      const toast = await page.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 4_000 }).catch(() => null);
      const v = toast?.match(/v([\d.]+)/)?.[1];
      if (v) {
        await page.evaluate((x) => localStorage.setItem('agty.changelogSeen', x), v);
        await page.reload();
      }
      await until('eight portraits', async () => (await page.locator('[data-portrait]').count()) >= LEADS.length, 60_000);
      const hooks = (js: string) => page.evaluate(`window.__agentTycoonTestHooks.${js}`);
      await until('the owner sheet loaded', async () => ((await hooks('loadedPresetSheets()')) as string[]).some((u) => u.includes('t-boss')), 60_000);
      await until('the bunny palette', async () => ((await hooks(`spawnPreset('builtin-bunny', 0, 9500)`)) as number) >= 0, 60_000);
      await hooks(`spawnPreset('builtin-bunny', 2, 9500)`);
      await wait(6000);
      const cdp = await ctx.newCDPSession(page);
      const tag = `${LABEL}-${dpr}`;
      const icon = (id: string) => page.locator(`[data-hud-id="icon:${id}"]`).getByRole('button').first();
      const log: string[] = [];
      const tryDo = async (what: string, fn: () => Promise<unknown>) => {
        try {
          await fn();
          log.push(`ok ${what}`);
        } catch (e) {
          log.push(`skip ${what}: ${String(e).split('\n')[0].slice(0, 140)}`);
        }
      };
      // ── open: messenger on alpha, 현황판, 개발실 with two terminal panes ──
      const msgr = page.locator('[data-hud-window="messenger"]');
      await tryDo('messenger on alpha', async () => {
        await icon('messenger').click({ timeout: 5_000 });
        await msgr.waitFor({ timeout: 5_000 });
        await msgr.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }).click({ timeout: 5_000 });
        await msgr.getByTestId('chat-scroll').first().waitFor({ timeout: 10_000 });
      });
      await tryDo('현황판', async () => {
        await icon('office').click({ timeout: 5_000 });
        await page.locator('[data-hud-window="office"]').waitFor({ timeout: 5_000 });
      });
      const dev = page.locator('[data-hud-window="devroom"]');
      await tryDo('개발실, two terminal panes', async () => {
        await icon('devroom').click({ timeout: 5_000 });
        await dev.waitFor({ timeout: 20_000 });
        await dev.getByTestId('devroom-layout-2').click({ timeout: 20_000 });
        await until('two panes', async () => (await dev.getByTestId('devroom-pane').count()) === 2, 10_000);
        for (let i = 0; i < 2; i++) {
          const pane = dev.getByTestId('devroom-pane').nth(i);
          if (i === 1 && !(await pane.getAttribute('data-agent'))) {
            const first = await dev.getByTestId('devroom-pane').nth(0).getAttribute('data-agent');
            const names = (await pane.getByTestId('devroom-pane-pick').locator('option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).filter(Boolean);
            const other = names.find((n) => n !== first);
            if (!other) break; // one agent with a terminal here: one terminal pane (an agent shows in one pane)
            await pane.getByTestId('devroom-pane-pick').selectOption(other);
          }
          await pane.locator('[data-testid="devroom-pane-view"][data-view="terminal"]').click({ timeout: 5_000 });
        }
        await until('the xterms', async () => (await dev.locator('.xterm').count()) >= 1, 30_000);
      });
      await wait(5000);
      await page.screenshot({ path: path.join(OUT, `${tag}-open.png`) });
      const open = { rest: await rest(page, REST_MS, `${dpr} open`), sample: await sample(page, cdp, `${dpr} open`, SNAP && dpr === 2) };
      // ── office: the windows closed ──
      for (const [id, close] of [['devroom', '개발실 닫기'], ['office', '현황판 닫기'], ['messenger', '메신저 닫기']])
        await tryDo(`${id} closed`, async () => {
          const w = page.locator(`[data-hud-window="${id}"]`);
          if (!(await w.isVisible())) return;
          await w.getByRole('button', { name: close, exact: true }).first().click({ timeout: 5_000 });
          await w.waitFor({ state: 'hidden', timeout: 5_000 });
        });
      await wait(4000);
      await page.screenshot({ path: path.join(OUT, `${tag}-office.png`) });
      const office = { rest: await rest(page, REST_MS, `${dpr} office`, PROFILE && dpr === 2), sample: await sample(page, cdp, `${dpr} office`) };
      console.log(`  ${log.join('\n  ')}`);
      runs.push({ dpr, steps: log, open, office });
      if (dpr === DPRS[DPRS.length - 1]) {
        // Every detailed frame at each zoom, hashed: the same pictures before and after a change.
        // Zoom 1-5 first (what the office drew so far), then a close zoom, then 6-10 once it settles.
        const low = await hooks('sheetDigest([1, 2, 3, 4, 5])');
        await hooks('sheetDigest([10])');
        await wait(3000);
        results.digest = { low, high: await hooks('sheetDigest([6, 7, 8, 9, 10])') };
        console.log(`digest ${JSON.stringify(results.digest)}`);
      }
      await ctx.close();
      await wait(2000);
    }
    results.runs = runs;
    results.errors = errors;
    fs.writeFileSync(path.join(OUT, `${LABEL}.json`), JSON.stringify(results, null, 1));
    if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  } finally {
    clearTimeout(deadline);
    await browser?.close().catch(() => undefined);
    killFakeSessions(home);
    await daemon.stop();
    for (const r of repos) r.cleanup();
    removeTestHome(home);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
