/**
 * T-0036 check: dist/cli.js with an isolated HOME on a spare port, in headless
 * Chromium, desktop (1280x800) and phone (393x852). The office holds two
 * orchestrators (the engine project `veteran`, a Claude session `lead`), the lead's two
 * sub-agents (two open Task calls), one teammate (`scout`, a named background
 * spawn with its sidecar transcript) and one Codex worker (an engine Codex task).
 * - with nameplates off (charpack v3 §6A), only the orchestrators carry a name on the canvas overlay;
 * - an idle character shows the zzz status icon, drawn on the canvas;
 * - hovering a sub-agent (desktop) or tapping it (phone) shows its details;
 * - the card bar is grouped by kind, each card named.
 * Hangul from Malgun Gothic and emoji from Segoe UI Emoji (Windows fonts, read
 * only). Screenshots go to cld/artifacts/t0036/.
 *
 *   npx tsx cld/test/run-labels.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
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
  seedCodexTask,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import propData from '../../webview-ui/src/cld/ez/props.json';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0036');
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0036/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0036/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
/** constants.ts: the status icon's rise and offset, the working box's border. */
const ICON = { rise: 28, offsetX: -2, box: 11, border: [0x4a, 0x4a, 0x6a] };

type Rec = Record<string, unknown>;
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[]): Rec => ({
  type: 'assistant',
  message: { model: 'claude-haiku-4-5', content },
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
const SCOUT_AGENT = 'a36c0de0';
/** The lead: two sub-agents at work, and a named background spawn (the teammate). */
const LEAD_RECORDS: Rec[] = [
  said([
    call('tu-fix', 'Task', { description: 'fix login', prompt: 'x' }),
    call('tu-docs', 'Task', { description: 'write docs', prompt: 'y' }),
    call('tu-scout', 'Agent', {
      description: 'scout the repo',
      prompt: 'z',
      name: 'scout',
      run_in_background: true,
    }),
  ]),
  userResult('tu-scout', `Async agent launched successfully.\nagentId: ${SCOUT_AGENT}`),
  sub('tu-fix', said([call('tu-fix-1', 'Grep', { pattern: 'login' })])),
  sub('tu-docs', said([call('tu-docs-1', 'Read', { file_path: '/work/alpha/README.md' })])),
];

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

/** The lead as a live Claude Code session (a `sleep`), its transcript and the scout's sidecar. */
function startLead(home: string): { proc: ChildProcess; transcript: string } {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c0360000-0000-4000-8000-000000000001';
  const cwd = '/work/alpha';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, '');
  const subDir = path.join(projectDir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, `agent-${SCOUT_AGENT}.jsonl`), '');
  fs.writeFileSync(
    path.join(subDir, `agent-${SCOUT_AGENT}.meta.json`),
    JSON.stringify({
      agentType: 'general-purpose',
      description: 'scout the repo',
      toolUseId: 'tu-scout',
      name: 'scout',
    }),
  );
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
      name: 'lead',
      status: 'busy',
    }),
  );
  return { proc, transcript };
}

interface Anchor {
  id: number;
  kind: string;
  icon: string;
  emoji: string;
  label: string;
  x: number;
  y: number;
}
const anchors = (page: Page): Promise<Anchor[]> =>
  page.$$eval('[data-testid="status-icon-anchor"]', (nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return {
        id: Number(n.getAttribute('data-agent-id')),
        kind: n.getAttribute('data-kind') ?? '',
        icon: n.getAttribute('data-icon') ?? '',
        emoji: n.getAttribute('data-emoji') ?? '',
        label: n.getAttribute('aria-label') ?? '',
        x: r.left,
        y: r.top,
      };
    }),
  );
/** Names on the canvas overlay: [name, kind of its overlay]. */
const names = (page: Page): Promise<Array<[string, string]>> =>
  page.$$eval('[data-testid="agent-name"]', (nodes) =>
    nodes.map((n) => [
      n.textContent ?? '',
      n.closest('[data-testid="agent-overlay"]')?.getAttribute('data-kind') ?? '',
    ]),
  );
/** The card bar in order: group headers or dividers ('|title') and card names. */
const cardBar = (page: Page): Promise<string[]> =>
  page.$$eval('[data-testid="card-group"], [data-testid="card-name"]', (nodes) =>
    nodes.map((n) =>
      n.getAttribute('data-testid') === 'card-group'
        ? `|${n.getAttribute('title')}`
        : (n.textContent ?? ''),
    ),
  );

type Rgb = [number, number, number];
const palette = propData.palette as Record<string, string>;
const rgb = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
/** The zzz frames as [col, row, rgb] for every opaque pixel. */
const ZZZ = propData.icons.zzz.frames.map((rows) =>
  rows.flatMap((row, r) =>
    [...row].flatMap((key, c) => (key === '.' ? [] : [[c, r, rgb(palette[key])]])),
  ),
) as Array<Array<[number, number, Rgb]>>;

/**
 * Canvas check under an anchor (the icon's bottom centre): the best zzz frame
 * match and the working box's border match, over every zoom.
 */
function drawnIcon(page: Page, a: Anchor) {
  return page.evaluate(
    ({ a, zzz, icon }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="office-canvas"]')!;
      const W = canvas.width;
      const H = canvas.height;
      const data = canvas.getContext('2d')!.getImageData(0, 0, W, H).data;
      const box = canvas.getBoundingClientRect();
      const dpr = W / box.width;
      const cx = Math.round((a.x - box.left) * dpr);
      const by = Math.round((a.y - box.top) * dpr);
      const at = (x: number, y: number, [R, G, B]: number[]) => {
        if (x < 0 || y < 0 || x >= W || y >= H) return false;
        const i = (y * W + x) * 4;
        return data[i] === R && data[i + 1] === G && data[i + 2] === B;
      };
      const out = { zoom: 0, zzz: 0, box: 0 };
      for (let z = 1; z <= 12; z++) {
        for (const frame of zzz) {
          const x0 = cx - 7 * z;
          const y0 = by - 12 * z;
          let hit = 0;
          for (const [c, r, colour] of frame)
            if (at(x0 + c * z + (z >> 1), y0 + r * z + (z >> 1), colour)) hit++;
          if (hit / frame.length > out.zzz)
            Object.assign(out, { zoom: z, zzz: hit / frame.length });
        }
        // The working box: its border ring, 11x11 sprite px.
        const x0 = cx - Math.floor(icon.box / 2) * z;
        const y0 = by - icon.box * z;
        let hit = 0;
        let all = 0;
        for (let r = 0; r < icon.box; r++)
          for (let c = 0; c < icon.box; c++) {
            if (r > 0 && r < icon.box - 1 && c > 0 && c < icon.box - 1) continue;
            all++;
            if (at(x0 + c * z + (z >> 1), y0 + r * z + (z >> 1), icon.border)) hit++;
          }
        if (hit / all > out.box)
          Object.assign(out, { box: hit / all, zoom: out.zzz ? out.zoom : z });
      }
      return out;
    },
    { a, zzz: ZZZ, icon: ICON },
  );
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  // The engine: veteran (a project the engine revives, idle) and one running Codex task.
  const { home, claudePath } = makeEngineHome();
  const fake = { home };
  const veteranDir = path.join(home, 'work', 'veteran');
  fs.mkdirSync(veteranDir, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/projects.json'),
    JSON.stringify([{ name: 'veteran', folder: veteranDir, wantRunning: true }]),
  );
  const { proc, transcript } = startLead(fake.home);
  const worker = spawn('sleep', ['900'], { stdio: 'ignore' }); // the Codex worker's job process
  seedCodexTask(home, {
    id: '1021-230000-alpha',
    project: 'alpha',
    state: 'running',
    started: new Date(Date.now() - 600_000).toISOString(),
    pid: worker.pid!,
    spec: 'T-36.md',
  });
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal', '--engine', 'on']);
  const daemon = started.child;
  const log = started.log;
  const pageErrors: string[] = [];
  const fonts = { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) };
  const browser = await launchBrowser();
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn;');
    // T-0041: office hours off, so nobody goes home when this runs at night.
    await ctx.addInitScript(() => localStorage.setItem('cld.office-hours', '{"on":false}'));
    // charpack v3 §6A: nameplates (on by default) name everyone; this runner checks the
    // office with them turned off (run-nameplates.ts checks them on).
    await ctx.addInitScript(() => localStorage.setItem('cld.nameplates', 'off'));
    await ctx.route('**/__t0036/*.ttf', (route) =>
      route.fulfill({
        body: route.request().url().endsWith('emoji.ttf') ? fonts.emoji : fonts.malgun,
        contentType: 'font/ttf',
      }),
    );
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const ready = async (page: Page, url: string) => {
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가📖'));
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });

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
      await until('veteran, lead and the Codex worker are in the office', async () => {
        const n = (await names(p)).map(([name]) => name);
        const a = await anchors(p);
        return n.includes('veteran') && n.includes('lead') && a.some((x) => x.kind === 'codex');
      }).catch(async (err) => {
        await shot(p, 'debug');
        console.error(JSON.stringify(await names(p)), JSON.stringify(await anchors(p)));
        throw err;
      });
    for (const record of LEAD_RECORDS) fs.appendFileSync(transcript, JSON.stringify(record) + '\n');
    const cast = async (p: Page) => {
      const a = await anchors(p);
      return {
        subs: a.filter((x) => x.kind === 'subagent'),
        mates: a.filter((x) => x.kind === 'teammate'),
        codex: a.filter((x) => x.kind === 'codex'),
      };
    };
    for (const p of [page, phone])
      await until(
        '2 sub-agents and the scout teammate appear',
        async () => {
          const c = await cast(p);
          return c.subs.length === 2 && c.mates.length === 1;
        },
        30_000,
      ).catch(async (err) => {
        await shot(p, 'debug');
        console.error(JSON.stringify(await anchors(p)));
        throw err;
      });
    await page.waitForTimeout(1_500);
    // T-0041: temps walk in from the door. Look once everyone has sat down,
    // with fresh sub-agent work (no permission guess yet).
    for (const p of [page, phone]) {
      let before = '';
      await until(
        'everyone sat down',
        async () => {
          const now = JSON.stringify((await anchors(p)).map((a) => [a.x, a.y]));
          const still = now === before;
          before = now;
          await p.waitForTimeout(700);
          return still;
        },
        60_000,
      );
    }
    for (const record of [
      sub('tu-fix', said([call('tu-fix-2', 'Grep', { pattern: 'session' })])),
      sub('tu-docs', said([call('tu-docs-2', 'Read', { file_path: '/work/alpha/a.md' })])),
    ])
      fs.appendFileSync(transcript, JSON.stringify(record) + '\n');
    await page.waitForTimeout(1_500);
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.click(); // more office on screen

    let fixId = -1;
    for (const [label, p] of [
      ['desktop', page],
      ['phone', phone],
    ] as const) {
      if (p === phone) {
        // T-0041: the sub-agents sit at a spare desk, maybe off this small
        // screen: the lead's +3 list takes the camera to "fix login", then
        // let go (a tap on the floor) so a tap selects it again; fresh work.
        // The phone's cards are compact by default; the +N chip waits for the full ones.
        if ((await p.getByTestId('cards-toggle').getAttribute('aria-expanded')) !== 'true')
          await p.getByTestId('cards-toggle').tap();
        await p.locator('[title="lead"] [data-testid="temp-chip"]').first().tap();
        // TEMP-PLATES: the sub-agent wears its roster employee's name; the row knows its task.
        const fixRow = p.locator('[data-testid="temp-row"]').filter({ hasText: 'fix login' });
        fixId = Number(await fixRow.getAttribute('data-agent-id'));
        await fixRow.tap();
        await p.waitForTimeout(1_500);
        // The camera glides to the sub-agent and may still be on its way (slowly on a slow run): let it arrive
        // before the floor tap lets go of it.
        await until('phone: "fix login" is mid-screen', async () => {
          const a = (await anchors(p)).find((x) => x.id === fixId);
          const box = await p.locator('[data-testid="office-canvas"]').boundingBox();
          return !!a && !!box && Math.abs(a.x - (box.x + box.width / 2)) < box.width * 0.3;
        });
        // T-0056: the row also opens the temp's work view over the office; close it.
        const closeWork = p.getByRole('button', { name: '닫기', exact: true });
        if (await closeWork.count()) await closeWork.first().tap();
        await p.waitForTimeout(500);
        const canvas = (await p.locator('[data-testid="office-canvas"]').boundingBox())!;
        // Tap the bare canvas somewhere nobody stands (no label or control over it): deselects.
        const floor = await p.evaluate(() => {
          const c = document.querySelector('[data-testid="office-canvas"]')!;
          const r = c.getBoundingClientRect();
          for (const [fx, fy] of [
            [0.1, 0.1],
            [0.9, 0.1],
            [0.1, 0.9],
            [0.9, 0.9],
            [0.5, 0.1],
            [0.5, 0.9],
            [0.1, 0.5],
            [0.9, 0.5],
          ]) {
            const x = r.left + r.width * fx;
            const y = r.top + r.height * fy;
            if (document.elementFromPoint(x, y) === c) return { x, y };
          }
          return null;
        });
        await p.touchscreen.tap(floor?.x ?? canvas.x + 8, floor?.y ?? canvas.y + 8);
        for (const record of [
          sub('tu-fix', said([call('tu-fix-3', 'Grep', { pattern: 'token' })])),
          sub('tu-docs', said([call('tu-docs-3', 'Read', { file_path: '/work/alpha/b.md' })])),
        ])
          fs.appendFileSync(transcript, JSON.stringify(record) + '\n');
        await p.waitForTimeout(1_500);
      }
      // 1. Only orchestrators carry a name.
      const shown = await names(p);
      check(
        shown.length === 2 &&
          shown.every(([, kind]) => kind === 'orchestrator') &&
          shown
            .map(([n]) => n)
            .sort()
            .join() === 'lead,veteran',
        `${label}: only the orchestrators have names (${shown.map((s) => s.join(':')).join(', ')})`,
      );
      const c = await cast(p);
      check(
        c.subs.length === 2 && c.mates.length === 1 && c.codex.length === 1,
        `${label}: the others wear a status icon only (${(await anchors(p)).map((a) => `${a.kind}:${a.icon}`).join(', ')})`,
      );
      // 2. An idle character shows zzz: the anchor says so and the canvas draws it.
      const idle = [...c.codex, ...c.mates].filter((a) => a.icon === 'zzz');
      check(
        idle.length >= 1,
        `${label}: an idle character's icon is zzz (${idle.map((a) => a.label).join(', ')})`,
      );
      let best = { zoom: 0, zzz: 0, box: 0 };
      for (let i = 0; i < 18 && best.zzz < 0.9; i++) {
        for (const a of await anchors(p)) {
          if (a.icon !== 'zzz') continue;
          const d = await drawnIcon(p, a);
          if (d.zzz > best.zzz) best = d;
        }
        // The lobby/rooms may start out of this view: the phone's card brings the character in, the
        // desktop zooms out a step (Ctrl+wheel), now and then.
        if (best.zoom === 0 && i % 3 === 2 && p === phone && idle[0]) {
          await p
            .locator(`[data-testid="agent-card"][data-agent-id="${idle[0].id}"]`)
            .first()
            .tap();
          await p.waitForTimeout(1_200);
        } else if (best.zoom === 0 && i % 3 === 2) {
          const box = (await p.getByTestId('office-canvas').boundingBox())!;
          await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await p.keyboard.down('Control');
          await p.mouse.wheel(0, 120);
          await p.keyboard.up('Control');
        }
        await p.waitForTimeout(250);
      }
      check(
        best.zzz >= 0.9,
        `${label}: the canvas draws the zzz (${Math.round(best.zzz * 100)}% at zoom ${best.zoom})`,
      );
      // The working sub-agents: the activity icon in its box.
      // T-0041: they may still be walking in from the door: the best of a few
      // looks, each with a fresh anchor.
      // The one the phone's camera went to (the other may sit out of view).
      const watched = c.subs.find((s) => s.id === fixId) ?? c.subs[0];
      let subBox = { zoom: 0, zzz: 0, box: 0 };
      for (let i = 0; i < 24 && subBox.box < 0.8; i++) {
        const a = (await anchors(p)).find((x) => x.id === watched.id);
        if (a) {
          const d = await drawnIcon(p, a);
          if (d.box > subBox.box) subBox = d;
        }
        // Out of this view (the lobby, a big map)? Zoom out a step now and then.
        if (subBox.zoom === 0 && i % 3 === 2) {
          const box = (await p.getByTestId('office-canvas').boundingBox())!;
          await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
          await p.keyboard.down('Control');
          await p.mouse.wheel(0, 120);
          await p.keyboard.up('Control');
        }
        await p.waitForTimeout(150);
      }
      check(
        c.subs.every((s) => s.icon === 'activity') && subBox.box >= 0.8,
        `${label}: a working sub-agent shows its activity box (${Math.round(subBox.box * 100)}% at zoom ${subBox.zoom})`,
      );
      await shot(p, `${label}-office`);

      // 3. Hover (desktop) or tap (phone) a sub-agent: its details.
      const target = c.subs.find((s) => s.id === fixId) ?? c.subs[0];
      const dpr = label === 'phone' ? 3 : 1;
      let z = (subBox.zoom || best.zoom) / dpr; // the last match pins the zoom (a box fits several)
      const overlay = p.locator(`[data-testid="agent-overlay"][data-agent-id="${target.id}"]`);
      // Where it is now (T-0041: it may still be walking to its desk).
      await until(`${label}: the sub-agent's details show`, async () => {
        const at = (await anchors(p)).find((a) => a.id === target.id) ?? target;
        // The zoom as it is now (under load the camera may have settled a step off).
        const now = (await drawnIcon(p, at)).zoom;
        if (now > 0) z = now / dpr;
        const hx = at.x - ICON.offsetX * z;
        const hy = at.y + (ICON.rise - 10) * z;
        if (p === phone) await p.touchscreen.tap(hx, hy);
        else await p.mouse.move(hx, hy);
        await p.waitForTimeout(600);
        return (await overlay.locator('[data-testid="agent-details"]').count()) > 0;
      }).catch(async (err) => {
        await shot(p, `${label}-debug-hover`);
        throw err;
      });
      const detailName = await overlay.locator('[data-testid="agent-name"]').textContent();
      const detailKind = await overlay.locator('[data-testid="agent-kind"]').textContent();
      const details = await overlay.locator('[data-testid="agent-details"]').textContent();
      check(
        // TEMP-PLATES: a roster name, its task in the details, and the temporary-employee line.
        !!detailName &&
          !['fix login', 'write docs'].includes(detailName) &&
          detailKind === '서브에이전트' &&
          details?.includes('리더: lead') &&
          /fix login|write docs/.test(details) &&
          details.includes('임시 직원'),
        `${label}: ${p === phone ? 'tapping' : 'hovering'} a sub-agent shows "${detailName}" (${detailKind}; ${details})`,
      );
      await shot(p, `${label}-${p === phone ? 'tap' : 'hover'}-subagent`);
      if (p === page) await p.mouse.move(5, 400);

      // 4. Cards: grouped by kind, each named. T-0041: temps have no card of
      // their own; the lead's card carries +3 (two sub-agents and the scout),
      // the unowned Codex worker sits under 외주.
      const bar = await cardBar(p);
      const groups = bar.filter((x) => x.startsWith('|')).map((x) => x.slice(1));
      const want = ['오케스트레이터', '외주'];
      // Desktop: a header before every group; phone: a divider between groups.
      const wantGroups = p === phone ? want.slice(1) : want;
      const cards = bar.filter((x) => !x.startsWith('|'));
      const chips = await p.$$eval('[data-testid="agent-card"]', (nodes) =>
        nodes.map(
          (n) =>
            `${n.querySelector('[data-testid="card-name"]')?.textContent}${n.querySelector('[data-testid="temp-chip"]')?.textContent ?? ''}`,
        ),
      );
      check(
        groups.join() === wantGroups.join() &&
          [...cards].sort().join() === 'lead,veteran,외주' &&
          chips.includes('lead+3') &&
          chips.includes('외주+1'),
        `${label}: cards grouped and named, temps as +N (${bar.join(' ')}; ${chips.join(' ')})`,
      );
    }
    // T-0045: the provider says veteran is mid-turn (session status busy) with no tool
    // running: it thinks (🤔, the activity icon) instead of resting (zzz); then back.
    const sessions = path.join(fake.home, '.claude/sessions');
    const withBusy = (busy: boolean) => {
      for (const f of fs.readdirSync(sessions)) {
        const file = path.join(sessions, f);
        const s = JSON.parse(fs.readFileSync(file, 'utf-8')) as Rec;
        if (s.name !== 'veteran') continue;
        fs.writeFileSync(
          file,
          JSON.stringify({ ...s, status: busy ? 'busy' : 'idle', statusUpdatedAt: Date.now() }),
        );
      }
    };
    const veteran = async () => (await anchors(page)).find((a) => a.label.startsWith('veteran:'));
    check((await veteran())?.icon === 'zzz', 'veteran, not busy and no tool, rests (zzz)');
    withBusy(true);
    await until(
      'a busy veteran with no tool thinks',
      async () => (await veteran())?.emoji === '🤔',
      30_000,
    );
    check((await veteran())?.icon === 'activity', 'busy and no tool: 🤔 with the activity icon');
    await shot(page, 'desktop-busy-thinking');
    withBusy(false);
    await until('veteran rests again', async () => (await veteran())?.icon === 'zzz', 30_000);
    check(true, 'not busy again: back to zzz');
    // Up close on the desktop: the camera follows a card's character, zoomed in.
    const office = (await page.locator('[data-testid="office-canvas"]').boundingBox())!;
    // T-0041: the scout has no card; its row in the lead's +3 list goes to it.
    await page.locator('[title="lead"] [data-testid="temp-chip"]').first().click();
    await page.locator('[data-testid="temp-row"]').filter({ hasText: 'scout' }).click();
    await page.mouse.move(office.x + office.width / 2, office.y + office.height / 2);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -120);
    await page.mouse.wheel(0, -120);
    await page.keyboard.up('Control');
    await page.waitForTimeout(1_500);
    await shot(page, 'desktop-closeup-idle');
    await page.locator('[title="lead"]').first().click();
    await page.waitForTimeout(1_500);
    const subNow = (await anchors(page)).find((a) => a.kind === 'subagent');
    if (subNow) {
      const z = (await drawnIcon(page, subNow)).zoom;
      await page.mouse.move(subNow.x - ICON.offsetX * z, subNow.y + (ICON.rise - 10) * z);
      await page.waitForTimeout(500);
    }
    await shot(page, 'desktop-closeup-hover');
    // The desktop card bar up close.
    const barBox = await page.locator('[data-testid="card-group"]').first().boundingBox();
    if (barBox)
      await page.screenshot({
        path: path.join(OUT, 'desktop-cards.png'),
        clip: { x: barBox.x - 20, y: 40, width: 120, height: 560 },
      });
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
  } finally {
    await browser.close();
    if (daemon.exitCode === null) {
      const exited = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      if (daemon.exitCode === null) daemon.kill('SIGKILL');
    }
    proc.kill('SIGKILL');
    worker.kill('SIGKILL');
    killFakeSessions(fake.home);
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
