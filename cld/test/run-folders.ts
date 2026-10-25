/**
 * T-0032 visual check: dist/cli.js on a spare port with an isolated HOME and
 * the engine's fake `claude` (one registered project, alpha),
 * --engine on --allow-actions, and a fake host through CLD_GUI_TEST_HOST.
 *
 * WSL host (its /mnt drives are temp folders): on a 1280×800 desktop, the one
 * 오케스트레이터 추가 (the engine's), the 엔진 badge,
 * the folder written the WSL way (`D:\…` -> /mnt/d, the Windows path under
 * it, the slow-drive warning), the folder picker (home and drive roots, hidden
 * folders, Escape closes only the picker), choosing a folder and adding it:
 * an engineAction. Then a 393×852 phone with iPhone
 * Home-Screen insets (--cld-safe-*): the picker and the form clear of the
 * inset strips, choose, add. macOS host (case-insensitive): the default
 * folder.
 * Screenshots into cld/artifacts/t0032/, Hangul from malgun.ttf (read only).
 *
 *   npx tsx cld/test/run-folders.ts <port 18256-18259>
 */
import type { Browser, Locator, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { WARN_MNT } from '../../core/src/cld/projectPath.js';
import {
  assertPortFree,
  type Daemon,
  FAKE_CLAUDE,
  killFakeSessions,
  launchBrowser,
  makeFakeHome,
  openOfficeWindow,
  REPO_ROOT,
  sparePort,
  startDaemon,
  writeEngineProjects,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0032');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0032/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 240_000;
const INSETS = { top: 59, bottom: 34 };
const ADD = '오케스트레이터 추가';

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

/** T-0008's rule: nothing tappable or text-bearing in an inset strip. */
function stripViolations(page: Page): Promise<{ checked: number; out: string[] }> {
  return page.evaluate((ins) => {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const out: string[] = [];
    let checked = 0;
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (el.closest('[data-testid="agent-overlay"], [data-testid="ez-mood"], canvas')) continue;
      const tappable = el.matches(
        'button, a[href], input, select, textarea, [role="button"], [role="tab"]',
      );
      const texty = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent?.trim());
      if (!tappable && !texty) continue;
      const style = getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') {
        continue;
      }
      const r = el.getBoundingClientRect();
      let [x0, x1, y0, y1] = [
        Math.max(r.left, 0),
        Math.min(r.right, W),
        Math.max(r.top, 0),
        Math.min(r.bottom, H),
      ];
      for (let a = el.parentElement; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const c = a.getBoundingClientRect();
        [x0, x1, y0, y1] = [
          Math.max(x0, c.left),
          Math.min(x1, c.right),
          Math.max(y0, c.top),
          Math.min(y1, c.bottom),
        ];
      }
      if (x1 - x0 < 1 || y1 - y0 < 1) continue;
      checked += 1;
      const hits = [y0 < ins.top && 'top', y1 > H - ins.bottom && 'bottom'].filter(Boolean);
      if (hits.length) {
        const what = (el.textContent ?? '').trim().slice(0, 24) || el.tagName;
        out.push(
          `${hits.join('+')}: <${el.tagName.toLowerCase()}> "${what}" y ${Math.round(y0)}-${Math.round(y1)}`,
        );
      }
    }
    return { checked, out };
  }, INSETS);
}

async function noStrips(page: Page, view: string): Promise<void> {
  const { checked, out } = await stripViolations(page);
  check(
    checked > 0 && out.length === 0,
    `inset strips empty (${view}, ${checked} on-screen elements)${out.map((l) => `\n  ${l}`).join('')}`,
  );
}

/** Fully inside the viewport and clear of the inset strips. */
async function onScreen(page: Page, loc: Locator, what: string): Promise<void> {
  await loc.scrollIntoViewIfNeeded(); // the engine form (model and effort choices) is taller than a phone
  const box = await loc.boundingBox();
  const { width, height } = page.viewportSize()!;
  check(
    !!box &&
      box.x >= 0 &&
      box.x + box.width <= width &&
      box.y >= INSETS.top &&
      box.y + box.height <= height - INSETS.bottom,
    `${what} on screen`,
  );
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  // The engine's stateful fake claude, and one registered project (alpha) to start from.
  const fake = makeFakeHome({ claude: null });
  const home = fake.home;
  fs.mkdirSync(path.join(home, 'bin'));
  fs.symlinkSync(path.join(FAKE_CLAUDE, 'engine.cjs'), path.join(home, 'bin/claude'));
  for (const d of [
    'projects/alpha-app',
    'projects/beta-lib',
    'projects/.cache',
    'mnt/c/Users/me/work',
    'mnt/d/data',
    'work/alpha',
  ])
    fs.mkdirSync(path.join(home, d), { recursive: true });
  writeEngineProjects(home, [{ name: 'alpha', folder: path.join(home, 'work/alpha') }]);
  const mnt = path.join(home, 'mnt');

  let daemon: Daemon | null = null;
  const serverLog: string[] = [];
  /** The daemon as `host` (CLD_GUI_TEST_HOST); resolves to a login URL. */
  const startAs = (host: Record<string, unknown>): Promise<string> => {
    daemon = startDaemon(
      { ...fake, claudePath: path.join(home, 'bin/claude') },
      port,
      ['--engine', 'on', '--no-terminal', '--allow-actions'],
      { CLD_GUI_TEST_HOST: JSON.stringify(host) },
    );
    return daemon.loginUrl();
  };
  const stopDaemon = async () => {
    const d = daemon;
    daemon = null;
    if (!d) return;
    await d.stop();
    serverLog.push(...d.log);
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    daemon?.child.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  const sent: Array<Record<string, unknown>> = [];
  const received: Array<Record<string, unknown>> = [];
  let browser: Browser | undefined;
  let font: Buffer | undefined;
  const open = async (opts: Parameters<Browser['newContext']>[0]) => {
    const ctx = await browser!.newContext(opts);
    // T-0029: the 현황판 folds rooms and orchestrators; these checks press
    // buttons inside the cards, so a fresh profile starts with all open (모두 펼치기).
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('cld.status-tree'))
        localStorage.setItem('cld.status-tree', '{"rooms":true,"orchs":true}');
    });
    await ctx.route('**/__t0032/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    const page = await ctx.newPage();
    page.on('websocket', (ws) => {
      const log = (into: typeof sent) => (f: { payload: string | Buffer }) => {
        try {
          into.push(JSON.parse(String(f.payload)) as Record<string, unknown>);
        } catch {
          /* binary */
        }
      };
      ws.on('framesent', log(sent));
      ws.on('framereceived', log(received));
    });
    return { ctx, page };
  };
  const hangul = async (page: Page, insets?: typeof INSETS) => {
    await page.addStyleTag({ content: FONT_CSS });
    if (insets) {
      await page.addStyleTag({
        content: `:root { --cld-safe-top: ${insets.top}px !important; --cld-safe-bottom: ${insets.bottom}px !important; }
          .t0032-strip { position: fixed; left: 0; right: 0; z-index: 2147483647; pointer-events: none; background: rgba(255, 0, 64, 0.3); }`,
      });
      await page.evaluate((ins) => {
        for (const [edge, px] of Object.entries(ins)) {
          const strip = document.createElement('div');
          strip.className = 't0032-strip';
          strip.style.cssText = `${edge}: 0; height: ${px}px;`;
          document.body.append(strip);
        }
      }, insets);
    }
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
  };
  const card = (scope: Locator, page: Page, name: string) =>
    scope.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const actions = (type: string) => sent.filter((m) => m.type === type);
  const toast = (page: Page, text: string) =>
    page.getByRole('status').filter({ hasText: text }).waitFor({ timeout: 15_000 });
  const notes = (form: Locator) =>
    form
      .locator('p')
      .allTextContents()
      .then((t) => t.map((s) => s.trim()));

  try {
    font = fs.readFileSync(FONT);
    browser = await launchBrowser();

    // ── WSL host, desktop ──
    let loginUrl = await startAs({ os: 'wsl', distro: 'TestDistro', mnt });
    const { ctx: desk, page } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await openOfficeWindow(page); // T-0108: a desktop starts with icons only
    await hangul(page);
    const drawer = page.getByRole('complementary', { name: '사무실 정보' });
    const addButton = drawer.getByRole('button', { name: ADD, exact: true });
    await addButton.waitFor();
    await card(drawer, page, 'alpha').waitFor();
    await page.waitForTimeout(1000);
    check((await page.getByRole('button', { name: ADD }).count()) === 1, 'one 오케스트레이터 추가');
    check(
      (await page.getByRole('button', { name: /프로젝트 추가/ }).count()) === 0,
      'no 프로젝트 추가 left',
    );
    const hostInfo = received.find((m) => m.type === 'hostInfo');
    check(
      hostInfo?.os === 'wsl' && hostInfo.distro === 'TestDistro' && hostInfo.home === home,
      'hostInfo arrived once logged in',
    );
    const alphaCard = card(drawer, page, 'alpha');
    check(
      (await alphaCard.getByText('엔진', { exact: true }).count()) === 1 &&
        (await alphaCard.getByRole('button', { name: '설정', exact: true }).count()) === 1 &&
        (await alphaCard.getByRole('button', { name: '삭제', exact: true }).count()) === 1,
      'an existing engine project: 엔진 badge, 설정 and 삭제',
    );
    await shot(page, 'desktop-cards');

    await addButton.click();
    const form = page.getByRole('form', { name: ADD });
    await form.waitFor();
    const folder = form.getByLabel('폴더');
    check((await folder.inputValue()) === '~/projects', 'the folder starts at ~/projects (WSL)');
    check(
      (await notes(form)).includes(
        `\\\\wsl.localhost\\TestDistro${home.replace(/\//g, '\\')}\\projects`,
      ),
      'under it: the Windows path of the WSL folder',
    );
    check(
      (await form.getByRole('radio').count()) === 0 &&
        !(await form.textContent())?.includes('실행 방식'),
      'no provider choice: engine only',
    );
    await shot(page, 'desktop-form');
    await folder.fill('D:\\data');
    const wslNotes = await notes(form);
    check(
      wslNotes.includes(`→ ${mnt}/d/data`) &&
        wslNotes.includes('D:\\data') === false &&
        wslNotes.some((n) => n.includes(WARN_MNT)),
      'D:\\data -> the /mnt/d folder, with the slow-drive warning',
    );
    await shot(page, 'desktop-form-windows-drive');

    // The picker, from the default folder.
    await folder.fill('~/projects');
    await form.getByRole('button', { name: '찾아보기', exact: true }).click();
    const picker = page.getByLabel('폴더 고르기', { exact: true }).last();
    const sub = picker.getByRole('list', { name: '하위 폴더' });
    await sub.getByRole('button', { name: '▸ alpha-app' }).waitFor();
    const list = async () => (await sub.getByRole('button').allTextContents()).map((s) => s.trim());
    check(
      JSON.stringify(await list()) === JSON.stringify(['▸ alpha-app', '▸ beta-lib']),
      'the picker lists the folders, no dot folder, no file',
    );
    const roots = (await picker.locator('button').allTextContents()).map((s) => s.trim());
    check(
      ['홈', 'C:', 'D:'].every((r) => roots.includes(r)),
      'roots: home and the /mnt drives',
    );
    await picker.getByLabel('숨김 폴더').check();
    await sub.getByRole('button', { name: '▸ .cache' }).waitFor();
    check(true, 'hidden folders when asked');
    await picker.getByLabel('숨김 폴더').uncheck();
    await sub.getByRole('button', { name: '▸ .cache' }).waitFor({ state: 'detached' });
    await sub.getByRole('button', { name: '▸ alpha-app' }).waitFor();
    await shot(page, 'desktop-picker');
    await picker.getByRole('button', { name: 'C:', exact: true }).click();
    await sub.getByRole('button', { name: '▸ Users' }).waitFor();
    check(
      (await picker.textContent())?.includes(WARN_MNT),
      'a drive in the picker: the slow-drive warning',
    );
    await shot(page, 'desktop-picker-drive');
    await page.keyboard.press('Escape');
    await picker.waitFor({ state: 'detached' });
    check(await form.isVisible(), 'Escape closes the picker only');
    await form.getByRole('button', { name: '찾아보기', exact: true }).click();
    await sub.getByRole('button', { name: '▸ alpha-app' }).click();
    await picker.getByText(path.join(home, 'projects/alpha-app'), { exact: true }).waitFor();
    await picker.getByRole('button', { name: '이 폴더 선택', exact: true }).click();
    await picker.waitFor({ state: 'detached' });
    check(
      (await folder.inputValue()) === path.join(home, 'projects/alpha-app') &&
        (await form.getByLabel('이름').inputValue()) === 'alpha-app',
      'choosing fills the folder, and the name follows it',
    );
    await shot(page, 'desktop-form-chosen');
    await form.getByRole('button', { name: '추가', exact: true }).click();
    await toast(page, '추가했어요');
    const added = actions('engineAction').at(-1);
    check(
      added?.action === 'add' &&
        added.name === 'alpha-app' &&
        added.folder === path.join(home, 'projects/alpha-app'),
      'added through an engineAction',
    );
    const newCard = card(drawer, page, 'alpha-app');
    await newCard.getByRole('button', { name: '켜기', exact: true }).waitFor();
    check(
      (await newCard.getByText('엔진', { exact: true }).count()) === 1,
      'the new card: 엔진 badge',
    );
    await newCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot(page, 'desktop-added');

    // ── WSL host, phone with iPhone Home-Screen insets ──
    const { page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      storageState: await desk.storageState(),
    });
    await phone.goto(`http://127.0.0.1:${port}/`);
    await hangul(phone, INSETS);
    await phone
      .locator('[data-hud-id^="icon:"]')
      .getByRole('button', { name: '현황판', exact: true })
      .click();
    const panel = phone.getByLabel('현황판 화면');
    const padd = panel.getByRole('button', { name: ADD, exact: true });
    await padd.waitFor();
    check((await phone.getByRole('button', { name: ADD }).count()) === 1, 'phone: one add button');
    await padd.tap();
    const pform = phone.getByRole('form', { name: ADD });
    await pform.getByRole('button', { name: '찾아보기', exact: true }).tap();
    const ppicker = phone.getByLabel('폴더 고르기', { exact: true }).last();
    const psub = ppicker.getByRole('list', { name: '하위 폴더' });
    await psub.getByRole('button', { name: '▸ beta-lib' }).waitFor();
    await phone.waitForTimeout(300);
    await shot(phone, 'phone-picker');
    await noStrips(phone, 'picker');
    await onScreen(
      phone,
      ppicker.getByRole('button', { name: '이 폴더 선택' }),
      'its 이 폴더 선택',
    );
    await psub.getByRole('button', { name: '▸ beta-lib' }).tap();
    await ppicker.getByText(path.join(home, 'projects/beta-lib'), { exact: true }).waitFor();
    await ppicker.getByRole('button', { name: '이 폴더 선택', exact: true }).tap();
    await ppicker.waitFor({ state: 'detached' });
    await shot(phone, 'phone-form');
    await noStrips(phone, 'form');
    await onScreen(phone, pform.getByRole('button', { name: '추가', exact: true }), 'its 추가');
    await pform.getByRole('button', { name: '추가', exact: true }).tap();
    await toast(phone, '추가했어요');
    check(actions('engineAction').at(-1)?.name === 'beta-lib', 'phone: added through engineAction');
    const pcard = card(panel, phone, 'beta-lib');
    await pcard.waitFor();
    await pcard.scrollIntoViewIfNeeded();
    await phone.waitForTimeout(300);
    await shot(phone, 'phone-added');
    await desk.close();

    // ── macOS host (case-insensitive) ──
    await stopDaemon();
    loginUrl = await startAs({ os: 'darwin', caseInsensitive: true });
    const { page: mac } = await open({ viewport: { width: 1280, height: 800 } });
    await mac.goto(loginUrl);
    await mac.waitForURL(`http://127.0.0.1:${port}/`);
    await openOfficeWindow(mac); // T-0108: a desktop starts with icons only
    await hangul(mac);
    const mdrawer = mac.getByRole('complementary', { name: '사무실 정보' });
    await mdrawer.getByRole('button', { name: ADD, exact: true }).click();
    const mform = mac.getByRole('form', { name: ADD });
    check(
      (await mform.getByLabel('폴더').inputValue()) === `${home}/projects`,
      'macOS: the folder starts at <home>/projects',
    );
    fs.writeFileSync(
      path.join(OUT, 'ws-engine-actions.json'),
      `${JSON.stringify(actions('engineAction'), null, 1).replaceAll(home, '<fake-home>')}\n`,
    );
    fs.writeFileSync(
      path.join(OUT, 'ws-list-folders.json'),
      `${JSON.stringify(
        received.filter((m) => m.type === 'folderList'),
        null,
        1,
      ).replaceAll(home, '<fake-home>')}\n`,
    );
  } finally {
    await browser?.close();
    await stopDaemon();
    clearTimeout(deadline);
    fs.writeFileSync(
      path.join(OUT, 'server-log.txt'),
      serverLog
        .join('')
        .replaceAll(home, '<fake-home>')
        .replace(/code=[^\s&]+/g, 'code=<redacted>'),
    );
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
