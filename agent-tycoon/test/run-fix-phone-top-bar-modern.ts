/**
 * FIX-PHONE-TOP-BAR-MODERN (T-111): on the phone the top bar (floor picker, job chip, clock with its
 * day bar, 설정) drew the elevator lamp and a different chip in 모던, the day bar ran into the chip,
 * and the buttons touched the bar's bottom border. dist/cli.js in an isolated HOME (fake claude, a
 * building.json with two floors so the picker shows) on a spare port, headless Chromium
 * (--disable-gpu), a touch phone at 390x844, 375x667 and 320x568, both screen styles, on the
 * 사무실 and 메신저 tabs. The runner asserts geometry and computed styles, not looks.
 *
 * Per view: (a) the day bar overlaps no button and sits inside the clock's own grid column, the
 * buttons inside theirs; (b) every button is at least GAP px inside the bar's border box at the
 * bottom and at both ends, the same at both ends; (c) 모던: the picker has a radius, a 1 px border,
 * the UI font and the job chip's and 설정's button colours (no lamp box); (d) 픽셀 감성: the picker
 * keeps radius 0, a 2 px border and the lamp box. Screenshots: agent-tycoon/artifacts/t0111/.
 *
 *   npx tsx agent-tycoon/test/run-fix-phone-top-bar-modern.ts <port 18256-18599> <before|after>
 */
import type { Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
const PHASE = process.argv[3] === 'after' ? 'after' : 'before';
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/t0111');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0111/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
/** An iPhone's status bar and home indicator, as the safe-area vars carry them. */
const SAFE_AREA = ':root { --agty-safe-top: 47px; --agty-safe-bottom: 34px; }';
/** The least gap (CSS px) between a button and the bar's border box at the bottom and both ends. */
const GAP = 6;
const VIEWS = [
  { w: 390, h: 844 },
  { w: 375, h: 667 },
  { w: 320, h: 568 },
] as const;
const STYLES = ['modern', 'pixel'] as const;
const TABS = ['office', 'messenger'] as const;

let failed = 0;
function check(ok: unknown, what: string): void {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`);
  if (!ok) failed++;
}

interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}
interface Probe {
  bar: Rect;
  buttons: Array<Rect & { id: string }>;
  day: Rect | null;
  col1: [number, number];
  col2: [number, number];
  picker: { radius: number; border: number; font: string; bg: string; color: string };
  /** The lamp box's background as the browser computes it (--agty-lamp-bg). */
  lampBg: string;
  chip: { bg: string; border: string; radius: number; h: number } | null;
  gear: { bg: string; border: string; radius: number; h: number } | null;
}

/** Everything the checks need, measured in the page. */
const probe = (page: Page): Promise<Probe> =>
  page.evaluate(() => {
    const rect = (e: Element) => {
      const r = e.getBoundingClientRect();
      return { l: r.left, t: r.top, r: r.right, b: r.bottom };
    };
    const bar = document.querySelector('[data-testid="mobile-top-bar"]') as HTMLElement;
    const cs = getComputedStyle(bar);
    const barRect = bar.getBoundingClientRect();
    const cols = cs.gridTemplateColumns.split(' ').map(parseFloat);
    const gap = parseFloat(cs.columnGap);
    const left = barRect.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
    const col1: [number, number] = [left, left + cols[0]];
    const col2: [number, number] = [col1[1] + gap, col1[1] + gap + cols[1]];
    const buttons = [...bar.querySelectorAll('button')]
      .filter((b) => b.getBoundingClientRect().width > 0)
      .map((b) => ({ id: b.getAttribute('data-testid') ?? b.getAttribute('aria-label') ?? '?', ...rect(b) }));
    const style = (e: Element) => {
      const s = getComputedStyle(e);
      return {
        bg: s.backgroundColor,
        border: s.borderTopColor,
        radius: parseFloat(s.borderTopLeftRadius),
        h: e.getBoundingClientRect().height,
      };
    };
    const picker = bar.querySelector('[data-testid="floor-picker"]') as HTMLElement;
    const ps = getComputedStyle(picker);
    const chip = bar.querySelector('[data-testid="hud-jobs"]');
    const gear = bar.querySelector('button[aria-label="설정"]');
    const day = bar.querySelector('.game-day');
    const probeEl = document.createElement('i');
    probeEl.style.background = 'var(--agty-lamp-bg)';
    document.body.appendChild(probeEl);
    const lampBg = getComputedStyle(probeEl).backgroundColor;
    probeEl.remove();
    return {
      lampBg,
      bar: rect(bar),
      buttons,
      day: day ? rect(day) : null,
      col1,
      col2,
      picker: {
        radius: parseFloat(ps.borderTopLeftRadius),
        border: parseFloat(ps.borderTopWidth),
        font: ps.fontFamily,
        bg: ps.backgroundColor,
        color: ps.color,
      },
      chip: chip ? style(chip) : null,
      gear: gear ? style(gear) : null,
    };
  });

const overlap = (a: Rect, b: Rect) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
const r1 = (n: number) => Math.round(n * 10) / 10;

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  fs.mkdirSync(configDirectory(fake.home), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(fake.home), 'building.json'),
    JSON.stringify({
      version: 1,
      floors: [
        { id: '1', name: '1층', rooms: [], characters: [] },
        { id: '2', name: '2층', rooms: [], characters: [] },
      ],
      perProject: false,
    }),
  );
  const daemon = startDaemon(fake, port, ['--allow-chat', '--no-terminal']);
  const font = fs.readFileSync(FONT);
  const pageErrors: string[] = [];
  const browser = await launchBrowser();
  const deadline = setTimeout(() => {
    console.error('aborted: deadline');
    daemon.child.kill('SIGKILL');
    process.exit(1);
  }, 300_000);
  try {
    for (const style of STYLES) {
      for (const view of VIEWS) {
        const ctx = await browser.newContext({
          viewport: { width: view.w, height: view.h },
          deviceScaleFactor: 3,
          isMobile: true,
          hasTouch: true,
          userAgent: devices['iPhone 13'].userAgent,
        });
        await ctx.route('**/__t0111/malgun.ttf', (route) =>
          route.fulfill({ body: font, contentType: 'font/ttf' }),
        );
        await ctx.addInitScript((th) => {
          (window as unknown as { __AGENT_TYCOON_E2E: boolean }).__AGENT_TYCOON_E2E = true;
          (window as unknown as { __name: (f: unknown) => unknown }).__name = (f) => f;
          localStorage.setItem('agty.title-scene', 'off');
          localStorage.setItem('agty.office-iso', 'off');
          localStorage.setItem('agty.ui-theme', th);
        }, style);
        const page = await ctx.newPage();
        page.on('pageerror', (e) => pageErrors.push(String(e)));
        await page.goto(await daemon.loginUrl());
        await page.waitForURL(`http://127.0.0.1:${port}/`);
        await page.addStyleTag({ content: FONT_CSS + SAFE_AREA });
        await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
        await page.getByTestId('floor-picker').waitFor({ timeout: 30_000 });
        await page.waitForTimeout(1500);

        for (const tab of TABS) {
          if (tab === 'messenger') {
            await page.locator('[data-dock="messenger"]').tap();
            await page.waitForTimeout(800);
          }
          const tag = `${style} ${view.w}x${view.h} ${tab}`;
          const p = await probe(page);
          // (a) the day bar and the neighbours.
          const touching = p.buttons.filter((b) => p.day && overlap(p.day, b)).map((b) => b.id);
          check(p.day && touching.length === 0, `(a) ${tag}: the day bar overlaps no button (${touching.join(', ') || 'none'})`);
          check(
            p.day && p.day.l >= p.col2[0] - 0.5 && p.day.r <= p.col2[1] + 0.5,
            `(a) ${tag}: the day bar is inside the clock's column (day ${r1(p.day?.l ?? 0)}-${r1(p.day?.r ?? 0)}, column ${r1(p.col2[0])}-${r1(p.col2[1])})`,
          );
          const first = p.buttons.filter((b) => b.r <= p.col1[1] + 40 && b.l < p.col2[0]);
          check(
            first.every((b) => b.r <= p.col1[1] + 0.5),
            `(a) ${tag}: the buttons of the first column stay inside it (right ${r1(Math.max(...first.map((b) => b.r)))} of ${r1(p.col1[1])})`,
          );
          // (b) the gap to the bar's border box.
          const bottom = Math.min(...p.buttons.map((b) => p.bar.b - b.b));
          const leftGap = Math.min(...p.buttons.map((b) => b.l - p.bar.l));
          const rightGap = Math.min(...p.buttons.map((b) => p.bar.r - b.r));
          check(bottom >= GAP, `(b) ${tag}: bottom gap ${r1(bottom)} >= ${GAP}`);
          check(
            leftGap >= GAP && rightGap >= GAP && Math.abs(leftGap - rightGap) <= 1,
            `(b) ${tag}: end gaps left ${r1(leftGap)}, right ${r1(rightGap)}, equal and >= ${GAP}`,
          );
          if (style === 'modern') {
            // (c)
            check(p.picker.radius > 0, `(c) ${tag}: picker radius ${p.picker.radius} > 0`);
            check(p.picker.border === 1, `(c) ${tag}: picker border ${p.picker.border}px is 1`);
            check(/Pretendard/.test(p.picker.font), `(c) ${tag}: picker font is the UI font (${p.picker.font.slice(0, 40)})`);
            check(p.picker.bg !== p.lampBg, `(c) ${tag}: picker background ${p.picker.bg} is not the lamp box`);
            check(
              p.chip && p.gear && p.chip.bg === p.gear.bg && p.chip.border === p.gear.border && p.chip.radius === p.gear.radius,
              `(c) ${tag}: job chip looks like 설정 (chip ${JSON.stringify(p.chip)}, 설정 ${JSON.stringify(p.gear)})`,
            );
            check(
              p.chip && p.gear && Math.abs(p.chip.h - p.gear.h) < 0.5,
              `(c) ${tag}: job chip is as tall as 설정 (${p.chip?.h} vs ${p.gear?.h})`,
            );
          } else {
            // (d)
            check(p.picker.radius === 0, `(d) ${tag}: picker radius ${p.picker.radius} is 0`);
            check(p.picker.border === 2, `(d) ${tag}: picker border ${p.picker.border}px is 2`);
            check(p.picker.bg === p.lampBg, `(d) ${tag}: picker keeps the lamp box (${p.picker.bg})`);
          }
          // Pictures: the bar at 3x like the owner's, and one full page per style on 390.
          const clipH = Math.ceil(p.bar.b) + 8;
          await page.screenshot({
            path: path.join(OUT, `${PHASE}-${style}-${view.w}x${view.h}-${tab}-bar.png`),
            clip: { x: 0, y: 0, width: view.w, height: clipH },
          });
          if (view.w === 390)
            await page.screenshot({ path: path.join(OUT, `${PHASE}-${style}-${view.w}x${view.h}-${tab}-full.png`) });
        }
        await ctx.close();
      }
    }
    check(pageErrors.length === 0, `no page errors (${pageErrors.slice(0, 2).join(' | ')})`);
  } finally {
    clearTimeout(deadline);
    await browser.close();
    await daemon.stop();
  }
  console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
