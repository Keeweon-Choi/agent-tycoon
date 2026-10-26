/**
 * G2 (PWA part) browser check: an external link in a messenger message opens a NEW page (no
 * opener) and the app page stays; links with other schemes do nothing; the page never reloads or
 * pans from a pull-down gesture on the phone shell (overscroll-behavior none, touch-action
 * manipulation: pinch zoom stays for reading); the manifest's icons all load and one is maskable. Desktop and phone. Headless,
 * temp HOME, the engine fake, no push.
 *
 *   npx tsx cld/test/run-g2-pwa.ts <port 18256-18259>
 */
import type { Browser, BrowserContext, Page } from '@playwright/test';
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/g2-pwa');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__g2/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 150_000;
const EXTERNAL = 'https://example.test/g2-external-link';

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
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([{ name: 'alpha', folder, wantRunning: true }]),
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
    const session = (): Session | null => {
      const dir = path.join(home, '.claude/sessions');
      for (const file of fs.readdirSync(dir)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Session;
          if (parsed.name === 'alpha') return parsed;
        } catch {
          /* a fake is writing */
        }
      }
      return null;
    };
    await eventually('fake session', () => !!session());
    let serial = 0;
    const say = (role: 'user' | 'assistant', text: string) => {
      const s = session()!;
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
    const font = fs.existsSync(FONT) ? fs.readFileSync(FONT) : null;
    const newContext = async (
      opts: Parameters<Browser['newContext']>[0],
    ): Promise<BrowserContext> => {
      const ctx = await browser!.newContext(opts);
      if (font)
        await ctx.route('**/__g2/malgun.ttf', (route) =>
          route.fulfill({ body: font, contentType: 'font/ttf' }),
        );
      // The external site is a stub: nothing leaves this machine.
      await ctx.route('https://example.test/**', (route) =>
        route.fulfill({ body: '<title>external</title>EXTERNAL SITE', contentType: 'text/html' }),
      );
      return ctx;
    };

    const run = async (
      label: 'desktop' | 'phone',
      ctx: BrowserContext,
      tap: (p: Page, name: RegExp | string, scope?: 'list') => Promise<void>,
    ) => {
      const page = await ctx.newPage();
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS });
      const appUrl = page.url();
      say('user', `${label}: start`);
      say(
        'assistant',
        `${label}: see [docs-${label}](${EXTERNAL}) and [bad](javascript:window.__pwned=1) and https://example.test/bare-${label}`,
      );
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      await tap(page, /^메신저/);
      await tap(page, /^alpha/, 'list');
      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      const link = conv.getByRole('link', { name: `docs-${label}` });
      await link.waitFor({ timeout: 15_000 });
      await page.evaluate(() => {
        (window as unknown as { __alive: boolean }).__alive = true;
      });
      await page.screenshot({ path: path.join(OUT, `${label}-1-message.png`) });

      // 1. The external link opens a new page; the app page stays and is not navigated.
      const popupPromise = ctx.waitForEvent('page', { timeout: 10_000 });
      if (label === 'phone') await link.tap();
      else await link.click();
      const popup = await popupPromise;
      await popup.waitForLoadState();
      check(popup.url() === EXTERNAL, `${label}: the link opened ${popup.url()} in a new page`);
      check(
        (await popup.evaluate(() => window.opener)) === null,
        `${label}: the new page has no opener`,
      );
      check(page.url() === appUrl, `${label}: the app page stayed at its own address`);
      check(
        await page.evaluate(() => (window as unknown as { __alive?: boolean }).__alive === true),
        `${label}: the app page did not reload`,
      );
      await popup.screenshot({ path: path.join(OUT, `${label}-2-new-page.png`) });
      await popup.close();

      // 2. Another scheme is refused: nothing runs, nothing opens, the app stays.
      const refused = await page.evaluate(() => {
        const out: Record<string, boolean> = {};
        for (const href of [
          'javascript:window.__pwned=1',
          'data:text/html,PWNED',
          'file:///etc/hostname',
          'cld-custom://x',
        ]) {
          const a = document.createElement('a');
          a.href = href;
          a.textContent = 'x';
          document.body.append(a);
          const event = new MouseEvent('click', { bubbles: true, cancelable: true });
          a.dispatchEvent(event);
          out[href] = event.defaultPrevented;
          a.remove();
        }
        return out;
      });
      check(
        Object.values(refused).every(Boolean),
        `${label}: javascript:, data:, file: and custom links are refused (${JSON.stringify(refused)})`,
      );
      check(
        !(await page.evaluate(
          () => 'x' in window && (window as unknown as { __pwned?: number }).__pwned,
        )),
        `${label}: no javascript: link ran`,
      );
      check(
        ctx.pages().length === 1 && page.url() === appUrl,
        `${label}: nothing opened and the app stayed`,
      );
      // A same-origin link is left to the browser (not prevented).
      const same = await page.evaluate(() => {
        const a = document.createElement('a');
        a.href = '#same-origin';
        document.body.append(a);
        const event = new MouseEvent('click', { bubbles: true, cancelable: true });
        a.dispatchEvent(event);
        a.remove();
        return event.defaultPrevented;
      });
      check(!same, `${label}: a same-origin link is not intercepted`);

      // 3. Pull-down gesture and page-level rules.
      const rules = await page.evaluate(() => {
        return {
          htmlOverscroll: getComputedStyle(document.documentElement).overscrollBehaviorY,
          bodyOverscroll: getComputedStyle(document.body).overscrollBehaviorY,
          touch: getComputedStyle(document.documentElement).touchAction,
          canvasTouch: getComputedStyle(document.querySelector('canvas')!).touchAction,
        };
      });
      console.log(`${label} rules: ${JSON.stringify(rules)}`);
      check(
        rules.htmlOverscroll === 'none' && rules.bodyOverscroll === 'none',
        `${label}: the page has overscroll-behavior none`,
      );
      check(
        rules.touch === 'manipulation' && rules.canvasTouch === 'none',
        `${label}: touch-action manipulation on the page, none on the office canvas`,
      );
      if (label === 'phone') {
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Input.synthesizeScrollGesture', {
          x: 200,
          y: 200,
          yDistance: 400,
          speed: 1200,
          gestureSourceType: 'touch',
        });
        await wait(600);
        check(
          await page.evaluate(() => (window as unknown as { __alive?: boolean }).__alive === true),
          'phone: a long pull-down did not reload the app',
        );
        check(
          await page.evaluate(
            () =>
              document.scrollingElement!.scrollTop === 0 && window.visualViewport!.pageTop === 0,
          ),
          'phone: the page did not move under the pull-down',
        );
      }
      await page.screenshot({ path: path.join(OUT, `${label}-3-after.png`) });

      // 4. The manifest: every icon loads, one is maskable, paths stay relative.
      const manifest = await page.evaluate(async () => {
        const m = (await (await fetch('./manifest.webmanifest')).json()) as {
          icons: { src: string; purpose?: string }[];
          start_url: string;
          scope: string;
        };
        const icons = await Promise.all(
          m.icons.map(async (i) => ({
            src: i.src,
            purpose: i.purpose,
            ok: (await fetch(new URL(i.src, new URL('./manifest.webmanifest', location.href)))).ok,
          })),
        );
        return { icons, start: m.start_url, scope: m.scope };
      });
      check(
        manifest.icons.every((i) => i.ok) &&
          manifest.icons.some((i) => i.purpose === 'maskable') &&
          manifest.start === './' &&
          manifest.scope === './',
        `${label}: manifest icons load, one is maskable, start_url and scope are relative`,
      );
    };

    const desk = await newContext({ viewport: { width: 1400, height: 900 } });
    await run('desktop', desk, async (page, name, scope) => {
      const where =
        scope === 'list'
          ? page
              .getByRole('region', { name: '메신저', exact: true })
              .getByRole('list', { name: '연락처' })
          : page;
      await where.getByRole('button', { name }).first().click();
    });
    await desk.close();
    const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 13'];
    const phone = await newContext(iphone);
    await run('phone', phone, async (page, name, scope) => {
      const where =
        scope === 'list'
          ? page
              .getByRole('region', { name: '메신저', exact: true })
              .getByRole('list', { name: '연락처' })
          : page;
      await where.getByRole('button', { name }).first().tap();
    });
    await phone.close();
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
