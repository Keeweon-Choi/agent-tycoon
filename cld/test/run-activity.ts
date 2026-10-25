/**
 * T-0026 check: dist/cli.js with an isolated HOME on a spare port, in headless
 * Chromium. Claude Code sessions are what the daemon reads (T-0013): one
 * ~/.claude/sessions/<pid>.json per live process (a `sleep` each), one
 * character per activity plus five at set 피로도 levels; one engine project that is registered but off
 * (sleeper) adds an off character. Tool and
 * usage records appended to the transcripts drive them. On desktop (1280x800)
 * and phone (393x852) at once:
 * - each head badge shows its activity: emoji, prop, ring, the state in words;
 * - the office canvas draws that prop and that ring, pixel for pixel
 *   (props.json at the canvas zoom, placed from the badge's position);
 * - an EZ label is the name and 피로도 until hovered (desktop) or tapped (phone),
 *   which adds the activity in words;
 * - 피로도 (20 / 75 / 90 / 98 %, two context drops):
 *   the bar, sweat drops and yawns on the canvas, the rest bubble and its
 *   suggestion on a tap, the same on the 현황판 cards;
 * - 범례 lists every ring state, prop and fatigue sign;
 * - there is no 자세히 mode or EZ button; the raw status is a tooltip.
 * Hangul from Malgun Gothic and emoji from Segoe UI Emoji (Windows fonts, read
 * only; this Linux has no emoji font). Screenshots go to cld/artifacts/t0026/.
 *
 *   npx tsx cld/test/run-activity.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { appendEvent, eventsPath } from '../../server/src/cld/engine/events.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
  writeEngineProjects,
} from '../../server/src/cld/testHome.js';
import propData from '../../webview-ui/src/cld/ez/props.json';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0026');
/** U-15 / U-34 / U-35 screenshots. */
const UI_OUT = path.join(REPO_ROOT, 'cld/artifacts/ui-b2');
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0026/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0026/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
// Ring rims (constants.ts ACTIVITY_RING_COLORS); off and neutral are translucent.
const RIMS: Record<string, string> = {
  working: '#58d46a',
  waiting: '#f0b43c',
  permission: '#f0483c',
  idle: '#a8aac0',
};

type Rec = Record<string, unknown>;
const tid = () => `tu-${Math.random().toString(36).slice(2, 10)}`;
/** An assistant record: tool calls and/or text, with the context it carried. */
const said = (content: Rec[], tokens?: number): Rec => ({
  type: 'assistant',
  message: {
    model: 'claude-haiku-4-5', // a 200k window
    content,
    ...(tokens && {
      usage: { input_tokens: 10, cache_read_input_tokens: tokens - 110, output_tokens: 100 },
    }),
  },
});
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const result = (id: string): Rec => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
});
/** A finished tool: the agent stays active and shows it, and no permission timer runs. */
const ran = (name: string, input: Rec, tokens?: number) => {
  const id = tid();
  return [said([call(id, name, input)], tokens), result(id)];
};
const sh = (command: string) => ran('Bash', { command });
const text = (tokens: number) => said([{ type: 'text', text: 'ok' }], tokens);
const sub = (msg: Rec): Rec => ({
  type: 'progress',
  parentToolUseID: 'tu-boss-task',
  data: { type: 'agent_progress', message: msg },
});

interface Fatigue {
  value: number;
  tone: string;
  sweat: boolean;
  yawn: boolean;
  rest: boolean;
  /** The line beside the bar: 피로도 N% · 휴식 N/M (T-0045). */
  text: string;
}
interface Member {
  room: string;
  records: Rec[];
  icon: string;
  prop: string;
  ring: string;
  fatigue?: Fatigue;
}
// T-0045/T-0047: 피로도 is the context %, tired from 60, yawning from 70, the rest bubble
// from 80 only; compactions reaching office's 2 just highlight "휴식 2/2".
const tired = (value: number, compactions = 0, threshold: number | null = null): Fatigue => ({
  value,
  tone: value >= 70 ? 'worn' : value >= 60 ? 'tired' : 'fresh',
  sweat: value >= 60,
  yawn: value >= 70,
  rest: value >= 80,
  text: `피로도 ${value}% · 휴식 ${compactions}${threshold === null ? '' : `/${threshold}`}`,
});

/** Claude Code sessions, by name: where they work, what they do, what they must show. */
const CAST: Record<string, Member> = {
  read: {
    room: 'alpha',
    icon: '📖',
    prop: 'book',
    ring: 'working',
    records: ran('Read', { file_path: '/work/alpha/app.ts' }),
  },
  edit: {
    room: 'alpha',
    icon: '✏️',
    prop: 'keys',
    ring: 'working',
    records: ran('Edit', { file_path: '/work/alpha/app.ts' }),
  },
  write: {
    room: 'alpha',
    icon: '📝',
    prop: 'paper',
    ring: 'working',
    records: ran('Write', { file_path: '/work/alpha/new.ts' }),
  },
  search: {
    room: 'alpha',
    icon: '🔎',
    prop: 'magnifier',
    ring: 'working',
    records: ran('Grep', { pattern: 'TODO' }),
  },
  test: { room: 'alpha', icon: '🧪', prop: 'flask', ring: 'working', records: sh('npm test') },
  build: {
    room: 'alpha',
    icon: '🔨',
    prop: 'hammer',
    ring: 'working',
    records: sh('npm run build'),
  },
  install: { room: 'beta', icon: '📥', prop: 'box', ring: 'working', records: sh('npm install') },
  web: {
    room: 'beta',
    icon: '🌐',
    prop: 'globe',
    ring: 'working',
    records: ran('WebFetch', { url: 'https://example.test' }),
  },
  boss: {
    room: 'beta',
    icon: '🤝',
    prop: 'link',
    ring: 'working',
    records: [
      said([call('tu-boss-task', 'Task', { description: 'fix the login bug', prompt: 'x' })]),
      sub(said([call('tu-sub-1', 'Grep', { pattern: 'login' })])),
      sub(result('tu-sub-1')),
    ],
  },
  codex: {
    room: 'beta',
    icon: '🤖',
    prop: 'robot',
    ring: 'working',
    records: sh('codex exec "fix the bug"'),
  },
  train: {
    room: 'beta',
    icon: '🏋️',
    prop: 'dumbbell',
    ring: 'working',
    records: sh('python3 train.py --epochs 3'),
  },
  tool: { room: 'beta', icon: '⚙️', prop: 'gear', ring: 'working', records: ran('FancyTool', {}) },
  ask: {
    room: 'gamma',
    icon: '✋',
    prop: 'hand',
    ring: 'waiting',
    records: [said([call('tu-ask', 'AskUserQuestion', { questions: [] })])],
  },
  // Left running: the heuristic permission timer (7 s) asks for approval.
  perm: {
    room: 'gamma',
    icon: '🔐',
    prop: 'lock',
    ring: 'permission',
    records: [said([call('tu-perm', 'Bash', { command: 'rm -rf build' })])],
  },
  idle: { room: 'gamma', icon: '☕', prop: 'mug', ring: 'idle', records: [] },
  shell: { room: 'gamma', icon: '💻', prop: '', ring: 'working', records: sh('echo hello') },
  // U-35: busy with no tool running: thinking, the widening dot bubble over its head.
  think: { room: 'gamma', icon: '🤔', prop: '', ring: 'working', records: [] },
  // 피로도 = the context %; the compactions show beside it.
  fresh: {
    room: 'delta',
    icon: '☕',
    prop: 'mug',
    ring: 'idle',
    records: [text(40_000)],
    fatigue: tired(20),
  },
  tired: {
    room: 'delta',
    icon: '✏️',
    prop: 'keys',
    ring: 'working',
    records: ran('Edit', { file_path: '/work/delta/a.ts' }, 150_000),
    fatigue: tired(75),
  },
  sleepy: {
    room: 'delta',
    icon: '☕',
    prop: 'mug',
    ring: 'idle',
    records: [text(180_000)],
    fatigue: tired(90),
  },
  spent: {
    room: 'delta',
    icon: '📖',
    prop: 'book',
    ring: 'working',
    records: ran('Read', { file_path: '/work/delta/b.ts' }, 196_000),
    fatigue: tired(98),
  },
  // Two context drops of more than 40 points: two compactions (no threshold
  // for a Claude session, so no rest bubble from the count), the context 10%.
  relay: {
    room: 'delta',
    icon: '☕',
    prop: 'mug',
    ring: 'idle',
    records: [text(180_000), text(20_000), text(170_000), text(20_000)],
    fatigue: tired(10, 2),
  },
};
/** The engine project that is registered but not running. */
const OFFICE: Record<string, Member & { transcript?: string }> = {
  sleeper: { room: 'orch-office', icon: '💤', prop: '', ring: 'off', records: [] },
};
// The 🤝 sub-agent: its Grep finished, so it is between tools. Since T-0041 a sub that is not
// running a tool rests (a lingering temp), as the product's ToolOverlay does.
const SUB: Member = { room: '', records: [], icon: '☕', prop: 'mug', ring: 'idle' };

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean>, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

/** Live sessions as Claude Code writes them, one `sleep` process each. */
function startSessions(home: string): { procs: ChildProcess[]; transcript: Map<string, string> } {
  const procs: ChildProcess[] = [];
  const transcript = new Map<string, string>();
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  Object.entries(CAST).forEach(([name, m], i) => {
    const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
    procs.push(proc);
    const pid = proc.pid!;
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const n = String(i + 1).padStart(4, '0');
    const sessionId = `c0260000-0000-4000-8000-00000000${n}`;
    const cwd = `/work/${m.room}`;
    const file = path.join(
      home,
      '.claude/projects',
      normalizeProjectPath(cwd),
      `${sessionId}.jsonl`,
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    transcript.set(name, file);
    const session = {
      pid,
      sessionId,
      cwd,
      startedAt: Date.now() - 600_000 + i * 1000,
      procStart,
      version: '2.1.306',
      kind: 'interactive',
      name,
      status: m.ring === 'idle' ? 'idle' : 'busy',
    };
    fs.writeFileSync(path.join(home, '.claude/sessions', `${pid}.json`), JSON.stringify(session));
  });
  for (const [name, m] of Object.entries(OFFICE))
    if (m.transcript) transcript.set(name, path.join(home, m.transcript));
  return { procs, transcript };
}

interface Badge {
  id: number;
  icon: string;
  prop: string;
  ring: string;
  label: string;
}

// T-0036: each character's status sits on its head-icon anchor (the DOM
// head badge is gone; the canvas draws the icon of a name-less character).
const badges = (page: Page): Promise<Badge[]> =>
  page.$$eval('[data-testid="status-icon-anchor"]', (nodes) =>
    nodes.map((n) => ({
      id: Number(n.getAttribute('data-agent-id')),
      icon: n.getAttribute('data-emoji') ?? '',
      prop: n.getAttribute('data-prop') ?? '',
      ring: n.getAttribute('data-ring') ?? '',
      label: n.getAttribute('aria-label') ?? '',
    })),
  );

type Rgb = [number, number, number];
type Px = [number, number, Rgb];
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
/** Opaque pixels of a sprite as [col, row, rgb]. */
const pixels = (rows: string[], colour: (key: string) => string | null): Px[] =>
  rows.flatMap((row, r) =>
    [...row].flatMap((key, c) => {
      const hex = colour(key);
      return hex && hex.length === 7 ? [[c, r, rgb(hex)] as Px] : [];
    }),
  );
const palette = propData.palette as Record<string, string>;
const sheet = (s: Record<string, { at: number[]; frames: string[][] }>) =>
  Object.fromEntries(
    Object.entries(s).map(([id, p]) => [
      id,
      { at: p.at, frames: p.frames.map((f) => pixels(f, (k) => (k === '.' ? null : palette[k]))) },
    ]),
  );
const effects = sheet(propData.effects);
// The yawn's first frames are a few pixels, which a neighbour's mug can half match: look for the full puff.
effects.yawn.frames = effects.yawn.frames.slice(-1);
const TEMPLATES = {
  props: sheet(propData.props),
  effects,
  // A ring is a 16x8 box under the feet; walls, seats and feet in front hide parts of it.
  rings: Object.fromEntries(Object.entries(RIMS).map(([s, hex]) => [s, rgb(hex)])),
};

interface Drawn {
  id: number;
  /** The badge, so the character, is inside the canvas (else nothing is drawn to match). */
  inView: boolean;
  zoom: number;
  prop: string;
  propScore: number;
  ring: string;
  ringScore: number;
  sweat: number;
  yawn: number;
}

/**
 * What the canvas draws for each badge's character, best match per kind. The
 * anchor is world (x - 2, y + sit - 28) from the feet (constants.ts
 * STATUS_ICON_OFFSET_X / STATUS_ICON_RISE_PX), so the feet and every sprite's
 * origin follow for each candidate zoom.
 */
function drawnVisuals(page: Page, ids: number[]): Promise<Drawn[]> {
  return page.evaluate(
    ({ ids, t }) => {
      type P = [number, number, [number, number, number]];
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="office-canvas"]')!;
      const W = canvas.width;
      const H = canvas.height;
      const data = canvas.getContext('2d')!.getImageData(0, 0, W, H).data;
      const box = canvas.getBoundingClientRect();
      const dpr = W / box.width;
      const score = (tpl: P[], ox: number, oy: number, z: number) => {
        let hit = 0;
        for (const [c, r, [R, G, B]] of tpl) {
          const x = ox + c * z + (z >> 1);
          const y = oy + r * z + (z >> 1);
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const i = (y * W + x) * 4;
          if (data[i] === R && data[i + 1] === G && data[i + 2] === B) hit++;
        }
        return hit / tpl.length;
      };
      const best = (tpl: P[], ox: number, oy: number, z: number) => {
        let s = 0;
        for (let dx = -2; dx <= 2; dx++)
          for (let dy = -2; dy <= 2; dy++) s = Math.max(s, score(tpl, ox + dx, oy + dy, z));
        return s;
      };
      return ids.map((id) => {
        const out = {
          id,
          inView: false,
          zoom: 0,
          prop: '',
          propScore: 0,
          ring: '',
          ringScore: 0,
          sweat: 0,
          yawn: 0,
        };
        const el = document.querySelector(
          `[data-testid="status-icon-anchor"][data-agent-id="${id}"]`,
        );
        if (!el) return out;
        const r = el.getBoundingClientRect();
        // Room for the ring below and the prop and sweat around it.
        out.inView =
          r.left - 40 > box.left &&
          r.right + 80 < box.right &&
          r.top - 60 > box.top &&
          r.bottom + 60 < box.bottom;
        const bx = (r.left - box.left) * dpr;
        const by = (r.top - box.top) * dpr;
        // The ring: sprite pixels of a rim colour in its box (a count, as parts may be hidden).
        for (let z = 1; z <= 12; z++) {
          const fx = Math.round(bx + 2 * z);
          const fy = Math.round(by + 28 * z);
          for (const [state, [R, G, B]] of Object.entries(t.rings)) {
            let hits = 0;
            for (let r = 0; r < 8; r++)
              for (let c = 0; c < 16; c++) {
                const x = fx - 8 * z + c * z + (z >> 1);
                const y = fy - 4 * z + r * z + (z >> 1);
                if (x < 0 || y < 0 || x >= W || y >= H) continue;
                const i = (y * W + x) * 4;
                if (data[i] === R && data[i + 1] === G && data[i + 2] === B) hits++;
              }
            if (hits > out.ringScore) Object.assign(out, { zoom: z, ring: state, ringScore: hits });
          }
        }
        const z = out.zoom;
        const fx = Math.round(bx + 2 * z);
        const fy = Math.round(by + 28 * z);
        const frames = (sprites: Record<string, { at: number[]; frames: P[][] }>, key: string) =>
          Math.max(
            0,
            ...sprites[key].frames.map((tpl) =>
              best(tpl, fx + sprites[key].at[0] * z, fy + sprites[key].at[1] * z, z),
            ),
          );
        for (const prop of Object.keys(t.props)) {
          const s = frames(t.props, prop);
          if (s > out.propScore) Object.assign(out, { prop, propScore: s });
        }
        out.sweat = frames(t.effects, 'sweat');
        out.yawn = frames(t.effects, 'yawn');
        return out;
      });
    },
    { ids, t: TEMPLATES },
  );
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({});
  writeEngineProjects(fake.home, [
    { name: 'sleeper', folder: path.join(fake.home, 'work/sleeper'), room: 'orch-office' },
  ]);
  const { procs, transcript } = startSessions(fake.home);
  const started = startDaemon(fake, port, ['--no-terminal']);
  const daemon = started.child;
  const log = started.log;
  const received: Rec[] = [];
  const pageErrors: string[] = [];
  const fonts = { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) };
  const browser = await launchBrowser();
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    // T-0029: the 현황판 folds rooms and orchestrators; these checks press
    // buttons inside the cards, so a fresh profile starts with all open (모두 펼치기).
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('cld.status-tree'))
        localStorage.setItem('cld.status-tree', '{"rooms":true,"orchs":true}');
    });
    // tsx keeps function names with an `__name` helper the page does not have.
    await ctx.addInitScript('globalThis.__name = (fn) => fn;');
    await ctx.route('**/__t0026/*.ttf', (route) =>
      route.fulfill({
        body: route.request().url().endsWith('emoji.ttf') ? fonts.emoji : fonts.malgun,
        contentType: 'font/ttf',
      }),
    );
    const page = await ctx.newPage();
    page.on('websocket', (ws) =>
      ws.on('framereceived', (f) => {
        try {
          received.push(JSON.parse(String(f.payload)) as Rec);
        } catch {
          /* binary */
        }
      }),
    );
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const ready = async (page: Page, url: string) => {
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가📖'));
  };
  const nameOf = (id: number): string => {
    const office = [...received].reverse().find((m) => m.type === 'officeSnapshot') as
      { orchestrators: Array<{ name: string; agentId: number | null }> } | undefined;
    return office?.orchestrators.find((o) => o.agentId === id)?.name ?? (id < 0 ? 'sub' : `#${id}`);
  };
  const expectOf = (id: number): Member | undefined =>
    id < 0 && nameOf(id) === 'sub' ? SUB : (CAST[nameOf(id)] ?? OFFICE[nameOf(id)]);
  const idOf = async (page: Page, name: string) =>
    (await badges(page)).find((b) => nameOf(b.id) === name)!.id;
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const overlay = (page: Page, id: number) =>
    page.locator(`[data-testid="agent-overlay"][data-agent-id="${id}"]`);
  const everyone = Object.keys(CAST).length + Object.keys(OFFICE).length;

  try {
    const loginUrl = await started.loginUrl();
    const { ctx: desk, page } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await ready(page, loginUrl);
    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await phoneCtx.addCookies(await desk.cookies());
    await ready(phone, `http://127.0.0.1:${port}/`);
    for (const p of [page, phone])
      await until(
        `a badge on all ${everyone} characters`,
        async () => (await badges(p)).length >= everyone,
        30_000,
      );

    // Drive the activities (both pages watch: context drops are counted on screen).
    for (const [name, { records }] of [...Object.entries(CAST), ...Object.entries(OFFICE)])
      for (const record of records)
        fs.appendFileSync(transcript.get(name)!, JSON.stringify(record) + '\n');
    const settled = async (p: Page) => {
      const list = await badges(p);
      return (
        list.length === everyone + 1 &&
        list.every((b) => expectOf(b.id)?.icon === b.icon && expectOf(b.id)?.ring === b.ring)
      );
    };
    const mismatches = async (p: Page) =>
      (await badges(p))
        .filter((b) => expectOf(b.id)?.icon !== b.icon || expectOf(b.id)?.ring !== b.ring)
        .map(
          (b) =>
            `${nameOf(b.id)}: ${b.icon} ${b.ring} (want ${expectOf(b.id)?.icon} ${expectOf(b.id)?.ring})`,
        );
    try {
      await until(
        'every badge shows its activity',
        async () => (await settled(page)) && settled(phone),
        30_000,
      );
    } catch (err) {
      await shot(page, 'debug-desktop');
      console.error(
        `badges: ${(await badges(page)).length}; off: ${(await mismatches(page)).join(' | ')}`,
      );
      throw err;
    }
    await page.waitForTimeout(1_000);
    // T-0108: the 현황판 window starts closed, so the office already has the room.

    for (const [label, p] of [
      ['desktop', page],
      ['phone', phone],
    ] as const) {
      const list = await badges(p);
      for (const b of list) {
        const want = expectOf(b.id)!;
        check(
          b.icon === want.icon &&
            b.prop === want.prop &&
            b.ring === want.ring &&
            b.label.includes(':'),
          `${label}: ${nameOf(b.id)} wears ${b.icon} (prop ${b.prop || 'none'}, ${b.ring} ring, "${b.label}")`,
        );
        const bar = overlay(p, b.id).locator('[data-testid="fatigue"]');
        if (want.fatigue) {
          const value = Number(await bar.getAttribute('aria-valuenow'));
          const tone = await bar.getAttribute('data-tone');
          // The plate's compact bar keeps its words in the meter's value (charpack v3 §6A).
          const text = await bar.getAttribute('aria-valuetext');
          const rest = await overlay(p, b.id).locator('[data-testid="rest-bubble"]').count();
          check(
            value === want.fatigue.value &&
              tone === want.fatigue.tone &&
              text === want.fatigue.text &&
              rest === (want.fatigue.rest ? 1 : 0),
            `${label}: ${nameOf(b.id)} reads "${text}" (${tone} bar${rest ? ', rest bubble' : ''}) [context: ${received
              .filter((m) => m.type === 'agentContextUsage' && m.id === b.id)
              .map((m) => m.contextTokens)
              .join(' ')}]`,
          );
        } else {
          check((await bar.count()) === 0, `${label}: ${nameOf(b.id)} has no fatigue bar yet`);
        }
      }
      // Canvas: tour the rooms (a card tap makes the camera follow that
      // character) and sample there for a while -- rings blink, yawns come and
      // go, idle characters wander. A character counts only while in view.
      const seen = new Map<
        number,
        Drawn & { ringOk: boolean; samples: number; sweatHits: number; yawnHits: number }
      >();
      const ids = list.map((b) => b.id);
      const verified = (id: number) => {
        const want = expectOf(id)!;
        const got = seen.get(id);
        return (
          !!got &&
          got.samples >= 5 &&
          (!want.prop || (got.prop === want.prop && got.propScore >= 0.8)) &&
          (!RIMS[want.ring] || got.ringOk) &&
          (!want.fatigue?.sweat || got.sweat >= 0.8) &&
          (!want.fatigue?.yawn || got.yawn >= 0.8)
        );
      };
      const sample = async () => {
        for (const d of await drawnVisuals(p, ids)) {
          if (!d.inView) continue;
          const want = expectOf(d.id)!;
          const prev = seen.get(d.id);
          seen.set(d.id, {
            ...(!prev || d.propScore > prev.propScore ? d : prev),
            ringOk: (prev?.ringOk ?? false) || (d.ring === want.ring && d.ringScore >= 4),
            sweat: Math.max(d.sweat, prev?.sweat ?? 0),
            yawn: Math.max(d.yawn, prev?.yawn ?? 0),
            samples: (prev?.samples ?? 0) + 1,
            sweatHits: (prev?.sweatHits ?? 0) + (d.sweat >= 0.8 ? 1 : 0),
            yawnHits: (prev?.yawnHits ?? 0) + (d.yawn >= 0.8 ? 1 : 0),
          });
        }
      };
      const bossId = ids.find((id) => nameOf(id) === 'boss')!;
      let focused = 0;
      const focusOn = async (id: number) => {
        const target = id > 0 ? id : bossId;
        if (target === focused) return; // a second tap on a phone card opens its terminal page
        focused = target;
        const card = p.locator(`[data-testid="agent-card"][data-agent-id="${target}"]`).first();
        if (p === phone) await card.tap();
        else await card.click();
        await p.waitForTimeout(1_500);
      };
      const ROOMS = ['search', 'boss', 'perm', 'tired', 'relay'];
      for (const name of ROOMS) {
        const id = ids.find((x) => nameOf(x) === name)!;
        await focusOn(id);
        await shot(p, `${label}-room-${(CAST[name] ?? OFFICE[name]).room}`);
        for (const end = Date.now() + 9_000; Date.now() < end; await p.waitForTimeout(120)) {
          await sample();
          if (ids.every((x) => verified(x) || !seen.has(x))) break;
        }
      }
      for (const id of ids.filter((x) => !verified(x))) {
        await focusOn(id); // a wanderer, followed wherever it went
        // A yawn period is 7 s and the full puff shows for half a second; under load (software
        // rendering, other runs) a sample can take that long, so wait for it, up to a minute.
        for (const end = Date.now() + 60_000; Date.now() < end && !verified(id);)
          await sample().then(() => p.waitForTimeout(120));
        if (!verified(id)) await shot(p, `debug-${label}-${nameOf(id)}`);
      }
      for (const b of list) {
        const want = expectOf(b.id)!;
        const got = seen.get(b.id);
        const who = nameOf(b.id);
        check(got, `${label}: ${who} came into view`);
        if (!got) continue;
        if (want.prop)
          check(
            got.prop === want.prop && got.propScore >= 0.8,
            `${label}: the canvas draws ${who}'s ${want.prop} (${Math.round(got.propScore * 100)}% of its pixels at zoom ${got.zoom})`,
          );
        else
          check(
            got.propScore < 0.8, // a match is 80% of the sprite's pixels; wanderers brush past others
            `${label}: no prop beside ${who} (closest: ${got.prop} ${Math.round(got.propScore * 100)}%)`,
          );
        if (RIMS[want.ring])
          check(got.ringOk, `${label}: the canvas draws ${who}'s ${want.ring} ring`);
        if (want.fatigue) {
          check(
            // A wanderer brushing past a tired neighbour can match its sweat for a sample or two:
            // not sweating means a match in a small share of the samples at most.
            want.fatigue.sweat ? got.sweat >= 0.8 : got.sweatHits / got.samples < 0.25,
            `${label}: ${who} ${want.fatigue.sweat ? 'sweats' : 'does not sweat'} (${Math.round(got.sweat * 100)}%)`,
          );
          check(
            want.fatigue.yawn ? got.yawn >= 0.8 : got.yawnHits / got.samples < 0.25,
            `${label}: ${who} ${want.fatigue.yawn ? 'yawns now and then' : 'does not yawn'} (${Math.round(got.yawn * 100)}%)`,
          );
        }
      }
      await p.keyboard.press('Escape');
    }
    await shot(page, 'desktop-office');
    await shot(phone, 'phone-office');

    // EZ labels: the name (and 피로도) alone; the activity in words on hover / tap
    // (T-0036: a sub-agent shows only its head icon until then).
    const office = (await page.getByTestId('office-canvas').boundingBox())!;
    await page.mouse.click(office.x + 4, office.y + 4); // empty floor: nothing selected
    await page.mouse.move(640, 20);
    await page.waitForTimeout(300);
    const lines = await page
      .locator('[data-testid="agent-overlay"] [data-testid="activity-text"]')
      .evaluateAll((n) =>
        n.map((e) => e.closest('[data-agent-id]')!.getAttribute('data-agent-id')),
      );
    check(
      lines.length === 0,
      `desktop: unhovered labels are the name only, no activity lines (${lines.join(', ') || 'none'})`,
    );
    /** Bring a character to the middle (its card), clear the selection, and say where its body is. */
    const at = async (p: Page, id: number) => {
      const card = p.locator(`[data-testid="agent-card"][data-agent-id="${id}"]`).first();
      if (p === phone) await card.tap();
      else await card.click();
      await p.waitForTimeout(1_500);
      const canvas = (await p.getByTestId('office-canvas').boundingBox())!;
      if (p === phone) await p.touchscreen.tap(canvas.x + 3, canvas.y + 3);
      else await p.mouse.click(canvas.x + 3, canvas.y + 3);
      await p.waitForTimeout(300);
      return where(p, id);
    };
    /** Where the body of a character is now (it may walk: ask again before each try). */
    const where = async (p: Page, id: number) => {
      // The label is centred over the character; the head-icon anchor is 28
      // world px above its feet, and the hit box is the lowest 24.
      const label = (await overlay(p, id).boundingBox())!;
      const anchor = (await p
        .locator(`[data-testid="status-icon-anchor"][data-agent-id="${id}"]`)
        .boundingBox())!;
      const zoom = (await drawnVisuals(p, [id]))[0].zoom / (p === phone ? 3 : 1);
      return { x: label.x + label.width / 2, y: anchor.y + 18 * zoom };
    };
    const testId = await idOf(page, 'test');
    const hover = await at(page, testId);
    check(
      (await overlay(page, testId).locator('[data-testid="activity-text"]').count()) === 0,
      "desktop: before the hover, test's label is its name",
    );
    const hoverLine = overlay(page, testId).locator('[data-testid="activity-text"]');
    // Under load the character may have walked on: point at where it is now, a few times.
    for (let i = 0; i < 8 && !(await hoverLine.isVisible()); i++) {
      const here = i === 0 ? hover : await where(page, testId);
      await page.mouse.move(here.x, here.y);
      await hoverLine.waitFor({ timeout: 2_500 }).catch(() => undefined);
    }
    await hoverLine.waitFor({ timeout: 5_000 }).catch(async (err: unknown) => {
      await shot(page, 'debug-hover');
      throw err;
    });
    check(
      (await hoverLine.textContent()) === '🧪 시험 돌리는 중',
      `desktop: hovering test reads "${await hoverLine.textContent()}"`,
    );
    await shot(page, 'desktop-hover');

    // U-15: Lv, 환생 and the XP bar are on the label's details, and the observed work counts.
    const lv = overlay(page, testId).getByTestId('level');
    await lv.waitFor({ timeout: 5_000 });
    const lvText = (await lv.textContent()) ?? '';
    check(
      /^Lv 1 · 환생 0회/.test(lvText) && /다음 레벨까지 \d+/.test(lvText),
      `desktop: test's details read "${lvText}"`,
    );
    check(
      Number(await lv.getAttribute('data-xp')) > 0,
      `desktop: test's Bash run earned XP (${await lv.getAttribute('data-xp')})`,
    );
    fs.mkdirSync(UI_OUT, { recursive: true });
    await page.screenshot({ path: path.join(UI_OUT, 'desktop-level-hover.png') });
    await page.mouse.move(640, 790);

    const permId = await idOf(phone, 'perm');
    const tap = await at(phone, permId);
    check(
      (await overlay(phone, permId).locator('[data-testid="activity-text"]').count()) === 0,
      "phone: before the tap, perm's label is its name",
    );
    const tapLine = overlay(phone, permId).locator('[data-testid="activity-text"]');
    for (let i = 0; i < 8 && !(await tapLine.isVisible()); i++) {
      const here = i === 0 ? tap : await where(phone, permId);
      await phone.touchscreen.tap(here.x, here.y);
      await tapLine.waitFor({ timeout: 2_500 }).catch(() => undefined);
    }
    await tapLine.waitFor();
    check(
      (await tapLine.textContent()) === '🔐 허락을 기다림',
      `phone: tapping perm reads "${await tapLine.textContent()}"`,
    );
    await phone.waitForTimeout(800);
    await shot(phone, 'phone-tap');


    // The rest bubble only suggests: a tap tells what to do, nothing is sent.
    const sent: string[] = [];
    page.on('websocket', (ws) => ws.on('framesent', (f) => sent.push(String(f.payload))));
    const spentId = await idOf(page, 'spent');
    const bubble = overlay(page, spentId).locator('[data-testid="rest-bubble"]');
    await bubble.click();
    await until('the suggestion shows', async () =>
      ((await bubble.textContent()) ?? '').includes('새 대화로 인수인계 권장'),
    );
    check(true, 'desktop: tapping spent\'s "휴식이 필요해요" shows "새 대화로 인수인계 권장"');
    check(!sent.some((f) => /chatSend/.test(f)), 'desktop: the suggestion sends no chat');
    // Zoom in on the tired room for a close look.
    await page.locator(`[data-testid="agent-card"][data-agent-id="${spentId}"]`).click();
    await page.mouse.move(office.x + office.width / 2, office.y + office.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await page.waitForTimeout(1_500);
    await shot(page, 'desktop-fatigue-closeup');

    // The 현황판 cards carry the same bar and bubble (desktop drawer, phone tab).
    if (!(await page.getByRole('navigation', { name: '사무실 메뉴' }).isVisible()))
      await page
        .locator('[data-hud-id^="icon:"]')
        .getByRole('button', { name: '현황판', exact: true })
        .click();
    const card = page.locator('article', { has: page.locator('h3', { hasText: /^spent$/ }) });
    check(
      (await card.locator('[data-testid="fatigue"]').getAttribute('aria-valuenow')) === '98' &&
        (await card.locator('[data-testid="rest-bubble"]').count()) === 1,
      'desktop: the 현황판 card of spent shows 피로도 98% and the rest bubble',
    );
    await card.locator('[data-testid="rest-bubble"]').click();
    check(
      ((await card.locator('[data-testid="rest-bubble"]').textContent()) ?? '').includes(
        '새 대화로 인수인계 권장',
      ),
      'desktop: tapping the card bubble shows the suggestion',
    );
    await card.scrollIntoViewIfNeeded();
    await shot(page, 'desktop-status-card');
    await phone
      .locator('[data-hud-id^="icon:"]')
      .getByRole('button', { name: '현황판', exact: true })
      .click();
    const phoneCard = phone.locator('article', {
      has: phone.locator('h3', { hasText: /^relay$/ }),
    });
    await phoneCard.waitFor();
    check(
      (await phoneCard.locator('[data-testid="fatigue"]').getAttribute('aria-valuenow')) === '10' &&
        ((await phoneCard.locator('[data-testid="fatigue-text"]').textContent()) ?? '') ===
          '피로도 10% · 휴식 2',
      'phone: the 현황판 card of relay shows 피로도 10% · 휴식 2 (two context drops)',
    );
    await phoneCard.scrollIntoViewIfNeeded();
    await shot(phone, 'phone-status');
    await phone.getByLabel('현황판 화면').getByRole('button', { name: '사무실' }).click();

    // 범례: every ring state, prop and fatigue sign.
    for (const [label, p] of [
      ['desktop', page],
      ['phone', phone],
    ] as const) {
      await p.getByRole('button', { name: '범례' }).click();
      const legend = p.getByTestId('activity-legend');
      await legend.waitFor();
      const rings = await legend.locator('[data-ring]').count();
      const props = await legend
        .locator('[data-prop]')
        .evaluateAll((n) => n.map((e) => e.getAttribute('data-prop')));
      const signs = await legend.getByTestId('fatigue-legend').locator('li').count();
      check(
        rings === 6 && new Set(props).size === Object.keys(propData.props).length && signs === 7, // 7: T-0047 added the 휴식 N/M one
        `${label}: 범례 shows ${rings} ring states, ${props.length} props and ${signs} fatigue signs`,
      );
      await p.waitForTimeout(300);
      const levelLegend = legend.getByTestId('level-legend');
      check(
        ((await levelLegend.textContent()) ?? '').includes('Lv 3') &&
          ((await levelLegend.textContent()) ?? '').includes('환생'),
        `${label}: 범례 explains Lv, 경험치 and 환생`,
      );
      await levelLegend.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await p.screenshot({ path: path.join(UI_OUT, `${label}-legend-level.png`) });
      await legend.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await shot(p, `${label}-legend`);
      await legend.evaluate((el) => el.scrollIntoView({ block: 'end' }));
      await shot(p, `${label}-legend-fatigue`);
      await p.getByRole('button', { name: 'x', exact: true }).click();
    }

    // U-15: a renew that really started the new conversation is one 환생 (the engine event).
    appendEvent(eventsPath(fake.home), 'orch_renew', 'engine', {
      name: 'sleeper',
      old_session_id: null,
      session_id: null,
      ok: true,
    });
    await until(
      'sleeper shows one 환생',
      async () => {
        const office = [...received].reverse().find((m) => m.type === 'officeSnapshot') as
          | { orchestrators: Array<{ name: string; level?: { rebirths: number } }> }
          | undefined;
        return office?.orchestrators.find((o) => o.name === 'sleeper')?.level?.rebirths === 1;
      },
      20_000,
    );
    check(true, 'the daemon counted the renew as one 환생 of sleeper');
    // U-10: an off orchestrator's label offers its info (name, state, level, recent activity).
    const sleeperId = await idOf(page, 'sleeper');
    await page.locator(`[data-testid="agent-card"][data-agent-id="${sleeperId}"]`).click();
    const openInfo = overlay(page, sleeperId).getByTestId('off-duty-open');
    await openInfo.waitFor({ timeout: 10_000 });
    await openInfo.click();
    const sheet = page.getByTestId('off-duty-sheet');
    await sheet.waitFor({ timeout: 5_000 });
    const sheetText = (await sheet.textContent()) ?? '';
    check(
      sheetText.includes('꺼져 있어요') && sheetText.includes('환생 1회') && sheetText.includes('엔진'),
      `desktop: sleeper's info sheet reads state, level and provider (${sheetText.slice(0, 90)})`,
    );
    check(
      (await sheet.getByTestId('off-duty-chat').count()) === 0,
      'desktop: with chat off the sheet offers no chat button',
    );
    await page.screenshot({ path: path.join(UI_OUT, 'desktop-off-sheet.png') });
    await page.getByRole('button', { name: 'x', exact: true }).click();

    // EZ is the only mode: no toggle, and the details stay in the tooltips.
    check((await page.getByRole('button', { name: 'EZ' }).count()) === 0, 'no EZ button');
    await shot(page, 'desktop-no-toggle');

    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
  } finally {
    await browser.close();
    if (daemon.exitCode === null) {
      const exited = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      if (daemon.exitCode === null) daemon.kill('SIGKILL');
    }
    for (const p of procs) p.kill('SIGKILL');
  }
  fs.writeFileSync(
    path.join(OUT, 'server.log'),
    log
      .join('')
      .replace(/code=[\w-]+/g, 'code=<redacted>')
      .replaceAll(fake.home, '<HOME>')
      .replaceAll(os.hostname(), '<host>'),
  );
  fs.rmSync(fake.home, { recursive: true, force: true });
  console.log('all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
