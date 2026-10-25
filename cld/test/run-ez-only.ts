/**
 * EZ-ONLY + LINKS: dist/cli.js in a temp HOME on a spare port, headless Chromium (no GPU).
 *  - no EZ button anywhere (desktop top bar, phone 설정 row), no `cld.ez-activity-mode` written;
 *  - the host's date and time in the top bars (daemon on Seoul time, page on UTC), HH:MM only on a narrow phone;
 *  - a character's details keep the raw status as a tooltip and the context numbers as a line;
 *  - a sub-agent works (🤝 dots from its lead), the lead's turn ends, it walks out of the door: while it
 *    leaves, and once it is gone, no dots run to it (canvas pixels of the dot colour, against the baseline).
 * Office hours are off but the linger time is 0, so the walk-out follows the turn end at once.
 * Screenshots in cld/artifacts/ez-only/.
 *
 *   npx tsx cld/test/run-ez-only.ts <port 18256-18259>
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/ez-only');
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__ez/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__ez/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
/** The link dots' colour (ACTIVITY_LINK_DOT_COLOR). */
const DOT = [244, 244, 248];
const DEADLINE_MS = 240_000;

type Rec = Record<string, unknown>;
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[]): Rec => ({
  type: 'assistant',
  message: { model: 'claude-opus-4-5', usage: { input_tokens: 40_000, output_tokens: 500 }, content },
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
const turnEnd: Rec = { type: 'system', subtype: 'turn_duration', durationMs: 1000 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean>, ms = 20_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(100)) if (await fn()) return;
  throw new Error(`timed out: ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const cwd = '/work/alpha';
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c0410000-0000-4000-8000-000000000001';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() - 600_000, procStart, version: '2.1.306', kind: 'interactive', name: 'lead', status: 'idle' }),
  );
  const append = (records: Rec[]) => {
    for (const r of records) fs.appendFileSync(transcript, JSON.stringify(r) + '\n');
  };
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal', '--engine', 'on', '--allow-chat'], {
    TZ: 'Asia/Seoul',
  });
  const pageErrors: string[] = [];
  const fonts = { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) };
  const browser = await launchBrowser({ officeHours: true });
  const deadline = setTimeout(() => {
    console.error('deadline');
    started.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    const loginUrl = await started.loginUrl();
    let cookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>> = [];
    const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
      const ctx = await browser.newContext({ ...opts, timezoneId: 'UTC' });
      await ctx.addInitScript(
        `globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true; try { localStorage.setItem('cld.office-hours', '{"on":false,"lingerMin":0}'); } catch {}`,
      );
      await ctx.route('**/__ez/*.ttf', (route) =>
        route.fulfill({
          body: route.request().url().endsWith('emoji.ttf') ? fonts.emoji : fonts.malgun,
          contentType: 'font/ttf',
        }),
      );
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      if (cookies.length) await ctx.addCookies(cookies);
      await page.goto(cookies.length ? `http://127.0.0.1:${port}/` : loginUrl);
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS });
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가📖'));
      await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
      await page.waitForTimeout(2500);
      return { ctx, page };
    };
    const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
    /** "10.24 (금) 22:28": the host's (Seoul) clock, which differs from the page's (UTC). */
    const clockRe = /^\d{1,2}\.\d{1,2} \([일월화수목금토]\) (\d\d):(\d\d)$/;
    const seoul = (offsetMin: number) => {
      const d = new Date(Date.now() - offsetMin * 60_000 + 9 * 3_600_000);
      return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
    };

    // ───────────── Desktop ─────────────
    {
      const { ctx, page } = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
      check((await page.getByRole('button', { name: 'EZ' }).count()) === 0, 'desktop: no EZ button in the top bar');
      const clock = (await page.getByTestId('host-clock').innerText()).trim();
      const m = clockRe.exec(clock);
      check(m && [seoul(0), seoul(1)].includes(`${m[1]}:${m[2]}`), `desktop: the top bar reads the host's date and time (${clock}, Seoul ${seoul(0)})`);

      // The details of the lead keep the raw status and the context numbers.
      append([said([call('tu-fix', 'Task', { description: 'fix login', prompt: 'x', model: 'sonnet' })]), sub('tu-fix', said([call('tu-fix-1', 'Grep', { pattern: 'login' })]))]);
      const staff = async (): Promise<Array<{ id: number; phase?: string; seat?: string; state?: string }>> =>
        JSON.parse(await page.evaluate(() => JSON.stringify(Reflect.get(window, '__cldStaff') ?? [])));
      const sample = () =>
        page.evaluate((dot) => {
          const c = document.querySelector<HTMLCanvasElement>('[data-testid="office-canvas"]')!;
          const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] === dot[0] && d[i + 1] === dot[1] && d[i + 2] === dot[2]) n++;
          return n;
        }, DOT);
      let subId = 0;
      await until('the sub-agent sits at its desk working', async () => {
        const s = (await staff()).find((x) => x.phase === 'working');
        if (s) subId = s.id;
        return !!s && s.state === 'type';
      }, 60_000);
      await page.waitForTimeout(800);
      const workingDots = Math.max(await sample(), await sample(), await sample());

      const leadId = (await page.$$eval('[data-testid="agent-overlay"]', (ns) =>
        ns.map((n) => Number(n.getAttribute('data-agent-id'))).filter((id) => id > 0),
      ))[0];
      await page.evaluate((id) => {
        (window as unknown as { __pixelAgentsTestHooks: { selectAgent: (id: number | null) => void } }).__pixelAgentsTestHooks.selectAgent(id);
      }, leadId);
      await page.waitForTimeout(500);
      const lead = page.locator(`[data-testid="agent-overlay"][data-agent-id="${leadId}"]`);
      const tip = await lead.getByTestId('activity-text').getAttribute('title');
      check(!!tip && tip.length > 0, `desktop: the activity line's tooltip carries the raw status (${tip})`);
      const ctxLine = (await lead.getByTestId('context-numbers').textContent()) ?? '';
      check(/컨텍스트/.test(ctxLine) && /4[01]k/.test(ctxLine), `desktop: the details keep the context numbers (${ctxLine})`);
      await shot(page, 'desktop-working-dots-details');
      await page.evaluate(() => {
        (window as unknown as { __pixelAgentsTestHooks: { selectAgent: (id: number | null) => void } }).__pixelAgentsTestHooks.selectAgent(null);
      });

      // The lead's turn ends: the sub-agent leaves (no linger time) and walks out of the door.
      append([userResult('tu-fix', 'done'), said([{ type: 'text', text: 'ok' }]), turnEnd]);
      const trail: Array<{ phase: string; dots: number }> = [];
      let shotLeaving = false;
      for (const end = Date.now() + 60_000; Date.now() < end; await wait(60)) {
        const s = (await staff()).find((x) => x.id === subId);
        if (!s) break;
        const dots = await sample();
        trail.push({ phase: s.phase ?? '', dots });
        if (s.phase === 'leaving' && !shotLeaving && trail.filter((t) => t.phase === 'leaving').length === 3) {
          shotLeaving = true;
          await shot(page, 'desktop-leaving-no-dots');
        }
      }
      await page.waitForTimeout(600);
      const baseline = await sample();
      const phases = [...new Set(trail.map((t) => t.phase))];
      const leaving = trail.filter((t) => t.phase === 'leaving');
      const lingering = trail.filter((t) => t.phase === 'lingering');
      console.log(`phases ${phases.join(' > ')}; working ${workingDots}, baseline ${baseline}, leaving ${leaving.map((t) => t.dots).join(',')}, lingering ${lingering.map((t) => t.dots).join(',')}`);
      check(workingDots > baseline + 40, `desktop: dots run to the working sub-agent (${workingDots} vs ${baseline} px)`);
      check(leaving.length > 3, `desktop: the sub-agent was seen walking out (${leaving.length} samples)`);
      // The sub-agent's own sprite adds a few pixels of that colour; the line is ~300.
    const limit = baseline + (workingDots - baseline) / 3;
    check(leaving.every((t) => t.dots <= limit), `desktop: no dots while it walks out (max ${Math.max(0, ...leaving.map((t) => t.dots))}, limit ${Math.round(limit)}, baseline ${baseline})`);
      check((await staff()).every((x) => x.id !== subId), 'desktop: the sub-agent is gone from the office');
      await shot(page, 'desktop-gone');
      check(
        (await page.evaluate(() => { try { return localStorage.getItem('cld.ez-activity-mode'); } catch { return null; } })) === null,
        'desktop: nothing is stored under cld.ez-activity-mode',
      );
      cookies = await ctx.cookies();
      await ctx.close();
    }

    // ───────────── Phone ─────────────
    for (const [w, h, narrow] of [[393, 852, false], [340, 700, true]] as const) {
      const { ctx, page } = await open({ viewport: { width: w, height: h }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const bar = page.getByTestId('mobile-top-bar');
      const clock = (await bar.getByTestId('host-clock').innerText()).trim();
      if (narrow) check(/^\d\d:\d\d$/.test(clock), `phone ${w}: a narrow phone shows only HH:MM (${clock})`);
      else check(clockRe.test(clock), `phone ${w}: the top bar shows the date and time (${clock})`);
      const box = await bar.boundingBox();
      check(box && box.width <= w + 1, `phone ${w}: the top bar fits the screen (${box?.width})`);
      await shot(page, `phone-${w}-top-bar`);
      await bar.getByRole('button', { name: '설정' }).tap();
      const quick = await page.getByTestId('settings-quick').getByRole('button').evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));
      check(!quick.includes('EZ'), `phone ${w}: no EZ button in 설정 (${quick.join(' | ')})`);
      await shot(page, `phone-${w}-settings`);
      await ctx.close();
    }
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
    console.log('\nall checks passed');
  } finally {
    clearTimeout(deadline);
    await browser.close();
    started.child.kill('SIGTERM');
    proc.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
