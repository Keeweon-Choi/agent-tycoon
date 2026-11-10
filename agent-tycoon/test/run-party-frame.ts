/**
 * PARTY-FRAME (owner 11-04 16:21, specs/ui-mock-1104/panels (나)): the card bar folds to a column of
 * 56px portraits and the elevator to a 40px ▲ 1F ▼ strip. dist/cli.js in a temp HOME (the engine's fake
 * claude as `claude-pty`, never a real agent), four Leads whose transcripts put them in three states:
 * alpha works, beta waits for the owner, gamma and delta rest; two floors. Page defaults (launchBrowser
 * `partyFrame: true`), headless Chromium without a GPU.
 *  1. 1282x832 (the owner's screen) with the 메신저 open: folded by default, the bar as tall as its
 *     portraits, alpha's purple border, beta's 기다림 tail, gamma's face dimmed; the bar covers neither the
 *     messenger nor its 보내기; no expand toggle (FEAT-PARTY-V2)
 *  2. the elevator: the strip is 40px wide, the lamp opens the floor list, a floor from it rides there,
 *     ▼ comes back; the list's state survives a reload
 *  3. 1400x900 folded; the 시점 group stays clear of the bar
 *  4. phone 390x844: neither the bar nor the strip, no horizontal scroll
 * Screenshots: agent-tycoon/artifacts/party-frame-1104/.
 *
 *   npx tsx agent-tycoon/test/run-party-frame.ts <port 18400-18409>
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { transcriptPath } from '../../server/src/agent-tycoon/providers/claudeProvider.js';
import {
  assertPortFree,
  type Daemon,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18400 && port <= 18409)) throw new Error('port 18400-18409');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/party-frame-1104');
const DEADLINE_MS = 300_000;
const LEADS = [
  { name: 'alpha', tokens: 52_000, state: 'work' },
  { name: 'beta', tokens: 138_000, state: 'ask' },
  { name: 'gamma', tokens: 24_000, state: 'rest' },
  { name: 'delta', tokens: 90_000, state: 'rest' },
] as const;
const OWNER: BrowserContextOptions = { viewport: { width: 1282, height: 832 } };
const WIDE: BrowserContextOptions = { viewport: { width: 1400, height: 900 } };
const PHONE: BrowserContextOptions = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const MODEL = 'claude-sonnet-4-5';

let failed = 0;
const check = (ok: unknown, text: string) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'FAIL'} - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what: string, test: () => Promise<unknown> | unknown, timeout = 30_000): Promise<boolean> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    if (await test()) return true;
    if (Date.now() > end) {
      check(false, `timed out: ${what}`);
      return false;
    }
  }
}
type Rec = Record<string, unknown>;
const stamp = (r: Rec): Rec => ({ uuid: `u-${Math.random().toString(16).slice(2, 10)}`, timestamp: new Date().toISOString(), ...r });
type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

async function main() {
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  put('config.json', { accessChosen: true, port });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const ids = LEADS.map((_, i) => String.fromCharCode(97 + i).repeat(10));
  const folders = LEADS.map((l) => fs.mkdtempSync(path.join(home, `${l.name}-`)));
  put('projects.json', { v: 2, projects: LEADS.map((l, i) => ({ projectId: `p_${ids[i]}`, name: l.name, folder: folders[i], room: `${l.name}-room`, leadAssignmentId: `a_${ids[i]}` })) });
  put('assignments.json', { v: 1, assignments: LEADS.map((l, i) => ({ assignmentId: `a_${ids[i]}`, projectId: `p_${ids[i]}`, role: 'lead', provider: 'claude-pty', model: MODEL, wantRunning: true })) });
  put('building.json', {
    version: 1,
    perProject: false,
    floors: [
      { id: '1', name: '1층', rooms: ['alpha-room', 'beta-room'], characters: [] },
      { id: '2', name: '연구실', rooms: ['gamma-room', 'delta-room'], characters: [] },
    ],
  });

  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--no-terminal'], {
    FAKE_TURN_MS: '240000',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  });
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  let busy: ReturnType<typeof setInterval> | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
    process.exit(2);
  }, DEADLINE_MS);

  const sessionOf = (name: string) => {
    for (const file of fs.readdirSync(path.join(home, '.claude/sessions'))) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as { name: string; sessionId: string; cwd: string };
        if (s.name === name) return s;
      } catch {
        /* written as we read */
      }
    }
    return undefined;
  };
  const append = (name: string, ...records: Rec[]) => {
    const s = sessionOf(name)!;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    for (const r of records) fs.appendFileSync(file, `${JSON.stringify(stamp(r))}\n`);
  };
  const said = (tokens: number, content: unknown[]) => ({ type: 'assistant', message: { role: 'assistant', model: MODEL, content, usage: { input_tokens: 10, cache_read_input_tokens: tokens - 110, output_tokens: 100 } } });
  const turnEnd = { type: 'system', subtype: 'turn_duration', durationMs: 1200 };

  const newPage = async (opts: BrowserContextOptions) => {
    const ctx = await browser!.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;');
    const p = await ctx.newPage();
    await p.goto(await daemon.loginUrl());
    await p.waitForURL(`http://127.0.0.1:${port}/`);
    const toast = await p.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 4_000 }).catch(() => null);
    const v = toast?.match(/v([\d.]+)/)?.[1];
    if (v) {
      await p.evaluate((x) => localStorage.setItem('agty.changelogSeen', x), v);
      await p.reload();
    }
    return p;
  };
  const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
  const portrait = (p: Page, name: string) => p.locator(`[data-portrait][title="${name}"]`);
  const bar = (p: Page) => p.getByTestId('card-container');

  try {
    await daemon.loginUrl();
    for (const l of LEADS) await eventually(`${l.name} revived`, () => !!sessionOf(l.name), 90_000);
    browser = await launchBrowser({ partyFrame: true });
    const desk = await newPage(OWNER);

    // ── 1. folded by default, the three states ──
    await eventually('four portraits', async () => (await desk.locator('[data-portrait]').count()) === 4, 30_000);
    check((await desk.getByTestId('card-name').count()) === 0, 'folded by default: no names, portraits only');
    const [alpha, beta, gamma, delta] = LEADS;
    append(alpha.name, { type: 'user', message: { content: 'usage.ts 를 읽어 주세요' } }, said(alpha.tokens, [{ type: 'tool_use', id: 'toolu_alpha1', name: 'Bash', input: { command: 'cat usage.ts', description: 'usage.ts 읽기' } }]));
    busy = setInterval(() => append(alpha.name, { type: 'progress', parentToolUseID: 'toolu_alpha1', data: { type: 'bash_progress' } }), 3_000);
    append(beta.name, { type: 'user', message: { content: '마이그레이션 정리' } }, said(beta.tokens, [{ type: 'text', text: '마이그레이션 먼저 돌릴까요?' }]), turnEnd);
    for (const l of [gamma, delta]) append(l.name, { type: 'user', message: { content: '정리해 주세요' } }, said(l.tokens, [{ type: 'text', text: '정리했어요.' }]), turnEnd);
    for (const l of LEADS) await eventually(`${l.name} is ${l.state}`, async () => (await portrait(desk, l.name).getAttribute('data-state')) === l.state, 30_000);
    const look = await desk.evaluate(() => {
      const of = (n: string) => document.querySelector<HTMLElement>(`[data-portrait][title="${n}"]`)!;
      const face = (n: string) => Number(getComputedStyle(of(n).querySelector('.game-portrait-face')!).opacity);
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim();
      const probe = document.createElement('i');
      probe.style.color = accent;
      document.body.append(probe);
      const accentRgb = getComputedStyle(probe).color;
      probe.remove();
      return {
        alphaBorder: getComputedStyle(of('alpha')).borderTopColor,
        accentRgb,
        alphaFace: face('alpha'),
        gammaFace: face('gamma'),
        waits: [...document.querySelectorAll('[data-testid="party-wait"]')].map((w) => w.closest<HTMLElement>('[data-portrait]')!.title),
        waitText: document.querySelector('[data-testid="party-wait"]')?.textContent ?? '',
        cells: of('beta').querySelectorAll('.game-seg-portrait > i').length,
        size: [of('alpha').offsetWidth, of('alpha').offsetHeight],
      };
    });
    check(look.alphaBorder === look.accentRgb, `work: alpha's border is the one purple (${look.alphaBorder})`);
    check(look.waits.join() === 'beta' && look.waitText.includes('기다림'), `waiting: only beta has the 기다림 tail (${look.waits.join()})`);
    check(look.gammaFace === 0.5 && look.alphaFace === 1, `rest: gamma's face dimmed (${look.gammaFace}), alpha's not`);
    check(look.cells === 8, `a portrait has 8 context cells (${look.cells})`);
    check(look.size[0] === 56 && look.size[1] === 56, `portraits are 56x56 (${look.size.join('x')})`);
    const barBox = (await bar(desk).boundingBox())!;
    check(barBox.width <= 72 && barBox.height < 832 * 0.6, `the folded bar is narrow and as tall as its portraits (${Math.round(barBox.width)}x${Math.round(barBox.height)})`);

    // The messenger beside it: the bar covers neither the window nor 보내기.
    await desk.locator('[data-hud-id="icon:messenger"]').getByRole('button').click();
    const msgr = desk.locator('[data-hud-window="messenger"]');
    await msgr.waitFor({ timeout: 10_000 });
    await msgr.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }).click();
    const send = msgr.getByRole('button', { name: '보내기' }).first();
    await send.waitFor({ timeout: 10_000 });
    await desk.waitForTimeout(500);
    const sendHit = await send.evaluate((b) => {
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && b.contains(hit);
    });
    check(sendHit, '1282: 보내기 is what a click hits');
    check(!overlap((await bar(desk).boundingBox())!, (await msgr.boundingBox())!), '1282: the folded bar and the messenger do not overlap');
    await shot(desk, 'desktop-1282-folded');

    // FEAT-PARTY-V2: no unfolding any more.
    check((await desk.getByTestId('party-fold').count()) === 0, 'no expand toggle');

    // ── 2. the elevator strip ──
    const lamp = desk.getByTestId('elevator-display');
    await lamp.waitFor({ timeout: 30_000 });
    const strip = (await desk.locator('.agty-elevator-strip').boundingBox())!;
    check(Math.round(strip.width) === 40, `the strip is 40px wide (${strip.width})`);
    check(strip.x < 40, `the strip sits on the left edge (x ${Math.round(strip.x)})`);
    check((await desk.getByTestId('elevator-list').count()) === 0, 'the floor list starts closed');
    check((await lamp.innerText()).includes('1F'), 'the lamp says 1F');
    await lamp.click();
    await desk.getByTestId('elevator-list').waitFor({ timeout: 5_000 });
    await shot(desk, 'desktop-1282-floors');
    await desk.locator('.agty-elevator [data-floor-id="2"]').click();
    await eventually('2F lit', async () => (await lamp.innerText()).includes('2F'), 10_000);
    check(true, 'a floor from the list rides there (2F)');
    await desk.waitForTimeout(1_500);
    await desk.getByTestId('elevator-down').click();
    await eventually('1F again', async () => (await lamp.innerText()).includes('1F'), 10_000);
    check(true, '▼ rides back to 1F');
    await desk.reload();
    await lamp.waitFor({ timeout: 30_000 });
    check((await desk.getByTestId('elevator-list').count()) === 1, 'an open list stays open after a reload');
    await lamp.click();
    check((await desk.getByTestId('elevator-list').count()) === 0, 'the lamp closes it');

    // ── 3. 1400x900 ──
    const wide = await newPage(WIDE);
    await eventually('four portraits at 1400', async () => (await wide.locator('[data-portrait]').count()) === 4, 30_000);
    const cam = await wide.getByTestId('camera-modes').boundingBox();
    check(!!cam && !overlap(cam, (await bar(wide).boundingBox())!), '1400: the 시점 group stays clear of the bar');
    await wide.waitForTimeout(800);
    await shot(wide, 'desktop-1400-folded');

    // ── 4. phone ──
    const phone = await newPage(PHONE);
    await phone.waitForTimeout(2_500);
    check((await phone.locator('[data-portrait]').count()) === 0 && (await phone.locator('.agty-elevator-strip').count()) === 0, 'phone: no desktop bar, no strip');
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: no horizontal scroll');
    await shot(phone, 'phone-390x844');
  } finally {
    clearTimeout(deadline);
    if (busy) clearInterval(busy);
    await browser?.close().catch(() => undefined);
    killFakeSessions(home);
    await daemon.stop();
    removeTestHome(home);
  }
  console.log(failed ? `\n${failed} failed` : '\nall checks ok');
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
