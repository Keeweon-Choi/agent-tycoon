/**
 * FIX-MEMBER-CARD-FIT (owner 11-06 20:22): a sub-agent's member card fits. dist/cli.js in a temp HOME on a spare
 * port, headless Chromium without a GPU, no model: one Lead with a long name as a live Claude Code session (a
 * `sleep` and its transcript) running two sub-agents with long task titles (open Task calls). The sub-agent's
 * card is opened the real way (the Lead's portrait, 관계, its row) at 1600x1000 and 1024x700, then on the phone.
 * Checks: no line of the card runs out of its box (the 임시 직원 note on 능력치 wraps), the card is inside the
 * window and never taller than the room above the bottom HUD (the body scrolls), its head drags it (once, then
 * far past the edge: it stays on screen), a new selection opens it beside the portrait again, the party's menu sits
 * over an open window (the popovers layer); the phone's sheet fits too. UI_THEME=modern|pixel picks the style; pictures in cld/artifacts/fix-member-card-fit/<PREFIX>-*.png.
 *
 *   UI_THEME=pixel PREFIX=pixel npx tsx cld/test/run-member-card-fit.ts <port 18930-18939>
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
  removeTestHome,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { outDir, UI_THEME_INIT } from './uiTheme.js';

const port = Number(process.argv[2]);
if (!(port >= 18930 && port <= 18939)) throw new Error('port 18930-18939');
const PREFIX = process.env.PREFIX ?? 'after';
const OUT = outDir(path.resolve('cld/artifacts/fix-member-card-fit'));
const DEADLINE_MS = 600_000;
const LEAD = 'orchestrator-with-a-really-long-name-for-the-card';
const TASKS = [
  'Read the whole requirements engine path RQ4 and set up Spec Kit with the long checklist and every follow-up note',
  'Write the release notes for the November build including every fix, every known issue and the upgrade steps',
];
const STORE: Record<string, string> = { 'cld.title-scene': 'off', 'cld.office-iso': 'on', 'cld.floor': '1', 'cld.floor-view': 'one' };
const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;

type Rec = Record<string, unknown>;
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[]): Rec => ({
  type: 'assistant',
  message: { model: 'claude-opus-4-7', content, usage: { input_tokens: 10, cache_read_input_tokens: 60_000, output_tokens: 100 } },
});
const sub = (parent: string, msg: Rec): Rec => ({ type: 'progress', parentToolUseID: parent, data: { type: 'agent_progress', message: msg } });

const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};
async function until(what: string, fn: () => Promise<boolean>, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  check(false, `in time: ${what}`);
  return false;
}

function startLead(home: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'f1d00000-0000-4000-8000-000000000001';
  const cwd = '/work/fit';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() - 600_000, procStart, version: '2.1.306', kind: 'interactive', name: LEAD, status: 'busy' }),
  );
  return { proc, transcript };
}

/** The Lead's turn: two open Task calls, each sub-agent at work (written while a page watches). */
const RECORDS = [
  said(TASKS.map((d, i) => call(`tu-${i}`, 'Task', { description: d, prompt: 'x' }))),
  ...TASKS.map((_, i) => sub(`tu-${i}`, said([call(`tu-${i}-1`, 'Read', { file_path: `/work/fit/doc-${i}.md` })]))),
];

/** Every visible descendant of the card that runs past the card's inner sides (text out of its box). */
const spills = (page: Page) =>
  page.getByTestId('inspector').evaluate((card) => {
    const box = card.getBoundingClientRect();
    const out: string[] = [];
    for (const el of card.querySelectorAll<HTMLElement>('*')) {
      if (el.closest('[hidden]') || !el.getClientRects().length) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      const scroller = el.closest('.mc-scroll');
      // Inside the scrolling body only the sideways spill counts (it scrolls vertically by design).
      if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || (!scroller && (r.top < box.top - 0.5 || r.bottom > box.bottom + 0.5)))
        out.push(`${el.tagName.toLowerCase()}.${el.className || el.getAttribute('data-testid') || ''}: ${(el.textContent ?? '').slice(0, 30)}`);
      // A box narrower than its own text (a line cut off without wrapping).
      if (getComputedStyle(el).overflowX === 'visible' && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && el.children.length === 0)
        out.push(`overflowing ${el.tagName.toLowerCase()}: ${(el.textContent ?? '').slice(0, 30)}`);
    }
    return out;
  });

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const lead = startLead(home);
  let written = false;
  // The sub-agents keep reporting, so they stay at work for the whole run (cleared in finally).
  let tick = 0;
  let keepAlive: NodeJS.Timeout | undefined;
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal', '--allow-chat', '--engine', 'on']);
  const browser = await launchBrowser({ partyFrame: true });
  const deadline = setTimeout(() => {
    console.error('deadline');
    process.exit(2);
  }, DEADLINE_MS);
  try {
    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(await daemon.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await login.cookies();
    await login.close();
    const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
      const ctx = await browser.newContext(opts);
      await ctx.addInitScript(INIT + UI_THEME_INIT);
      await ctx.addInitScript((pairs) => {
        for (const [k, v] of pairs)
          try {
            if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
          } catch {
            // about:blank
          }
      }, Object.entries(STORE));
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.getByTestId('office-canvas').waitFor({ timeout: 60_000 });
      if (!written) {
        written = true;
        await page.locator('[data-testid="agent-card"]').first().waitFor({ timeout: 60_000 });
        fs.appendFileSync(lead.transcript, RECORDS.map((r) => JSON.stringify(r)).join('\n') + '\n');
        keepAlive = setInterval(() => {
          tick++;
          const lines = TASKS.map((_, i) => sub(`tu-${i}`, said([call(`tu-${i}-k${tick}`, 'Read', { file_path: `/work/fit/doc-${i}.md` })])));
          fs.appendFileSync(lead.transcript, lines.map((r) => JSON.stringify(r)).join('\n') + '\n');
        }, 3_000);
        await page.waitForTimeout(4_000);
      }
      return { ctx, page };
    };
    const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${PREFIX}-${name}.png`) });
    const portrait = (page: Page) => page.locator(`[data-testid="agent-card"][title="${LEAD}"]`).first();
    /** The Lead's portrait, its 관계 tab, then the first sub-agent's row: that sub-agent's card. */
    const openSubCard = async (page: Page, tap: boolean) => {
      await portrait(page).waitFor({ timeout: 60_000 });
      const card = page.getByTestId('inspector');
      // A press while the page still settles can be lost: press again until the Lead's card is up.
      await until('the Lead card', async () => {
        if ((await page.getByTestId('member-tab-team').count()) > 0) return true;
        await (tap ? portrait(page).tap() : portrait(page).click());
        await page.waitForTimeout(1_000);
        return (await page.getByTestId('member-tab-team').count()) > 0;
      });
      await (tap ? page.getByTestId('member-tab-team').tap() : page.getByTestId('member-tab-team').click());
      const row = card.locator('[data-testid="temp-row"]').first();
      await until('the team rows', async () => (await row.count()) > 0);
      const subId = await row.getAttribute('data-agent-id');
      await (tap ? row.tap() : row.click());
      await until('the sub-agent card', async () => (await card.getAttribute('data-agent-id')) === subId);
      await page.waitForTimeout(800);
      return subId;
    };
    const fits = async (page: Page, what: string, room: boolean) => {
      const view = page.viewportSize()!;
      const b = (await page.getByTestId('inspector').boundingBox())!;
      check(b.y >= 0 && b.y + b.height <= view.height + 0.5 && b.x >= 0 && b.x + b.width <= view.width + 0.5, `${what}: the card is inside the window (${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)})`);
      if (room) check(b.y + b.height <= view.height - 120 + 1, `${what}: the card ends above the bottom HUD (${Math.round(b.y + b.height)} / ${view.height - 120})`);
      const s = await spills(page);
      check(s.length === 0, `${what}: no line runs out of its box${s.length ? ` (${s.slice(0, 4).join(' | ')})` : ''}`);
    };
    const statsTab = async (page: Page, what: string, tap: boolean) => {
      const tab = page.getByTestId('member-tab-stats');
      await (tap ? tab.tap() : tab.click());
      await page.waitForTimeout(300);
      const row = page.locator('[data-testid="inspector"] [data-row="employee"]');
      check((await row.count()) === 1, `${what}: the 능력치 tab has the 임시 직원 row`);
      const lines = await row.locator('.mc-value').evaluate((e) => Math.round(e.getBoundingClientRect().height / parseFloat(getComputedStyle(e).lineHeight || '20')));
      check(lines >= 2, `${what}: the 임시 직원 note wraps (${lines} lines)`);
      const scroll = await page.locator('[data-testid="inspector"] .mc-scroll').evaluate((e) => ({ sh: e.scrollHeight, ch: e.clientHeight, oy: getComputedStyle(e).overflowY }));
      check(scroll.oy === 'auto', `${what}: the body scrolls inside (${JSON.stringify(scroll)})`);
    };

    for (const viewport of [
      { width: 1600, height: 1000 },
      { width: 1024, height: 700 },
    ]) {
      const size = `${viewport.width}x${viewport.height}`;
      const { ctx, page } = await open({ viewport });
      await openSubCard(page, false);
      await fits(page, `${size} 개요`, true);
      await shot(page, `${size}-sub-overview`);
      await statsTab(page, size, false);
      await fits(page, `${size} 능력치`, true);
      await shot(page, `${size}-sub-stats`);
      await page.getByTestId('inspector').screenshot({ path: path.join(OUT, `${PREFIX}-${size}-card-stats.png`) });
      // The head drags it, once; far past the edge it stays on screen.
      const head = page.getByTestId('inspector-head');
      const before = (await page.getByTestId('inspector').boundingBox())!;
      const hb = (await head.boundingBox())!;
      const grab = { x: hb.x + 60, y: hb.y + hb.height / 2 };
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(grab.x - 300, grab.y - 40, { steps: 8 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      const moved = (await page.getByTestId('inspector').boundingBox())!;
      check(Math.abs(moved.x - (before.x - 300)) <= 2 && Math.abs(moved.y - Math.max(0, before.y - 40)) <= 2, `${size}: the head drags the card (${Math.round(before.x)},${Math.round(before.y)} -> ${Math.round(moved.x)},${Math.round(moved.y)})`);
      check((await page.getByTestId('inspector').getAttribute('data-dragged')) === '', `${size}: the card knows it was dragged`);
      await shot(page, `${size}-dragged`);
      const hb2 = (await head.boundingBox())!;
      await page.mouse.move(hb2.x + 60, hb2.y + hb2.height / 2);
      await page.mouse.down();
      await page.mouse.move(hb2.x + 60 + 3000, hb2.y + 3000, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(400);
      await fits(page, `${size} dragged far`, false);
      // The tabs and buttons still work after a drag (a press on a button is not a drag).
      await page.getByTestId('member-tab-overview').click();
      check((await page.locator('[data-testid="inspector"] [data-testid="member-issues"]').count()) === 1, `${size}: a tab still opens after the drag`);
      // A new selection opens beside its portrait again, undragged.
      await page.getByTestId('inspector-close').click();
      await portrait(page).click();
      await page.waitForTimeout(600);
      const again = (await page.getByTestId('inspector').boundingBox())!;
      const pb = (await portrait(page).boundingBox())!;
      check((await page.getByTestId('inspector').getAttribute('data-dragged')) === null && again.x + again.width <= pb.x, `${size}: a new selection opens beside the party again`);
      await fits(page, `${size} the Lead (long name)`, true);
      // The party's menu is a popover: a window open under it never covers it.
      await page.getByTestId('inspector-close').click();
      const messenger = page.locator('[data-testid="hud-dock"] [data-hud-id="icon:messenger"] button');
      if (await messenger.count()) await messenger.click();
      await page.waitForTimeout(600);
      await page.getByTestId('party-select').click();
      await page.waitForTimeout(300);
      const hit = await page.getByTestId('party-menu').evaluate((m) => {
        const r = m.getBoundingClientRect();
        const pts = [[r.left + 8, r.top + 8], [r.left + r.width / 2, r.top + r.height / 2], [r.right - 8, r.bottom - 8]];
        return pts.every(([x, y]) => m.contains(document.elementFromPoint(x, y)));
      });
      check(hit, `${size}: the party menu sits over an open window`);
      await shot(page, `${size}-party-menu-over-window`);
      await page.keyboard.press('Escape');
      await ctx.close();
    }

    const { ctx: phoneCtx, page: phone } = await open({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    await openSubCard(phone, true);
    const sheet = phone.locator('[data-testid="inspector"][data-sheet]');
    check((await sheet.count()) === 1, 'phone: the sub-agent card is the bottom sheet');
    await fits(phone, 'phone 개요', false);
    await statsTab(phone, 'phone', true);
    await fits(phone, 'phone 능력치', false);
    await shot(phone, 'phone-sub-stats');
    await phoneCtx.close();
    if (failures.length) throw new Error(`${failures.length} check(s) failed:\n${failures.join('\n')}`);
  } finally {
    clearTimeout(deadline);
    if (keepAlive) clearInterval(keepAlive);
    await browser.close();
    await daemon.stop();
    lead.proc.kill();
    killFakeSessions(home);
    removeTestHome(home);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
