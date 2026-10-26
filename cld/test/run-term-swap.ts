/**
 * TERM-SWAP2 check: "이 터미널로 바꾸기" at the terminal cap, pressed like a person does (a real
 * mouse click on the button's centre). dist/cli.js with the fake claude (S-chat: beta-task and
 * gamma-review are background sessions whose attach is an echoing prompt), cap 1, temp HOME,
 * headless Chromium (--disable-gpu).
 *
 * Cases, each on its own page (cap 1, beta-task attached, gamma-review refused): A the messenger closed (only the second tab visible),
 * B the messenger left open beside the terminal window (as on the owner's screen),
 * C the first tab is also attached by a second browser context (a viewer this window cannot release).
 * Logs what the click reached (mousedown/click on the button), page errors and unhandled
 * rejections, every WebSocket open/close and which attach processes run.
 * Screenshots go to cld/artifacts/term-swap/.
 *
 *   npx tsx cld/test/run-term-swap.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  FAKE_CLAUDE,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/term-swap');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const HANGUL = 'unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3;';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__ts/malgun.ttf'); ${HANGUL} }
@font-face { font-family: 'Menlo'; src: url('/__ts/malgun.ttf'); ${HANGUL} }`;
const DEADLINE_MS = 300_000;
const SWAP = '이 터미널로 바꾸기';

const attachIds = () =>
  (spawnSync('pgrep', ['-af', `${FAKE_CLAUDE}/attach.cjs`]).stdout ?? '')
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(' ').at(-1));

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f)); // the old shots, not the folder
  const fake = makeFakeHome({ claude: 'S-chat', agentsJson: true });
  const daemon = startDaemon(fake, port, ['--no-terminal', '--allow-chat']);
  const deadline = setTimeout(() => {
    console.error(`deadline ${DEADLINE_MS / 1000} s`);
    void daemon.stop().then(() => process.exit(2));
  }, DEADLINE_MS);
  const font = fs.readFileSync(FONT);
  const browser = await launchBrowser();
  try {
    const loginUrl = await daemon.loginUrl();
    // The login link works once: the first page keeps the session for every later one.
    let session: Awaited<ReturnType<Page['context']>['storageState']> | undefined;
    const newPage = async (storage?: Awaited<ReturnType<Page['context']>['storageState']>) => {
      const ctx = await browser.newContext({
        viewport: { width: 1400, height: 900 },
        ...(storage ? { storageState: storage } : {}),
      });
      await ctx.addInitScript(() => {
        localStorage.setItem('cld.status-tree', '{"rooms":true,"orchs":true}');
      });
      await ctx.route('**/__ts/malgun.ttf', (r) =>
        r.fulfill({ body: font, contentType: 'font/ttf' }),
      );
      const page = await ctx.newPage();
      return { ctx, page };
    };
    const trace: string[] = [];
    const watch = (page: Page, tag: string) => {
      const say = (s: string) =>
        trace.push(`${tag} ${((Date.now() % 1e6) / 1000).toFixed(2)} ${s}`);
      page.on('pageerror', (e) => say(`PAGEERROR ${e.message}`));
      page.on('websocket', (ws) => {
        const u = ws
          .url()
          .replace(/^.*\/ws\//, '/ws/')
          .slice(0, 60);
        say(`ws open ${u}`);
        ws.on('close', () => say(`ws close ${u}`));
      });
      page.on('console', (m) => m.text().includes('[probe]') && say(m.text()));
      return say;
    };
    const probe = (page: Page) =>
      page.evaluate(() => {
        window.addEventListener('unhandledrejection', (e) =>
          console.log(`[probe] unhandledrejection ${String(e.reason)}`),
        );
        for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click'] as const)
          document.addEventListener(
            type,
            (e) => {
              const el = e.target as HTMLElement;
              const btn = el.closest('button');
              if (
                btn?.textContent?.includes('바꾸기') ||
                el.closest('[data-testid="terminal-overlay"]')
              )
                console.log(
                  `[probe] ${type} on ${btn ? 'swap button' : el.tagName} (${Math.round((e as MouseEvent).clientX)},${Math.round((e as MouseEvent).clientY)})`,
                );
            },
            true,
          );
      });
    const openTerminalOf = async (page: Page, name: string) => {
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      if (!(await messenger.count()))
        await page.locator('[data-hud-id="icon:messenger"]').getByRole('button').click();
      await messenger
        .getByRole('list', { name: '연락처' })
        .getByRole('button', { name: new RegExp(`^${name}`) })
        .click();
      await messenger
        .getByRole('region', { name: `${name} 대화` })
        .getByRole('button', { name: '터미널로 보기' })
        .click();
    };
    const term = (page: Page) =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.xterm-rows')]
          .filter((el) => el.offsetParent !== null)
          .map((el) => el.innerText)
          .join('\n'),
      );
    const waitTerm = (page: Page, text: string) =>
      page.waitForFunction(
        (t) =>
          [...document.querySelectorAll<HTMLElement>('.xterm-rows')].some(
            (el) => el.offsetParent !== null && el.innerText.includes(t),
          ),
        text,
        { timeout: 15_000, polling: 'raf' },
      );
    const boot = async (
      tag: string,
      storage?: Awaited<ReturnType<Page['context']>['storageState']>,
    ) => {
      const { ctx, page } = await newPage(storage ?? session);
      const say = watch(page, tag);
      await page.goto((storage ?? session) ? BASE : loginUrl);
      if (!(storage ?? session)) {
        await page.waitForURL(BASE);
        session = await ctx.storageState();
      }
      await page.addStyleTag({ content: FONT_CSS });
      await page.locator('[data-hud-id="icon:messenger"]').waitFor();
      await page.waitForTimeout(1500);
      await probe(page);
      return { ctx, page, say };
    };
    const clickCentre = async (page: Page) => {
      const b = (await page.getByRole('button', { name: SWAP }).boundingBox())!;
      const [x, y] = [b.x + b.width / 2, b.y + b.height / 2];
      const top = await page.evaluate(
        ([px, py]) => {
          const el = document.elementFromPoint(px, py);
          return `${el?.tagName} ${(el?.textContent ?? '').slice(0, 20)}`;
        },
        [x, y],
      );
      console.log(
        `element at the centre: ${top}; renderers: ${await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-renderer]')].map((e) => e.dataset.renderer).join(','))}`,
      );
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.waitForTimeout(150);
      await page.mouse.up();
    };
    const tabsDone = async (page: Page) => {
      for (const n of ['gamma-review', 'beta-task'])
        await page
          .getByRole('button', { name: new RegExp(`${n} 터미널 닫기`) })
          .click()
          .catch(() => undefined);
      await page.waitForTimeout(1200);
    };

    for (const variant of ['A', 'B', 'C'] as const) {
      const closeMessenger = variant === 'A';
      const { ctx, page, say } = await boot(variant);
      let phone: Page | undefined;
      if (variant === 'C') {
        // A second browser (a phone) views beta-task's attach too.
        const p = await boot('C-other', await ctx.storageState());
        phone = p.page;
        await openTerminalOf(phone, 'beta-task');
        await waitTerm(phone, 'fake claude attach a0000016');
      }
      await openTerminalOf(page, 'beta-task');
      if (closeMessenger) await page.getByRole('button', { name: '메신저 닫기' }).click();
      await waitTerm(page, 'fake claude attach a0000016');
      if (closeMessenger) await openTerminalOf(page, 'gamma-review');
      else {
        // The messenger stays open: the second tab comes from the terminal window's + menu.
        const win = page.locator('[data-hud-window="terminal"]');
        await win.getByRole('button', { name: '터미널 추가' }).click();
        await win.getByRole('menuitem', { name: /^gamma-review/ }).click();
      }
      if (closeMessenger) await page.getByRole('button', { name: '메신저 닫기' }).click();
      await page.getByRole('button', { name: SWAP }).waitFor();
      say(`before click: attaches ${JSON.stringify(attachIds())}`);
      await page.screenshot({ path: path.join(OUT, `${variant}-before.png`) });
      await clickCentre(page);
      await page.waitForTimeout(2500);
      say(
        `after click: attaches ${JSON.stringify(attachIds())}; visible: ${JSON.stringify((await term(page)).slice(-80))}; swap button ${await page.getByRole('button', { name: SWAP }).count()}`,
      );
      await page.screenshot({ path: path.join(OUT, `${variant}-after.png`) });
      const ids = JSON.stringify(attachIds());
      if (variant === 'C') {
        check(
          ids === '["a0000016"]' &&
            (await page
              .getByTestId('terminal-overlay')
              // 1ce5df2f: the line names what can hold the slot (another device or window, or a message being sent).
              .getByText('다른 기기나 창')
              .count()) === 1 &&
            (await page.getByRole('button', { name: SWAP }).count()) === 0,
          'C: another browser holds the slot: the overlay says so in Korean and offers no swap button',
        );
      } else {
        check(
          ids === '["a0000017"]' && (await page.getByRole('button', { name: SWAP }).count()) === 0,
          `${variant}: the click released beta-task and attached gamma-review (one attach process)`,
        );
      }
      await tabsDone(page);
      if (phone) await phone.context().close();
      await ctx.close();
      await new Promise((r) => setTimeout(r, 1500));
    }
    console.log(trace.join('\n'));
    console.log('--- daemon log ---');
    console.log(
      daemon.log
        .join('')
        .split('\n')
        .filter((l) => /chat:/.test(l))
        .join('\n'),
    );
    check(true, 'done');
  } finally {
    clearTimeout(deadline);
    await browser.close();
    await daemon.stop();
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
