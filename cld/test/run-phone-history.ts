/**
 * MOBILE-SWIPE (owner 11-01 16:12): on a phone the browser's Back and Forward (an edge swipe, a
 * back gesture) never leave the app or leave it frozen. history.back()/forward() several times
 * from the office, a messenger DM, an open attachment and the 개발실; a page back from the
 * back/forward cache (pageshow persisted, its socket closed without a close event) and a real
 * leave-and-return; after each, the app is on its own page and a new message still arrives.
 * The edge strips cancel a touchstart, a tap target in them is left alone.
 *
 * dist/cli.js --engine on --allow-chat --no-terminal in an isolated HOME (the engine fake as
 * `claude`), Chromium --disable-gpu, iPhone 13 viewport. Screenshots: cld/artifacts/mobile-swipe/.
 *
 *   npx tsx cld/test/run-phone-history.ts <port 18256-18269>
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
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

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/mobile-swipe');
const PNG = path.join(REPO_ROOT, 'webview-ui/public/assets/characters/char_0.png');
const DEADLINE_MS = 300_000;
const IPHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.writeFileSync(
    path.join(configDirectory(home), 'config.json'),
    JSON.stringify({ accessChosen: true, port }),
  );
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
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '600', SHELL: '/bin/sh' },
  );
  const cleanup = () => {
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (daemon.child.exitCode === null && daemon.child.signalCode === null)
      daemon.child.kill('SIGKILL');
    cleanup();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  type Sess = { sessionId: string; cwd: string; name: string };
  const session = (): Sess | null => {
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
  const say = (text: string) => {
    const s = session()!;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const message = { role: 'assistant', content: [{ type: 'text', text }] };
    const line = { type: 'assistant', uuid: id, timestamp: new Date().toISOString(), message };
    fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
  };

  const browser = await launchBrowser();
  try {
    const url = await daemon.loginUrl();
    for (const end = Date.now() + 40_000; !session(); await sleep(300))
      if (Date.now() > end) throw new Error('the engine did not revive alpha');
    say('첫 메시지');
    await sleep(2_000);

    const ctx = await browser.newContext(IPHONE);
    // Every socket the page opens, so a check can close one as a back/forward cache would.
    await ctx.addInitScript(`window.__name = (f) => f; window.__AGENT_TYCOON_E2E = true;
      window.__sockets = [];
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(...a) { super(...a); window.__sockets.push(this); }
      };`);
    const page: Page = await ctx.newPage();
    await page.goto(url);
    const APP = `http://127.0.0.1:${port}/`;
    await page.waitForURL(APP);
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.waitForTimeout(1_500);

    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const tab = () =>
      page.getByTestId('mobile-dock').locator('[aria-current="page"]').getAttribute('data-dock');
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    const conv = messenger.getByRole('region', { name: 'alpha 대화' });
    const where = () =>
      page.evaluate(() => ({ href: location.href, state: history.state as unknown }));
    /** history.back() or forward(), then a beat for the popstate and its re-render. */
    const nav = async (dir: 'back' | 'forward', times = 1) => {
      for (let i = 0; i < times; i++) {
        await page.evaluate((d) => (d === 'back' ? history.back() : history.forward()), dir);
        await page.waitForTimeout(400);
      }
    };
    /** On the app's own page, on the guard, the Dock on `want`, and a new message arrives. */
    let n = 0;
    /** `want` null: either (a reload starts on the office, the cache keeps the page). */
    const alive = async (want: string | null, label: string) => {
      const w = await where();
      check(
        w.href === APP && (w.state as Record<string, unknown> | null)?.cldTab === true,
        `${label}: still the app's page, our guard on top (${w.href} ${JSON.stringify(w.state)})`,
      );
      if (want) check((await tab()) === want, `${label}: the Dock is on ${want} (${await tab()})`);
      const text = `살아있음 ${++n}`;
      say(text);
      await page.getByTestId('mobile-dock').locator('[data-dock="messenger"]').tap();
      if (!(await conv.isVisible()))
        await messenger
          .getByRole('list', { name: '연락처' })
          .getByRole('button', { name: /^alpha/ })
          .tap();
      await conv.getByText(text).waitFor({ timeout: 15_000 });
      check(true, `${label}: a new message arrives and shows`);
    };
    const home = async () => {
      await page.getByTestId('mobile-dock').locator('[data-dock="office"]').tap();
      await page.waitForTimeout(300);
    };
    const openDm = async () => {
      await page.getByTestId('mobile-dock').locator('[data-dock="messenger"]').tap();
      if (!(await conv.isVisible()))
        await messenger
          .getByRole('list', { name: '연락처' })
          .getByRole('button', { name: /^alpha/ })
          .tap();
      await conv.waitFor();
    };

    // ── Office: a stray Back and Forward do nothing ──
    check((await where()).state && (await tab()) === 'office', 'load: the guard is on top at home');
    await nav('back', 3);
    await shot('01-office-after-3-back');
    await nav('forward', 3);
    await alive('office', 'office, 3 Back + 3 Forward');

    // ── Messenger DM: Back steps to the list, then home; more Back and Forward stay home ──
    await openDm();
    await nav('back');
    check(
      (await tab()) === 'messenger' && !(await conv.isVisible()),
      'DM: Back steps to the conversation list',
    );
    await nav('back');
    check((await tab()) === 'office', 'DM: a second Back goes home');
    await nav('back', 2);
    await nav('forward', 3);
    check((await tab()) === 'office', 'DM: more Back and Forward stay home');
    await shot('02-dm-back-forward');
    await alive('office', 'DM, Back x4 + Forward x3');

    // ── An attachment open: Back closes it, Forward does not step the DM back ──
    await openDm();
    await conv.locator('input[type="file"]').setInputFiles(PNG);
    const draft = conv.getByTestId('draft-open');
    await draft.waitFor();
    await page.waitForTimeout(600);
    await conv.getByRole('textbox', { name: '보낼 글' }).blur();
    await page.waitForTimeout(300);
    await draft.tap();
    const viewer = page.getByTestId('attach-viewer');
    await viewer.first().waitFor();
    await shot('03-attachment-open');
    await nav('back');
    check(
      (await viewer.count()) === 0 && (await conv.isVisible()),
      'attachment: Back closes the viewer, the DM stays',
    );
    await nav('forward', 2);
    check(
      (await viewer.count()) === 0 && (await conv.isVisible()),
      'attachment: Forward neither reopens it nor steps the DM back to the list',
    );
    await shot('04-attachment-forward');
    await alive('messenger', 'attachment, Back + Forward x2');

    // ── 개발실: Back goes home, Forward stays ──
    await page.getByTestId('mobile-dock').locator('[data-dock="devroom"]').tap();
    await page.waitForTimeout(300);
    await nav('back');
    check((await tab()) === 'office', '개발실: Back goes home');
    await nav('forward', 2);
    await shot('05-devroom-forward');
    await alive('office', '개발실, Back + Forward x2');

    // ── Back from the back/forward cache: the socket closed with no close event ──
    await openDm();
    await page.evaluate(() => {
      for (const ws of (window as unknown as { __sockets: WebSocket[] }).__sockets) {
        ws.onclose = ws.onerror = null;
        ws.close();
      }
    });
    await page.waitForTimeout(500);
    await page.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
    );
    await shot('06-bfcache-restore');
    await alive('messenger', 'pageshow persisted after a dead socket');

    // ── A real leave and return (whatever the browser does: its cache or a reload) ──
    await page.goto('about:blank');
    await page.goBack();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1_500);
    await shot('07-leave-and-return');
    await alive(null, 'left for another page and came back');
    await home();

    // ── The edge strips: a touchstart there is cancelled, a tap target in them is not ──
    const prevented = (x: number, y: number) =>
      page.evaluate(
        ([x, y]) => {
          const el = document.elementFromPoint(x, y)!;
          const t = new Touch({ identifier: 9, target: el, clientX: x, clientY: y });
          const ev = new TouchEvent('touchstart', {
            bubbles: true,
            cancelable: true,
            touches: [t],
            changedTouches: [t],
            targetTouches: [t],
          });
          el.dispatchEvent(ev);
          el.dispatchEvent(
            new TouchEvent('touchend', { bubbles: true, cancelable: true, changedTouches: [t] }),
          );
          return { prevented: ev.defaultPrevented, tag: el.tagName };
        },
        [x, y],
      );
    // In the DM (the office canvas cancels its own touches, so it would prove nothing).
    await openDm();
    const W = IPHONE.viewport!.width;
    const cb = (await conv.boundingBox())!;
    const mid = Math.round(cb.y + cb.height / 2);
    const left = await prevented(4, mid);
    const right = await prevented(W - 4, mid);
    const centre = await prevented(W / 2, mid);
    check(
      left.prevented && right.prevented,
      `edges: a touchstart in either strip is cancelled (${left.tag}, ${right.tag})`,
    );
    check(!centre.prevented, `edges: the middle of the screen is left alone (${centre.tag})`);
    const officeTab = page.getByTestId('mobile-dock').locator('[data-dock="office"]');
    const box = (await officeTab.boundingBox())!;
    const edgeX = Math.max(1, Math.min(10, box.x + 2));
    const onTab = await prevented(edgeX, box.y + box.height / 2);
    check(
      !onTab.prevented,
      `edges: a tap target at the edge (${onTab.tag} at x=${edgeX}) keeps its tap`,
    );
    await page.touchscreen.tap(edgeX, box.y + box.height / 2);
    await page.waitForTimeout(300);
    check((await tab()) === 'office', 'edges: a real tap on the Dock tab at the edge still works');
    await shot('08-edge-tap');
    console.log('ALL OK');
  } finally {
    clearTimeout(deadline);
    await browser.close();
    await daemon.stop();
    cleanup();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
