/**
 * UI-CONSISTENCY check: dist/cli.js with an isolated HOME on a spare port, headless Chromium
 * (--disable-gpu), desktop 1280x800 and phone 393x852.
 * Survey and result in one: screenshots of 설정 (all five tabs), the elevator, the 현황판 row of a
 * project with sub-agents (one with a very long description), the 팀원 popup and the card bar,
 * then geometry checks on what the owner named:
 * - 설정: every control ends at the window's content edge (no 75 px gap), one row layout;
 * - the elevator's floor buttons, 편집 and 인테리어 are one width;
 * - a sub-agent's description never wraps (one line, ellipsis, full text in the title) and its
 *   작업 보기 button sits at the row's vertical centre, the same height in every row.
 * TAG=before|after (default after) names the screenshots in cld/artifacts/ui-consistency/.
 *
 *   npx tsx cld/test/run-ui-consistency.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const TAG = process.env.TAG ?? 'after';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/ui-consistency');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const EMOJI = '/mnt/c/Windows/Fonts/seguiemj.ttf';
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__uic/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__uic/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
const TABS = ['일반', '화면', '접속', '보안', '고급'];
const LONG = 'Mark finished background agents and rerun the repro with a very long description that cannot fit on one line';

type Rec = Record<string, unknown>;
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[]): Rec => ({ type: 'assistant', message: { model: 'claude-opus-4-5', content } });
const sub = (parent: string, msg: Rec): Rec => ({
  type: 'progress',
  parentToolUseID: parent,
  data: { type: 'agent_progress', message: msg },
});

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

function session(home: string, k: number, name: string, cwd: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `c0510000-0000-4000-8000-${String(k).padStart(12, '0')}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() - 600_000, procStart, version: '2.1.306', kind: 'interactive', name, status: 'idle' }),
  );
  return { proc, transcript };
}

/** Two sub-agents under lead, spawned live (a page that loads later never sees the spawn's description). */
function spawnSubs(transcript: string, k: string) {
  for (const [id, description, model] of [
    [`tu-a${k}`, `fix login ${k}`, 'sonnet'],
    [`tu-b${k}`, LONG, 'haiku'],
  ])
    for (const r of [
      said([call(id, 'Task', { description, prompt: 'x', model })]),
      sub(id, said([call(`${id}-1`, 'Grep', { pattern: 'login' })])),
      // Answered at once: no permission wait, so the row shows what the spawn says it does.
      sub(id, {
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: `${id}-1`, content: 'ok' }] },
      }),
    ])
      fs.appendFileSync(transcript, JSON.stringify(r) + '\n');
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const lead = session(home, 1, 'lead', '/work/alpha');
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal', '--allow-actions']);
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const fonts = { malgun: fs.readFileSync(FONT), emoji: fs.readFileSync(EMOJI) };
  try {
    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(await started.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await login.cookies();
    await login.close();
    for (const [tag, viewport, mobile] of [
      ['desktop', { width: 1280, height: 800 }, false],
      ['phone', { width: 393, height: 852 }, true],
    ] as const) {
      const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
      await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
      await ctx.route('**/__uic/*.ttf', (route) =>
        route.fulfill({ body: route.request().url().endsWith('emoji.ttf') ? fonts.emoji : fonts.malgun, contentType: 'font/ttf' }),
      );
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${TAG}-${name}-${tag}.png`) });
      const tap = (loc: ReturnType<Page['locator']>) => (mobile ? loc.tap() : loc.click());
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS });
      await page.getByRole('button', { name: '설정', exact: true }).first().waitFor({ timeout: 60_000 });
      const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
      if (await closeInfo.count()) await closeInfo.first().click();
      await until('lead and its temps are in', async () =>
        (await page.$$eval('[data-testid="card-name"]', (n) => n.map((x) => x.textContent))).includes('lead'),
      );
      await page.waitForTimeout(4_000);
      spawnSubs(lead.transcript, tag);
      // The first-run question about permissions covers the office: answer it.
      const ask = page.getByRole('button', { name: '계속 물어보기' });
      if (await ask.count()) await ask.first().click();
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가📖'));

      // ── 설정, every tab ──
      await page.getByRole('button', { name: '설정', exact: true }).first().click();
      const dialog = page.getByRole('dialog').last();
      for (const name of TABS) {
        await page.getByRole('tab', { name, exact: true }).click();
        await page.waitForTimeout(400);
        const panel = page.locator('[role="tabpanel"]:visible').first();
        // Every visible row's right-most control must end at the content edge (the panel's right edge).
        const gap = await panel.evaluate((el) => {
          const edge = el.getBoundingClientRect().right;
          let worst = 0;
          for (const c of el.querySelectorAll('button, input:not([type=file]), textarea')) {
            const r = (c as HTMLElement).getBoundingClientRect();
            if (r.width === 0) continue;
            worst = Math.max(worst, r.right);
          }
          return { edge, controlsRight: worst };
        });
        console.log(`${tag} ${name}: panel right ${gap.edge}, furthest control ${gap.controlsRight}`);
        await shot(`settings-${name}`);
        if (name === '일반' || name === '화면') {
          const edge = await dialog.evaluate((el) => {
            const d = el.getBoundingClientRect();
            // A control that is not drawn (the edge-scroll row on a touch screen) has no box.
            return [...el.querySelectorAll('[role="tabpanel"]:not([hidden]) [data-setting-control]')]
              .map((c) => (c as HTMLElement).getBoundingClientRect())
              .filter((r) => r.width > 0)
              .map((r) => d.right - r.right);
          });
          if (TAG === 'after') {
            check(edge.length > 0 && edge.every((g) => g <= 16), `${tag} ${name}: every right-side control ends at the content edge (${edge.map(Math.round).join(',')})`);
          }
        }
      }
      await page.getByRole('button', { name: 'x', exact: true }).last().click();

      // ── The elevator (desktop): one floor and 편집, then three floors ──
      if (!mobile) {
        const panel = page.getByRole('navigation', { name: '엘리베이터' });
        await panel.waitFor();
        await panel.getByRole('button', { name: '편집', exact: true }).click();
        const add = page.getByRole('button', { name: '층 추가' });
        await add.click();
        await page.waitForTimeout(600);
        await add.click();
        await page.waitForTimeout(600);
        await panel.getByRole('button', { name: '편집', exact: true }).click();
        await page.waitForTimeout(600);
        await panel.screenshot({ path: path.join(OUT, `${TAG}-elevator-${tag}.png`) });
        const widths = await panel.evaluate((el) => {
          const w = (sel: string) => [...el.querySelectorAll(sel)].map((n) => Math.round((n as HTMLElement).getBoundingClientRect().width));
          return [...w('.cld-floor-button'), ...w('.cld-elevator-edit'), ...w('.cld-elevator-decorate')];
        });
        console.log(`${tag}: elevator button widths ${widths.join(',')}`);
        if (TAG === 'after') check(new Set(widths).size === 1, `${tag}: the floor buttons, 편집 and 인테리어 share one width (${widths.join(',')})`);
      }

      // ── 현황판: the lead's row, folded open ──
      // The 현황판 is open on a desktop's first load; a phone (or a closed one) opens it from its icon or tab.
      if (!(await page.getByRole('heading', { name: 'lead', exact: true }).isVisible())) {
        const board = mobile
          ? page.getByRole('button', { name: '현황판', exact: true }).last()
          : page.locator('[data-hud-id^="icon:"]').getByRole('button', { name: '현황판', exact: true });
        await tap(board);
      }
      const lead3 = page.locator('article').filter({ has: page.getByRole('heading', { name: 'lead', exact: true }) });
      await lead3.waitFor({ timeout: 20_000 });
      await lead3.getByRole('button', { name: 'lead', exact: true }).click();
      await until('two work buttons', async () => (await lead3.locator('[data-testid="work-open"]').count()) >= 2);
      // The spawn's description arrives a little after the row does.
      await until('the long description is in its row', async () =>
        (await lead3.locator('[data-testid="temp-task"]').allTextContents()).some((x) => x.includes('Mark finished')),
      );
      await page.waitForTimeout(800);
      await lead3.scrollIntoViewIfNeeded();
      await shot('board');
      const rows = await lead3.locator('[data-testid="temp-row"]').evaluateAll((nodes) =>
        nodes.map((n) => {
          const li = n.closest('li') as HTMLElement;
          const b = li.querySelector('[data-testid="work-open"]') as HTMLElement | null;
          const task = li.querySelector('[data-testid="temp-task"]') as HTMLElement | null;
          const lr = li.getBoundingClientRect();
          const br = b?.getBoundingClientRect();
          return {
            rowH: Math.round(lr.height),
            btnH: br ? Math.round(br.height) : 0,
            btnW: br ? Math.round(br.width) : 0,
            btnMid: br ? Math.round(br.top + br.height / 2 - (lr.top + lr.height / 2)) : 0,
            taskH: task ? Math.round(task.getBoundingClientRect().height) : 0,
            taskTitle: task?.getAttribute('title') ?? '',
          };
        }),
      );
      console.log(`${tag} board rows ${JSON.stringify(rows)}`);
      if (TAG === 'after') {
        check(rows.length >= 2 && new Set(rows.map((r) => `${r.btnW}x${r.btnH}`)).size === 1, `${tag}: 작업 보기 is the same size in every row`);
        check(rows.every((r) => Math.abs(r.btnMid) <= 1), `${tag}: 작업 보기 sits at each row's vertical centre`);
        check(new Set(rows.map((r) => r.rowH)).size === 1, `${tag}: rows have one height (${rows.map((r) => r.rowH).join(',')})`);
        check(rows.some((r) => r.taskTitle.includes('Mark finished')), `${tag}: the long description's full text is in its title`);
      }
      // Back to the office: the phone's 사무실 button (no close on a phone), the desktop's window close.
      if (mobile) await page.getByRole('button', { name: '사무실', exact: true }).first().tap();
      else await page.getByRole('button', { name: '정보 창 닫기' }).click().catch(() => undefined);

      // ── 팀원 popup from the card bar ──
      if (mobile && (await page.getByTestId('cards-toggle').getAttribute('aria-expanded')) !== 'true')
        await page.getByTestId('cards-toggle').tap();
      const chip = page
        .locator('[data-testid="agent-card"]')
        .filter({ has: page.locator('[data-testid="card-name"]', { hasText: /^lead$/ }) })
        .locator('[data-testid="temp-chip"]');
      await shot('cards');
      await tap(chip);
      const list = page.getByTestId('temp-list');
      await list.waitFor();
      await page.waitForTimeout(500);
      await shot('team-popup');
      const prow = await list.locator('[data-testid="temp-row"]').evaluateAll((nodes) =>
        nodes.map((n) => {
          const li = n.closest('li') as HTMLElement;
          const b = li.querySelector('[data-testid="work-open"]') as HTMLElement;
          const lr = li.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return { rowH: Math.round(lr.height), btnW: Math.round(br.width), btnH: Math.round(br.height), btnMid: Math.round(br.top + br.height / 2 - (lr.top + lr.height / 2)) };
        }),
      );
      console.log(`${tag} popup rows ${JSON.stringify(prow)}`);
      if (TAG === 'after') {
        check(prow.length >= 2 && new Set(prow.map((r) => r.rowH)).size === 1, `${tag}: 팀원 rows have one height (${prow.map((r) => r.rowH).join(',')})`);
        check(new Set(prow.map((r) => `${r.btnW}x${r.btnH}`)).size === 1 && prow.every((r) => Math.abs(r.btnMid) <= 1), `${tag}: 작업 보기 is one size and centred in the popup`);
        const fit = await page.getByRole('dialog').last().evaluate((el) => el.scrollWidth <= el.clientWidth);
        check(fit, `${tag}: the popup has no sideways scroll`);
      }
      await ctx.close();
    }
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
    console.log(`all ${oks} checks passed`);
  } finally {
    await browser.close();
    await started.stop?.();
    lead.proc.kill('SIGKILL');
    killFakeSessions(home);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
