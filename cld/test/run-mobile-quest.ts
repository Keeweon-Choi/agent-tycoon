/**
 * MOBILE-QUEST (owner 11-04 19:40, iPhone): the question card and the usage strip, end to end on dist/cli.js
 * (--engine on --allow-chat, the engine fake as `claude`, temp HOME, headless Chromium --disable-gpu).
 *  phone 390x844 (touch): the question card shows; 접기 folds it to its head line, 펼치기 opens it; its request
 *    has no raw `**`; 답하기 folds it and focuses the composer, which stays on screen when the keyboard takes
 *    half the height; sending clears the card. The usage strip: Claude "남음 39%" (the endpoint says 61% used),
 *    Codex 모름 with no lit cell (its last log's reset passed), both rows in the same columns, one ▶.
 *  desktop 1282x832: the same figures in the top bar, the title says "주간 61% 사용 · 남음 39% · … 초기화";
 *    답하기 focuses the composer and leaves the card open (it never covers the composer there).
 * Screenshots: cld/artifacts/mobile-quest-1104/.
 *
 *   npx tsx cld/test/run-mobile-quest.ts <port 18590-18599> [quest-only]
 */
import type { Locator, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import { assertPortFree, fakeUsage, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, sparePort, startDaemon } from '../../server/src/cld/testHome.js';

const port = sparePort();
if (port < 18590) throw new Error('port must be 18590-18599');
const questOnly = process.argv[3] === 'quest-only';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/mobile-quest-1104');
const DEADLINE_MS = 240_000;
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__mq/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
// The owner's question, as the orchestrator left it (bold and a list, ending on '?').
const QUESTION =
  '시안 두 장을 만들었어요.\n\n**정해 주실 것 (시안 두 개)**\n- **콕핏**: B안으로 가고, v0.3 설계에서 여섯 가지를 바꿔도 될까요?\n- **건물**: A안과 현황판 판 2 로 구현에 들어갈까요?';

let oks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  oks++;
  console.log(`ok - ${what}`);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  for (const end = Date.now() + ms; !(await ok()); await wait(100)) if (Date.now() > end) throw new Error(`timed out: ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(path.join(configDirectory(home), 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(configDirectory(home), 'projects.json'), JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true }]));
  // Claude: an Ultra week only, 61% used. Codex: its newest log's windows reset an hour ago (this PC knows no figure now).
  const usage = await fakeUsage(home, { sevenDay: 61 }, { fiveHour: 0, sevenDay: 0 });
  const past = Math.floor(Date.now() / 1000) - 3600;
  const codexLog = path.join(home, '.codex/sessions/2026/10/23/rollout-usage.jsonl');
  const rl = { primary: { used_percent: 40, window_minutes: 300, resets_at: past }, secondary: { used_percent: 10, window_minutes: 10080, resets_at: past } };
  fs.writeFileSync(codexLog, `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: rl } })}\n`);

  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'], {
    FAKE_TURN_MS: '600',
    ...usage.env,
  });
  const { child: server } = daemon;
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL'); // our own daemon only
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  type Sess = { sessionId: string; cwd: string; name: string };
  const alphaSession = (): Sess | null => {
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
    const s = alphaSession()!;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ uuid: `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`, timestamp: new Date().toISOString(), ...record })}\n`);
  };
  const askQuestion = () => {
    rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: QUESTION }] } });
    rec({ type: 'system', subtype: 'turn_duration', durationMs: 1000 });
  };

  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    await until('the engine started alpha', () => !!alphaSession(), 40_000);
    rec({ type: 'permission-mode', permissionMode: 'bypassPermissions' });
    rec({ type: 'user', message: { role: 'user', content: '[사장 · 메신저 · 11-04 19:30] ⟨m:aaaaaaa1⟩\n시안 보여 줘' } });
    const url = await daemon.loginUrl();
    await wait(4_000); // past the page's resync quiet
    browser = await launchBrowser();
    const font = fs.existsSync(FONT) ? fs.readFileSync(FONT) : null;
    const newPage = async (opts: Parameters<NonNullable<typeof browser>['newContext']>[0]) => {
      const ctx = await browser!.newContext(opts);
      await ctx.addInitScript('globalThis.__name = (fn) => fn;');
      if (font) await ctx.route('**/__mq/malgun.ttf', (r) => r.fulfill({ body: font, contentType: 'font/ttf' }));
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
      return { ctx, page };
    };
    const shot = (name: string, p: Page) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const openAlpha = async (p: Page, touch: boolean) => {
      const tap = (l: Locator) => (touch ? l.tap() : l.click());
      await p.getByRole('button', { name: /^메신저/ }).first().waitFor();
      await tap(p.getByRole('button', { name: /^메신저/ }).first());
      const messenger = p.getByRole('region', { name: '메신저', exact: true });
      await tap(messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }));
      return messenger.getByRole('region', { name: 'alpha 대화' });
    };

    // A desktop login first; the phone reuses its cookie.
    const desk = await newPage({ viewport: { width: 1282, height: 832 } });
    await desk.page.goto(url);
    await desk.page.waitForURL(`http://127.0.0.1:${port}/`);
    if (font) await desk.page.addStyleTag({ content: FONT_CSS });
    const infoClose = desk.page.getByRole('button', { name: '정보 창 닫기' });
    if (await infoClose.count()) await infoClose.click();
    const state = await desk.ctx.storageState();

    // ── phone ──
    const ph = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, storageState: state });
    await ph.page.goto(`http://127.0.0.1:${port}/`);
    if (font) await ph.page.addStyleTag({ content: FONT_CSS });
    const pa = await openAlpha(ph.page, true);
    // Asked once the fake's own turns (the engine's revive) are over, so the question is the last word.
    await wait(3_000);
    askQuestion();
    const card = pa.getByTestId('question-card');
    await card.waitFor({ timeout: 20_000 });
    check(true, 'phone: the question card shows');
    const request = card.getByTestId('question-request');
    await until('the request text', async () => (await request.innerText()).trim().length > 0, 20_000);
    const reqText = await request.innerText();
    check(!reqText.includes('**') && (await request.locator('strong').count()) >= 2 && (await request.locator('li').count()) === 2, `phone: the request is drawn Markdown (bold, a 2-item list), no raw ** ("${reqText.replace(/\s+/g, ' ').slice(0, 60)}")`);
    await shot('phone-card-open', ph.page);
    const openH = (await card.boundingBox())!.height;
    await card.getByTestId('quest-fold').tap();
    await until('folded', async () => (await card.getAttribute('data-folded')) !== null);
    const foldedH = (await card.boundingBox())!.height;
    const foldedText = (await card.innerText()).replace(/\s+/g, ' ');
    check((await request.count()) === 0 && foldedH < openH / 3 && foldedText.includes('alpha') && foldedText.includes('펼치기'), `phone: 접기 folds it to one line (${Math.round(openH)} -> ${Math.round(foldedH)} px: "${foldedText}")`);
    await shot('phone-card-folded', ph.page);
    await card.getByTestId('quest-fold').tap();
    await until('unfolded', async () => (await card.getAttribute('data-folded')) === null && (await request.count()) === 1);
    check(true, 'phone: 펼치기 opens it again');
    if (!questOnly) {
      // The usage row (the desktop control center's folded usage): Claude's figure on one row, a tap opens the sheet.
      const strip = ph.page.getByTestId('cc-seg-usage');
      await until('the phone usage row', async () => (await strip.count()) === 1 && (await strip.locator('[data-agent="claude"]').count()) === 1, 30_000);
      check((await strip.locator('[data-agent="claude"]').getAttribute('data-left')) === '39', 'phone: Claude has 39% left on the row');
      await strip.tap();
      const sheet = ph.page.getByTestId('cc-usage-sheet');
      await sheet.waitFor({ timeout: 5_000 });
      const dText = (await sheet.innerText()).replace(/\s+/g, ' ');
      check(/39%/.test(dText) && /모름/.test(dText) && !dText.includes('초기화됨'), `phone: the sheet says what is left, Codex 모름 ("${dText}")`);
      for (const w of [360, 390]) {
        await ph.page.setViewportSize({ width: w, height: 844 });
        await wait(300);
        const f = await ph.page.evaluate(() => ({ right: Math.round(document.querySelector('[data-testid="cc-usage-sheet"]')!.getBoundingClientRect().right), width: window.innerWidth, scroll: document.documentElement.scrollWidth > window.innerWidth + 1 }));
        check(!f.scroll && f.right <= f.width, `phone ${w}: the sheet fits the screen (right edge ${f.right} <= ${f.width}, no sideways scroll)`);
        await shot(`phone-usage-open-${w}`, ph.page);
      }
      await ph.page.getByTestId('cc-usage-sheet-close').tap();
    }
    // 답하기: the card folds and the composer has the focus, on screen with the keyboard's half height gone.
    await card.getByTestId('question-answer').tap();
    await until('folded on 답하기', async () => (await card.getAttribute('data-folded')) !== null);
    const box = pa.getByRole('textbox', { name: '보낼 글' });
    check(await box.evaluate((el) => el === document.activeElement), 'phone: 답하기 folds the card and focuses the composer');
    await ph.page.setViewportSize({ width: 390, height: 460 });
    await wait(500);
    const bb = (await box.boundingBox())!;
    check(bb.y >= 0 && bb.y + bb.height <= 460, `phone: with the keyboard up (460 px left) the composer is on screen (y ${Math.round(bb.y)}..${Math.round(bb.y + bb.height)})`);
    await shot('phone-answer-keyboard', ph.page);
    await ph.page.setViewportSize({ width: 390, height: 844 });
    await box.fill('콕핏은 B안, 건물은 A안으로 가 주세요');
    await pa.getByRole('button', { name: '보내기', exact: true }).tap(); // a phone's Enter is a new line
    await pa.getByText('콕핏은 B안').first().waitFor({ timeout: 10_000 });
    // Claude's transcript gets the boss's line when the session takes it (the engine fake leaves that to us).
    rec({ type: 'user', message: { role: 'user', content: '[사장 · 메신저 · 11-04 19:45] ⟨m:aaaaaaa2⟩\n콕핏은 B안, 건물은 A안으로 가 주세요' } });
    await until('the card goes once sent', async () => (await card.count()) === 0, 20_000);
    check(true, 'phone: sending clears the question card');
    await shot('phone-sent', ph.page);
    check(await ph.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'phone: no horizontal page scroll');
    await ph.ctx.close();

    if (!questOnly) {
      // ── desktop ── a new question, then the top bar and 답하기.
      await wait(1_500);
      askQuestion();
      const da = await openAlpha(desk.page, false);
      const dcard = da.getByTestId('question-card');
      await dcard.waitFor({ timeout: 20_000 });
      const dreq = await dcard.getByTestId('question-request').innerText();
      check(!dreq.includes('**'), 'desktop: the request has no raw **');
      const bar = desk.page.getByTestId('usage-folded');
      await until('the desktop usage', async () => (await bar.count()) === 1 && /남음 39%/.test(await bar.innerText()), 30_000);
      const barText = (await bar.innerText()).replace(/\s+/g, ' ');
      check(/Claude.*남음 39%/.test(barText) && /Codex.*모름/.test(barText) && !barText.includes('초기화됨'), `desktop: the top bar reads the same figures ("${barText}")`);
      const dTitle = await bar.locator('[data-provider="claude"] [data-window="7d"]').getAttribute('title');
      check(/주간 61% 사용 · 남음 39% · \d\d-\d\d \d\d:\d\d 초기화/.test(dTitle ?? ''), `desktop: hover title "${dTitle}"`);
      await dcard.getByTestId('question-answer').click();
      check(await da.getByRole('textbox', { name: '보낼 글' }).evaluate((el) => el === document.activeElement) && (await dcard.getAttribute('data-folded')) === null, 'desktop: 답하기 focuses the composer, the card stays open');
      await shot('desktop-card', desk.page);
      await dcard.getByTestId('quest-fold').click();
      check((await dcard.getAttribute('data-folded')) !== null, 'desktop: 접기 folds it too');
      await shot('desktop-card-folded', desk.page);
    }
    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    await browser?.contexts().at(-1)?.pages()[0]?.screenshot({ path: path.join(OUT, 'debug.png') }).catch(() => undefined);
    console.error(`daemon log (end):\n${daemon.log.join('').split('\n').slice(-30).join('\n')}`);
    throw err;
  } finally {
    await browser?.close().catch(() => undefined);
    if (server.exitCode === null && server.signalCode === null) {
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
