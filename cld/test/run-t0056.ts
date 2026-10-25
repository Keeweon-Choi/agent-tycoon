/**
 * T-0056 visual check: the read-only work view of a temp. dist/cli.js with the
 * fake claude (T-56: one session, alpha), --allow-chat, an isolated HOME and a
 * spare port; the real claude is never run. Chromium without a GPU, office
 * hours off in the page.
 *
 * The fixture: a lead (alpha) whose transcript has an inline sub-agent (a
 * markdown prompt and answer, tool calls with a bearer token and a password in
 * them).

 * Desktop and iPhone: the sub-agent press only selects it; its tooltip button
 * and the "+N" row button open the sheet with its prompt, markdown,
 * EZ tool lines and results, live tail, no input, only 리더에게 가기 and 닫기;
 * a "+N" row -> the same view; no secret reaches the DOM; a session the
 * engine does not own says why it is read-only in the messenger.
 *
 *   npx tsx cld/test/run-t0056.ts <port 18256-18259>
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0056');
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0056/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0056/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
const SAFE_AREA = ':root { --cld-safe-top: 47px; --cld-safe-bottom: 34px; }';
const DEADLINE_MS = 280_000;
const IPHONE13 = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();

/** Secrets planted in the fixtures: none may reach the page. */
const SECRETS = [
  'SECRET-BEARER-7781',
  'hunter2-SECRET-9912',
  'ZZ-SECRET-APIKEY-4410',
  'sk-ant-api03-SECRETKEY9988776655',
];

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

type Rec = Record<string, unknown>;
const line = (r: Rec) => `${JSON.stringify(r)}\n`;
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const said = (content: Rec[]): Rec => ({
  type: 'assistant',
  message: { model: 'claude-opus-4-5', content },
});
const result = (id: string, text: string): Rec => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
});
const sub = (parent: string, msg: Rec): Rec => ({
  type: 'progress',
  parentToolUseID: parent,
  data: { type: 'agent_progress', message: msg },
});

const SPAWN = 'tu-dig';
const PROMPT =
  '로그를 조사해 주세요.\n\n- **캐시 만료** 가 원인인지 확인\n- 재시도 횟수를 `retry` 로 찾기';

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });

  const fake = makeFakeHome({ claude: 'T-56', agentsJson: true });
  const home = fake.home;
  const alphaFile = path.join(
    home,
    '.claude/projects/-work-alpha/a0000001-0000-4000-8000-000000000001.jsonl',
  );
  fs.writeFileSync(
    alphaFile,
    line({ type: 'user', message: { role: 'user', content: '로그를 조사시켜 줘' } }),
  );

  const daemon = startDaemon(fake, port, ['--no-terminal', '--allow-chat']);
  const { child: server, log: serverLog } = daemon;
  const loginUrl = daemon.loginUrl();
  const abort = (why: string) => {
    console.error(`aborted: ${why}\n${serverLog.join('').slice(-1500)}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  const fonts = { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) };
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const open = async (opts: BrowserContextOptions) => {
    const ctx = await browser.newContext(opts);
    // Office hours off, so nobody goes home when this runs at night (T-0041).
    await ctx.addInitScript(() => localStorage.setItem('cld.office-hours', '{"on":false}'));
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
    await ctx.route('**/__t0056/*.ttf', (route) =>
      route.fulfill({
        body: route.request().url().endsWith('emoji.ttf') ? fonts.emoji : fonts.malgun,
        contentType: 'font/ttf',
      }),
    );
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const ready = async (page: Page, url: string) => {
    await page.goto(url);
    await page.waitForURL(BASE);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가📖'));
  };

  interface Anchor {
    id: number;
    kind: string;
    x: number;
    y: number;
  }
  const anchors = (page: Page): Promise<Anchor[]> =>
    page.$$eval('[data-testid="status-icon-anchor"]', (nodes) =>
      nodes.map((n) => {
        const r = n.getBoundingClientRect();
        return {
          id: Number(n.getAttribute('data-agent-id')),
          kind: n.getAttribute('data-kind') ?? '',
          x: r.left,
          y: r.top,
        };
      }),
    );
  const until = async (what: string, fn: () => Promise<boolean>, ms = 30_000) => {
    for (const end = Date.now() + ms; Date.now() < end;) {
      if (await fn()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`timed out: ${what}`);
  };
  const cardFor = (page: Page, name: string) =>
    page.locator('[data-testid="agent-card"]').filter({
      has: page.locator('[data-testid="card-name"]', { hasText: new RegExp(`^${name}$`) }),
    });
  /** Everything the page holds as text and markup: no planted secret may be in it. */
  const leaks = (page: Page) =>
    page.evaluate((secrets) => {
      const all = document.documentElement.outerHTML + document.body.innerText;
      return secrets.filter((s) => all.includes(s));
    }, SECRETS);

  const detailsOf = (page: Page, id: number) =>
    page.locator(
      `[data-testid="agent-overlay"][data-agent-id="${id}"] [data-testid="agent-details"]`,
    );
  const sheetCount = (page: Page) => page.getByTestId('work-sheet').count();

  /** A tap or click on a temp character (where its body is, below its status
   *  icon); the offset that hit, so the next press can hit the same spot. */
  async function pressCharacter(page: Page, id: number, tap: boolean, from?: number) {
    // The office may open with the character out of view (a lobby, a big map): zoom out, or on a
    // touch page let the lead's card bring the camera, until its anchor is inside the canvas.
    for (let i = 0; i < 4; i++) {
      const a = (await anchors(page)).find((x) => x.id === id);
      const box = (await page.getByTestId('office-canvas').boundingBox())!;
      if (
        a &&
        a.x > box.x + 20 &&
        a.x < box.x + box.width - 60 &&
        a.y > box.y + 20 &&
        a.y < box.y + box.height - 100
      )
        break;
      if (tap) {
        await cardFor(page, 'lead').first().tap();
      } else {
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, 120);
        await page.keyboard.up('Control');
      }
      await page.waitForTimeout(1_200);
    }
    for (const down of from === undefined ? [24, 40, 56, 72, 12] : [from]) {
      const a = (await anchors(page)).find((x) => x.id === id);
      if (!a) throw new Error(`no anchor for #${id}`);
      const [x, y] = [a.x + 4, a.y + down];
      if (tap) await page.touchscreen.tap(x, y);
      else await page.mouse.click(x, y);
      if (from !== undefined) return down;
      if (
        await detailsOf(page, id)
          .waitFor({ timeout: 1_500 })
          .then(
            () => true,
            () => false,
          )
      )
        return down;
    }
    await shot(page, `debug-press-${id}`);
    throw new Error(`pressing #${id} never selected it (${JSON.stringify(await anchors(page))})`);
  }

  /** What the sub-agent's open view must show (and must not). */
  const viewChecks = async (page: Page, label: string) => {
    const sheet = page.getByTestId('work-sheet');
    await sheet.getByText('로그를 조사해 주세요.').waitFor();
    check(
      (await sheet.getAttribute('data-kind')) === 'subagent',
      `${label}: the sub-agent's work view is open`,
    );
    // Markdown: a bold run and a list in the prompt-turn's answer, code inline.
    await sheet.getByText('원인은 캐시 만료예요').waitFor();
    check(
      (await sheet.locator('strong', { hasText: '캐시 만료' }).count()) >= 1 &&
        (await sheet.locator('li').count()) >= 2 &&
        (await sheet.locator('code', { hasText: 'retry' }).count()) >= 1,
      `${label}: the assistant text is rendered as Markdown (bold, list, code)`,
    );
    // Tool lines folded the EZ way, results folded and trimmed.
    const tools = sheet.locator('details > summary').filter({ hasNot: page.locator('x') });
    check((await tools.count()) >= 3, `${label}: tool calls and results are folded lines`);
    const toolText = (await tools.allTextContents()).join(' | ');
    check(
      /찾아보는|받아오는|명령|읽는/.test(toolText) && !/Bash|Grep|curl/.test(toolText),
      `${label}: tool lines are EZ words (${toolText})`,
    );
    check(
      (await sheet.locator('textarea, input').count()) === 0,
      `${label}: no input box in the work view`,
    );
    const buttons = (await sheet.getByRole('button').allInnerTexts()).map((t) => t.trim());
    const allowed = new Set(['리더에게 가기', '닫기', '×', '더 보기', '접기']);
    check(
      buttons.every((b) => allowed.has(b)) && buttons.includes('리더에게 가기'),
      `${label}: only 리더에게 가기 and 닫기 act (${buttons.join(', ')})`,
    );
    check(
      (await leaks(page)).length === 0,
      `${label}: no planted secret in the page's text or markup`,
    );
    check(
      (await sheet.evaluate((el) => el.textContent ?? '')).includes('***'),
      `${label}: the masked values show as ***`,
    );
    await page.waitForTimeout(400);
    await shot(page, `${label}-subagent-view`);
  };
  /** The press selects (details with the button), a second press opens nothing,
   *  and the tooltip's 작업 보기 opens the view. */
  const dig = async (page: Page, label: string, tap: boolean) => {
    const subId = (await anchors(page)).find((a) => a.kind === 'subagent')!.id;
    const down = await pressCharacter(page, subId, tap);
    const open = detailsOf(page, subId).getByTestId('work-open');
    await open.waitFor();
    check(
      (await sheetCount(page)) === 0 && (await detailsOf(page, subId).innerText()).includes('리더'),
      `${label}: pressing the sub-agent only selects it (its details show, no work view)`,
    );
    await shot(page, `${label}-subagent-details`);
    await pressCharacter(page, subId, tap, down); // again: the desktop deselects, the phone keeps it
    await page.waitForTimeout(500);
    check((await sheetCount(page)) === 0, `${label}: pressing it again opens no work view either`);
    if (!(await open.count())) await pressCharacter(page, subId, tap, down);
    await open.waitFor();
    await open[tap ? 'tap' : 'click']();
    await page.getByTestId('work-sheet').waitFor();
    await viewChecks(page, label);
    return subId;
  };

  try {
    const url = await loginUrl;
    const { ctx: deskCtx, page } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await ready(page, url);
    const { ctx: phoneCtx, page: phone } = await open({
      ...IPHONE13,
      viewport: { width: 393, height: 852 },
    });
    await phoneCtx.addCookies(await deskCtx.cookies());
    await ready(phone, BASE);
    await phone.addStyleTag({ content: SAFE_AREA });
    for (const p of [page, phone])
      await until('alpha is in the office', async () => (await cardFor(p, 'alpha').count()) > 0);
    await page.waitForTimeout(3_000);
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.click();

    // The lead spawns an inline sub-agent; its sidechain is logged on the lead.
    const append = (...recs: Rec[]) => {
      for (const r of recs) fs.appendFileSync(alphaFile, line(r));
    };
    append(
      said([
        call(SPAWN, 'Task', {
          description: 'dig into the logs',
          prompt: PROMPT,
          model: 'sonnet',
        }),
      ]),
      sub(
        SPAWN,
        said([
          {
            type: 'text',
            text: '## 조사 시작\n원인은 캐시 만료예요.\n\n- **캐시 만료** 확인\n- `retry` 횟수 보기',
          },
          call('tu-dig-1', 'Grep', { pattern: 'retry' }),
        ]),
      ),
      sub(SPAWN, result('tu-dig-1', 'src/a.ts:3: retry(3)\nsrc/b.ts:9: retry(5)')),
      sub(
        SPAWN,
        said([
          call('tu-dig-2', 'Bash', {
            command: 'curl -s -H "Authorization: Bearer SECRET-BEARER-7781" https://api.test/x',
          }),
        ]),
      ),
      sub(SPAWN, result('tu-dig-2', 'DB_PASSWORD=hunter2-SECRET-9912\nresponse: ok')),
    );
    for (const p of [page, phone])
      await until('the sub-agent comes in', async () =>
        (await anchors(p)).some((a) => a.kind === 'subagent'),
      );
    // It walks in from the door; give it a moment to settle at its desk.
    await page.waitForTimeout(6_000);
    await shot(page, 'desktop-office');

    // ── Desktop ────────────────────────────────────────────
    const subId = await dig(page, 'desktop', false);

    // Live tail: a record the sub-agent writes while the view is open.
    append(sub(SPAWN, said([{ type: 'text', text: '마지막 정리: 재시도는 5회예요' }])));
    await page.getByTestId('work-sheet').getByText('마지막 정리: 재시도는 5회예요').waitFor({
      timeout: 10_000,
    });
    check(true, 'desktop: a new sidechain record shows up while the view is open');

    // 리더에게 가기: the sheet closes and the lead is selected.
    await page.getByTestId('work-go-lead').click();
    await page.getByTestId('work-sheet').waitFor({ state: 'detached' });
    await until('the lead is selected', async () => {
      const o = page
        .locator('[data-testid="agent-overlay"]')
        .filter({ has: page.locator('[data-testid="agent-name"]', { hasText: /^alpha$/ }) });
      return (await o.locator('[data-testid="agent-details"]').count()) > 0;
    });
    check(true, 'desktop: 리더에게 가기 closes the view and goes to the lead');

    // A "+N" row opens the same view.
    const chip = cardFor(page, 'alpha').locator('[data-testid="temp-chip"]');
    await chip.click();
    const list = page.locator('[data-testid="temp-list"]');
    await list.waitFor();
    await shot(page, 'desktop-plus-n-list');
    await list.locator(`[data-testid="temp-row"][data-agent-id="${subId}"]`).click();
    await detailsOf(page, subId).waitFor();
    check(
      (await sheetCount(page)) === 0 && (await list.count()) === 0,
      'desktop: a +N row still only goes to the character (selected, details up), no work view',
    );
    await chip.click();
    await list.waitFor();
    await list.locator(`[data-testid="work-open"][data-agent-id="${subId}"]`).click();
    const sheet = page.getByTestId('work-sheet');
    await sheet.getByText('로그를 조사해 주세요.').waitFor();
    check(
      (await sheet.getAttribute('data-kind')) === 'subagent' && (await list.count()) === 0,
      "desktop: the row's 작업 보기 button opens the same work view (and the list closes)",
    );
    await page.getByTestId('work-close').click();
    await sheet.waitFor({ state: 'detached' });

    // The messenger: a Claude session the engine does not own says why it cannot be written to.
    await page
      .getByRole('button', { name: /^메신저/ })
      .first()
      .click();
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    const contacts = messenger.getByRole('list', { name: '연락처' });
    await contacts.waitFor();
    await contacts.getByRole('button', { name: /^alpha/ }).click();
    const conv = messenger.getByRole('region', { name: 'alpha 대화' });
    await conv.getByTestId('no-send-note').waitFor();
    check(
      (await conv.getByRole('textbox', { name: '보낼 글' }).count()) === 0,
      'desktop: a session the engine does not own has a read-only note and no input',
    );
    await shot(page, 'desktop-read-only-note');
    await page.getByRole('button', { name: '메신저 닫기' }).click();

    // ── Phone ──────────────────────────────────────────────
    await phone.waitForTimeout(1_000);
    // The phone's camera is on the lead: the "+N" row goes to the sub-agent
    // (selecting and following it, no view); a tap on it opens nothing either;
    // the tooltip's 작업 보기 does. The row's own button opens it too.
    const chipP = cardFor(phone, 'alpha').locator('[data-testid="temp-chip"]');
    await chipP.tap();
    await phone.locator('[data-testid="temp-list"]').waitFor();
    const subIdP = (await anchors(phone)).find((a) => a.kind === 'subagent')!.id;
    await phone.locator(`[data-testid="temp-row"][data-agent-id="${subIdP}"]`).tap();
    await detailsOf(phone, subIdP).waitFor();
    await phone.waitForTimeout(1_500);
    check(
      (await sheetCount(phone)) === 0,
      'phone: a +N row only selects and follows the sub-agent, no work view',
    );
    await dig(phone, 'phone', true);
    await phone.getByTestId('work-close').tap();
    await phone.getByTestId('work-sheet').waitFor({ state: 'detached' });
    await chipP.tap();
    await phone.locator('[data-testid="temp-list"]').waitFor();
    await phone
      .locator(`[data-testid="temp-list"] [data-testid="work-open"][data-agent-id="${subIdP}"]`)
      .tap();
    await viewChecks(phone, 'phone-row');
    const sheetP = phone.getByTestId('work-sheet');
    const box2 = (await sheetP.boundingBox())!;
    check(
      box2.width >= 380 && box2.height >= 400,
      `phone: the view fills the office page, as the messenger does (${Math.round(box2.width)}x${Math.round(box2.height)})`,
    );
    await phone.getByTestId('work-close').tap();
    await sheetP.waitFor({ state: 'detached' });
    check(
      pageErrors.length === 0,
      `no page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`,
    );
    console.log(`screenshots in ${OUT}`);
  } catch (err) {
    console.error(serverLog.join('').slice(-1500));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser.close();
    if (server.exitCode === null && server.signalCode === null) {
      const gone = new Promise((r) => server.once('exit', r));
      server.kill('SIGTERM');
      await Promise.race([gone, new Promise((r) => setTimeout(r, 5_000))]);
    }
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
