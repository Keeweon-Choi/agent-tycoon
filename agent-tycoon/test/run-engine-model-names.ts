/**
 * T-143: a Lead's 설정 lists Claude's models as the CLI names them ("Opus 5.5"), like the side question.
 * dist/cli.js with --engine on --allow-chat --allow-actions in an isolated HOME whose `claude` is the
 * engine fake (it answers the initialize probe with the captured CLI answer), headless Chromium
 * (--disable-gpu). A "/" typed in the Lead's conversation brings the CLI's answer (the slash list asks for it);
 * then the settings form shows the names, keeps the value --model takes, and saves it. Desktop
 * 1440x900 and phone 390x844, 모던, with the model list drawn open (a `size` on the select, since a
 * native drop-down is not in a screenshot).
 *
 *   npx tsx agent-tycoon/test/run-engine-model-names.ts <port 18256-18599>
 *
 * Screenshots: agent-tycoon/artifacts/t0143/*.png
 */
import type { BrowserContextOptions, Locator, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';
import { engineButton } from './engineRow.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/t0143');
const DEADLINE_MS = 180_000;
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__mn/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const config = configDirectory(home);
  fs.writeFileSync(path.join(config, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  fs.copyFileSync(
    path.join(REPO_ROOT, 'server/src/agent-tycoon/fixtures/claude-initialize.json'),
    path.join(home, 'fake-initialize.json'),
  );
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(config, 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true, model: 'opus' }]),
  );
  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, [
    '--engine',
    'on',
    '--allow-chat',
    '--allow-actions',
    '--no-terminal',
  ]);
  const { child: server } = daemon;
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));
  // projects.json v2 keeps a Lead's launch options in assignments.json: read whichever holds it.
  const saved = (model: string) =>
    ['projects.json', 'assignments.json'].some((f) => {
      try {
        return new RegExp(`"model":\\s*"${model}"`).test(fs.readFileSync(path.join(config, f), 'utf-8'));
      } catch {
        return false;
      }
    });

  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  let page: Page | undefined;
  try {
    const font = fs.readFileSync(FONT);
    const loginUrl = await daemon.loginUrl();
    const base = `http://127.0.0.1:${port}/`;
    browser = await launchBrowser();
    let cookies: Awaited<ReturnType<import('@playwright/test').BrowserContext['cookies']>> | null = null;

    const open = async (phone: boolean) => {
      const opts: BrowserContextOptions = phone
        ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
        : { viewport: { width: 1440, height: 900 } };
      const ctx = await browser!.newContext(opts);
      if (cookies) await ctx.addCookies(cookies);
      await ctx.route('**/__mn/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
      const p = await ctx.newPage();
      page = p;
      p.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
      await p.goto(cookies ? base : loginUrl);
      await p.waitForURL(base);
      cookies ??= await ctx.cookies();
      await p.addStyleTag({ content: FONT_CSS });
      return { p, ctx };
    };
    // The settings form's model select, with its options drawn as an open list for the shot.
    const modelSelect = async (p: Page, phone: boolean): Promise<Locator> => {
      const item = await engineButton(p, 'alpha', '설정');
      await (phone ? item.tap() : item.click());
      const form = p.getByRole('form', { name: '설정', exact: false });
      await form.waitFor({ timeout: 10_000 });
      return form.getByLabel('모델');
    };
    const drawOpen = (select: Locator) =>
      select.evaluate((el) => {
        const s = el as HTMLSelectElement;
        s.size = Math.min(s.options.length, 10);
      });

    // --- desktop: the conversation brings the CLI's answer, then the form lists its names ---
    {
      const { p, ctx } = await open(false);
      await p.getByRole('button', { name: /^메신저/ }).click();
      const messenger = p.getByRole('region', { name: '메신저', exact: true });
      await messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }).click();
      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      await conv.waitFor({ timeout: 15_000 });
      // A typed "/" asks for the slash list, and with it the CLI's answer (the side question's way too).
      const box = conv.getByRole('textbox', { name: '보낼 글' });
      await box.fill('/');
      await conv.getByText('/model', { exact: false }).first().waitFor({ timeout: 30_000 });
      await box.fill('');
      const select = await modelSelect(p, false);
      await select.locator('option', { hasText: 'Fable 5.2' }).waitFor({ state: 'attached', timeout: 30_000 });
      const texts = await select.locator('option').allTextContents();
      check(
        texts.includes('Opus 5.5 · Claude Code') &&
          texts.includes('Fable 5.2 · Claude Code') &&
          !texts.some((x) => x.startsWith('Default (recommended)')),
        `the model list reads as the CLI names it, without its own default twice (${texts.length} options)`,
      );
      check((await select.inputValue()) === 'opus', "alpha's saved model shows as its listed name (opus)");
      check(
        (await select.locator('option:checked').innerText()).startsWith('Opus 5.5'),
        'the selected option reads Opus 5.5',
      );
      await select.selectOption({ label: 'Fable 5.2 · Claude Code' });
      check((await select.inputValue()) === 'fable', 'picking Fable 5.2 keeps the value --model takes');
      await drawOpen(select);
      await p.screenshot({ path: path.join(OUT, '01-desktop-model-list.png') });
      await p.getByRole('button', { name: '저장', exact: true }).click();
      for (const end = Date.now() + 15_000; !saved('fable'); ) {
        if (Date.now() > end) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      check(saved('fable'), '저장 writes the value (fable) to the project');
      await ctx.close();
    }

    // --- phone: the same form as a sheet ---
    {
      const { p, ctx } = await open(true);
      const select = await modelSelect(p, true);
      await select.locator('option', { hasText: 'Fable 5.2' }).waitFor({ state: 'attached', timeout: 15_000 });
      check(
        (await select.locator('option:checked').innerText()).startsWith('Fable 5.2'),
        'phone: the saved model reads Fable 5.2',
      );
      await select.scrollIntoViewIfNeeded();
      await drawOpen(select);
      await p.screenshot({ path: path.join(OUT, '02-phone-model-list.png') });
      await ctx.close();
    }
  } catch (err) {
    await page
      ?.screenshot({ path: path.join(OUT, 'debug.png'), timeout: 5_000 })
      .catch((e: unknown) => console.error(`no debug shot: ${String(e)}`));
    throw err;
  } finally {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) {
      const exited = new Promise((r) => server.once('exit', r));
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(force);
    }
    clearTimeout(deadline);
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
