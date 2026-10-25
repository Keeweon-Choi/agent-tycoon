/**
 * CHAR-NAMEPLATE (charpack v3 §6A) check: dist/cli.js with an isolated HOME on a
 * spare port, headless Chromium (--disable-gpu), desktop 1280x800 and phone
 * 393x852. 30 characters: 27 Claude sessions with long Korean parody names (11
 * crowded in alpha's room with 3 Codex workers, 8 in beta, 8 in gamma), each with
 * a context usage record (피로도) and a level in levels.json (U-15).
 * - every character carries a nameplate with its name; every session one with a
 *   ring (its levels.json numbers, read back from the aria-label) and a fatigue
 *   bar; a Codex worker has its rank icon and no ring (no level kept for it);
 * - the plates the runner itself finds overlapping (from their screen boxes)
 *   are exactly the dimmed ones, at 60 %; the others are at 100 %;
 * - selecting a dimmed character's plate makes it 100 % and on top; zooming in
 *   moves the characters apart and the plates that no longer overlap are 100 %;
 * - the overlap pass with 30 plates: passes per second and ms per pass;
 * - on the phone a long name ends in an ellipsis with the full name in its title.
 * Screenshots to cld/artifacts/char-nameplate/ (BEFORE=1: only the "before"
 * screenshots, against a build without nameplates).
 *
 *   npx tsx cld/test/run-nameplates.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  seedCodexTask,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const BEFORE = process.env.BEFORE === '1';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/char-nameplate');
const DIM = 0.6; // NAMEPLATE_OVERLAP_OPACITY
const SLOP = 4; // NAMEPLATE_OVERLAP_SLOP_PX
/** Names up to six syllables: in full on a phone's unselected plate. */
const SIX = ['해리 커밋터', '다스 디버거', '셜록 홈즈버그', '레골라스 린터'];

/** name, cwd, xp, rebirths, context tokens (of a 200k window). */
const CREW: Array<[string, string, number, number, number]> = [
  ['해리 커밋터', '/work/alpha', 75, 0, 40_000],
  ['다스 디버거', '/work/alpha', 37, 0, 150_000],
  ['헤르미온느 그레인저 리팩터링 대마법사', '/work/alpha', 0, 2, 90_000],
  ['간달프 더 머지', '/work/alpha', 375, 1, 120_000],
  ['셜록 홈즈버그', '/work/alpha', 600, 0, 20_000],
  ['프로도 배기스 핫픽스', '/work/alpha', 150, 0, 170_000],
  ['Obi-Wan Kenobuild', '/work/alpha', 99, 0, 60_000],
  ['론 위즐리 롤백', '/work/alpha', 10, 3, 10_000],
  ['덤블도어 디프', '/work/alpha', 210, 0, 80_000],
  ['레골라스 린터', '/work/alpha', 50, 0, 30_000],
  ['아라곤 어설션', '/work/alpha', 5, 0, 100_000],
  ...Array.from({ length: 8 }, (_, k): [string, string, number, number, number] => [
    `베타 요원 ${k + 1}호`,
    '/work/beta',
    k * 40,
    0,
    20_000 * (k + 1),
  ]),
  ...Array.from({ length: 8 }, (_, k): [string, string, number, number, number] => [
    `감마 수습 ${k + 1}호`,
    '/work/gamma',
    k * 25,
    0,
    15_000 * (k + 1),
  ]),
];
/** The ring's text for xp (levels.ts: Lv n starts at 50n(n-1) XP). */
function ringText(xp: number): string {
  let level = 1;
  while (50 * (level + 1) * level <= xp) level++;
  const floor = 50 * level * (level - 1);
  const next = 50 * (level + 1) * level;
  return `레벨 ${level}, 경험치 ${Math.floor(((xp - floor) / (next - floor)) * 100)}%`;
}

let oks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  oks++;
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

function session(home: string, k: number, name: string, cwd: string, tokens: number): ChildProcess {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `c0700000-0000-4000-8000-${String(k).padStart(12, '0')}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  // One finished turn with its usage: the 피로도 the office reads at adoption.
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, cache_read_input_tokens: tokens - 1, output_tokens: 0 },
      },
    }) + '\n',
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
      name,
      status: 'idle',
    }),
  );
  return proc;
}

interface Plate {
  id: number;
  name: string;
  title: string;
  ring: string | null;
  fatigue: boolean;
  rank: string | null;
  dim: boolean;
  opacity: number;
  ellipsis: boolean;
  box: { l: number; t: number; r: number; b: number };
}
const plates = (page: Page): Promise<Plate[]> =>
  page.$$eval('[data-nameplate]', (nodes) =>
    nodes.map((n) => {
      const r = n.getBoundingClientRect();
      const name = n.querySelector<HTMLElement>('[data-testid="agent-name"]');
      return {
        id: Number(n.getAttribute('data-agent-id')),
        name: name?.textContent ?? '',
        title: name?.getAttribute('data-name') ?? '',
        ring: n.querySelector('[data-testid="level-ring"]')?.getAttribute('aria-label') ?? null,
        fatigue: !!n.querySelector('[data-testid="fatigue"]'),
        rank: n.querySelector('[data-testid="rank-icon"]')?.getAttribute('aria-label') ?? null,
        dim: n.hasAttribute('data-dim'),
        opacity: Number(getComputedStyle(n).opacity),
        ellipsis: !!name && name.scrollWidth > name.clientWidth,
        box: { l: r.left, t: r.top, r: r.right, b: r.bottom },
      };
    }),
  );
/** The runner's own overlap rule, over the plates' screen boxes (all pairs: a reference). */
function overlapping(ps: Plate[]): Set<number> {
  const out = new Set<number>();
  for (const a of ps)
    for (const b of ps)
      if (
        a !== b &&
        a.box.l + SLOP < b.box.r &&
        b.box.l + SLOP < a.box.r &&
        a.box.t + SLOP < b.box.b &&
        b.box.t + SLOP < a.box.b
      )
        out.add(a.id);
  return out;
}
const anchorCount = (page: Page) =>
  page.locator('[data-testid="status-icon-anchor"]').count();
type Stats = { passes: number; ms: number; maxMs: number; plates: number };
const stats = (page: Page): Promise<Stats> =>
  page.evaluate(
    () =>
      (
        window as unknown as { __pixelAgentsTestHooks: { getNameplateStats: () => Stats } }
      ).__pixelAgentsTestHooks.getNameplateStats(),
  );

/** Dimmed = overlapping and not focused; the focused plate is never dimmed. */
async function checkOverlap(page: Page, label: string, focus: number | null): Promise<Plate[]> {
  await page.waitForTimeout(600); // a pass or two after the last change
  const ps = await plates(page);
  const over = overlapping(ps);
  const wrong = ps.filter((p) => p.dim !== (over.has(p.id) && p.id !== focus));
  check(
    wrong.length === 0,
    `${label}: the dimmed plates are exactly the overlapping ones (${ps.filter((p) => p.dim).length} of ${ps.length} dimmed${wrong.length ? `; wrong: ${wrong.map((p) => p.name).join(', ')}` : ''})`,
  );
  const off = ps.filter((p) => Math.abs(p.opacity - (p.dim ? DIM : 1)) > 0.01);
  check(off.length === 0, `${label}: dimmed plates at ${DIM * 100} %, the rest at 100 %`);
  const vp = page.viewportSize()!;
  const seen = ps.filter((p) => p.box.r > 0 && p.box.l < vp.width && p.box.b > 0 && p.box.t < vp.height);
  const widths = seen.map((p) => p.box.r - p.box.l).sort((a, b) => a - b);
  console.log(
    `${label}: on screen ${seen.length} plates, ${seen.filter((p) => p.dim).length} dimmed; ` +
      `plate width median ${widths[widths.length >> 1]?.toFixed(1)} px, max ${widths.at(-1)?.toFixed(1)} px`,
  );
  return ps;
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const procs = CREW.map(([name, cwd, , , tokens], k) => session(home, k + 1, name, cwd, tokens));
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/levels.json'),
    JSON.stringify({
      v: 1,
      levels: Object.fromEntries(CREW.map(([name, , xp, rebirths]) => [`name:${name}`, { xp, rebirths }])),
    }),
  );
  ['terra', 'sol', 'luna'].forEach((model, k) => {
    const job = spawn('sleep', ['900'], { stdio: 'ignore' });
    procs.push(job);
    seedCodexTask(home, {
      id: `1024-12000${k}-alpha`,
      project: 'alpha',
      state: 'running',
      model,
      spec: `T-7${k}.md`,
      started: new Date(Date.now() - 600_000).toISOString(),
      pid: job.pid!,
    });
  });
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal', '--engine', 'on']);
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const ready = async (page: Page, url: string) => {
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    // The bundled Galmuri11 draws the Hangul, as on a phone (no system-font override).
    await page.evaluate(() => document.fonts.load("16px Galmuri11", '가'));
    await page.evaluate(() => document.fonts.ready);
    await until('30 characters in the office', async () => (await anchorCount(page)) >= 30, 60_000);
    let before = '';
    await until(
      'everyone sat down',
      async () => {
        const now = JSON.stringify(
          await page.$$eval('[data-testid="status-icon-anchor"]', (ns) =>
            ns.map((n) => [n.getBoundingClientRect().left, n.getBoundingClientRect().top]),
          ),
        );
        const still = now === before;
        before = now;
        await page.waitForTimeout(700);
        return still;
      },
      90_000,
    );
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.first().click();
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${BEFORE ? 'before' : 'after'}-${name}.png`) });
  const select = (page: Page, id: number | null) =>
    page.evaluate((id) => {
      (
        window as unknown as { __pixelAgentsTestHooks: { selectAgent: (id: number | null) => void } }
      ).__pixelAgentsTestHooks.selectAgent(id as number);
    }, id);
  /** Bring alpha's room (its first session) to the middle of the screen. */
  const focusAlpha = async (page: Page) => {
    const card = page.locator('[data-testid="agent-card"]').filter({ hasText: CREW[0][0] }).first();
    if (await card.count()) {
      if (page.viewportSize()!.width < 500) await card.tap();
      else await card.click();
      await page.waitForTimeout(1_500);
    }
  };

  try {
    const loginUrl = await daemon.loginUrl();
    const { ctx: desk, page } = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await ready(page, loginUrl);
    await focusAlpha(page);
    await select(page, null);
    await page.mouse.move(1270, 790);
    await page.waitForTimeout(800);
    await shot(page, 'desktop');

    if (!BEFORE) {
      const ps = await plates(page);
      const ids = await page.$$eval('[data-testid="status-icon-anchor"]', (ns) =>
        ns.map((n) => [Number(n.getAttribute('data-agent-id')), n.getAttribute('data-kind')] as const),
      );
      check(
        ids.every(([id]) => ps.some((p) => p.id === id && p.name)),
        `desktop: all ${ids.length} characters carry a nameplate with a name`,
      );
      const byName = new Map(ps.map((p) => [p.title || p.name, p]));
      for (const [name, , xp] of CREW) {
        const p = byName.get(name);
        check(p?.ring === ringText(xp), `desktop: ${name}: ring "${p?.ring}" (${ringText(xp)})`);
        check(p?.fatigue, `desktop: ${name}: a fatigue bar`);
      }
      const codex = ps.filter((p) => ids.some(([id, kind]) => id === p.id && kind === 'codex'));
      check(
        // TEMP-PLATES: each is a roster employee, with its own level from Lv 1.
        codex.length === 3 && codex.every((p) => p.rank && p.ring?.startsWith('레벨 1')),
        `desktop: the 3 Codex workers carry a rank icon (${codex.map((p) => p.rank).join(' / ')}) and their employee's ring (${codex.map((p) => p.ring).join(' / ')})`,
      );
      check(
        ps.filter((p) => !codex.includes(p)).every((p) => p.rank),
        'desktop: every session (an orchestrator) carries the lead icon',
      );

      // Overlap: the default view, then zoomed out one step (the wheel zooms
      // around the pointer: over the middle of alpha's crowd) so the room's plates crowd.
      const atDefault = await checkOverlap(page, 'desktop', null);
      const mid = atDefault.filter((p) => p.box.l > 0 && p.box.r < 1200 && p.box.t > 0 && p.box.b < 800);
      const cx = mid.reduce((a, p) => a + (p.box.l + p.box.r) / 2, 0) / mid.length;
      const cy = mid.reduce((a, p) => a + p.box.b, 0) / mid.length;
      const wheel = async (dy: number, n: number) => {
        await page.mouse.move(cx, cy);
        for (let i = 0; i < n; i++) {
          await page.mouse.wheel(0, dy);
          await page.waitForTimeout(150);
        }
        await select(page, null);
        await page.mouse.move(1270, 790);
      };
      await wheel(120, 1);
      const crowd = await checkOverlap(page, 'desktop, zoomed out', null);
      const dimmed = crowd.filter((p) => p.dim);
      check(dimmed.length >= 2, `desktop: the crowded room has overlapping plates (${dimmed.length})`);
      await shot(page, 'desktop-crowded');

      // Select a dimmed one: 100 % and on top.
      const pick = dimmed[0];
      await select(page, pick.id);
      await page.waitForTimeout(400);
      const sel = (await plates(page)).find((p) => p.id === pick.id)!;
      check(!sel.dim && sel.opacity === 1, `desktop: selecting ${pick.name} makes its plate 100 %`);
      const onTop = await page.evaluate((s) => {
        const x = (s.box.l + s.box.r) / 2;
        const y = (s.box.t + s.box.b) / 2;
        return document.elementFromPoint(x, y)?.closest('[data-nameplate]')?.getAttribute('data-agent-id');
      }, sel);
      check(Number(onTop) === pick.id, `desktop: ${pick.name}'s plate is on top of the ones it overlaps`);
      await checkOverlap(page, 'desktop, selected', pick.id);
      await shot(page, 'desktop-selected');
      await select(page, null);

      // Hover another dimmed one, the pointer on its legs (the first whose legs no
      // rest bubble covers): 100 % and on top.
      const legs = (id: number) =>
        page.evaluate((id) => {
          const h = (
            window as unknown as {
              __pixelAgentsTestHooks: {
                getTileCenter: (c: number, r: number) => { x: number; y: number } | null;
                getCharacterPosition: (id: number) => { x: number; y: number } | null;
              };
            }
          ).__pixelAgentsTestHooks;
          const a = h.getTileCenter(0, 0)!;
          const b = h.getTileCenter(1, 0)!;
          const k = (b.x - a.x) / 16; // CSS px per world px
          const p = h.getCharacterPosition(id)!;
          const r = document.querySelector('[data-testid="office-canvas"]')!.getBoundingClientRect();
          const x = r.left + a.x + (p.x - 8) * k;
          const y = r.top + a.y + (p.y - 4 - 8) * k;
          return document.elementFromPoint(x, y)?.getAttribute('data-testid') === 'office-canvas'
            ? { x, y }
            : null;
        }, id);
      let other: Plate | undefined;
      for (const d of dimmed.filter((d) => d.id !== pick.id)) {
        const at = await legs(d.id);
        if (!at) continue;
        await page.mouse.move(at.x, at.y);
        await page.waitForTimeout(400);
        other = d;
        break;
      }
      const hov = (await plates(page)).find((p) => p.id === other?.id);
      check(hov && !hov.dim && hov.opacity === 1, `desktop: hovering ${other?.name} makes its plate 100 %`);
      await checkOverlap(page, 'desktop, hovered', other!.id);
      await page.mouse.move(1270, 790);

      // The pass's cost with 30 plates, sampled over 5 s.
      const s0 = await stats(page);
      await page.waitForTimeout(5_000);
      const s1 = await stats(page);
      const passes = s1.passes - s0.passes;
      const msPer = (s1.ms - s0.ms) / Math.max(1, passes);
      console.log(
        `overlap pass: ${s1.plates} plates, ${(passes / 5).toFixed(1)} passes/s, ${msPer.toFixed(3)} ms per pass (max ${s1.maxMs.toFixed(3)} ms)`,
      );
      check(s1.plates >= 30, `the pass sees ${s1.plates} plates`);
      check(passes / 5 <= 6, `the pass is throttled (${(passes / 5).toFixed(1)}/s)`);

      // Zoom in: the characters move apart, the plates that no longer overlap return to 100 %.
      await wheel(-120, 3);
      const apart = await checkOverlap(page, 'desktop, zoomed in', null);
      const back = dimmed.filter((d) => apart.some((p) => p.id === d.id && !p.dim));
      check(back.length > 0, `desktop: zoomed in, ${back.length} plates no longer overlap and are back at 100 %`);
      await shot(page, 'desktop-zoomed');
    }

    for (const [tag, viewport] of [
      ['phone', { width: 393, height: 852 }],
      ['phone-390', { width: 390, height: 844 }],
    ] as const) {
      const { ctx: phoneCtx, page: phone } = await open({
        viewport,
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 3,
      });
      await desk.cookies().then((c) => phone.context().addCookies(c));
      await ready(phone, `http://127.0.0.1:${port}/`);
      await focusAlpha(phone);
      await select(phone, null);
      await phone.waitForTimeout(800);
      await shot(phone, tag);
      if (!BEFORE) {
        const ps = await checkOverlap(phone, tag, null);
        // Names up to six syllables read in full on an unselected plate.
        for (const name of SIX) {
          const p = ps.find((x) => x.title === name);
          check(p && !p.ellipsis && p.name === name, `${tag}: "${name}" reads in full`);
        }
        const long = ps.find((p) => p.title === CREW[2][0]);
        check(long?.ellipsis && long.name === CREW[2][0], `${tag}: the long name ends in an ellipsis`);
        if (tag === 'phone') {
          // Its card brings it into view (the first tap focuses), then it is selected.
          await phone.locator('[data-testid="agent-card"]').filter({ hasText: '헤르미온느' }).first().tap();
          await phone.waitForTimeout(1_500);
          await select(phone, long!.id);
          await phone.waitForTimeout(400);
          const opened = (await plates(phone)).find((p) => p.id === long!.id)!;
          check(!opened.ellipsis, `${tag}: selected, the long name reads in full`);
          await shot(phone, `${tag}-selected`);
          // The office slid off screen, as the phone shell's terminal page does (the
          // test moves the office's page itself: this office has no shell terminal):
          // nothing is measured; slid back, the first overlay render measures at once.
          await select(phone, null);
          const slide = (x: string) =>
            phone.evaluate((x) => {
              const page = document.querySelector('[data-testid="office-canvas"]')!.parentElement!;
              page.style.transform = x;
            }, x);
          await slide('translateX(-110%)');
          await phone.waitForTimeout(800);
          const canvasOff = await phone.evaluate(() => {
            const r = document.querySelector('[data-testid="office-canvas"]')!.getBoundingClientRect();
            return r.right <= 0 || r.left >= window.innerWidth;
          });
          check(canvasOff, `${tag}: the office canvas is off screen`);
          const off0 = (await stats(phone)).passes;
          await phone.waitForTimeout(4_000);
          const offPasses = (await stats(phone)).passes - off0;
          check(offPasses === 0, `${tag}: off screen, no overlap passes (${offPasses} in 4 s)`);
          // Three times, 80 ms each: the 200 ms timer alone would land in all three ~6 % of the time.
          const backs: number[] = [];
          for (let i = 0; i < 3; i++) {
            if (i) {
              await slide('translateX(-110%)');
              await phone.waitForTimeout(500);
            }
            const back0 = (await stats(phone)).passes;
            await slide('');
            await phone.waitForTimeout(80);
            backs.push((await stats(phone)).passes - back0);
          }
          check(
            backs.every((n) => n > 0),
            `${tag}: back on the office, measured at once (passes within 80 ms: ${backs.join(', ')})`,
          );
        }
      }
      await phoneCtx.close();
    }
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
    console.log(`\n${oks} checks passed`);
  } finally {
    await browser.close();
    await daemon.stop();
    for (const p of procs) p.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
