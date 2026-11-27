/**
 * T-81 C: the messenger's slash list behaves like Claude Code's own prompt. The list shows each
 * command's argument hint; Enter on a partly typed command that takes arguments inserts `/name `
 * with the hint greyed after it, Tab completes, Enter on one without arguments sends it; a bare
 * /model sent from the messenger opens the CLI's model picker, which slides up as the lead's live
 * terminal over the conversation; choosing in it (keys, or the phone's key bar) closes the sheet.
 * T-141: the same /model to a Lead in the middle of a turn (the fake's FAKE-THINK) opens the sheet, and
 * a message sent while the picker is up is held until it closes.
 * Desktop 모던 and 픽셀 감성, phone 390x844 모던. dist/cli.js with --engine on --allow-chat in a temp
 * HOME whose `claude` is the engine fake (fake-claude/pty-tui.cjs draws the picker), the project
 * in our PTY host (claude-pty), headless Chromium --disable-gpu.
 *
 *   npx tsx agent-tycoon/test/run-slash-like-terminal.ts <port 18490-18499>
 *
 * T-169: a /model closed in the terminal, picked or kept with Esc, leaves no 보냄 bubble at the bottom:
 * it settles as the owner's `/model` line where the CLI logged it. A dialog that closes logging
 * nothing (the fake's `/tasks`, as Claude Code's display "skip" dialogs) leaves no bubble either.
 *
 * Screenshots: agent-tycoon/artifacts/t0081/*.png, agent-tycoon/artifacts/t169/*.png
 */
import type { BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { PtyHostClient } from '../../server/src/agent-tycoon/ptyhost/client.js';
import { ptyhostPaths } from '../../server/src/agent-tycoon/ptyhost/protocol.js';
import {
  assertPortFree,
  isFakeOf,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/t0081');
const OUT_T169 = path.join(REPO_ROOT, 'agent-tycoon/artifacts/t169');
const DEADLINE_MS = 420_000;
const PHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 390, height: 844 } };
})();

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what: string, ok: () => boolean | Promise<boolean>, ms: number): Promise<void> {
  for (const end = Date.now() + ms; !(await ok()); ) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(OUT_T169, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  // T-169: `/tasks` in the slash list (a user command here; the fake opens its silent dialog on it).
  fs.mkdirSync(path.join(home, '.claude/commands'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/commands/tasks.md'), '---\ndescription: background tasks\n---\nList the tasks.\n');
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'config.json'),
    JSON.stringify({ accessChosen: true, port }),
  );
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true, provider: 'claude-pty' }]),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
  );
  const { child: server } = daemon;
  const host = ptyhostPaths(home);
  const read = (f: string) => {
    try {
      return fs.readFileSync(f, 'utf-8');
    } catch {
      return '';
    }
  };
  /** The PTY host this test HOME's daemon started: it outlives the daemon, so it is stopped here. */
  const stopHost = () => {
    const m = [...read(host.log).matchAll(/listening, pid (\d+)/g)].at(-1);
    const pid = m ? Number(m[1]) : 0;
    if (pid && isFakeOf(pid, home)) process.kill(pid, 'SIGKILL');
  };
  const client = new PtyHostClient({ home, launch: () => undefined, log: () => undefined });
  const ptyCols = async () => {
    const [term] = JSON.parse(read(host.terminals) || '[]') as Array<{ id: string }>;
    return term ? ((await client.screen(term.id))?.cols ?? 0) : 0;
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null) server.kill('SIGKILL');
    client.dispose();
    stopHost();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort('deadline'), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));
  const lines = (file: string) => {
    const f = path.join(home, file);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean) : [];
  };
  const alphaUp = () =>
    fs.readdirSync(path.join(home, '.claude/sessions')).some((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', f), 'utf-8')).name === 'alpha';
      } catch {
        return false;
      }
    });

  const browser = await launchBrowser();
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const open = async (page: Page, touch: boolean) => {
    const tap = (l: Locator) => (touch ? l.tap() : l.click());
    await page.getByRole('button', { name: /^메신저/ }).waitFor({ timeout: 30_000 });
    await tap(page.getByRole('button', { name: /^메신저/ }));
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    await tap(messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }));
    return messenger.getByRole('region', { name: 'alpha 대화' });
  };
  const newPage = async (opts: BrowserContextOptions, theme: 'modern' | 'pixel', cookies?: Parameters<import('@playwright/test').BrowserContext['addCookies']>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript(
      `globalThis.__name = (fn) => fn; try { localStorage.setItem('agty.ui-theme', '${theme}') } catch {}`,
    );
    if (cookies) await ctx.addCookies(cookies);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    return { ctx, page };
  };
  /** T-169: no `/model` bubble waits as sent; the conversation shows it as a settled line. */
  const modelSettled = async (conv: Locator, what: string) => {
    const waiting = conv.getByTestId('pending').filter({ hasText: '/model' });
    await until(`${what}: the /model bubble settled`, async () => (await waiting.count()) === 0, 15_000);
    check((await conv.locator('[data-chat-id]').filter({ hasText: '/model' }).count()) >= 1, `${what}: /model settled in its place, no 보냄 bubble left`);
  };
  const sheetText = (page: Page) =>
    page.getByTestId('picker-sheet').locator('.xterm-rows').textContent().then((t) => t ?? '');

  /** Bare /model from the composer (`hinted`: Enter on the `/model ` the list inserted, its hint
   *  showing): the sheet slides up already showing the CLI's picker. */
  const sendModel = async (page: Page, conv: Locator, touch: boolean, hinted = false) => {
    const box = conv.getByRole('textbox', { name: '보낼 글' });
    // The composer ignores Enter while a send is still on its way (the FAKE-THINK just before).
    const onItsWay = conv.locator('[data-testid="pending"][data-state="sending"]');
    await until('no send on its way', async () => (await onItsWay.count()) === 0, 20_000);
    if (!hinted) await box.fill('/model');
    if (touch) await conv.getByRole('button', { name: '보내기', exact: true }).tap();
    else await box.press('Enter');
    const sheet = page.getByTestId('picker-sheet');
    await sheet.waitFor({ timeout: 30_000 });
    await until('the sheet shows the picker', async () => (await sheetText(page)).includes('Select model'), 20_000);
    return sheet;
  };

  try {
    await until('the engine started alpha in the PTY host', alphaUp, 60_000);
    await new Promise((r) => setTimeout(r, 1_500)); // its probe and first screen
    const url = await daemon.loginUrl();

    // ════ Desktop 모던 ════
    const desk = await newPage({ viewport: { width: 1280, height: 800 } }, 'modern');
    await desk.page.goto(url);
    await desk.page.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await desk.ctx.cookies();
    const conv = await open(desk.page, false);
    const box = conv.getByRole('textbox', { name: '보낼 글' });
    await box.fill('/mo');
    const list = conv.getByRole('listbox', { name: '/ 명령' });
    const modelRow = list.getByRole('option', { name: /^\/model/ });
    await modelRow.waitFor({ timeout: 20_000 });
    check(((await modelRow.textContent()) ?? '').includes('<모델>'), 'desktop: the list shows /model with its argument hint');
    await shot(desk.page, '1-desktop-modern-list');
    await box.press('Enter');
    check((await box.inputValue()) === '/model ', 'desktop: Enter on a partly typed command with arguments inserts it');
    const hint = conv.getByTestId('slash-hint');
    check(((await hint.textContent()) ?? '').includes('<모델>'), 'desktop: the hint shows greyed after the command');
    check((await list.count()) === 0, 'desktop: the list closes once the command is in');
    await shot(desk.page, '2-desktop-modern-hint');
    await box.press('s');
    check((await hint.count()) === 0, 'desktop: the hint goes once the owner types');
    await box.fill('/cont');
    await box.press('Tab');
    const tabbed = await box.inputValue();
    check(tabbed === '/context ', `desktop: Tab completes the highlighted command ("${tabbed}")`);
    await box.fill('/cont');
    await box.press('Enter');
    await until('/context went in', () => lines('fake-claude-typed.log').some((l) => l.includes('"/context"')), 30_000);
    check(true, 'desktop: Enter on a command without arguments sends it whole');
    await new Promise((r) => setTimeout(r, 2_000)); // its fake turn ends
    const colsBefore = await ptyCols();
    check(colsBefore > 0, `desktop: the Lead's PTY is ${colsBefore} columns wide before the sheet`);
    await box.fill('/mo');
    await modelRow.waitFor({ timeout: 20_000 });
    await box.press('Enter');
    await hint.waitFor({ timeout: 5_000 });
    // Enter with the greyed hint showing: the fake opens its picker on exactly `/model` only.
    const sheet = await sendModel(desk.page, conv, false, true);
    check(
      lines('fake-claude-typed.log').every((l) => !l.includes('/model') && !l.includes('<모델>')),
      'desktop: Enter with the hint showing sent exactly /model (no space, no hint): it opened the picker',
    );
    console.log(`  (the PTY at the sheet's width: ${await ptyCols()} columns)`);
    await shot(desk.page, '3-desktop-modern-sheet');
    await sheet.locator('.xterm').click();
    await desk.page.keyboard.press('ArrowDown');
    await desk.page.keyboard.press('Enter');
    await until('the pick reached the CLI', () => lines('fake-claude-model.log').length === 1, 15_000);
    check(lines('fake-claude-model.log')[0].includes('Sonnet 5.5'), 'desktop: the arrow and Enter picked the next model in the terminal');
    await sheet.waitFor({ state: 'detached', timeout: 20_000 });
    check((await conv.getByTestId('picker-note').count()) === 0, 'desktop: the sheet closed by itself with the picker, no notice left');
    await modelSettled(conv, 'desktop (picked)');
    await desk.page.screenshot({ path: path.join(OUT_T169, '1-desktop-modern-picked.png') });
    await until('the PTY has its size back', async () => (await ptyCols()) === colsBefore, 10_000);
    check(true, `desktop: the Lead's PTY is back at ${colsBefore} columns after the sheet`);
    check(await box.evaluate((el) => el === document.activeElement), 'desktop: the keys went back to the composer');
    await desk.page.keyboard.type('hi');
    check((await box.inputValue()) === 'hi', 'desktop: the next keys land in the composer');
    await box.fill('');
    await shot(desk.page, '4-desktop-modern-closed');
    // T-169: a dialog that closes logging nothing.
    await box.fill('/tasks');
    await box.press('Enter');
    const tasks = desk.page.getByTestId('picker-sheet');
    await until('the sheet shows the tasks dialog', async () => (await sheetText(desk.page)).includes('Background tasks'), 30_000);
    await tasks.locator('.xterm').click();
    await desk.page.keyboard.press('Escape');
    await tasks.waitFor({ state: 'detached', timeout: 20_000 });
    const tasksWaiting = conv.getByTestId('pending').filter({ hasText: '/tasks' });
    await until('the /tasks bubble left', async () => (await tasksWaiting.count()) === 0, 20_000);
    check(true, 'desktop: a dialog closed with nothing logged leaves no 보냄 bubble');
    await desk.page.screenshot({ path: path.join(OUT_T169, '4-desktop-modern-silent-dialog.png') });
    await desk.ctx.close();

    // ════ Desktop 픽셀 감성 ════
    const pix = await newPage({ viewport: { width: 1280, height: 800 } }, 'pixel', cookies);
    await pix.page.goto(`http://127.0.0.1:${port}/`);
    check((await pix.page.evaluate(() => document.documentElement.dataset.uiTheme)) === 'pixel', 'pixel: the 픽셀 감성 screen style is on');
    const conv2 = await open(pix.page, false);
    const box2 = conv2.getByRole('textbox', { name: '보낼 글' });
    await box2.fill('/mo');
    await conv2.getByRole('listbox', { name: '/ 명령' }).getByRole('option', { name: /^\/model/ }).waitFor({ timeout: 20_000 });
    await box2.press('Enter');
    check((await conv2.getByTestId('slash-hint').textContent())?.includes('<모델>'), 'pixel: the hint shows after the inserted command');
    await shot(pix.page, '5-desktop-pixel-hint');
    // The chat search open: its Esc listener must leave the terminal's Esc alone.
    await conv2.getByRole('button', { name: '대화 검색' }).click();
    const sheet2 = await sendModel(pix.page, conv2, false);
    await shot(pix.page, '6-desktop-pixel-sheet');
    // The owner closes the sheet: the notice offers it again while the picker stays up.
    await sheet2.getByTestId('picker-sheet-close').click();
    await conv2.getByTestId('picker-note').waitFor({ timeout: 5_000 });
    await conv2.getByTestId('picker-open-terminal').click();
    await until('the reopened sheet shows the picker', async () => (await sheetText(pix.page)).includes('Select model'), 20_000);
    check(true, 'pixel: a closed sheet comes back from the notice');
    await sheet2.locator('.xterm').click();
    await pix.page.keyboard.press('Escape');
    await sheet2.waitFor({ state: 'detached', timeout: 20_000 });
    check(lines('fake-claude-model.log').length === 1, 'pixel: Esc in the terminal kept the model and closed the sheet');
    await modelSettled(conv2, 'pixel (kept with Esc)');
    await pix.page.screenshot({ path: path.join(OUT_T169, '2-desktop-pixel-kept.png') });
    check(
      (await conv2.getByRole('region', { name: '대화 검색' }).count()) === 1,
      'pixel: with the chat search open, Esc went to the terminal, not the search',
    );
    await pix.ctx.close();

    // ════ Phone 390x844 모던 ════
    const ph = await newPage(PHONE, 'modern', cookies);
    await ph.page.goto(`http://127.0.0.1:${port}/`);
    const conv3 = await open(ph.page, true);
    const box3 = conv3.getByRole('textbox', { name: '보낼 글' });
    await box3.tap();
    await box3.fill('/mo');
    await conv3.getByRole('listbox', { name: '/ 명령' }).getByRole('option', { name: /^\/model/ }).tap();
    check((await box3.inputValue()) === '/model ', 'phone: a tap fills the command');
    check((await conv3.getByTestId('slash-hint').textContent())?.includes('<모델>'), 'phone: with its hint after it');
    await shot(ph.page, '7-phone-hint');
    const sheet3 = await sendModel(ph.page, conv3, true);
    // It opens on the current model (Sonnet 5.5, picked on the desktop): one row down is Haiku.
    await sheet3.getByRole('button', { name: '아래쪽 화살표 키' }).tap();
    await shot(ph.page, '8-phone-sheet');
    await sheet3.getByRole('button', { name: '보내기 키' }).tap();
    await until('the phone pick reached the CLI', () => lines('fake-claude-model.log').length === 2, 15_000);
    check(lines('fake-claude-model.log')[1].includes('Haiku 5.5'), 'phone: the key bar moved and picked in the terminal');
    await sheet3.waitFor({ state: 'detached', timeout: 20_000 });
    check(true, 'phone: the sheet closed with the picker');
    check(
      await ph.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'phone: no horizontal page scroll',
    );
    await ph.ctx.close();

    // ════ T-141: a busy Lead, desktop 모던 ════
    const busy = await newPage({ viewport: { width: 1280, height: 800 } }, 'modern', cookies);
    await busy.page.goto(`http://127.0.0.1:${port}/`);
    const conv4 = await open(busy.page, false);
    const box4 = conv4.getByRole('textbox', { name: '보낼 글' });
    await box4.fill('FAKE-THINK 60');
    await box4.press('Enter');
    await until('the long turn started', () => lines('fake-claude-typed.log').some((l) => l.includes('FAKE-THINK')), 30_000);
    // The turn's text 5 s old (MESSENGER quietMs): the messenger takes a command in the running turn.
    await new Promise((r) => setTimeout(r, 6_500));
    const sessionBusy = () =>
      fs.readdirSync(path.join(home, '.claude/sessions')).some((f) => read(path.join(home, '.claude/sessions', f)).includes('"status":"busy"'));
    check(sessionBusy(), 'busy: the Lead is in the middle of a turn');
    const models = lines('fake-claude-model.log').length;
    const sheet4 = await sendModel(busy.page, conv4, false);
    check(sessionBusy(), 'busy: /model opened the sheet while the turn still ran');
    check((await sheetText(busy.page)).includes('esc to interrupt'), "busy: the sheet shows the turn's spinner row above the picker");
    await shot(busy.page, '9-desktop-busy-sheet');
    await sheet4.getByTestId('picker-sheet-close').click();
    await conv4.getByTestId('picker-note').waitFor({ timeout: 5_000 });
    await box4.fill('T141 그대로 진행해');
    await box4.press('Enter');
    await new Promise((r) => setTimeout(r, 5_000));
    check(!lines('fake-claude-typed.log').some((l) => l.includes('T141')), 'busy: the message sent while the picker is up was not typed');
    check(lines('fake-claude-model.log').length === models, 'busy: nothing picked a model in the open picker');
    await shot(busy.page, '10-desktop-busy-held');
    await conv4.getByTestId('picker-open-terminal').click();
    await until('the reopened sheet shows the picker', async () => (await sheetText(busy.page)).includes('Select model'), 20_000);
    await sheet4.locator('.xterm').click();
    await busy.page.keyboard.press('Escape');
    await sheet4.waitFor({ state: 'detached', timeout: 20_000 });
    await until('the held message went in', () => lines('fake-claude-typed.log').some((l) => l.includes('T141')), 30_000);
    check(true, 'busy: once the picker closed, the held message went in');
    check(lines('fake-claude-model.log').length === models, 'busy: Esc kept the model');
    await shot(busy.page, '11-desktop-busy-delivered');
    // The same, /model queued first: sent while the turn's text is younger than quietMs, the tick types it later.
    await until('the first long turn ended', () => !sessionBusy(), 90_000);
    const typedThink = () => lines('fake-claude-typed.log').filter((l) => l.includes('FAKE-THINK')).length;
    const thinks = typedThink();
    await box4.fill('FAKE-THINK 25');
    await box4.press('Enter');
    await until('the second turn started', () => typedThink() > thinks, 30_000);
    const sheet5 = await sendModel(busy.page, conv4, false);
    check(sessionBusy(), 'queued: the /model the tick typed opened the sheet while the turn still ran');
    await shot(busy.page, '12-desktop-busy-queued-sheet');
    await sheet5.locator('.xterm').click();
    await busy.page.keyboard.press('Escape');
    await sheet5.waitFor({ state: 'detached', timeout: 20_000 });
    check(lines('fake-claude-model.log').length === models, 'queued: Esc kept the model');
    await modelSettled(conv4, 'busy and queued (kept with Esc)');
    await busy.page.screenshot({ path: path.join(OUT_T169, '3-desktop-busy-kept.png') });
    await busy.ctx.close();
    console.log('done');
  } catch (err) {
    console.error(`daemon log (end):\n${daemon.log.join('').split('\n').slice(-60).join('\n')}`);
    throw err;
  } finally {
    await browser.close().catch(() => undefined);
    if (server.exitCode === null) {
      const exited = new Promise((r) => server.once('exit', r));
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(force);
    }
    clearTimeout(deadline);
    client.dispose();
    stopHost();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
