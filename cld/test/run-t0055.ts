/**
 * T-0055 visual check: the messenger's jump-to-newest button and the folded
 * usage line. dist/cli.js with the engine's fake claude (one revived project,
 * `alpha`), a fake claude-dashboard plugin (Claude 5h 1% / 7d 66% and Codex
 * 5h 73% / 27%) and --allow-chat, isolated HOME, a spare port; the real claude
 * is never run.
 *
 * Desktop and iPhone: a long conversation opens at the bottom (no button); up
 * less than a screen (no button); up more (the button); a message while up
 * (the count, the view stays); a tap (smooth scroll, the button hides); a
 * message at the bottom (follows). The usage strip folds to both figures per
 * provider, coloured by the thresholds, one line on desktop, one per provider
 * on a phone, and a tap unfolds it.
 *
 *   npx tsx cld/test/run-t0055.ts <port 18256-18259>
 */
import type { BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  launchBrowser,
  killFakeSessions,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0055');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0055/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const SAFE_AREA = ':root { --cld-safe-top: 47px; --cld-safe-bottom: 34px; }';
const DEADLINE_MS = 240_000;
const IPHONE13 = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

let n = 0;
const rec = (r: Record<string, unknown>) =>
  `${JSON.stringify({ uuid: `${(++n).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, timestamp: new Date().toISOString(), ...r })}\n`;
const say = (role: 'user' | 'assistant', text: string) =>
  role === 'user'
    ? rec({ type: 'user', message: { role, content: text } })
    : rec({ type: 'assistant', message: { role, content: [{ type: 'text', text }] } });
const tool = (name: string, input: Record<string, unknown>) =>
  rec({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });

  const { home, claudePath } = makeEngineHome();
  const fake = { home };
  const alphaDir = path.join(home, 'work', 'alpha');
  fs.mkdirSync(alphaDir, { recursive: true });
  // One project the engine revives.
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/projects.json'),
    JSON.stringify([{ name: 'alpha', folder: alphaDir, wantRunning: true }]),
  );
  const plugin = path.join(
    home,
    '.claude/plugins/cache/claude-dashboard/claude-dashboard/9.9.9/dist/check-usage.js',
  );
  fs.mkdirSync(path.dirname(plugin), { recursive: true });
  const at = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
  fs.writeFileSync(
    plugin,
    `console.log(JSON.stringify({
  claude: { fiveHourPercent: 1, sevenDayPercent: 66, fiveHourReset: ${JSON.stringify(at(2))}, sevenDayReset: ${JSON.stringify(at(60))} },
  codex: { fiveHourPercent: 73, sevenDayPercent: 27, fiveHourReset: ${JSON.stringify(at(3))}, sevenDayReset: ${JSON.stringify(at(100))} },
}));\n`,
  );
  const sessions = path.join(home, '.claude/sessions');
  const sessionFile = (): [string, Record<string, unknown>] | null => {
    for (const f of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Record<
          string,
          unknown
        >;
        if (s.name === 'alpha') return [path.join(sessions, f), s];
      } catch {
        /* being written */
      }
    }
    return null;
  };
  let alphaFile = '';
  let conversation = '';
  for (let i = 1; i <= 40; i++) {
    conversation +=
      say('user', `${i}번째 질문이에요`) +
      say(
        'assistant',
        `${i}번째 답이에요.\n${Array.from({ length: 4 }, (_, k) => `- 항목 ${i}-${k + 1}`).join('\n')}`,
      );
  }

  const daemon = startDaemon(
    { home, claudePath },
    port,
    ['--engine', 'on', '--no-terminal', '--allow-chat'],
    { FAKE_TURN_MS: '600' },
  );
  const { child: server, log: serverLog } = daemon;
  const loginUrl = daemon.loginUrl();
  const abort = (why: string) => {
    console.error(`aborted: ${why}\n${serverLog.join('').slice(-1500)}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    fs.rmSync(fake.home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  const font = fs.readFileSync(FONT);
  const browser = await launchBrowser();
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const open = async (opts: BrowserContextOptions) => {
    const ctx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
      ...opts,
    });
    // Office hours off, so nobody goes home when this runs at night (T-0041).
    await ctx.addInitScript(() => localStorage.setItem('cld.office-hours', '{"on":false}'));
    await ctx.route('**/__t0055/malgun.ttf', (route) =>
      route.fulfill({ body: font, contentType: 'font/ttf' }),
    );
    return { ctx, page: await ctx.newPage() };
  };
  const hangul = async (page: Page) => {
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
  };

  /** The list's distance from its bottom, px. */
  const fromBottom = (list: Locator) =>
    list.evaluate((el) => Math.round(el.scrollHeight - el.scrollTop - el.clientHeight));
  const scrollTo = (list: Locator, up: number | 'top') =>
    list.evaluate((el, u) => {
      el.scrollTop = u === 'top' ? 0 : el.scrollHeight - el.clientHeight - u;
    }, up);

  /** The messenger's alpha conversation: its message list and the jump button. */
  async function messengerChecks(page: Page, label: string, tap: boolean) {
    await page
      .getByRole('button', { name: /^메신저/ })
      .first()
      [tap ? 'tap' : 'click']();
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    await messenger
      .getByRole('list', { name: '연락처' })
      .getByRole('button', { name: /^alpha/ })
      [tap ? 'tap' : 'click']();
    const conv = messenger.getByRole('region', { name: 'alpha 대화' });
    await conv.getByText('40번째 답이에요.').waitFor();
    await page.waitForTimeout(500);
    const list = conv.locator('div.overflow-y-auto');
    const jump = conv.getByTestId('jump-newest');
    const h = await list.evaluate((el) => el.clientHeight);

    // It settles on the newest message a moment after the text is there (longer under load).
    for (let i = 0; i < 40 && !((await fromBottom(list)) <= 2 && (await jump.count()) === 0); i++)
      await page.waitForTimeout(250);
    check(
      (await fromBottom(list)) <= 2 && (await jump.count()) === 0,
      `${label}: a long conversation opens at the newest message, no jump button`,
    );
    await scrollTo(list, Math.round(h * 0.6));
    await page.waitForTimeout(300);
    // T-0115: any scroll away from the bottom shows the button (the old one-screen rule is gone).
    check((await jump.count()) === 1, `${label}: up 0.6 screen: the button shows`);
    await scrollTo(list, 'top');
    await jump.waitFor();
    check(
      (await jump.innerText()).trim() === '↓',
      `${label}: scrolled up past a screen: the ↓ button shows`,
    );
    const box = (await jump.boundingBox())!;
    const lbox = (await list.boundingBox())!;
    check(
      // The button is centred above the list's bottom edge.
      Math.abs(box.x + box.width / 2 - (lbox.x + lbox.width / 2)) < 4 &&
        box.y + box.height <= lbox.y + lbox.height &&
        lbox.y + lbox.height - (box.y + box.height) < 24 + 8,
      `${label}: the button sits centred over the list's bottom edge`,
    );
    await shot(page, `${label}-jump-button`);

    // A message while scrolled up: the count, no auto-scroll. (At the top an
    // older page may load first, T-0060: it keeps the rows in view where they are.)
    await conv.getByText('불러오는 중…').waitFor({ state: 'detached' });
    const anchorRow = conv.locator('[data-chat-id]').nth(2);
    const anchorY = () =>
      anchorRow.evaluate(
        (row) =>
          row.getBoundingClientRect().top -
          row.closest('.overflow-y-auto')!.getBoundingClientRect().top,
      );
    const yBefore = await anchorY();
    fs.appendFileSync(
      alphaFile,
      say('assistant', `${label}: 새 메시지 하나`) +
        tool('Bash', { command: 'ls' }) +
        say('assistant', `${label}: 새 메시지 둘`),
    );
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="jump-newest"]')?.textContent?.trim() ===
        '새 메시지 2 ↓',
      undefined,
      { timeout: 10_000 },
    );
    const yAfter = await anchorY();
    check(
      Math.abs(yAfter - yBefore) <= 1,
      `${label}: two new messages while up: "새 메시지 2 ↓" (the tool line not counted), the view did not move (${Math.round(yBefore)} → ${Math.round(yAfter)} px)`,
    );
    await shot(page, `${label}-jump-count`);

    // Tap: smooth scroll to the newest, the button hides.
    await jump[tap ? 'tap' : 'click']();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="jump-newest"]'),
      undefined,
      { timeout: 2_000 },
    );
    await page.waitForTimeout(1_500);
    check(
      (await fromBottom(list)) <= 2 &&
        (await conv.getByText(`${label}: 새 메시지 둘`).isVisible()) &&
        (await jump.count()) === 0,
      `${label}: tap: scrolled to the newest message and the button is gone`,
    );
    await shot(page, `${label}-jumped`);

    // At the bottom: a new message follows, as before.
    fs.appendFileSync(alphaFile, say('assistant', `${label}: 바닥에서 온 메시지`));
    await conv.getByText(`${label}: 바닥에서 온 메시지`).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(300);
    check(
      (await fromBottom(list)) <= 2 && (await jump.count()) === 0,
      `${label}: at the bottom a new message scrolls into view, no button`,
    );
  }

  /** A fenced code block gets a 복사 button that copies the code as written. */
  async function codeCopyChecks(page: Page, label: string, tap: boolean, plainHttp = false) {
    const conv = page.getByRole('region', { name: 'alpha 대화' });
    const code = 'if (x) {\n\treturn a < b && **c**;\n}\n\n  <b>끝</b>';
    fs.appendFileSync(
      alphaFile,
      say(
        'assistant',
        `${label}: 코드예요, \`inline\` 은 버튼이 없어요.\n\n\`\`\`ts\n${code}\n\`\`\``,
      ),
    );
    await conv.getByText(`${label}: 코드예요`).waitFor({ timeout: 10_000 });
    await page.waitForTimeout(500);
    const buttons = conv.getByTestId('code-copy');
    check(
      (await buttons.count()) >= 1 &&
        (await conv.locator('p code', { hasText: 'inline' }).count()) >= 1 &&
        (await conv.locator('p button[data-testid="code-copy"]').count()) === 0 &&
        (await conv.locator('p:has(> code) button').count()) === 0,
      `${label}: fenced blocks have a 복사 button, inline code has none`,
    );
    const target = buttons.nth(-1); // the newest message's block
    await shot(page, `${label}-code-copy-idle`);
    if (plainHttp) {
      // As on a LAN http:// URL: no Clipboard API, the copy-event fallback.
      await page.evaluate(() => {
        Object.defineProperty(window, 'isSecureContext', { value: false });
      });
    }
    await page.evaluate(() => navigator.clipboard.writeText('before'));
    await target[tap ? 'tap' : 'click']();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="code-copy"][data-state="done"]').length === 1,
      undefined,
      { timeout: 3_000 },
    );
    const got = await page.evaluate(() => navigator.clipboard.readText());
    check(
      got === code,
      `${label}${plainHttp ? ' (no Clipboard API)' : ''}: the button copied the code exactly (${JSON.stringify(got)})`,
    );
    await shot(page, `${label}-code-copied${plainHttp ? '-http' : ''}`);
    await page.waitForTimeout(1_800);
    check((await target.innerText()) === '복사', `${label}: 복사됨 for 1.5 s, then 복사 again`);
  }

  /** The folded usage strip: text, tones, shape, tap to unfold. */
  async function usageChecks(page: Page, label: string, phone: boolean) {
    const open = page.getByLabel('사용량', { exact: true });
    await open.waitFor();
    await page.getByRole('button', { name: '사용량 접기' }).click();
    const folded = page.getByTestId('usage-folded');
    await folded.waitFor();
    const text = (await folded.innerText()).replace(/\s+/g, ' ').trim();
    check(
      text === 'Claude 5h 1% · 7d 66% Codex 5h 73% · 7d 27%',
      `${label}: folded usage reads "${text}"`,
    );
    const tones = await folded.evaluate((el) =>
      [...el.querySelectorAll('span')]
        .filter((s) => /^\d[hd] \S+%$/.test(s.textContent ?? ''))
        .map((s) => [s.textContent, s.className] as const),
    );
    const tone = (t: string) => tones.find(([x]) => x === t)?.[1] ?? '';
    check(
      tone('5h 73%').includes('text-yellow-300') &&
        tone('5h 1%').includes('text-text') &&
        tone('7d 66%').includes('text-text') &&
        !tone('7d 66%').includes('yellow') &&
        tone('7d 27%').includes('text-text'),
      `${label}: each figure coloured by the thresholds (73% warn, the rest normal)`,
    );
    const names = await folded.locator('strong').evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return { name: e.textContent, top: Math.round(r.top) };
      }),
    );
    const height = Math.round((await folded.boundingBox())!.height);
    if (phone) {
      check(
        names.length === 2 && height <= 60,
        `${label}: on the phone it may wrap between the providers, never inside one (Claude y ${names[0].top}, Codex y ${names[1].top}, ${height} px high)`,
      );
    } else {
      check(
        names.length === 2 && names[1].top === names[0].top && height < 30,
        `${label}: one line on desktop (${height} px)`,
      );
    }
    check(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      `${label}: the folded usage fits the width`,
    );
    await shot(page, `${label}-usage-folded`);
    await folded.click();
    await open.waitFor();
    check(
      (await page.getByTestId('usage-folded').count()) === 0 &&
        (await open.innerText()).includes('7d 66%'),
      `${label}: a tap unfolds it`,
    );
    await page.getByRole('button', { name: '사용량 접기' }).click(); // folded again, as left
    await page.getByTestId('usage-folded').waitFor();
  }

  try {
    const url = await loginUrl;
    // The engine revives alpha: its session file names the transcript the conversation goes in.
    for (const end = Date.now() + 40_000; !sessionFile();) {
      if (Date.now() > end) throw new Error('the engine did not revive alpha');
      await new Promise((r) => setTimeout(r, 300));
    }
    const [, s] = sessionFile()!;
    alphaFile = transcriptPath(String(s.cwd), String(s.sessionId), home);
    fs.mkdirSync(path.dirname(alphaFile), { recursive: true });
    fs.writeFileSync(alphaFile, conversation);

    // ════ Desktop ════
    const { ctx: desk, page } = await open({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 1,
    });
    await page.goto(url);
    await page.waitForURL(BASE);
    await hangul(page);
    await usageChecks(page, 'desktop', false);
    await messengerChecks(page, 'desktop', false);
    await codeCopyChecks(page, 'desktop', false);
    await codeCopyChecks(page, 'desktop-http', false, true);
    await desk.close();

    // ════ iPhone ════
    // A fresh login code: the desktop's was spent.
    const { page: phone2 } = await open({ ...IPHONE13 });
    await phone2.goto(await daemon.loginUrl());
    await phone2.waitForURL(BASE);
    await hangul(phone2);
    await phone2.addStyleTag({ content: SAFE_AREA });
    await usageChecks(phone2, 'iphone', true);
    await messengerChecks(phone2, 'iphone', true);
    await codeCopyChecks(phone2, 'iphone', true);
    check(
      await phone2.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'iphone: the page fits the width',
    );
    console.log('ALL OK');
  } finally {
    clearTimeout(deadline);
    killFakeSessions(fake.home);
    await browser.close();
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
    fs.rmSync(fake.home, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
