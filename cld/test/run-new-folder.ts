/**
 * T-0035 visual check: dist/cli.js on a spare port with an isolated HOME, the
 * engine's fake `claude`, a Linux host.
 *
 * Desktop 1280×800: the picker's 새 폴더 (a bad name is refused under the
 * input; nothing is created until 추가), a picker-new folder whose text is then
 * edited goes back to the 만들까요? question, and a picker-new folder is added
 * with mkdir at once (the folder exists, the card appears). Then 사무실 추가:
 * its title, the empty, required, focused 사무실 field with its hint and the
 * office list, 추가 disabled until named, and the new office with its first
 * orchestrator. A 393×852 phone does 사무실 추가 with a picker-new folder.
 * Screenshots into cld/artifacts/t0035/, Hangul from malgun.ttf (read only).
 *
 *   npx tsx cld/test/run-new-folder.ts <port 18256-18259>
 */
import type { Browser, Locator, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  FAKE_CLAUDE,
  killFakeSessions,
  launchBrowser,
  makeFakeHome,
  openOfficeWindow,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0035');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0035/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 240_000;
const ADD = '오케스트레이터 추가';
const OFFICE = '사무실 추가';
const HINT = '새 폴더예요. 추가하면 만들어요.';

/** Poll `probe` until true (the engineState message trails the toast under load). */
async function waitUntil(probe: () => unknown, ms = 15_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end && !probe();)
    await new Promise((r) => setTimeout(r, 200));
}

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: null });
  const home = fake.home;
  fs.mkdirSync(path.join(home, 'bin'));
  fs.symlinkSync(path.join(FAKE_CLAUDE, 'engine.cjs'), path.join(home, 'bin/claude'));
  fs.mkdirSync(path.join(home, 'projects/alpha-app'), { recursive: true });
  const projects = path.join(home, 'projects');

  const daemon = startDaemon(
    { ...fake, claudePath: path.join(home, 'bin/claude') },
    port,
    ['--engine', 'on', '--no-terminal', '--allow-actions'],
    { CLD_GUI_TEST_HOST: JSON.stringify({ os: 'linux', caseInsensitive: false }) },
  );
  const { child: server, log: serverLog } = daemon;
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    server.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  const sent: Array<Record<string, unknown>> = [];
  const received: Array<Record<string, unknown>> = [];
  let browser: Browser | undefined;
  const font = fs.readFileSync(FONT);
  const open = async (opts: Parameters<Browser['newContext']>[0]) => {
    const ctx = await browser!.newContext(opts);
    // T-0029: the 현황판 folds rooms and orchestrators; these checks press
    // buttons inside the cards, so a fresh profile starts with all open (모두 펼치기).
    await ctx.addInitScript(() => {
      if (!localStorage.getItem('cld.status-tree'))
        localStorage.setItem('cld.status-tree', '{"rooms":true,"orchs":true}');
    });
    await ctx.route('**/__t0035/malgun.ttf', (route) =>
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
  const hangul = async (page: Page) => {
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
  };
  const card = (scope: Locator, page: Page, name: string) =>
    scope.locator('article').filter({ has: page.getByRole('heading', { name, exact: true }) });
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const engineActions = () => sent.filter((m) => m.type === 'engineAction');
  const toast = (page: Page, text: string) =>
    page.getByRole('status').filter({ hasText: text }).waitFor({ timeout: 15_000 });
  const lastEngineState = () =>
    received.filter((m) => m.type === 'engineState').at(-1) as
      { projects: Array<{ name: string; room: string; folder: string }> } | undefined;
  /** The picker from `form`, 새 폴더 named `name`, 만들기. */
  const pickNew = async (page: Page, form: Locator, name: string, tap = false) => {
    const press = (l: Locator) => (tap ? l.tap() : l.click());
    await press(form.getByRole('button', { name: '찾아보기', exact: true }));
    const picker = page.getByLabel('폴더 고르기', { exact: true }).last();
    await picker
      .getByRole('list', { name: '하위 폴더' })
      .getByRole('button', { name: '▸ alpha-app' })
      .waitFor();
    await press(picker.getByRole('button', { name: '새 폴더', exact: true }));
    await picker.getByLabel('새 폴더 이름').fill(name);
    await press(picker.getByRole('button', { name: '만들기', exact: true }));
    await picker.waitFor({ state: 'detached' });
  };

  try {
    browser = await launchBrowser();
    const loginUrl = await daemon.loginUrl();

    // ── Desktop ──
    const { ctx: desk, page } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await openOfficeWindow(page); // T-0108: a desktop starts with icons only
    await hangul(page);
    const drawer = page.getByRole('complementary', { name: '사무실 정보' });
    await drawer.getByRole('button', { name: ADD, exact: true }).waitFor();
    check(
      (await drawer.getByRole('button', { name: OFFICE, exact: true }).count()) === 1,
      '사무실 추가 next to 오케스트레이터 추가',
    );
    check(
      (await page.getByRole('button', { name: '새 방', exact: true }).count()) === 0,
      'no button says 새 방 (it is 사무실)',
    );
    await shot(page, 'desktop-buttons');

    // 1. A bad name is refused in the picker; nothing is made.
    await drawer.getByRole('button', { name: ADD, exact: true }).click();
    const form = page.getByRole('form', { name: ADD });
    await form.waitFor();
    check((await form.getByLabel('사무실').count()) === 1, 'the field is labelled 사무실');
    await form.getByRole('button', { name: '찾아보기', exact: true }).click();
    const picker = page.getByLabel('폴더 고르기', { exact: true }).last();
    await picker.getByRole('button', { name: '▸ alpha-app' }).waitFor();
    await picker.getByRole('button', { name: '새 폴더', exact: true }).click();
    const nameInput = picker.getByLabel('새 폴더 이름');
    check(
      await nameInput.evaluate((el) => el === document.activeElement),
      'the new-folder name is focused',
    );
    for (const [bad, want] of [
      ['..', '. 이나 ..'],
      ['a/b', '/ 나'],
      ['', '입력해'],
    ]) {
      await nameInput.fill(bad);
      await picker.getByRole('button', { name: '만들기', exact: true }).click();
      check(
        (await picker.getByRole('alert').textContent())?.includes(want),
        `"${bad}" is refused under the input`,
      );
    }
    await nameInput.fill('..');
    await picker.getByRole('button', { name: '만들기', exact: true }).click();
    await shot(page, 'desktop-picker-bad-name');
    // The name input's 취소 (the picker's own 취소 closes it, further down).
    await picker.getByRole('button', { name: '취소', exact: true }).first().click();
    check(
      (await picker.getByRole('button', { name: '새 폴더', exact: true }).count()) === 1,
      '취소 closes the name input',
    );
    await page.keyboard.press('Escape');
    await picker.waitFor({ state: 'detached' });

    // 2. Picker-new, then the text edited: back to the 만들까요? question.
    await pickNew(page, form, 'typed-app');
    check(
      (await form.getByLabel('폴더').inputValue()) === path.join(projects, 'typed-app'),
      'the picker fills <current folder>/<name>',
    );
    check(await form.getByText(HINT).isVisible(), 'the new-folder hint under the folder');
    await form.getByLabel('폴더').fill(path.join(projects, 'typed-app2'));
    check((await form.getByText(HINT).count()) === 0, 'editing the folder drops the hint');
    await form.getByRole('button', { name: '추가', exact: true }).click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    check(
      (await dialog.textContent())?.includes('폴더가 없어요. 만들까요?'),
      'a typed missing folder still asks first',
    );
    check(!('mkdir' in engineActions().at(-1)!), 'the typed add went without mkdir');
    await shot(page, 'desktop-typed-confirm');
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    check(
      !fs.existsSync(path.join(projects, 'typed-app')) &&
        !fs.existsSync(path.join(projects, 'typed-app2')),
      'nothing created',
    );

    // 3. Picker-new, added at once with mkdir.
    await drawer.getByRole('button', { name: ADD, exact: true }).click();
    await form.waitFor();
    await pickNew(page, form, 'new-app');
    check(
      (await form.getByLabel('이름').inputValue()) === 'new-app',
      'the name follows the new folder',
    );
    check(!fs.existsSync(path.join(projects, 'new-app')), 'not made before 추가');
    await shot(page, 'desktop-form-new-folder');
    const asks = await dialog.count();
    await form.getByRole('button', { name: '추가', exact: true }).click();
    await toast(page, '추가했어요');
    check(asks === 0 && (await dialog.count()) === 0, 'no second confirm');
    check(
      engineActions().at(-1)?.mkdir === true &&
        engineActions().at(-1)?.folder === path.join(projects, 'new-app'),
      'sent engineAction add with mkdir: true',
    );
    check(fs.statSync(path.join(projects, 'new-app')).isDirectory(), 'the folder exists');
    const newCard = card(drawer, page, 'new-app');
    await newCard.getByRole('button', { name: '켜기', exact: true }).waitFor();
    await newCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot(page, 'desktop-new-folder-added');

    // 4. 사무실 추가.
    await drawer.getByRole('button', { name: OFFICE, exact: true }).click();
    const oform = page.getByRole('form', { name: OFFICE });
    await oform.waitFor();
    const office = oform.getByLabel('사무실');
    check(
      (await page.getByText(OFFICE, { exact: true }).count()) >= 2 &&
        (await office.inputValue()) === '' &&
        (await office.getAttribute('placeholder')) === '새 사무실 이름' &&
        (await office.evaluate((el) => (el as HTMLInputElement).required)),
      '사무실 추가: its title, an empty and required office field',
    );
    check(
      await office.evaluate((el) => el === document.activeElement),
      `the office field is focused (active: ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))})`,
    );
    check(
      await oform.getByText('새 사무실은 첫 오케스트레이터와 함께 생겨요.').isVisible(),
      'the office hint',
    );
    const submit = oform.getByRole('button', { name: '추가', exact: true });
    check(await submit.isDisabled(), '추가 disabled without an office name');
    const options = await page
      .locator(`datalist#${await office.getAttribute('list')} option`)
      .evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    check(
      options.includes('new-app') &&
        new Set(options).size === options.length &&
        JSON.stringify(options) ===
          JSON.stringify([...options].sort((a, b) => a.localeCompare(b, 'ko'))),
      `office list: distinct, sorted, engine rooms included (${options.join(', ')})`,
    );
    await shot(page, 'desktop-office-form');
    await oform.getByLabel('폴더').fill(path.join(projects, 'alpha-app'));
    await office.fill('디자인실');
    check(await submit.isEnabled(), '추가 enabled once named');
    await submit.click();
    await toast(page, '추가했어요');
    await waitUntil(() =>
      lastEngineState()?.projects.some((p) => p.name === 'alpha-app' && p.room === '디자인실'),
    );
    check(
      lastEngineState()?.projects.some((p) => p.name === 'alpha-app' && p.room === '디자인실'),
      'engineState: alpha-app in 디자인실',
    );
    const officeCard = card(drawer, page, 'alpha-app');
    await officeCard.waitFor();
    await page.waitForTimeout(1500);
    const carriers = received
      .filter((m) => m.type !== 'engineState' && JSON.stringify(m).includes('"디자인실"'))
      .map((m) => String(m.type));
    check(
      carriers.length > 0,
      `the office gets room 디자인실 (${[...new Set(carriers)].join(', ')})`,
    );
    await officeCard.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot(page, 'desktop-office-added');

    // ── Phone: 사무실 추가 with a picker-new folder ──
    const { page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      storageState: await desk.storageState(),
    });
    await phone.goto(`http://127.0.0.1:${port}/`);
    await hangul(phone);
    await phone
      .locator('[data-hud-id^="icon:"]')
      .getByRole('button', { name: '현황판', exact: true })
      .click();
    const panel = phone.getByLabel('현황판 화면');
    await panel.getByRole('button', { name: OFFICE, exact: true }).tap();
    const pform = phone.getByRole('form', { name: OFFICE });
    await pform.waitFor();
    await phone.waitForTimeout(300);
    await shot(phone, 'phone-office-form');
    await pform.getByRole('button', { name: '찾아보기', exact: true }).tap();
    const ppicker = phone.getByLabel('폴더 고르기', { exact: true }).last();
    await ppicker.getByRole('button', { name: '▸ alpha-app' }).waitFor();
    await ppicker.getByRole('button', { name: '새 폴더', exact: true }).tap();
    await ppicker.getByLabel('새 폴더 이름').fill('모바일');
    await phone.waitForTimeout(300);
    await shot(phone, 'phone-picker-new-folder');
    await ppicker.getByRole('button', { name: '만들기', exact: true }).tap();
    await ppicker.waitFor({ state: 'detached' });
    await pform.getByLabel('이름').fill('mobile-app');
    await pform.getByLabel('사무실').fill('모바일실');
    await phone.waitForTimeout(300);
    await shot(phone, 'phone-office-form-filled');
    await pform.getByRole('button', { name: '추가', exact: true }).tap();
    await toast(phone, '추가했어요');
    check(
      fs.statSync(path.join(projects, '모바일')).isDirectory() &&
        engineActions().at(-1)?.mkdir === true,
      'phone: the new folder made by the add',
    );
    await waitUntil(() =>
      lastEngineState()?.projects.some((p) => p.name === 'mobile-app' && p.room === '모바일실'),
    );
    check(
      lastEngineState()?.projects.some((p) => p.name === 'mobile-app' && p.room === '모바일실'),
      'phone: mobile-app in the new office 모바일실',
    );
    const pcard = card(panel, phone, 'mobile-app');
    await pcard.waitFor();
    await pcard.scrollIntoViewIfNeeded();
    await phone.waitForTimeout(300);
    await shot(phone, 'phone-office-added');

    fs.writeFileSync(
      path.join(OUT, 'ws-engine-actions.json'),
      `${JSON.stringify(engineActions(), null, 1).replaceAll(home, '<fake-home>')}\n`,
    );
  } finally {
    await browser?.close();
    const exited = new Promise((r) => server.once('exit', r));
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      const force = setTimeout(() => server.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(force);
    }
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
