/**
 * UI-SCALE check: dist/cli.js with an isolated HOME on a spare port, headless
 * Chromium (--disable-gpu), phone 390x844 and desktop 1280x800, 8 Claude sessions
 * with a level and a 피로도 each. For every 화면 크기 step, chosen in 설정:
 * - the nameplate's numbers are the step's (name font, ring, 피로도 row font, rank
 *   icon width): 보통 on the phone is today's phone plate (16 / 22 / 14 / x2);
 * - Tailwind sizes follow --ui-scale (설정's title font, an agent card's name font);
 * - 크게 on the phone: no plate wider than the screen, no page horizontal scroll;
 * - the choice survives a reload; a new browser starts at 보통.
 * Screenshots to cld/artifacts/ui-scale/.
 *
 *   npx tsx cld/test/run-ui-scale.ts <port 18256-18259>
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
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/ui-scale');
const STEPS = [
  ['small', '작게'],
  ['medium', '보통'],
  ['large', '크게'],
] as const;
/** constants.ts NAMEPLATE_SIZES: name font, ring, 피로도 font, rank icon scale (its width is compared between steps). */
const PLATE = {
  small: { name: 16, ring: 20, fatigue: 12, rank: 2 },
  medium: { name: 16, ring: 22, fatigue: 14, rank: 2 },
  large: { name: 20, ring: 26, fatigue: 18, rank: 3 },
} as const;
const FACTOR = { small: 0.875, medium: 1, large: 1.25 } as const;
const CREW = ['해리 커밋터', '다스 디버거', '간달프 더 머지', '셜록 홈즈버그', '프로도 배기스 핫픽스', '레골라스 린터', '덤블도어 디프', '아라곤 어설션'];

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

function session(home: string, k: number, name: string): ChildProcess {
  const cwd = '/work/alpha';
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `c0800000-0000-4000-8000-${String(k).padStart(12, '0')}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5',
        content: [{ type: 'text', text: 'ok' }],
        usage: { input_tokens: 1, cache_read_input_tokens: 20_000 * k, output_tokens: 0 },
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

interface Measure {
  scaleVar: string;
  dataScale: string | undefined;
  name: number;
  ring: number;
  fatigue: number;
  rankW: number;
  plateMaxW: number;
  plateOutside: number;
  cardH: number;
  cardName: number;
  scrollW: number;
  innerW: number;
}
const measure = (page: Page): Promise<Measure> =>
  page.evaluate(() => {
    const px = (el: Element | null) => (el ? parseFloat(getComputedStyle(el).fontSize) : NaN);
    const plates = [...document.querySelectorAll('[data-nameplate]')].map((n) => n.getBoundingClientRect());
    const card = document.querySelector('[data-testid="agent-card"]');
    return {
      scaleVar: getComputedStyle(document.documentElement).getPropertyValue('--ui-scale').trim(),
      dataScale: document.documentElement.dataset.uiScale,
      name: px(document.querySelector('[data-nameplate] [data-testid="agent-name"]')),
      ring: document.querySelector('[data-nameplate] [data-testid="level-ring"]')?.getBoundingClientRect().width ?? NaN,
      fatigue: px(document.querySelector('[data-nameplate] [data-testid="fatigue"]')),
      rankW: document.querySelector('[data-nameplate] [data-testid="rank-icon"]')?.getBoundingClientRect().width ?? NaN,
      plateMaxW: Math.max(...plates.map((r) => r.width)),
      plateOutside: plates.filter((r) => r.width > window.innerWidth).length,
      cardH: card?.getBoundingClientRect().height ?? NaN,
      cardName: px(document.querySelector('[data-testid="card-name"]')),
      scrollW: document.scrollingElement!.scrollWidth,
      innerW: window.innerWidth,
    };
  });

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const procs = CREW.map((name, k) => session(home, k + 1, name));
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/levels.json'),
    JSON.stringify({
      v: 1,
      levels: Object.fromEntries(CREW.map((name, k) => [`name:${name}`, { xp: 40 * k, rebirths: 0 }])),
    }),
  );
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal']);
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  try {
    const loginUrl = await daemon.loginUrl();
    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(loginUrl);
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await login.cookies();
    await login.close();

    for (const [tag, viewport, mobile] of [
      ['phone', { width: 390, height: 844 }, true],
      ['desktop', { width: 1280, height: 800 }, false],
    ] as const) {
      const ctx = await browser.newContext({
        viewport,
        isMobile: mobile,
        hasTouch: mobile,
        deviceScaleFactor: mobile ? 3 : 1,
      });
      await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      const ready = async () => {
        await page.goto(`http://127.0.0.1:${port}/`);
        await page.evaluate(() => document.fonts.ready);
        await until(
          `${CREW.length} plates with a ring`,
          async () => (await page.locator('[data-nameplate] [data-testid="level-ring"]').count()) >= CREW.length,
          60_000,
        );
        const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
        if (await closeInfo.count()) await closeInfo.first().click();
        await page.waitForTimeout(2_500); // everyone sits down
      };
      await ready();
      const fresh = await measure(page);
      check(fresh.dataScale === 'medium' && fresh.scaleVar === '1', `${tag}: a new browser starts at 보통 (--ui-scale ${fresh.scaleVar})`);

      const settings = async () => {
        await page.getByRole('button', { name: '설정', exact: true }).first().click();
        await page.getByRole('tab', { name: '화면', exact: true }).click();
        await page.getByTestId('ui-scale-option').waitFor();
      };
      const closeSettings = async () => {
        // The dialog's x (the top dialog's is the last in the DOM).
        await page.getByRole('button', { name: 'x', exact: true }).last().click();
        await page.waitForTimeout(300);
      };
      const heights: Record<string, number> = {};
      for (const [step, label] of STEPS) {
        await settings();
        const row = page.getByTestId('ui-scale-option');
        await row.getByRole('button', { name: label, exact: true }).click();
        check(
          (await row.locator(`[data-ui-scale="${step}"]`).getAttribute('aria-pressed')) === 'true',
          `${tag}: ${label} is pressed after the click`,
        );
        const title = await page.evaluate(() => {
          const p = document.querySelector('[data-testid="ui-scale-option"] p');
          return p ? parseFloat(getComputedStyle(p).fontSize) : NaN;
        });
        check(Math.abs(title - 22 * FACTOR[step]) < 0.01, `${tag} ${label}: the row's title (text-base) is ${title} px (22 x ${FACTOR[step]})`);
        await page.screenshot({ path: path.join(OUT, `${tag}-${step}-settings.png`) });
        await closeSettings();
        await page.waitForTimeout(600); // an overlap pass
        const m = await measure(page);
        const want = PLATE[step];
        console.log(`${tag} ${label}: ${JSON.stringify(m)}`);
        check(m.scaleVar === String(FACTOR[step]), `${tag} ${label}: --ui-scale ${m.scaleVar}`);
        check(
          m.name === want.name && Math.round(m.ring) === want.ring && m.fatigue === want.fatigue,
          `${tag} ${label}: plate name ${m.name} px, ring ${m.ring} px, 피로도 ${m.fatigue} px (${want.name} / ${want.ring} / ${want.fatigue})`,
        );
        heights[step] = m.rankW;
        check(m.plateOutside === 0, `${tag} ${label}: no plate wider than the screen (widest ${m.plateMaxW.toFixed(1)} px of ${m.innerW})`);
        check(m.scrollW <= m.innerW, `${tag} ${label}: no page horizontal scroll (${m.scrollW} <= ${m.innerW})`);
        check(Math.abs(m.cardName - 10 * FACTOR[step]) < 0.01, `${tag} ${label}: an agent card's name is ${m.cardName} px (10 x ${FACTOR[step]})`);
        if (!Number.isNaN(m.cardH)) console.log(`${tag} ${label}: agent card height ${m.cardH.toFixed(1)} px`);
        await page.screenshot({ path: path.join(OUT, `${tag}-${step}.png`) });
      }
      check(
        Math.abs(heights.small / heights.medium - 1) < 0.01 && Math.abs(heights.large / heights.medium - 1.5) < 0.01,
        `${tag}: the rank icon is x2, x2, x3 (${heights.small} / ${heights.medium} / ${heights.large} px wide)`,
      );

      // 크게 is the last choice: it survives a reload.
      await ready();
      const back = await measure(page);
      check(back.dataScale === 'large' && back.name === PLATE.large.name, `${tag}: after a reload still 크게 (plate name ${back.name} px)`);
      await settings();
      check(
        (await page.getByTestId('ui-scale-option').locator('[data-ui-scale="large"]').getAttribute('aria-pressed')) === 'true',
        `${tag}: after a reload 설정 shows 크게 pressed`,
      );
      // Back to 보통 for the screenshot of the default.
      await page.getByTestId('ui-scale-option').getByRole('button', { name: '보통', exact: true }).click();
      await closeSettings();
      await ctx.close();
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
