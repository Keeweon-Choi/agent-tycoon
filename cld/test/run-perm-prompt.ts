/**
 * PERM-PROMPT: an engine session (bypass mode, so no heuristic permission guess) held by a Claude
 * Code permission dialog reaches the owner: the 🔐 notice (toast and bell), the messenger card naming the open call,
 * a queued message that says why it waits; 허용 answers the dialog ("1. Yes"), the card goes and the
 * queued message goes in. Desktop, then a second dialog on the phone (393x852). dist/cli.js with
 * --engine on --allow-chat in an isolated HOME whose `claude` is the engine fake (fake-perm-<id>
 * draws the dialog and lists it as `waitingFor: permission prompt`), headless Chromium --disable-gpu.
 *
 *   npx tsx cld/test/run-perm-prompt.ts <port 18256-18259>
 *
 * Screenshots: cld/artifacts/perm-prompt/*.png
 */
import type { BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/perm-prompt');
const DEADLINE_MS = 240_000;
const PHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 393, height: 852 } };
})();
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__msf/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(
  what: string,
  ok: () => boolean | Promise<boolean>,
  ms: number,
): Promise<void> {
  for (const end = Date.now() + ms; !(await ok());) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true }]),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
  );
  const { child: server } = daemon;
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null) server.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort('deadline'), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  type Sess = { sessionId: string; cwd: string; name: string; jobId: string };
  const alpha = (): Sess | null => {
    for (const f of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Sess;
        if (s.name === 'alpha') return s;
      } catch {
        /* being written */
      }
    }
    return null;
  };
  let uuid = 0;
  const rec = (record: Record<string, unknown>) => {
    const s = alpha()!;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        uuid: `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
        timestamp: new Date().toISOString(),
        ...record,
      })}\n`,
    );
  };
  /** The lead opens a Bash call and Claude Code asks about it (the fake's dialog shows the same words). */
  const ask = (toolId: string, description: string, command: string) => {
    rec({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command, description } }],
      },
    });
    fs.writeFileSync(
      path.join(home, `fake-perm-${alpha()!.jobId}`),
      JSON.stringify({ title: 'Bash command', desc: description, command }),
    );
  };
  const done = (toolId: string) =>
    rec({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }],
      },
    });
  const answers = () => {
    const f = path.join(home, 'fake-claude-answers.log');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean) : [];
  };
  const typed = () => {
    const f = path.join(home, 'fake-claude-typed.log');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : '';
  };

  const browser = await launchBrowser();
  const nameShim = 'globalThis.__name = (fn) => fn;';
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const asked = (p: Page) =>
    p.locator('[data-testid="notice-item"]').filter({ hasText: '허락을 기다려요' });
  const open = async (page: Page, touch: boolean) => {
    const tap = (l: Locator) => (touch ? l.tap() : l.click());
    await page.getByRole('button', { name: /^메신저/ }).waitFor();
    await tap(page.getByRole('button', { name: /^메신저/ }));
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    const b = messenger
      .getByRole('list', { name: '연락처' })
      .getByRole('button', { name: /^alpha/ });
    await tap(b);
    return messenger.getByRole('region', { name: 'alpha 대화' });
  };
  try {
    await until('the engine started alpha', () => !!alpha(), 40_000);
    // Bypass mode, as the orchestrator runs: the heuristic never guesses a permission wait here.
    rec({ type: 'permission-mode', permissionMode: 'bypassPermissions' });
    rec({
      type: 'user',
      message: { role: 'user', content: '[사장 · 메신저 · 10-24 23:30] ⟨m:aaaa1111⟩\n정리해 줘' },
    });
    const url = await daemon.loginUrl();

    // ════ Desktop ════
    const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await deskCtx.addInitScript(nameShim);
    if (fs.existsSync(FONT))
      await deskCtx.route('**/__msf/malgun.ttf', (r) =>
        r.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
      );
    const page = await deskCtx.newPage();
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    page.on('console', (m) => {
      if (/notice|permission/i.test(m.text())) console.log(`  [console] ${m.text()}`);
    });
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    const infoClose = page.getByRole('button', { name: '정보 창 닫기' });
    if (await infoClose.count()) await infoClose.click();

    // Past the page's resync quiet (RESYNC_QUIET_MS): a notice in it is history, not news.
    await page.waitForTimeout(4_000);
    ask('toolu_perm1', 'Clean the marks', 'rm -f $M/*\necho cleaned');
    // The 🔐 notice (the bell's list, as run-notices checks a permission ask), naming alpha.
    await until(
      'the daemon confirmed the wait',
      () => daemon.log.join('').includes('"alpha" waits on a permission dialog'),
      40_000,
    );
    await page.waitForTimeout(500);
    await page.locator('[data-testid="notice-bell"]').click();
    await asked(page).first().waitFor({ timeout: 10_000 });
    const text = (await asked(page).first().textContent()) ?? '';
    check(text.includes('alpha'), `desktop: the 🔐 notice names alpha ("${text}")`);
    await shot(page, 'desktop-notice');
    await page.keyboard.press('Escape');
    const conv = await open(page, false);
    const card = conv.getByTestId('permission-card');
    await card.waitFor({ timeout: 15_000 });
    // Viewed: the card becomes the dialog itself, read off the session's screen (its command too).
    const call = card.getByTestId('permission-call');
    await until(
      'the card read off the screen',
      async () => ((await call.textContent()) ?? '').includes('rm -f $M/*'),
      20_000,
    );
    check(
      ((await call.textContent()) ?? '').includes('Clean the marks'),
      'desktop: the card shows the dialog read off the screen (title, description, command)',
    );
    // A message for the held session waits, and says why.
    await conv.getByRole('textbox', { name: '보낼 글' }).fill('확인 뒤에 들어갈 말');
    await conv.getByRole('button', { name: '보내기', exact: true }).click();
    const pending = conv.locator('[data-testid="pending"][data-state="queued"]');
    await pending.waitFor({ timeout: 15_000 });
    check(
      (await pending.textContent())?.includes('확인 창에 먼저 답해 주세요'),
      'desktop: the queued message says why it waits',
    );
    await shot(page, 'desktop-card');
    await card.getByRole('button', { name: '허용' }).click();
    await card.waitFor({ state: 'detached', timeout: 20_000 });
    check(
      answers().length === 1 && answers()[0].includes('"yes"'),
      'desktop: 허용 answered the dialog with "1. Yes"',
    );
    done('toolu_perm1');
    await shot(page, 'desktop-answered');
    await until(
      'the queued message goes in after the dialog',
      () => typed().includes('확인 뒤에 들어갈 말'),
      90_000,
    );
    check(true, 'desktop: the queued message went in once the dialog was answered');

    // ════ Phone 393x852: a second dialog, a new notice ════
    const ctx2 = await browser.newContext({ ...PHONE, storageState: await deskCtx.storageState() });
    await deskCtx.close();
    await ctx2.addInitScript(nameShim);
    if (fs.existsSync(FONT))
      await ctx2.route('**/__msf/malgun.ttf', (r) =>
        r.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
      );
    const p2 = await ctx2.newPage();
    p2.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    await p2.goto(`http://127.0.0.1:${port}/`);
    await p2.addStyleTag({ content: FONT_CSS });
    const conv2 = await open(p2, true);
    ask('toolu_perm2', 'Remove the old build', 'rm -rf "${OUT:?}"/build');
    const card2 = conv2.getByTestId('permission-card');
    await card2.waitFor({ timeout: 40_000 });
    const call2 = card2.getByTestId('permission-call');
    await until(
      'the phone card read off the screen',
      async () => ((await call2.textContent()) ?? '').includes('"${OUT:?}"/build'),
      20_000,
    );
    check(
      ((await call2.textContent()) ?? '').includes('Remove the old build'),
      'phone: a later dialog shows a new card, read off the screen',
    );
    await shot(p2, 'phone-card');
    await card2.getByRole('button', { name: '허용' }).tap();
    await card2.waitFor({ state: 'detached', timeout: 20_000 });
    check(answers().length === 2, 'phone: 허용 answered the second dialog');
    done('toolu_perm2');
    await shot(p2, 'phone-answered');
    check(
      await p2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'phone: no horizontal page scroll',
    );
    await ctx2.close();
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
