/**
 * PHONE-CLIP (owner 11-01 02:50 / 03:13): the phone's bottom edge in every iPhone mode.
 *
 * An installed iPhone app sometimes comes up with a layout viewport 47 px (the top inset) short of
 * the screen (390x797 of 390x844). WebKit paints nothing of the page past that viewport, only the
 * document's own background (the owner's screenshots: every box ends at exactly 797 px, #181828
 * below). So nothing may be laid out past innerHeight, and the band under it can only be given the
 * Dock's colour; the home indicator lies inside that band, so the Dock pads none of it.
 *
 * Playwright emulates neither the insets, the Home-Screen mode nor the software keyboard; they are
 * emulated the way the app reads them: the --agty-safe-* variables, `navigator.standalone` with
 * `screen.height`, and an iOS keyboard as a visualViewport that shrinks while innerHeight stays.
 *
 * Modes: app-short (WebKit, 390x797 of 844, standalone), app-full (WebKit, 390x844 standalone),
 * tab (WebKit, Safari tab 390x664 of 844), android (Chromium, 360x740, resizes-content keyboard).
 * In each: the office (Dock buttons inside the painted area, the gap under them), the roster
 * handle's place in its three states (left, clear of the joystick and 자동/로비), the messenger with
 * a long draft (composer above the Dock) and with the keyboard up (composer above the keys).
 *
 *   npx tsx agent-tycoon/test/run-phone-clip.ts <port 18262|18263> [--stage before|after|cause]
 *
 * Screenshots go to agent-tycoon/artifacts/phone-clip/<stage>-<mode>-*.png. Exits 1 on the first failed check.
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { transcriptPath } from '../../server/src/agent-tycoon/providers/claudeProvider.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
const stageArg = process.argv.indexOf('--stage');
const STAGE = stageArg > 0 ? process.argv[stageArg + 1] : 'after';
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/phone-clip');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const HANGUL = 'unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3;';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__clip/malgun.ttf'); ${HANGUL} }`;
const DEADLINE_MS = 360_000;
const LEADS = ['alpha', 'beta'];
/** The iPhone 13's software keyboard with its accessory bar (owner's screenshot: 367 px). */
const IOS_KEYBOARD_PX = 367;
const ANDROID_KEYBOARD_PX = 300;
/** Safari's bottom toolbar a tab gives up while typing (the tab's keys sit that much lower). */
const TAB_TOOLBAR_PX = 80;
const DRAFT = Array.from(
  { length: 9 },
  (_, i) => `${i + 1}번째 줄: 긴 초안이 몇 줄이나 보이나`,
).join('\n');

interface Mode {
  name: string;
  webkit: boolean;
  ctx: BrowserContextOptions;
  standalone: boolean;
  top: number;
  bottom: number;
  /** iOS: only the visual viewport shrinks; Android: the layout viewport resizes too. */
  keyboard: 'ios' | 'android';
}
const iphone = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();
const MODES: Mode[] = [
  {
    name: 'app-short',
    webkit: true,
    ctx: { ...iphone, viewport: { width: 390, height: 797 }, screen: { width: 390, height: 844 } },
    standalone: true,
    top: 47,
    bottom: 34,
    keyboard: 'ios',
  },
  {
    name: 'app-full',
    webkit: true,
    ctx: { ...iphone, viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 } },
    standalone: true,
    top: 47,
    bottom: 34,
    keyboard: 'ios',
  },
  {
    name: 'tab',
    webkit: true,
    ctx: { ...iphone, viewport: { width: 390, height: 664 }, screen: { width: 390, height: 844 } },
    standalone: false,
    top: 0,
    bottom: 0,
    keyboard: 'ios',
  },
  {
    name: 'android',
    webkit: false,
    ctx: {
      viewport: { width: 360, height: 740 },
      screen: { width: 360, height: 800 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      userAgent: devices['Pixel 5'].userAgent,
    },
    standalone: false,
    top: 24,
    bottom: 16,
    keyboard: 'android',
  },
];

let failed = 0;
function check(ok: unknown, what: string): void {
  if (!ok) {
    failed++;
    console.log(`FAIL - ${what}`);
  } else console.log(`ok - ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Box = { x: number; y: number; width: number; height: number } | null;
const apart = (a: Box, b: Box) =>
  !a ||
  !b ||
  a.x + a.width <= b.x ||
  b.x + b.width <= a.x ||
  a.y + a.height <= b.y ||
  b.y + b.height <= a.y;

/** The office: the Dock's buttons lie inside the painted viewport, and what is under them. */
async function officeChecks(page: Page, m: Mode): Promise<void> {
  const r = await page.evaluate(() => {
    const nav = document.querySelector('[data-testid="mobile-dock"]')!;
    const band = document.querySelector('[data-testid="mobile-bottom"]')!;
    const buttons = [...nav.querySelectorAll('button')].map((b) => b.getBoundingClientRect());
    const css = getComputedStyle(document.documentElement);
    return {
      inner: innerHeight,
      top: Math.min(...buttons.map((b) => b.top)),
      last: Math.max(...buttons.map((b) => b.bottom)),
      band: band.getBoundingClientRect().bottom,
      inset: parseFloat(css.getPropertyValue('--agty-safe-bottom')) || 0,
      pageBg: css.backgroundColor,
      bandBg: getComputedStyle(band).backgroundColor,
    };
  });
  check(
    r.top >= 0 && r.last <= r.inner,
    `${m.name} office: every Dock button is inside the ${r.inner}px viewport (${Math.round(r.top)}-${Math.round(r.last)})`,
  );
  check(
    Math.abs(r.band - r.inner) <= 1,
    `${m.name} office: the Dock's band ends at the viewport's bottom (${Math.round(r.band)})`,
  );
  // Under the icons: the inset where the home indicator is inside the viewport, else only the band's 4 px.
  const short = m.standalone && (m.ctx.screen?.height ?? 0) - r.inner === m.top;
  const want = short ? 4 : Math.max(4, m.bottom);
  const gap = Math.round(r.inner - r.last);
  check(
    Math.abs(gap - want) <= 1,
    `${m.name} office: ${gap}px under the Dock icons (want ${want}${short ? ': the home indicator is below the viewport' : ''})`,
  );
  if (short)
    check(
      r.pageBg === r.bandBg,
      `${m.name} office: the band under the viewport has the Dock's colour (page ${r.pageBg}, Dock ${r.bandBg})`,
    );
}

/** The roster's toggle in every state: in the left part, clear of the joystick and 자동/로비. */
async function handleChecks(page: Page, m: Mode): Promise<void> {
  const bar = page.getByTestId('mobile-agent-bar');
  const toggle = page.getByTestId('cards-toggle');
  const W = m.ctx.viewport!.width;
  for (let i = 0; i < 3; i++) {
    const state = await bar.getAttribute('data-roster-state');
    await page.waitForTimeout(400);
    const [h, j, c] = await Promise.all([
      toggle.boundingBox(),
      page
        .getByTestId('joystick')
        .count()
        .then((n) => (n ? page.getByTestId('joystick').boundingBox() : null)),
      page.getByTestId('camera-modes').boundingBox(),
    ]);
    check(
      !!h && h.x >= 0 && h.x + h.width <= W / 3,
      `${m.name} roster ${state}: the toggle is on the left (x ${h && Math.round(h.x)}-${h && Math.round(h.x + h.width)} of ${W})`,
    );
    check(
      apart(h, j) && apart(h, c),
      `${m.name} roster ${state}: the toggle covers neither the joystick (${j ? 'shown' : 'not shown'}) nor 자동/로비`,
    );
    await page.screenshot({ path: path.join(OUT, `${STAGE}-${m.name}-roster-${state}.png`) });
    await toggle.tap();
  }
}

/**
 * The keyboard as the owner's iPhone reports it (11-01 02:50: the composer box was a third of 477 px,
 * so innerHeight and visualViewport.height both read the 477 px above the keys, and the shell was not
 * clamped): both getters shrink, only visualViewport fires. iOS then pans the page to bring the field
 * above the keys, but never past the layout viewport's bottom. Android resizes the layout viewport.
 * Returns the keys' top; a grey box stands for the keys in the picture.
 */
async function keyboardUp(page: Page, m: Mode): Promise<number> {
  const H = m.ctx.viewport!.height;
  const keysTop =
    m.keyboard === 'android'
      ? H - ANDROID_KEYBOARD_PX
      : Math.min(H, (m.standalone ? m.ctx.screen!.height : H + TAB_TOOLBAR_PX) - IOS_KEYBOARD_PX);
  if (m.keyboard === 'android')
    await page.setViewportSize({ width: m.ctx.viewport!.width, height: keysTop });
  else
    await page.evaluate((h) => {
      const vv = window.visualViewport!;
      Object.defineProperty(vv, 'height', { configurable: true, get: () => h });
      Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => h });
      vv.dispatchEvent(new Event('resize'));
    }, keysTop);
  await page.waitForTimeout(600);
  return keysTop;
}

/** iOS's pan: up to the field's bottom, at most to the layout viewport's bottom. Drawn as a shift. */
async function iosPan(page: Page, fieldBottom: number, keysTop: number): Promise<number> {
  const layoutBottom = await page.evaluate(() => document.documentElement.clientHeight);
  const pan = Math.max(0, Math.min(fieldBottom - keysTop, layoutBottom - keysTop));
  await page.evaluate(
    ({ pan, keysTop }) => {
      document.getElementById('root')!.style.transform = `translateY(${-pan}px)`;
      const k = document.createElement('div');
      k.style.cssText = `position:fixed;left:0;right:0;top:${keysTop}px;bottom:0;background:var(--color-text-muted);opacity:.85;z-index:2147483647;pointer-events:none`;
      document.body.appendChild(k);
    },
    { pan, keysTop },
  );
  return pan;
}

async function messengerChecks(page: Page, m: Mode): Promise<void> {
  await page.locator('[data-dock="messenger"]').tap();
  const pm = page.getByRole('region', { name: '메신저', exact: true });
  await pm
    .getByRole('list', { name: '연락처' })
    .getByRole('button', { name: /^alpha/ })
    .tap();
  const conv = pm.getByRole('region', { name: 'alpha 대화' });
  await conv.getByText('alpha 24번째 메시지').waitFor();
  const box = conv.getByRole('textbox', { name: '보낼 글' });
  await box.fill(DRAFT);
  const composer = () =>
    box.evaluate((el) => {
      const form = el.closest('form')!;
      const rects = [el, ...form.querySelectorAll('button')].map((e) => e.getBoundingClientRect());
      const dock = document.querySelector('[data-testid="mobile-bottom"]');
      return {
        top: Math.min(...rects.map((r) => r.top)),
        bottom: Math.max(...rects.map((r) => r.bottom)),
        boxBottom: el.getBoundingClientRect().bottom,
        dockTop: dock ? dock.getBoundingClientRect().top : null,
        inner: innerHeight,
      };
    });
  await page.waitForTimeout(400);
  const closed = await composer();
  check(
    closed.dockTop !== null && closed.bottom <= closed.dockTop + 1 && closed.bottom <= closed.inner,
    `${m.name} messenger: the composer (box and buttons, bottom ${Math.round(closed.bottom)}) ends above the Dock (${closed.dockTop && Math.round(closed.dockTop)})`,
  );
  await page.screenshot({ path: path.join(OUT, `${STAGE}-${m.name}-messenger.png`) });
  await box.tap();
  const keysTop = await keyboardUp(page, m);
  const open = await composer();
  const pan = m.keyboard === 'ios' ? await iosPan(page, open.boxBottom, keysTop) : 0;
  check(
    open.top - pan >= 0 && open.bottom - pan <= keysTop + 1,
    `${m.name} keyboard: the whole composer (${Math.round(open.top - pan)}-${Math.round(open.bottom - pan)} on screen, panned ${pan}) is above the keys (${keysTop})`,
  );
  await page.screenshot({ path: path.join(OUT, `${STAGE}-${m.name}-keyboard.png`) });
}

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
  const folders = Object.fromEntries(LEADS.map((n) => [n, path.join(home, 'work', n)]));
  for (const f of Object.values(folders)) fs.mkdirSync(f, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(
      LEADS.map((name) => ({ name, folder: folders[name], room: '개발실', wantRunning: true })),
    ),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '600', SHELL: '/bin/sh' },
  );
  const server = daemon.child;
  const cleanup = () => {
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    cleanup();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  type Sess = { pid: number; sessionId: string; cwd: string; name: string };
  const sessionOf = (name: string): Sess | null => {
    for (const f of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Sess;
        if (s.name === name) return s;
      } catch {
        /* being written */
      }
    }
    return null;
  };
  let uuid = 0;
  const say = (name: string, role: 'user' | 'assistant', text: string) => {
    const s = sessionOf(name)!;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const timestamp = new Date().toISOString();
    const message =
      role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] };
    fs.appendFileSync(file, `${JSON.stringify({ type: role, uuid: id, timestamp, message })}\n`);
  };

  const browsers: Browser[] = [];
  try {
    const font = fs.readFileSync(FONT);
    const url = await daemon.loginUrl();
    for (const end = Date.now() + 40_000; LEADS.some((n) => !sessionOf(n));) {
      if (Date.now() > end) throw new Error('the engine did not revive the sessions');
      await sleep(300);
    }
    for (const n of LEADS)
      for (let i = 1; i <= 24; i++)
        say(n, i % 2 ? 'user' : 'assistant', `${n} ${i}번째 메시지: 오늘 할 일 정리`);
    await sleep(4_000);

    const wk = await launchBrowser({ webkit: true });
    const cr = await launchBrowser();
    browsers.push(wk, cr);
    let storageState: BrowserContextOptions['storageState'];
    for (const m of MODES) {
      const ctx = await (m.webkit ? wk : cr).newContext({ ...m.ctx, storageState });
      await ctx.route('**/__clip/malgun.ttf', (route) =>
        route.fulfill({ body: font, contentType: 'font/ttf' }),
      );
      await ctx.addInitScript('window.__name = (f) => f; window.__AGENT_TYCOON_E2E = true;');
      if (m.standalone)
        await ctx.addInitScript(
          "Object.defineProperty(navigator, 'standalone', { value: true, configurable: true });",
        );
      const page = await ctx.newPage();
      await page.goto(storageState ? `http://127.0.0.1:${port}/` : url);
      if (!storageState) await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: FONT_CSS });
      // The insets as the page's own variables (no !important: the app overrides them as it does env()).
      await page.addStyleTag({
        content: `:root { --agty-safe-top: ${m.top}px; --agty-safe-bottom: ${m.bottom}px; }`,
      });
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      await page.locator('[data-testid="agent-overlay"]').first().waitFor();
      await page.waitForTimeout(1_500);
      storageState ??= await ctx.storageState();
      // The update toast floats over the bottom of the office: dismiss it for the pictures.
      const notice = page.getByTestId('update-notice');
      if (await notice.count()) await notice.getByRole('button').last().tap();

      await officeChecks(page, m);
      await page.screenshot({ path: path.join(OUT, `${STAGE}-${m.name}-office.png`) });
      // A selected character brings the joystick (bottom-left) the toggle must clear.
      const id = Number(
        await page.locator('[data-testid="agent-overlay"]').first().getAttribute('data-agent-id'),
      );
      await page.evaluate((i) => {
        (
          window as unknown as { __agentTycoonTestHooks: { selectAgent: (n: number) => void } }
        ).__agentTycoonTestHooks.selectAgent(i);
      }, id);
      await page.getByTestId('joystick').waitFor({ timeout: 5_000 });
      await handleChecks(page, m);
      await messengerChecks(page, m);
      await ctx.close();
    }
  } finally {
    clearTimeout(deadline);
    for (const b of browsers) await b.close();
    await daemon.stop();
    cleanup();
  }
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
