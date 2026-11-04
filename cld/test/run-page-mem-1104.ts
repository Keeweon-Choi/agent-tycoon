/**
 * PAGE-MEM (owner 11-04 21:13 "원격 프로그램에서는 2기가 먹고 있는데? ... 페이지 부하가 넘 큰거같아"):
 * the page's memory and its load at rest, in an office like the owner's. dist/cli.js (or CLI=<path>,
 * a baseline build) in a temp HOME (the engine fake as `claude-pty`, never a real agent), headless
 * Chromium (--disable-gpu: canvases and decoded pictures live in the renderer, so the GPU process
 * the owner sees is not measured here), 1536×864 at dpr 1.25 (1920×1080 at 125 %), the iso view.
 *
 * The office: 6 Leads on 3 floors, the owner wearing a 2304×3168 iso8 test sheet, two built-in
 * bunnies (2592×2640), one Lead in another test sheet, 8 imported test sheets as presets (never
 * the owner's files), 10 built-in people and 10 mascots; alpha's conversation 400 turns long, the
 * 전체방 600 posts.
 *
 * Phases: settled (rest R s: renderer CPU, frames drawn), then USE_MS of use (messenger, its long
 * conversation and the room scrolled, the 개발실, a terminal, floors up and down, zoom in and out,
 * windows opened and closed), then rest again. At each: the renderer's PSS/RSS, the JS heap
 * (+ ArrayBuffer backing stores), DOM nodes, and a census of every live canvas, ImageBitmap,
 * ImageData and decoded <img> (an init script holds WeakRefs; sizes in MB at 4 bytes a pixel),
 * grouped by the code that made them (STACKS=1: names need an unminified build).
 * Output: cld/artifacts/page-mem-1104/<LABEL>.json (+ <LABEL>-*.png).
 *
 *   taskset -c 0-3 npx tsx cld/test/run-page-mem-1104.ts <port 18450-18459> [LABEL]
 */
import type { Browser, CDPSession, Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { monthFile } from '../../server/src/cld/engine/groupLogFiles.js';
import { groupTimelineDir } from '../../server/src/cld/engine/groups.js';
import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  type Daemon,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18450 && port <= 18459)) throw new Error('port 18450-18459');
const LABEL = process.argv[3] ?? 'run';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/page-mem-1104');
const USE_MS = Number(process.env.USE_MS ?? 60_000);
const REST_MS = Number(process.env.REST_MS ?? 20_000);
const STACKS = process.env.STACKS === '1';
const DEADLINE_MS = 240_000 + USE_MS + 3 * REST_MS;
const LEADS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'];
const MODEL = 'claude-sonnet-4-5';
const VIEW = { viewport: { width: 1536, height: 864 }, deviceScaleFactor: 1.25 };
const SHEET_CACHE = path.join(os.tmpdir(), 'page-mem-1104-sheets');
const SHEETS = ['t-boss', ...Array.from({ length: 7 }, (_, i) => `t-char-${i + 1}`)];
const MASCOTS = ['coral', 'byte', 'puff', 'tori', 'kwak', 'bugi', 'moka', 'mungge', 'boo', 'gasi'];

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

// Page side: WeakRefs to every canvas, bitmap, ImageData and <img> made, with the code that made it.
const INIT = `
  globalThis.__name = (fn) => fn;
  window.__AGENT_TYCOON_E2E = true;
  (() => {
    const STACKS = ${STACKS};
    const live = (window.__pm = { refs: [], frames: [], rec: false });
    const where = () => {
      if (!STACKS) return '';
      const s = (new Error().stack || '').split('\\n').slice(3, 8);
      return s.map((l) => (/at (?:new )?([\\w.$<>]+)/.exec(l) || [, '?'])[1]).join(' < ');
    };
    const keep = (kind, o) => live.refs.push({ kind, ref: new WeakRef(o), at: where() });
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
    // frames the office canvas drew (its full clear)
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (x, y, w, h) {
      if (live.rec && x === 0 && y === 0 && this.canvas.dataset && this.canvas.dataset.testid === 'office-canvas') live.frames.push(performance.now());
      return clear.call(this, x, y, w, h);
    };
    window.__census = () => {
      const by = {};
      const byAt = {};
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
        const k = r.kind + (attached ? '(dom)' : '');
        const b = (by[k] ??= { n: 0, mb: 0 });
        b.n++; b.mb += (px * 4) / 1048576;
        const sizeKey = k + ' ' + (r.kind === 'imagedata' ? o.width + 'x' + o.height : (o.naturalWidth || o.width) + 'x' + (o.naturalHeight || o.height));
        const a = (byAt[(STACKS ? r.at + ' | ' : '') + (px * 4 > 262144 ? sizeKey : k + ' small')] ??= { n: 0, mb: 0 });
        a.n++; a.mb += (px * 4) / 1048576;
      }
      const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { n: v.n, mb: +v.mb.toFixed(1) }]).sort((x, y) => y[1].mb - x[1].mb));
      const total = Object.values(by).reduce((t, v) => t + v.mb, 0);
      return { totalMB: +total.toFixed(1), objects: n, byKind: round(by), top: Object.entries(round(byAt)).slice(0, 30) };
    };
  })();
`;

/** An imported iso8 sheet with its drink row (8 columns of 288×528, 6 rows): a noisy figure per
 *  cell in its own hue, as big on disk as the owner's (run-looks-mem-1104.ts's). */
function makeSheet(file: string, hue: number): void {
  const [W, H, FW, FH] = [2304, 3168, 288, 528];
  const png = new PNG({ width: W, height: H });
  const base = [
    [200, 60, 60],
    [60, 160, 70],
    [60, 90, 200],
    [190, 160, 40],
    [150, 60, 180],
    [40, 160, 170],
    [210, 110, 40],
    [120, 120, 120],
  ][hue % 8];
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
const kindOf = (pid: number) => {
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
    if (!cmd.includes('chrom')) return 'other';
    return /--type=([a-z-]+)/.exec(cmd)?.[1] ?? 'browser';
  } catch {
    return 'gone';
  }
};
const read = (f: string) => {
  try {
    return fs.readFileSync(f, 'utf-8');
  } catch {
    return '';
  }
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

/** Chrome's own memory dump (memory-infra): the tab renderer's allocators (MB, effective size;
 *  names up to three levels deep). */
async function memDump(browser: Browser): Promise<Record<string, number>> {
  const b = await browser.newBrowserCDPSession();
  const events: Array<{
    ph: string;
    pid: number;
    args?: {
      dumps?: { allocators?: Record<string, { attrs?: Record<string, { value: string }> }> };
    };
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
  const per = new Map<number, Record<string, number>>();
  for (const e of events) {
    const al = e.ph === 'v' ? e.args?.dumps?.allocators : undefined;
    if (!al) continue;
    const out = per.get(e.pid) ?? {};
    for (const [name, a] of Object.entries(al)) {
      if (name.split('/').length > 3) continue;
      const v = a.attrs?.effective_size?.value ?? a.attrs?.size?.value;
      if (!v) continue;
      const mb = parseInt(v, 16) / 1048576;
      if (mb >= 1) out[name] = +mb.toFixed(1);
    }
    per.set(e.pid, out);
  }
  const renderers = [...per.values()].filter((o) => 'blink_gc' in o);
  renderers.sort(
    (x, y) =>
      (y.malloc ?? 0) + (y.partition_alloc ?? 0) - ((x.malloc ?? 0) + (x.partition_alloc ?? 0)),
  );
  return Object.fromEntries(Object.entries(renderers[0] ?? {}).sort((x, y) => y[1] - x[1]));
}

async function sample(page: Page, cdp: CDPSession, label: string) {
  await cdp.send('HeapProfiler.collectGarbage');
  await wait(1200);
  await cdp.send('HeapProfiler.collectGarbage');
  await wait(600);
  const heap = (await cdp.send('Runtime.getHeapUsage')) as {
    usedSize: number;
    totalSize: number;
    backingStorageSize?: number;
    embedderHeapUsedSize?: number;
  };
  const dom = (await cdp.send('Memory.getDOMCounters')) as {
    documents: number;
    nodes: number;
    jsEventListeners: number;
  };
  const census = (await page.evaluate('window.__census()')) as Rec;
  const tab = tabRenderer();
  const pids = descendants(process.pid);
  const gpu = pids.filter((p) => kindOf(p) === 'gpu-process').reduce((a, p) => a + pssMB(p), 0);
  const app = (await page.evaluate(`(() => {
    const h = window.__agentTycoonTestHooks;
    return { warm: h.warmState?.(), characters: h.getCharacters?.().length, sheets: h.loadedPresetSheets?.().map((u) => (/characters\\/([^.?]+)/.exec(u) || [, u])[1]), windows: [...document.querySelectorAll('[data-hud-window]')].map((w) => w.getAttribute('data-hud-window') + ':' + w.getElementsByTagName('*').length + (w.getClientRects().length ? '' : '(hidden)')), xterm: document.querySelectorAll(".xterm").length, elements: document.getElementsByTagName("*").length, canvas: (() => { const c = document.querySelector('[data-testid="office-canvas"]'); return c ? c.width + 'x' + c.height : null; })(), dpr: devicePixelRatio, mem: h.pictures?.() };
  })()`)) as Rec;
  const allocators =
    process.env.MEMDUMP === '0'
      ? {}
      : await memDump(page.context().browser()!).catch((e) => ({ failed: String(e) }) as never);
  const row = {
    label,
    allocators,
    rendererPssMB: Math.round(pssMB(tab)),
    rendererRssMB: Math.round(rssMB(tab)),
    gpuPssMB: Math.round(gpu),
    jsHeapMB: +(heap.usedSize / 1048576).toFixed(1),
    backingStoreMB: +((heap.backingStorageSize ?? 0) / 1048576).toFixed(1),
    embedderMB: +((heap.embedderHeapUsedSize ?? 0) / 1048576).toFixed(1),
    domNodes: dom.nodes,
    listeners: dom.jsEventListeners,
    pictures: census,
    app,
  };
  console.log(
    `[${label}] renderer PSS ${row.rendererPssMB} MB RSS ${row.rendererRssMB} MB, heap ${row.jsHeapMB} MB (+${row.backingStoreMB} buffers), DOM ${row.domNodes}, pictures ${census.totalMB} MB in ${census.objects}`,
  );
  return row;
}

/** `ms` of no input: the renderer's CPU and the frames the office drew. */
async function rest(page: Page, ms: number, label: string) {
  await page.mouse.move(2, 2);
  await wait(1500);
  const tab = tabRenderer();
  const gpus = descendants(process.pid).filter((p) => kindOf(p) === 'gpu-process');
  await page.evaluate('window.__pm.frames = []; window.__pm.rec = true');
  const [c0, g0, t0] = [cpuSec(tab), gpus.reduce((a, p) => a + cpuSec(p), 0), Date.now()];
  if (process.env.DIAG === '1')
    // what keeps the rate up: the camera, the owner, the doors, the characters moving
    for (let t = 0; t < ms; t += 2000) {
      console.log(
        JSON.stringify(
          await page.evaluate(`(() => { const h = window.__agentTycoonTestHooks; const c = h.getCamera(); const o = h.getCharacterTile(-2000000000);
            return { pan: [Math.round(c.pan.x), Math.round(c.pan.y)], zoom: c.zoom, follow: h.getCameraFollowId(), owner: o && [o.state, o.ride, o.col, o.row], busy: h.getBusy(), doors: h.getElevators().map((e) => e.open), walking: h.getCharacters().filter((x) => h.getCharacterTile(x.id)?.state === 'walk').length, fx: h.getCharacters().filter((x) => x.matrixEffect).map((x) => x.id + ':' + x.matrixEffect) }; })()`),
        ),
      );
      await wait(2000);
    }
  else await wait(ms);
  const secs = (Date.now() - t0) / 1000;
  const [c1, g1] = [cpuSec(tab), gpus.reduce((a, p) => a + cpuSec(p), 0)];
  const frames = (await page.evaluate(
    'window.__pm.rec = false; window.__pm.frames.length',
  )) as number;
  const row = {
    label,
    secs: +secs.toFixed(1),
    rendererCpuPct: +(((c1 - c0) / secs) * 100).toFixed(1),
    gpuProcCpuPct: +(((g1 - g0) / secs) * 100).toFixed(1),
    drawsPerSec: +(frames / secs).toFixed(1),
  };
  console.log(
    `[${label}] at rest: renderer CPU ${row.rendererCpuPct} %, office draws ${row.drawsPerSec}/s`,
  );
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
  const put = (rel: string, data: unknown) =>
    fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const ids = LEADS.map((_, i) => String.fromCharCode(97 + i).repeat(10));
  const folders = LEADS.map((l) => fs.mkdtempSync(path.join(home, `${l}-`)));
  put('projects.json', {
    v: 2,
    projects: LEADS.map((l, i) => ({
      projectId: `p_${ids[i]}`,
      name: l,
      folder: folders[i],
      room: `${l}-room`,
      leadAssignmentId: `a_${ids[i]}`,
    })),
  });
  put('assignments.json', {
    v: 1,
    assignments: LEADS.map((_, i) => ({
      assignmentId: `a_${ids[i]}`,
      projectId: `p_${ids[i]}`,
      role: 'lead',
      provider: 'claude-pty',
      model: MODEL,
      wantRunning: true,
    })),
  });
  put('building.json', {
    version: 1,
    perProject: false,
    floors: [0, 1, 2].map((f) => ({
      id: String(f + 1),
      name: `${f + 1}층`,
      rooms: LEADS.slice(f * 2, f * 2 + 2).map((l) => `${l}-room`),
      characters: [],
    })),
  });
  const chars = path.join(cfg, 'characters');
  fs.mkdirSync(chars, { recursive: true });
  for (const id of SHEETS) {
    fs.copyFileSync(path.join(SHEET_CACHE, `${id}.png`), path.join(chars, `${id}.png`));
    fs.writeFileSync(
      path.join(chars, `${id}.json`),
      JSON.stringify({ label: id, columns: 'standFirst', walk: 'steps' }),
    );
  }
  put('characters.json', {
    $meta: { v: 3, pinnedAt: new Date().toISOString() },
    owner: { preset: 't-boss' },
    alpha: { preset: 't-char-1' },
  });
  // the 전체방, 600 posts long
  const gdir = groupTimelineDir(home);
  fs.mkdirSync(gdir, { recursive: true });
  const t0 = Date.now() - 3 * 86_400_000;
  fs.writeFileSync(
    monthFile(gdir, 'all', Date.now()),
    Array.from({ length: 600 }, (_, i) =>
      JSON.stringify({
        v: 1,
        kind: 'post',
        post: {
          id: `g${i}`,
          at: t0 + i * 60_000,
          sender: i % 3 ? LEADS[i % 6] : null,
          text: `${i}번째 글: 오늘 배포 전에 \`server/src/cld/file${i % 40}.ts\` 를 같이 봐 주세요. 테스트는 다 통과했어요.`,
          targets: [],
          delivery: {},
        },
      }),
    ).join('\n') + '\n',
  );

  const daemon: Daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat'],
    { FAKE_TURN_MS: '240000', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    false,
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
        const s = JSON.parse(
          fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8'),
        ) as { name: string; sessionId: string; cwd: string };
        if (s.name === name) return s;
      } catch {
        /* written as we read */
      }
    }
    return undefined;
  };
  const said = (content: unknown[]) => ({
    type: 'assistant',
    message: {
      role: 'assistant',
      model: MODEL,
      content,
      usage: { input_tokens: 10, cache_read_input_tokens: 40_000, output_tokens: 100 },
    },
  });
  const LONG = Array.from(
    { length: 10 },
    (_, i) =>
      `${i + 1}번째로 바꾼 곳은 \`server/src/cld/file${i}.ts\` 이고, 상태를 따로 세도록 고쳤어요.`,
  ).join(' ');

  const results: Rec = { label: LABEL, cli: process.env.CLI ?? 'dist/cli.js', view: VIEW };
  const samples: unknown[] = [];
  const rests: unknown[] = [];
  const errors: string[] = [];
  try {
    await daemon.loginUrl();
    for (const l of LEADS) await until(`${l} revived`, () => !!sessionOf(l), 90_000);
    // alpha's conversation: 400 turns
    {
      const s = sessionOf('alpha')!;
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const at0 = Date.now() - 400 * 90_000;
      const lines: string[] = [];
      for (let i = 0; i < 400; i++) {
        lines.push(
          JSON.stringify(
            stamp(
              { type: 'user', message: { content: `${i}번 일: 정리해 주세요` } },
              at0 + i * 90_000,
            ),
          ),
        );
        lines.push(
          JSON.stringify(
            stamp(said([{ type: 'text', text: `${i}. ${LONG}` }]), at0 + i * 90_000 + 30_000),
          ),
        );
        lines.push(
          JSON.stringify(
            stamp(
              { type: 'system', subtype: 'turn_duration', durationMs: 1200 },
              at0 + i * 90_000 + 31_000,
            ),
          ),
        );
      }
      fs.appendFileSync(file, lines.join('\n') + '\n');
    }
    browser = await launchBrowser({ partyFrame: true });
    const ctx = await browser.newContext(VIEW);
    await ctx.addInitScript(INIT);
    await ctx.addInitScript(() => {
      for (const [k, v] of [
        ['cld.office-iso', 'on'],
        ['cld.backdrop', 'on'],
        ['cld.floor', '1'],
        ['cld.camera-mode', 'auto'],
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
    const toast = await page
      .getByText(/으로 업데이트됐어요/)
      .first()
      .textContent({ timeout: 4_000 })
      .catch(() => null);
    const v = toast?.match(/v([\d.]+)/)?.[1];
    if (v) {
      await page.evaluate((x) => localStorage.setItem('cld.changelogSeen', x), v);
      await page.reload();
    }
    await until(
      'six portraits',
      async () => (await page.locator('[data-portrait]').count()) >= LEADS.length,
      60_000,
    );
    const hooks = (js: string) => page.evaluate(`window.__agentTycoonTestHooks.${js}`);
    await until(
      'the owner sheet loaded',
      async () =>
        ((await hooks('loadedPresetSheets()')) as string[]).some((u) => u.includes('t-boss')),
      60_000,
    );
    await until(
      'the bunny palette',
      async () => ((await hooks(`spawnPreset('builtin-bunny', 0, 9500)`)) as number) >= 0,
      60_000,
    );
    await hooks(`spawnPreset('builtin-bunny', 2, 9500)`);
    await hooks(`spawnLook({ palette: 0 }, 10, 9000)`);
    for (const [i, species] of MASCOTS.entries())
      await hooks(`spawnLook({ kind: 'mascot', species: '${species}' }, 1, ${9100 + i})`);
    await wait(8000);
    const cdp = await ctx.newCDPSession(page);
    const iso = (await hooks('getIso().drawn')) as boolean;
    const characters = (await hooks('getCharacters().length')) as number;
    console.log(`iso drawn ${iso}, ${characters} characters`);
    results.iso = iso;
    results.characters = characters;
    await page.screenshot({ path: path.join(OUT, `${LABEL}-office.png`) });
    rests.push(await rest(page, REST_MS, 'settled'));
    samples.push(await sample(page, cdp, 'settled'));

    // ── a minute of use ──
    const canvas = page.getByTestId('office-canvas');
    const icon = (id: string) =>
      page.locator(`[data-hud-id="icon:${id}"]`).getByRole('button').first();
    const msgr = page.locator('[data-hud-window="messenger"]');
    const log: string[] = [];
    const tryDo = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        log.push(`ok ${what}`);
      } catch (e) {
        log.push(`skip ${what}: ${String(e).split('\n')[0].slice(0, 120)}`);
      }
    };
    const scrollChat = async (testId = 'chat-scroll') => {
      const box = await msgr.getByTestId(testId).first().boundingBox({ timeout: 5_000 });
      if (!box) throw new Error('no chat-scroll');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let i = 0; i < 25; i++) {
        await page.mouse.wheel(0, -900);
        await wait(80);
      }
    };
    const stopAt = Date.now() + USE_MS;
    let round = 0;
    while (Date.now() < stopAt) {
      round++;
      await tryDo('messenger open', async () => {
        if (!(await msgr.isVisible())) await icon('messenger').click({ timeout: 3_000 });
        await msgr.waitFor({ timeout: 5_000 });
      });
      await tryDo('alpha chat scrolled', async () => {
        await msgr
          .getByRole('list', { name: '연락처' })
          .getByRole('button', { name: /^alpha/ })
          .click({ timeout: 3_000 });
        await wait(800);
        await scrollChat();
      });
      await tryDo('전체방 scrolled', async () => {
        await msgr
          .getByRole('button', { name: /^# ?전체|^전체/ })
          .first()
          .click({ timeout: 3_000 });
        await wait(800);
        await scrollChat('room-scroll');
      });
      if (round === 1) await page.screenshot({ path: path.join(OUT, `${LABEL}-messenger.png`) });
      await tryDo('messenger closed', () => icon('messenger').click({ timeout: 3_000 }));
      await tryDo('개발실 open', async () => {
        await icon('devroom').click({ timeout: 3_000 });
        await wait(2500);
      });
      if (round === 1) await page.screenshot({ path: path.join(OUT, `${LABEL}-devroom.png`) });
      await tryDo('개발실 closed', () => icon('devroom').click({ timeout: 3_000 }));
      for (const dir of ['up', 'up', 'down', 'down'])
        await tryDo(`floor ${dir}`, async () => {
          await page.getByTestId(`elevator-${dir}`).click({ timeout: 3_000 });
          await wait(700);
        });
      await tryDo('zoom', async () => {
        const cb = (await canvas.boundingBox())!;
        await page.mouse.move(cb.x + cb.width * 0.45, cb.y + cb.height * 0.5);
        for (const d of [-120, -120, -120, -120, 120, 120, 120, 120, -120, 120]) {
          await page.mouse.wheel(0, d);
          await wait(150);
        }
      });
      await tryDo('pan', async () => {
        const cb = (await canvas.boundingBox())!;
        const [cx, cy] = [cb.x + cb.width * 0.45, cb.y + cb.height * 0.5];
        await page.mouse.move(cx, cy);
        await page.mouse.down({ button: 'middle' });
        await page.mouse.move(cx + 200, cy + 100, { steps: 15 });
        await page.mouse.move(cx, cy, { steps: 15 });
        await page.mouse.up({ button: 'middle' });
      });
    }
    // as the owner leaves it: the messenger open on alpha
    await tryDo('messenger open (end)', async () => {
      if (!(await msgr.isVisible())) await icon('messenger').click({ timeout: 3_000 });
      await msgr
        .getByRole('list', { name: '연락처' })
        .getByRole('button', { name: /^alpha/ })
        .click({ timeout: 3_000 });
    });
    const counts = new Map<string, number>();
    for (const l of log) counts.set(l, (counts.get(l) ?? 0) + 1);
    results.use = { rounds: round, steps: [...counts].map(([k, n]) => `${n}x ${k}`) };
    console.log(
      `use: ${round} rounds\n  ${[...counts].map(([k, n]) => `${n}x ${k}`).join('\n  ')}`,
    );
    await page.screenshot({ path: path.join(OUT, `${LABEL}-after-use.png`) });
    samples.push(await sample(page, cdp, 'after use'));
    rests.push(await rest(page, REST_MS, 'after use'));
    samples.push(await sample(page, cdp, 'after use + rest'));
    await tryDo('messenger closed (end)', () => icon('messenger').click({ timeout: 3_000 }));
    await wait(2000);
    samples.push(await sample(page, cdp, 'windows closed'));
    // the closest zoom on the owner (a 2304×3168 sheet) and on the whole floor, for the eye
    await hooks('setZoom(10)');
    await hooks('centerOn(-2000000000)');
    await wait(4000);
    await page.screenshot({
      path: path.join(OUT, `${LABEL}-zoom10.png`),
      clip: { x: 568, y: 232, width: 400, height: 400 },
    });
    results.samples = samples;
    results.rests = rests;
    results.errors = errors;
    fs.writeFileSync(path.join(OUT, `${LABEL}.json`), JSON.stringify(results, null, 1));
    if (errors.length) console.log(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  } finally {
    clearTimeout(deadline);
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
