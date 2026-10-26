/**
 * NOTICE-JUMP browser check: a lead's reply arrives right after a sub-agent's task-notice bubble
 * while its conversation is closed (the list the page holds is the stale one). Clicking the reply's
 * notice must outline THE REPLY, never the task-notice bubble before it. Desktop and phone.
 * Headless, temp HOME, the engine fake, no push.
 *
 *   npx tsx cld/test/run-notice-jump.ts <port 18256-18259>
 */
import type { Browser, Locator, Page } from '@playwright/test';
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

const port = sparePort(2);
const OUT = path.join(REPO_ROOT, 'cld/artifacts/notice-jump');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__nj/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 180_000;
const LEADS = ['alpha', 'beta'];

const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what: string, test: () => boolean, timeout = 20_000): Promise<void> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    if (test()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.writeFileSync(
    path.join(configDirectory(home), 'config.json'),
    JSON.stringify({ accessChosen: true, port }),
  );
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  const folders = Object.fromEntries(LEADS.map((name) => [name, path.join(home, 'work', name)]));
  for (const folder of Object.values(folders)) fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(LEADS.map((name) => ({ name, folder: folders[name], wantRunning: true }))),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '400' },
  );
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    type Session = { name: string; cwd: string; sessionId: string };
    const session = (name: string): Session | null => {
      const dir = path.join(home, '.claude/sessions');
      for (const file of fs.readdirSync(dir)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Session;
          if (parsed.name === name) return parsed;
        } catch {
          /* a fake is writing */
        }
      }
      return null;
    };
    await eventually('fake sessions', () => LEADS.every((name) => session(name)));
    let serial = 0;
    const say = (name: string, role: 'user' | 'assistant', text: string) => {
      const s = session(name)!;
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const uuid = `${(++serial).toString(16).padStart(8, '0')}-0099-4000-8000-000000000000`;
      const message =
        role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] };
      fs.appendFileSync(
        file,
        `${JSON.stringify({ type: role, uuid, timestamp: new Date().toISOString(), message })}\n`,
      );
    };
    browser = await launchBrowser();

    /** One run on a desktop or phone page: open alpha, close it (the held list is now stale), a
     *  task notice and then the reply land, the reply's notice is clicked. */
    const run = async (label: 'desktop' | 'phone', page: Page, tap: (l: Locator) => Promise<void>) => {
      const task = `TASK-NOTICE ${label}: a sub-agent finished`;
      const reply = `THE-REPLY ${label}: the answer you asked for`;
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS });
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      const conv = (n: string) => messenger.getByRole('region', { name: `${n} 대화` });
      say('alpha', 'user', `${label}: start`);
      say('alpha', 'assistant', `${label}: working on it`);
      await tap(page.getByRole('button', { name: /^메신저/ }));
      await tap(messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }));
      await conv('alpha').getByText(`${label}: working on it`).waitFor({ timeout: 15_000 });
      // Close alpha (the page keeps what it held, but the daemon stops feeding it), look at beta.
      await tap(messenger.getByRole('button', { name: 'alpha 대화 닫기' }));
      await tap(messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^beta/ }));
      await conv('beta').waitFor();
      // Record every row the jump outlines.
      await page.evaluate(() => {
        const seen: string[] = [];
        (window as unknown as { __focused: string[] }).__focused = seen;
        new MutationObserver((records) => {
          for (const r of records) {
            const el = r.target as HTMLElement;
            if (r.attributeName === 'data-focused' && el.dataset.focused === 'true')
              seen.push(el.innerText);
          }
        }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['data-focused'] });
      });
      await wait(1_500);
      // Written apart, as the transcript has them: the task notice, then the reply.
      say('alpha', 'user', `<task-notification>\n<summary>${task}</summary>\n<status>completed</status>\n</task-notification>`);
      await wait(1_200);
      say('alpha', 'assistant', reply);
      const bell = page.getByTestId('notice-bell');
      await bell.waitFor({ timeout: 20_000 });
      await tap(bell);
      const items = page.getByTestId('notice-item').filter({ hasText: 'alpha' });
      for (const end = Date.now() + 20_000; !(await items.filter({ hasText: 'THE-REPLY' }).count()); await wait(300))
        if (Date.now() > end) throw new Error(`${label}: no reply notice in the bell`);
      await page.screenshot({ path: path.join(OUT, `${label}-1-bell.png`) });
      await tap(items.filter({ hasText: 'THE-REPLY' }).first());
      await conv('alpha').getByText(reply).waitFor({ timeout: 15_000 });
      const focused = async () =>
        page.evaluate(() => (window as unknown as { __focused: string[] }).__focused);
      for (const end = Date.now() + 15_000; !(await focused()).length; await wait(100))
        if (Date.now() > end) throw new Error(`${label}: nothing was outlined`);
      await page.screenshot({ path: path.join(OUT, `${label}-2-landed.png`) });
      await wait(1_000);
      const marks = await focused();
      console.log(`${label} outlined: ${JSON.stringify(marks)}`);
      check(
        marks.length >= 1 && marks.every((m) => m.includes('THE-REPLY')),
        `${label}: the outline lands on the reply, never on the task-notice bubble or any other line`,
      );
    };

    const font = fs.existsSync(FONT) ? fs.readFileSync(FONT) : null;
    const withFont = async (opts: Parameters<Browser['newContext']>[0]) => {
      const ctx = await browser!.newContext(opts);
      if (font)
        await ctx.route('**/__nj/malgun.ttf', (route) =>
          route.fulfill({ body: font, contentType: 'font/ttf' }),
        );
      return ctx;
    };
    const desk = await withFont({ viewport: { width: 1400, height: 900 } });
    await run('desktop', await desk.newPage(), (l) => l.click());
    await desk.close();
    const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 13'];
    const phoneCtx = await withFont(iphone);
    await run('phone', await phoneCtx.newPage(), (l) => l.tap());
    await phoneCtx.close();
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
