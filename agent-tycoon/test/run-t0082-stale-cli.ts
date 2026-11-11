/**
 * STALE-CLI (T-82, owner 11-10): Claude Code updated itself while the Lead's session kept running the
 * old version. dist/cli.js with --engine on in a temp HOME; `claude` is the engine fake behind a small
 * wrapper whose `--version` reads $HOME/v-claude (the installed CLI), and every session the fake starts
 * writes $HOME/fake-claude-version as its own `version` (the running one). alpha starts on 2.1.319, then
 * "the CLI updates itself" to 2.1.322 while alpha is mid-turn. Checks and photos (Chromium --disable-gpu,
 * 1600x1000, both screen styles): the messenger band, the member card's mark, the usage panel's CLI line;
 * the band at phone width (390x844); then 재시작 while busy says it waits, and once the turn ends the
 * session is stopped and resumed on the same conversation (the fake's call log), and every mark goes.
 * Photos in agent-tycoon/artifacts/t0082/.
 *
 *   nice -n 10 taskset -c 8-11 npx tsx agent-tycoon/test/run-t0082-stale-cli.ts [port 19380-19389]
 */
import type { Browser, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { loadRegistry, registryPath } from '../../server/src/agent-tycoon/engine/registry.js';
import { transcriptPath } from '../../server/src/agent-tycoon/providers/claudeProvider.js';
import {
  assertPortFree,
  engineCalls,
  FAKE_CLAUDE,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
  topBarReady,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]) || 19380;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/t0082');
const DEADLINE_MS = 300_000;
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t82/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
let oks = 0;
const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  for (const end = Date.now() + ms; ; await sleep(250)) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

async function main() {
  if (port < 19380 || port > 19389) throw new Error('T-82 runs on 19380-19389');
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const claude = path.join(bin, 'claude');
  fs.rmSync(claude);
  fs.writeFileSync(
    claude,
    `#!/usr/bin/env node
const fs = require('fs');
if (process.argv[2] === '--version') {
  process.stdout.write(fs.readFileSync(require('path').join(process.env.HOME, 'v-claude'), 'utf8').trim() + ' (Claude Code)\\n');
  process.exit(0);
}
require(${JSON.stringify(path.join(FAKE_CLAUDE, 'engine.cjs'))});
`,
    { mode: 0o755 },
  );
  const setVersion = (v: string) => {
    fs.writeFileSync(path.join(home, 'v-claude'), v);
    fs.writeFileSync(path.join(home, 'fake-claude-version'), v);
    const now = new Date();
    fs.utimesSync(claude, now, now); // the binary was replaced: the daemon reads its --version again
  };
  setVersion('2.1.319');
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(path.join(cfg, 'projects.json'), JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true }]));
  const daemon = startDaemon({ home, claudePath: claude }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'], {
    FAKE_TURN_MS: '400',
  });
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
    process.exit(1);
  }, DEADLINE_MS);
  let browser: Browser | undefined;
  const font = fs.existsSync(FONT) ? fs.readFileSync(FONT) : null;
  try {
    const record = () => loadRegistry(registryPath(home)).projects.find((p) => p.name === 'alpha');
    /** alpha's live session file (the fake's), and a rewrite of its status: the turn as Claude writes it. */
    const sessionFile = () =>
      fs
        .readdirSync(path.join(home, '.claude/sessions'))
        .map((n) => path.join(home, '.claude/sessions', n))
        .find((f) => (JSON.parse(fs.readFileSync(f, 'utf8')) as { sessionId?: string }).sessionId === record()?.sessionId);
    const setStatus = (status: string) => {
      const f = sessionFile()!;
      fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), status }));
    };
    await until('alpha runs on 2.1.319', () => !!record()?.sessionId && !!sessionFile(), 60_000);
    const sessionId = record()!.sessionId!;
    // The conversation has messages (Claude's transcript): a restart resumes it, as with a real one.
    const transcript = transcriptPath(folder, sessionId, home);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({ type: 'user', sessionId, message: { role: 'user', content: 'hi' } })}\n`);
    check(JSON.parse(fs.readFileSync(sessionFile()!, 'utf8')).version === '2.1.319', 'alpha’s session file says 2.1.319');
    // The CLI updates itself while alpha works; alpha keeps its old process.
    setVersion('2.1.322');
    setStatus('busy');

    browser = await launchBrowser();
    const newPage = async (theme: 'modern' | 'pixel', phone = false) => {
      const ctx = await browser!.newContext(
        phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1600, height: 1000 } },
      );
      await ctx.addInitScript((v) => {
        try {
          localStorage.setItem('agty.ui-theme', v);
        } catch {
          /* about:blank */
        }
      }, theme);
      if (font) await ctx.route('**/__t82/malgun.ttf', (r) => r.fulfill({ body: font, contentType: 'font/ttf' }));
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      const toast = await page.getByText(/으로 업데이트됐어요/).first().textContent({ timeout: 3_000 }).catch(() => null);
      const v = toast?.match(/v([\d.]+)/)?.[1];
      if (v) {
        await page.evaluate((x) => localStorage.setItem('agty.changelogSeen', x), v);
        await page.reload();
      }
      if (font) await page.addStyleTag({ content: FONT_CSS });
      return page;
    };
    const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const openChat = async (page: Page) => {
      await page.getByRole('button', { name: /^메신저/ }).first().click();
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      await messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }).first().click({ timeout: 20_000 });
      const talk = messenger.getByRole('region', { name: 'alpha 대화' });
      await talk.waitFor({ timeout: 20_000 });
      return talk;
    };

    let modern: Page | undefined;
    for (const theme of ['modern', 'pixel'] as const) {
      const page = await newPage(theme);
      check((await page.locator('html').getAttribute('data-ui-theme')) === theme, `${theme}: the screen style is on`);
      await topBarReady(page, 30_000);
      await openOfficeWindow(page);
      // The member card's mark.
      const portrait = page.locator('[data-testid="agent-card"][title="alpha"]').first();
      await portrait.waitFor({ timeout: 30_000 });
      const card = page.locator(`[data-testid="inspector"][data-agent-id="${await portrait.getAttribute('data-agent-id')}"]`);
      for (let i = 0; i < 3 && !(await card.count()); i++) {
        await portrait.click();
        await sleep(700);
      }
      await card.waitFor({ state: 'attached', timeout: 10_000 }).catch(async (err: unknown) => {
        await shot(page, `debug-${theme}-no-card`);
        throw err;
      });
      const mark = card.getByTestId('stale-cli-mark');
      await mark.waitFor({ timeout: 40_000 });
      check((await mark.textContent())?.includes('2.1.319 → 2.1.322'), `${theme}: the member card says 2.1.319 → 2.1.322`);
      await shot(page, `${theme}-card`);
      // The usage panel's CLI row.
      await page.locator('[data-testid="cc-seg-usage"]').first().click();
      const stale = page.locator('[data-testid="cc-agent"][data-agent="claude"]:visible [data-testid="cc-stale"]');
      await stale.waitFor({ timeout: 20_000 });
      const line = (await stale.textContent()) ?? '';
      check(line.includes('켜져 있는 세션 1개는 2.1.319') && line.includes('재시작하면 새 버전'), `${theme}: the usage row says "${line}"`);
      await shot(page, `${theme}-usage`);
      await page.locator('[data-testid="cc-seg-usage"]').first().click();
      // The messenger band.
      const talk = await openChat(page);
      const band = page.getByTestId('stale-cli-band');
      await band.waitFor({ timeout: 20_000 });
      const text = (await band.textContent()) ?? '';
      check(text.includes('업데이트 설치됨 · 재시작하면 새 버전 (2.1.319 → 2.1.322)'), `${theme}: the band says "${text}"`);
      check((await band.getByRole('button').count()) === 1 && (await band.getByRole('button').textContent()) === '재시작', `${theme}: one button, 재시작`);
      check(await talk.isVisible(), `${theme}: the conversation is open under it`);
      await shot(page, `${theme}-band`);
      if (theme === 'modern') modern = page;
      else await page.context().close();
    }

    // The band at phone width.
    const phone = await newPage('modern', true);
    const dock = phone.locator('[data-dock="messenger"]');
    if (await dock.count()) await dock.first().tap();
    else await phone.getByRole('button', { name: /^메신저/ }).first().tap();
    const contacts = phone.getByRole('list', { name: '연락처' });
    await contacts.getByRole('button', { name: /^alpha/ }).first().tap({ timeout: 20_000 });
    const phoneBand = phone.getByTestId('stale-cli-band');
    await phoneBand.waitFor({ timeout: 20_000 });
    check(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: no sideways scroll');
    await shot(phone, 'phone-band');
    await phone.context().close();

    // 재시작 while alpha is mid-turn: it waits; nothing is stopped.
    const page = modern!;
    const band = page.getByTestId('stale-cli-band');
    const before = engineCalls(home).length;
    await band.getByRole('button', { name: '재시작', exact: true }).click();
    await until('the band says it waits', async () => (await band.getAttribute('data-wait')) === 'waiting', 20_000);
    check((await band.textContent())?.includes('기다리는 중') && (await band.getByRole('button').textContent()) === '취소', 'waiting: the band says so and offers 취소');
    await shot(page, 'modern-band-waiting');
    await sleep(12_000); // past one look of the wait (every 10 s)
    check(!engineCalls(home).slice(before).some((c) => c.argv[0] === 'stop'), 'nothing was stopped while the turn ran');
    // The turn ends: the wait restarts it in the same conversation.
    setStatus('idle');
    await until('the session was restarted', () => engineCalls(home).slice(before).some((c) => c.argv[0] === '--bg'), 40_000);
    const calls = engineCalls(home).slice(before).map((c) => c.argv);
    console.log(`  fake claude calls after the click: ${JSON.stringify(calls)}`);
    const stop = calls.findIndex((a) => a[0] === 'stop');
    const start = calls.findIndex((a) => a[0] === '--bg');
    check(stop >= 0 && start > stop, 'claude stop, then claude --bg');
    check(calls[start].includes('--resume') && calls[start][calls[start].indexOf('--resume') + 1] === sessionId, `--resume ${sessionId.slice(0, 8)}: the same conversation`);
    await until('the record keeps the conversation and a new session runs 2.1.322', () => {
      const f = sessionFile();
      return record()?.sessionId === sessionId && !!f && JSON.parse(fs.readFileSync(f, 'utf8')).version === '2.1.322';
    });
    await band.waitFor({ state: 'detached', timeout: 30_000 });
    check(true, 'the band went once the session runs the installed version');
    await shot(page, 'modern-after-restart');
    await page.context().close();
    console.log(`\n${oks} checks passed; photos in ${OUT}`);
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
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
