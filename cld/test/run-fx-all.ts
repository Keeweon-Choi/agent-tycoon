/**
 * FX-ALL recording: every character plays the game moments (owner 11-01 13:23). dist/cli.js on
 * an isolated HOME (the engine fake as `claude`, a `sleep` of ours as the Claude session `lead`
 * with a transcript we write; no model is ever called), headless Chromium without a GPU, the
 * isometric office with ?fx=1 (only for window.__agtyFx.playing: every moment here is the live
 * one, from the real trigger). The desktop (1280x800) and the phone (390x844) watch at once:
 *  1. `lead` spawns a foreground sub-agent and a background one (run-temp-plates.ts); 55 sub-tools
 *     of the foreground one take its employee to Lv 2: the level-up plays on its character;
 *  2. the background one's own transcript drops from 85% to 2% of its 1M context (a compaction): it walks
 *     to the pantry's coffee machine, drinks, and walks back to its spot by its lead;
 *  3. the owner's character is walked next to the coffee machine: E (the desktop) or a tap on the
 *     machine (the phone) and it drinks there.
 * Output: cld/artifacts/fx-all/<view>-<clip>.mp4 (H.264/yuv420p, not committed) and a stills
 * strip of each, <view>-<clip>-strip.png.
 *
 *   npx tsx cld/test/run-fx-all.ts <port 18266|18267>
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]) || 18266;
if (port !== 18266 && port !== 18267) throw new Error('FX-ALL records on 18266 or 18267');
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/fx-all');
const RAW = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-all-video-'));
const OWNER = -2_000_000_000; // OWNER_CHARACTER_ID
const BG_AGENT = 'a7e3f0c1d2b4';
const DEADLINE_MS = 600_000;
const LEAD_SEC = 1;
const TAIL_SEC = 1;
const STRIP_FRAMES = 6;
const HIDE =
  '[data-testid="fx-dev-bar"], [data-testid="update-notice"] { display: none !important; }';
const DESKTOP: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  recordVideo: { dir: RAW, size: { width: 1280, height: 800 } },
};
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  recordVideo: { dir: RAW, size: { width: 390, height: 844 } }, // CSS px: the frame the page fills
};

type Rec = Record<string, unknown>;
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[], usage?: Rec): Rec => ({
  type: 'assistant',
  message: { model: 'claude-sonnet-4-5', content, ...(usage && { usage }) },
});
const userResult = (id: string, text: string): Rec => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});
const sub = (parent: string, msg: Rec): Rec => ({
  type: 'progress',
  parentToolUseID: parent,
  data: { type: 'agent_progress', message: msg },
});
const usage = (tokens: number) => ({
  input_tokens: 10,
  cache_creation_input_tokens: 10_000,
  cache_read_input_tokens: tokens - 10_000,
  output_tokens: 500,
});

let oks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  oks++;
  console.log(`ok - ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, fn: () => Promise<boolean>, ms = 30_000): Promise<void> {
  for (const end = Date.now() + ms; ; await sleep(150)) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}
const hook = <T>(page: Page, js: string): Promise<T> =>
  page.evaluate(`window.__agentTycoonTestHooks.${js}`) as Promise<T>;
const playing = (page: Page, id: number) =>
  page.evaluate(`window.__agtyFx.playing(${id})`) as Promise<number | null>;
const tileOf = (page: Page, id: number) =>
  hook<{ col: number; row: number } | null>(page, `getCharacterTile(${id})`);
const ff = (args: string[]) =>
  execFileSync('nice', ['-n', '10', 'ffmpeg', '-y', '-loglevel', 'error', ...args]);

/** A live Claude Code session (a `sleep` of ours) named `name` in `cwd`; its transcript. */
function session(home: string, name: string, cwd: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c1101000-0000-4000-8000-000000000001';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, '');
  const subDir = path.join(projectDir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      cwd,
      startedAt: Date.now() - 600_000,
      procStart,
      version: '2.1.306',
      kind: 'interactive',
      name,
      status: 'busy',
    }),
  );
  return { proc, transcript, subDir };
}

interface Plate {
  id: number;
  kind: string;
  name: string;
  fatigue: 'bar' | 'unknown' | 'none';
}
const plates = (page: Page): Promise<Plate[]> =>
  page.$$eval('[data-testid="agent-overlay"]', (nodes) =>
    nodes.map((n) => ({
      id: Number(n.getAttribute('data-agent-id')),
      kind: n.getAttribute('data-kind') ?? '',
      name: n.querySelector('[data-testid="agent-name"]')?.textContent ?? '',
      fatigue: n.querySelector('[data-testid="fatigue"]')
        ? ('bar' as const)
        : n.querySelector('[data-testid="fatigue-unknown"]')
          ? ('unknown' as const)
          : ('none' as const),
    })),
  );

interface View {
  name: 'desktop' | 'phone';
  page: Page;
  t0: number;
  clips: Array<{ name: string; from: number; to: number }>;
}

async function main() {
  const deadline = setTimeout(() => {
    console.error('FX-ALL: past the deadline');
    process.exit(1);
  }, DEADLINE_MS);
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const lead = session(home, 'lead', '/work/alpha');
  const append = (records: Rec[], file = lead.transcript) => {
    for (const r of records) fs.appendFileSync(file, JSON.stringify(r) + '\n');
  };
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal', '--engine', 'on']);
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const views: View[] = [];
  try {
    const loginUrl = await daemon.loginUrl();
    let cookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>> = [];
    for (const [name, opts] of [
      ['desktop', DESKTOP],
      ['phone', PHONE],
    ] as const) {
      const ctx = await browser.newContext(opts);
      await ctx.addInitScript(
        "globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true; try { localStorage.setItem('cld.office-iso', 'on'); localStorage.setItem('cld.camera-mode', 'auto') } catch {}",
      );
      if (cookies.length) await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      const t0 = Date.now();
      page.on('pageerror', (err) => pageErrors.push(`${name}: ${String(err)}`));
      if (!cookies.length) {
        await page.goto(loginUrl);
        await page.waitForURL(BASE);
        cookies = await ctx.cookies();
      }
      await page.goto(`${BASE}?fx=1`);
      await page.evaluate(() => document.fonts.load("36px 'FS Pixel Sans'", 'Aa'));
      await page.addStyleTag({ content: HIDE });
      views.push({ name, page, t0, clips: [] });
    }
    for (const v of views) {
      await until(`${v.name}: lead is in`, async () =>
        (await plates(v.page)).some((x) => x.name === 'lead'),
      );
      const closeInfo = v.page.getByRole('button', { name: '정보 창 닫기' });
      if (await closeInfo.count()) await closeInfo.click();
      await hook(v.page, `setZoom(${v.name === 'desktop' ? 4 : 3})`);
    }

    // A foreground sub-agent and a background one (its own transcript, 85% of its 1M context).
    fs.writeFileSync(path.join(lead.subDir, `agent-${BG_AGENT}.jsonl`), '');
    fs.writeFileSync(
      path.join(lead.subDir, `agent-${BG_AGENT}.meta.json`),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'scan logs',
        toolUseId: 'tu-bg',
      }),
    );
    append([
      said([
        call('tu-a', 'Task', { description: 'fix login', prompt: 'x', model: 'sonnet' }),
        call('tu-bg', 'Agent', { description: 'scan logs', prompt: 'y', run_in_background: true }),
      ]),
      userResult('tu-bg', `Async agent launched successfully.\nagentId: ${BG_AGENT}`),
      sub('tu-a', said([call('tu-a-0', 'Grep', { pattern: 'login' })])),
    ]);
    const bgFile = path.join(lead.subDir, `agent-${BG_AGENT}.jsonl`);
    await sleep(2_000);
    append(
      [
        {
          ...said([call('tu-bg-1', 'Read', { file_path: '/work/alpha/app.log' })], usage(850_000)),
          isSidechain: true,
        },
      ],
      bgFile,
    );
    let fg = 0;
    let bg = 0;
    for (const v of views)
      await until(
        `${v.name}: the two sub-agents, the background one with its 피로도`,
        async () => {
          const subs = (await plates(v.page)).filter((x) => x.kind === 'subagent');
          const a = subs.find((x) => x.fatigue === 'unknown');
          const b = subs.find((x) => x.fatigue === 'bar');
          if (!a || !b) return false;
          [fg, bg] = [a.id, b.id];
          return true;
        },
        45_000,
      );
    check(true, `sub-agents on screen: foreground ${fg}, background ${bg}`);
    await sleep(4_000); // walking in from the door

    /** Follow `id`, start the trigger, and keep the clip from its moment's start to its end. */
    const clip = async (name: string, id: number, trigger: () => Promise<void>, maxSec: number) => {
      // selected and followed (with nothing selected the camera goes back to the owner's character)
      for (const v of views) await hook(v.page, `follow(${id})`);
      await sleep(1_500);
      const from = new Map<View, number>();
      const tiles: string[] = [];
      await trigger();
      await until(
        `${name}: the moment plays on ${id} on both`,
        async () => {
          for (const v of views)
            if (!from.has(v) && (await playing(v.page, id)) !== null)
              from.set(v, (Date.now() - v.t0) / 1000);
          return from.size === views.length;
        },
        25_000,
      );
      await until(
        `${name}: the moment is over on both`,
        async () => {
          const t = await tileOf(views[0].page, id);
          if (t && tiles.at(-1) !== `${t.col},${t.row}`) tiles.push(`${t.col},${t.row}`);
          for (const v of views) if ((await playing(v.page, id)) !== null) return false;
          return true;
        },
        maxSec * 1000,
      );
      const to = new Map(views.map((v) => [v, (Date.now() - v.t0) / 1000]));
      for (const v of views) v.clips.push({ name, from: from.get(v)!, to: to.get(v)! });
      await sleep(TAIL_SEC * 1000 + 300);
      return tiles;
    };

    // 1. The foreground sub-agent's employee reaches Lv 2 (55 sub-tools of 2 XP, the 5 s flush).
    await clip(
      'subagent-levelup',
      fg,
      async () =>
        append(
          Array.from({ length: 55 }, (_, i) =>
            sub(
              'tu-a',
              said([call(`tu-a-${i + 1}`, 'Read', { file_path: `/work/alpha/f${i}.ts` })]),
            ),
          ),
        ),
      15,
    );
    check(
      true,
      'a sub-agent leveled up on the desktop and the phone (its employee Lv 1 -> 2, live)',
    );

    // 2. The background one compacts (85% -> 2% of its own 1M context): a coffee break.
    await until(
      'the background sub-agent is at its place',
      async () =>
        ((await tileOf(views[0].page, bg)) as { state?: string } | null)?.state !== 'walk',
      20_000,
    );
    const home0 = await tileOf(views[0].page, bg);
    const walked = await clip(
      'subagent-coffee',
      bg,
      async () =>
        append(
          [
            {
              ...said([call('tu-bg-2', 'Read', { file_path: '/work/alpha/b.log' })], usage(20_000)),
              isSidechain: true,
            },
          ],
          bgFile,
        ),
      70,
    );
    const back = await tileOf(views[0].page, bg);
    check(
      walked.length > 3,
      `the sub-agent walked to the machine and back (${walked.join(' > ')})`,
    );
    // its spot: where it stood, or the spare desk in its lead's room it holds (a wandering temp)
    const seats = await hook<Array<{ col: number; row: number; assigned: boolean }>>(
      views[0].page,
      'getSeats()',
    );
    const atSpot =
      !!back &&
      ((back.col === home0?.col && back.row === home0?.row) ||
        seats.some((s) => s.assigned && s.col === back.col && s.row === back.row));
    check(
      atSpot,
      `it is back at its spot by its lead (from ${JSON.stringify(home0)}, now ${JSON.stringify(back)})`,
    );

    // 3. The owner's character, walked next to the coffee machine, drinks there.
    for (const v of views) {
      const furniture = await hook<Array<{ uid: string; type: string; col: number; row: number }>>(
        v.page,
        'getFurniture()',
      );
      const owner = (await tileOf(v.page, OWNER))!;
      const machines = furniture
        .filter((f) => f.type === 'COFFEE_MACHINE')
        .sort((a, b) => Math.abs(a.row - owner.row) - Math.abs(b.row - owner.row));
      check(machines.length > 0, `${v.name}: a coffee machine in the office`);
      const m = machines[0];
      let stand: { col: number; row: number } | null = null;
      for (const [dc, dr] of [
        [-1, 1],
        [1, 1],
        [-1, 2],
        [1, 2],
        [0, 2],
      ])
        if (await hook<boolean>(v.page, `isTileWalkable(${m.col + dc}, ${m.row + dr})`)) {
          stand = { col: m.col + dc, row: m.row + dr };
          break;
        }
      check(stand, `${v.name}: a tile next to the machine (${JSON.stringify(stand)})`);
      check(
        await hook<boolean>(v.page, `walkTo(${OWNER}, ${stand!.col}, ${stand!.row})`),
        `${v.name}: the owner walks there`,
      );
      await hook(v.page, `follow(${OWNER})`);
      await hook(v.page, 'selectAgent(null)');
      await until(
        `${v.name}: the owner stands by the machine`,
        async () => {
          const t = await tileOf(v.page, OWNER);
          return !!t && t.col === stand!.col && t.row === stand!.row;
        },
        60_000,
      );
      await sleep(1_500);
      const from = (Date.now() - v.t0) / 1000;
      let how = 'E';
      if (v.name === 'phone') {
        // a tap on the machine's body: up from its front tile until one lands on it
        const box = await v.page.evaluate(() => {
          const c = [...document.querySelectorAll('canvas')].sort(
            (a, b) => b.width * b.height - a.width * a.height,
          )[0];
          const r = c.getBoundingClientRect();
          return { x: r.left, y: r.top };
        });
        const p = await hook<{ x: number; y: number } | null>(
          v.page,
          `isoPoint(${(m.col + 0.5) * 16}, ${(m.row + 1.5) * 16})`,
        );
        for (const up of [6, 18, 30, 42]) {
          if (!p || (await playing(v.page, OWNER)) !== null) break;
          const [x, y] = [box.x + p.x, box.y + p.y - up];
          const under = await v.page.evaluate(
            ([x, y]) => document.elementFromPoint(x, y)?.tagName ?? 'none',
            [x, y],
          );
          console.log(`phone tap at (${x.toFixed(0)}, ${y.toFixed(0)}) on ${under}`);
          await v.page.touchscreen.tap(x, y);
          await sleep(400);
        }
        how = 'a tap on the machine';
        if ((await playing(v.page, OWNER)) === null) {
          how = 'E (the tap missed)';
          await v.page.keyboard.press('e');
        }
      } else await v.page.keyboard.press('e');
      await until(
        `${v.name}: the owner drinks`,
        async () => (await playing(v.page, OWNER)) !== null,
        3_000,
      );
      await until(
        `${v.name}: the owner's drink is over`,
        async () => (await playing(v.page, OWNER)) === null,
        45_000,
      );
      v.clips.push({ name: 'owner-drink', from, to: (Date.now() - v.t0) / 1000 });
      check(true, `${v.name}: the owner's character drank at the machine (${how})`);
      await sleep(TAIL_SEC * 1000 + 300);
    }

    for (const v of views) {
      const video = v.page.video()!;
      await v.page.context().close();
      const raw = await video.path();
      for (const c of v.clips) {
        const sec = c.to - c.from + LEAD_SEC + TAIL_SEC;
        const mp4 = path.join(OUT, `${v.name}-${c.name}.mp4`);
        ff([
          '-ss',
          Math.max(0, c.from - LEAD_SEC).toFixed(2),
          '-i',
          raw,
          '-t',
          sec.toFixed(2),
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-an',
          '-movflags',
          '+faststart',
          mp4,
        ]);
        const w = v.name === 'phone' ? 260 : 400;
        ff([
          '-i',
          mp4,
          '-vf',
          `fps=${STRIP_FRAMES}/${sec.toFixed(2)},scale=${w}:-1,tile=${STRIP_FRAMES}x1:padding=4:color=black`,
          '-frames:v',
          '1',
          path.join(OUT, `${v.name}-${c.name}-strip.png`),
        ]);
        console.log(`${path.basename(mp4)}: ${sec.toFixed(1)} s`);
      }
    }
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
  } finally {
    await browser.close();
    if (daemon.child.exitCode === null) {
      const exited = new Promise((r) => daemon.child.once('exit', r));
      daemon.child.kill('SIGTERM');
      await Promise.race([exited, sleep(5_000)]);
      if (daemon.child.exitCode === null) daemon.child.kill('SIGKILL');
    }
    lead.proc.kill();
    killFakeSessions(home);
    fs.rmSync(RAW, { recursive: true, force: true });
    clearTimeout(deadline);
  }
  console.log(`${oks} checks passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
