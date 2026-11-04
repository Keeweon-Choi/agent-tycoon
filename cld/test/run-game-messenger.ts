/**
 * GAME-UI-1 G1 end to end on the REAL API: dist/cli.js with --engine on --allow-chat in a temp HOME whose
 * `claude` is the engine fake (no real agent), headless Chromium (--disable-gpu), desktop 1400x900 and a
 * 390x844 phone. The lead's words are transcript records this runner writes.
 *  1. 01 dialogue: history shows at once (plates, portrait frames, no typing); every new reply types in, a time
 *     per sentence (533 ms, 5 s at most), with a ▶ 넘기기 button; a long one types too and folds behind the
 *     purple ▼ in the box's corner (▲ folds it again; no text button under it); a click on the box, Space or Enter
 *     outside a field shows the sentence being typed whole, the second press the whole reply (· 건너뜀); the ▶ 넘기기
 *     button shows it all at once; in the composer Space is a space and Enter sends (typing carries on); 타자 효과 끔
 *     shows the next line whole. A 답글 pressed while text is in the composer, or while a held message is being
 *     edited (it re-points that message), shows its chip at once and leaves the text alone; × removes it
 *  2. 02 quest card: a permission wait is a quest card; 허용 stamps only after the daemon answered the
 *     dialog (start, middle, end photos), then the card folds into a 허용함 record; Y / N on the keyboard
 *     (focus outside the composer) answer nothing, 거부 on the button denies the next one: a dim 거부함 record
 *  3. 04 envelope: 보내기 flies the envelope to alpha's row (start, middle, end photos), the row pops
 *     ✓ 전달됨 once the send result says delivered, and gives the time back
 *  4. 게임 효과 끔: no typing, no envelope, the answered card folds at once
 *  5. phone, and one picture beside the mock (01, 02, 04)
 * Screenshots in cld/artifacts/game-messenger/.
 *
 *   npx tsx cld/test/run-game-messenger.ts <port 18316|18317|18490|18491>
 */
import type { Locator, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import { assertPortFree, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (![18316, 18317, 18490, 18491].includes(port)) throw new Error('port must be 18316, 18317, 18490 or 18491');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/msg-type-1104');
const MOCK = path.join(REPO_ROOT, '../specs/ui-mock-1103/ideas/messenger');
const DEADLINE_MS = 300_000;
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__gm/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const SHORT = 'deploy check 를 돌릴게요. 결과가 나오면 바로 알려 드릴게요.';
// Ten sentences (more than the 8 a bubble shows before 더 보기) with a code block, then English.
const FOLDY = Array.from({ length: 10 }, (_, i) => `${i + 1}번째 문장이에요.`).join(' ') + '\n\n```ts\nconst a = 1.5;\n```';
const ENGLISH = 'Deployment finished without any problem. Every check passed on staging. Nothing else to do.';
const LONG = '정리했어요. 바꾼 곳은 세 군데예요.\n\n1. `core/src/cld/work.ts` 상태 네 개를 따로 셈\n2. `EvidenceLeds.tsx` LED 칸 네 개\n3. `evidence.ts` 보고만 있는 시험은 half 로';

let oks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  oks++;
  console.log(`ok - ${what}`);
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(what: string, ok: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  for (const end = Date.now() + ms; !(await ok()); await wait(50)) if (Date.now() > end) throw new Error(`timed out: ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(path.join(configDirectory(home), 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(configDirectory(home), 'projects.json'), JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true }]));
  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'], {
    FAKE_TURN_MS: '600',
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
  process.once('unhandledRejection', (e) => abort(`unhandled: ${String(e)}`));

  type Sess = { sessionId: string; cwd: string; name: string; jobId: string };
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
  const say = (text: string) => rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
  const boss = (text: string) => rec({ type: 'user', message: { role: 'user', content: `[사장 · 메신저 · 11-03 19:40] ⟨m:${(++uuid).toString(16).padStart(8, 'a')}⟩\n${text}` } });
  const ask = (toolId: string, description: string, command: string) => {
    rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: toolId, name: 'Bash', input: { command, description } }] } });
    fs.writeFileSync(path.join(home, `fake-perm-${alphaSession()!.jobId}`), JSON.stringify({ title: 'Bash command', desc: description, command }));
  };
  const done = (toolId: string) => rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }] } });
  const answers = () => {
    const f = path.join(home, 'fake-claude-answers.log');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').split('\n').filter(Boolean) : [];
  };

  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    await until('the engine started alpha', () => !!alphaSession(), 40_000);
    rec({ type: 'permission-mode', permissionMode: 'bypassPermissions' });
    boss('FR-TRC-008 네 가지 상태가 따로 보이게 해 줘. 시험 결과도 같이.');
    say(LONG);
    boss('좋아. 배포 확인까지 돌려 줘.');
    say('시험은 다 통과했어요. 이제 배포 확인을 돌리려면 허락이 필요해요.');
    const url = await daemon.loginUrl();
    await wait(4_000); // past the page's resync quiet
    browser = await launchBrowser();
    const font = fs.existsSync(FONT) ? fs.readFileSync(FONT) : null;
    const newPage = async (opts: Parameters<NonNullable<typeof browser>['newContext']>[0]) => {
      const ctx = await browser!.newContext(opts);
      await ctx.addInitScript('globalThis.__name = (fn) => fn;'); // tsx names the functions it hands the page
      if (font) await ctx.route('**/__gm/malgun.ttf', (r) => r.fulfill({ body: font, contentType: 'font/ttf' }));
      const page = await ctx.newPage();
      page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
      return { ctx, page };
    };
    const { ctx, page } = await newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    if (font) await page.addStyleTag({ content: FONT_CSS });
    const infoClose = page.getByRole('button', { name: '정보 창 닫기' });
    if (await infoClose.count()) await infoClose.click();
    const shot = (name: string, p: Page = page) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const openAlpha = async (p: Page, touch = false) => {
      const tap = (l: Locator) => (touch ? l.tap() : l.click());
      await p.getByRole('button', { name: /^메신저/ }).waitFor();
      await tap(p.getByRole('button', { name: /^메신저/ }));
      const messenger = p.getByRole('region', { name: '메신저', exact: true });
      await tap(messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }));
      return { messenger, alpha: messenger.getByRole('region', { name: 'alpha 대화' }) };
    };
    const { messenger, alpha } = await openAlpha(page);
    const blur = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

    // ── 1. 01 dialogue ──
    await until('the history', async () => (await alpha.locator('.dlg-box').count()) >= 4);
    const leadPlate = alpha.locator('.dlg-box[data-kind="lead"] .dlg-plate').first();
    check((await alpha.getByTestId('dlg-typing').count()) === 0 && (await alpha.getByTestId('dlg-skip').count()) === 0 && (await alpha.locator('.dlg-next').count()) === 0, '1: history shows at once: no typing, no 넘기기 button, no ▼');
    check((await alpha.locator('.dlg-pf').count()) >= 1 && (await leadPlate.innerText()).includes('alpha'), `1: the lead's line has a portrait frame and the plate "${(await leadPlate.innerText()).replace(/\s+/g, ' ')}"`);
    check((await alpha.locator('.dlg-box[data-kind="boss"] .dlg-plate').first().innerText()) === '나', '1: the boss\'s line carries the 나 plate');
    await shot('01-dialogue-history');

    // The page samples the typed text every frame (screenshots are too slow to time it).
    const sampled = page.evaluate(
      () =>
        new Promise<Array<[number, number]>>((resolve) => {
          const out: Array<[number, number]> = [];
          const end = performance.now() + 15_000;
          const tick = () => {
            const el = document.querySelector('[data-testid="dlg-typing"]');
            if (el) out.push([performance.now(), (el.textContent ?? '').length]);
            else if (out.length) return resolve(out);
            if (performance.now() > end) return resolve(out);
            requestAnimationFrame(tick);
          };
          tick();
        }),
    );
    say(SHORT);
    await alpha.getByTestId('dlg-typing').waitFor({ timeout: 15_000 });
    await shot('02-typing-start');
    const skipBtn = alpha.getByTestId('dlg-skip');
    check((await skipBtn.count()) === 1 && (await skipBtn.innerText()).includes('넘기기'), '1: while it types the box carries the ▶ 넘기기 button');
    await shot('02-typing-middle');
    await alpha.getByTestId('dlg-typing').waitFor({ state: 'detached', timeout: 5_000 });
    const samples = await sampled;
    const took = samples.at(-1)![0] - samples[0][0];
    const lens = [...new Set(samples.map((x) => x[1]))];
    check(lens.length >= 5 && lens.every((n, i) => !i || n >= lens[i - 1]) && lens[0] < SHORT.length, `1: the new short line types in (${lens.length} steps of ${SHORT.length} characters)`);
    check(took >= 530 && took <= 5_000 + 400, `1: two sentences take about 2 x 533 ms (${Math.round(took)} ms from its first frame to its last)`);
    check((await alpha.locator('.dlg-box').last().innerText()).includes('알려 드릴게요') && (await skipBtn.count()) === 0 && (await alpha.locator('.dlg-next').count()) === 0, '1: the whole line is there at the end, the 넘기기 button and any ▼ are gone');
    await shot('02-typing-end');

    // A long reply (10 sentences and a code block) types too, within the 2.4 s cap; a click on the box shows it whole.
    say(FOLDY);
    await alpha.getByTestId('dlg-typing').waitFor({ timeout: 15_000 });
    const typedLen = async () => (await alpha.getByTestId('dlg-typing').textContent())?.length ?? 0;
    let sum = 0;
    const ends = Array.from({ length: 10 }, (_, i) => (sum += Array.from(`${i + 1}번째 문장이에요. `).length));
    const before = await typedLen();
    await alpha.locator('.dlg-box').last().click({ position: { x: 20, y: 20 } });
    await wait(40);
    const after = await typedLen();
    check(ends.some((e) => e > before && after >= e && after <= e + 4) && (await alpha.getByTestId('dlg-typing').count()) === 1 && (await alpha.getByTestId('dlg-skipped').count()) === 0, `1: the first click on the box finishes the sentence being typed (${before} -> ${after} characters), the rest types on`);
    await shot('03-long-typing');
    await alpha.locator('.dlg-box').last().click({ position: { x: 20, y: 20 } });
    await alpha.getByTestId('dlg-skipped').waitFor({ timeout: 2_000 });
    check((await alpha.getByTestId('dlg-typing').count()) === 0 && (await alpha.getByTestId('dlg-tag').count()) === 0, '1: a long reply types in (no 긴 답 tag), the second click shows it all (· 건너뜀)');
    const fold = alpha.getByTestId('fold-toggle').last();
    const iconOf = () => fold.locator('svg').getAttribute('data-icon');
    const lastBox = alpha.locator('.dlg-box').last();
    const fb = (await fold.boundingBox())!;
    const bb = (await lastBox.boundingBox())!;
    check(
      (await alpha.locator('.dlg-box > [data-testid="fold-toggle"]').count()) === 1 &&
        (await fold.innerText()) === '' &&
        (await fold.getAttribute('aria-label')) === '더 보기' &&
        (await fold.getAttribute('aria-expanded')) === 'false' &&
        (await iconOf()) === 'next' &&
        fb.x + fb.width <= bb.x + bb.width + 1 && fb.y + fb.height <= bb.y + bb.height + 1 && fb.x > bb.x + bb.width / 2 && fb.y > bb.y + bb.height / 2 &&
        !(await lastBox.innerText()).includes('10번째') &&
        (await alpha.getByText('더 보기', { exact: true }).count()) === 0,
      '1: more than 8 sentences fold behind a purple ▼ in the box\'s bottom right corner (named 더 보기), no text button under the message',
    );
    check((await fold.evaluate((el) => getComputedStyle(el).animationName)) === 'none', '1: the triangle does not blink');
    check((await alpha.locator('.dlg-box').filter({ hasText: '알려 드릴게요' }).getByTestId('fold-toggle').count()) === 0, '1: a short reply has no triangle');
    await shot('03-long-folded');
    await fold.click();
    check((await iconOf()) === 'up' && (await fold.getAttribute('aria-label')) === '접기' && (await fold.getAttribute('aria-expanded')) === 'true' && (await lastBox.innerText()).includes('10번째 문장이에요'), '1: pressing ▼ opens it whole, the triangle turns ▲ (접기)');
    await shot('03-long-open');
    await fold.focus();
    await page.keyboard.press('Enter');
    check((await iconOf()) === 'next' && !(await lastBox.innerText()).includes('10번째'), '1: ▲ folds it again; the keyboard works on the triangle (Enter)');

    await blur();
    say('시작했어요. 2분쯤 걸려요. 그동안 T-5 시험 기록을 다시 볼게요.');
    await alpha.getByTestId('dlg-typing').waitFor({ timeout: 15_000 });
    const skippedNow = await alpha.getByTestId('dlg-skipped').count();
    await page.keyboard.press('Space');
    await wait(40);
    const len = await typedLen();
    check((await alpha.getByTestId('dlg-typing').count()) === 1 && [7, 16].some((e) => (len >= e && len <= e + 4)) && (await alpha.getByTestId('dlg-skipped').count()) === skippedNow, `1: the first Space (focus outside a field) finishes the sentence being typed, the next ones are not there yet (${len} characters)`);
    await page.keyboard.press('Space');
    await until('the second Space showed it all', async () => (await alpha.getByTestId('dlg-typing').count()) === 0, 2_000);
    check((await alpha.locator('.dlg-box').last().innerText()).includes('다시 볼게요') && (await alpha.getByTestId('dlg-skipped').count()) === skippedNow + 1, '1: the second Space shows it all, · 건너뜀 in its meta line');
    await shot('04-skipped');
    say(ENGLISH);
    await alpha.getByTestId('dlg-typing').waitFor({ timeout: 15_000 });
    await page.keyboard.press('Enter');
    await wait(80);
    check((await alpha.getByTestId('dlg-typing').count()) === 1, '1: the first Enter finishes the first sentence of an English reply only');
    await page.keyboard.press('Enter');
    await alpha.getByTestId('dlg-typing').waitFor({ state: 'detached', timeout: 2_000 });
    check((await alpha.locator('.dlg-box').last().innerText()).includes('Nothing else to do.'), '1: the second Enter shows an English reply whole');
    say('버튼으로도 넘겨요. 한 번에 다 보여요. 정말로요.');
    await alpha.getByTestId('dlg-typing').waitFor({ timeout: 15_000 });
    await alpha.getByTestId('dlg-skip').click();
    await alpha.getByTestId('dlg-typing').waitFor({ state: 'detached', timeout: 2_000 });
    check((await alpha.locator('.dlg-box').last().innerText()).includes('정말로요'), '1: the ▶ 넘기기 button shows it whole');

    // The composer keeps its keys: Space is a space, Enter sends; the typing line is not touched by either.
    say(FOLDY);
    await alpha.getByTestId('dlg-typing').waitFor({ timeout: 15_000 });
    const skippedBefore = await alpha.getByTestId('dlg-skipped').count();
    const field = alpha.getByRole('textbox', { name: '보낼 글' });
    await field.focus();
    await page.keyboard.type('a b');
    check((await field.inputValue()) === 'a b' && (await alpha.getByTestId('dlg-typing').count()) === 1, '1: Space in the composer is a space and does not skip the typing line');
    await page.keyboard.press('Enter');
    await page.getByTestId('mail-envelope').waitFor({ timeout: 2_000 }); // the send flew off
    check((await field.inputValue()) === '' && (await alpha.getByTestId('dlg-skipped').count()) === skippedBefore, '1: Enter in the composer sends the message (the envelope flies, the composer is empty) and skips nothing');
    await shot('04b-composer-keys');
    // A 답글 pressed with text in the composer: the chip is there at once, the text is untouched; × removes it.
    await field.fill('half written');
    await alpha.getByTestId('message-actions').first().getByRole('button', { name: '답글' }).dispatchEvent('click');
    await alpha.getByTestId('reply-chip').waitFor({ timeout: 1_000 });
    check((await field.inputValue()) === 'half written' && (await alpha.getByTestId('reply-chip').count()) === 1, '1: 답글 with text in the composer: the chip shows at once and the text stays');
    await alpha.getByRole('button', { name: '답글 취소' }).click();
    check((await alpha.getByTestId('reply-chip').count()) === 0 && (await field.inputValue()) === 'half written', '1: × removes the chip, the text stays');
    await field.fill('');
    await until('the envelope and badge gone', async () => (await page.getByTestId('mail-envelope').count()) === 0 && (await page.getByTestId('delivered-badge').count()) === 0, 20_000);

    const sw = alpha.getByTestId('typing-switch');
    await sw.click();
    check((await sw.getAttribute('aria-pressed')) === 'false' && (await sw.innerText()).includes('끔'), '1: 타자 효과 끔');
    say('끄면 바로 보여요.');
    await until('the line', async () => (await alpha.locator('.dlg-box').last().innerText()).includes('바로 보여요'));
    check((await alpha.getByTestId('dlg-typing').count()) === 0, '1: with 타자 효과 끔 a new line shows whole');
    await sw.click();
    check((await alpha.getByTestId('dlg-skip').count()) === 0, '1: with typing off no 넘기기 button');

    // ── 2. 02 quest card ──
    ask('toolu_q1', 'Run the deploy check', 'npm run deploy:check -- --env staging');
    const card = alpha.getByTestId('permission-card');
    await card.waitFor({ timeout: 40_000 });
    await until('the card read off the screen', async () => ((await card.getByTestId('permission-call').textContent()) ?? '').includes('deploy:check'));
    check((await card.innerText()).includes('퀘스트') && (await card.getByTestId('quest-goal').innerText()).includes('작업 재개') && (await card.locator('.dlg-pf').count()) === 1, '2: the wait is a quest card: 퀘스트, the requester portrait, the request, the reward 작업 재개');
    check((await card.getByTestId('quest-stamp').count()) === 0, '2: no stamp before an answer');
    await shot('05-quest-card');
    await card.getByRole('button', { name: /허용/ }).click();
    const stamp = card.getByTestId('quest-stamp');
    await stamp.waitFor({ timeout: 20_000 });
    await shot('06-stamp-start');
    check(answers().length === 1 && answers()[0].includes('"yes"'), '2: the stamp came after the daemon answered the dialog with "1. Yes"');
    await wait(150);
    await shot('06-stamp-middle');
    await wait(400);
    await shot('06-stamp-end');
    check((await stamp.getAttribute('data-answer')) === 'allow' && (await stamp.innerText()).includes('허용함') && (await card.getByTestId('permission-result').innerText()).includes('답했어요'), '2: a purple 허용함 stamp and 답했어요 · <time>');
    const tone = await stamp.locator('.game-stamp').evaluate((el) => [el.getAttribute('data-tone'), getComputedStyle(el).animationName]);
    check(tone[0] === 'accent' && tone[1].includes('game-stamp-drop'), `2: the stamp is the shared Stamp (${tone.join(', ')})`);
    done('toolu_q1');
    const record = alpha.getByTestId('quest-record');
    await record.first().waitFor({ timeout: 5_000 });
    check((await card.count()) === 0 && (await record.first().getAttribute('data-answer')) === 'allow' && (await record.first().innerText()).includes('허용함'), '2: the card folded into a 허용함 record in the conversation');
    await shot('07-quest-folded');

    ask('toolu_q2', 'Remove the old build', 'rm -rf dist/');
    await card.waitFor({ timeout: 40_000 });
    await until('the second card read', async () => ((await card.getByTestId('permission-call').textContent()) ?? '').includes('rm -rf'));
    await alpha.getByRole('textbox', { name: '보낼 글' }).focus();
    await page.keyboard.press('n');
    await wait(500);
    check(answers().length === 1, '2: N typed in the composer is text, not an answer');
    await alpha.getByRole('textbox', { name: '보낼 글' }).fill('');
    await blur();
    await page.keyboard.press('y');
    await page.keyboard.press('n');
    await wait(800);
    check(answers().length === 1 && (await card.count()) === 1 && (await card.getByRole('button', { name: /허용/ }).count()) === 1 && (await card.getByRole('button', { name: /거부/ }).count()) === 1, '2: Y / N with the focus outside a field answer nothing: the card and its buttons stay');
    await card.getByRole('button', { name: /거부/ }).click();
    await until('the deny record', async () => (await record.count()) === 2, 20_000);
    check(answers().length === 2 && !answers()[1].includes('"yes"') && (await record.last().getAttribute('data-answer')) === 'deny', `2: the 거부 button denies it: a dim 거부함 record (${answers()[1]})`);
    done('toolu_q2');
    await shot('08-quest-deny-record');

    // ── 3. 04 envelope ──
    const box = alpha.getByRole('textbox', { name: '보낼 글' });
    await box.fill('deploy check 결과 나오면 바로 알려 줘. 실패하면 로그 첫 줄도.');
    // Enter sends (the 보내기 button sits under the camera group's 내 캐릭터 at 1400x900; reported).
    await box.press('Enter');
    const env = page.getByTestId('mail-envelope');
    await env.waitFor({ timeout: 2_000 });
    await shot('09-envelope-start');
    await wait(220);
    await shot('09-envelope-middle');
    const row = messenger.getByRole('list', { name: '연락처' }).locator('li').filter({ hasText: 'alpha' });
    const badge = row.getByTestId('delivered-badge');
    await badge.waitFor({ timeout: 15_000 });
    await shot('09-envelope-end');
    check((await badge.innerText()).includes('전달됨'), '3: the row pops ✓ 전달됨 once the send result says delivered');
    await until('the envelope landed', async () => (await env.count()) === 0, 3_000);
    check(true, '3: the envelope is gone after landing');
    await until('the time back', async () => (await badge.count()) === 0, 4_000);
    check(true, '3: the badge gives the time back');

    // ── 3b. 답글 while a held message is edited ──
    ask('toolu_q4', 'Check the disk', 'df -h');
    await card.waitFor({ timeout: 40_000 });
    // Editing a held message (the lead waits for a permission, so a message to it queues): 답글 on another message
    // shows its chip at once, beside the text being edited; saving re-points the held message to it.
    const editBox = alpha.getByRole('textbox', { name: '보낼 글' });
    await editBox.fill('held words');
    await editBox.press('Enter');
    const held = alpha.locator('[data-testid="pending"]', { hasText: 'held words' });
    await held.getByRole('button', { name: '수정' }).waitFor({ timeout: 20_000 });
    await held.getByRole('button', { name: '수정' }).click();
    await until('the edit box holds the held words', async () => (await editBox.inputValue()) === 'held words');
    await editBox.press('End');
    await page.keyboard.type(' more');
    await alpha.getByTestId('message-actions').first().getByRole('button', { name: '답글' }).dispatchEvent('click');
    await alpha.getByTestId('reply-chip').waitFor({ timeout: 1_000 });
    check((await editBox.inputValue()) === 'held words more' && (await alpha.getByTestId('reply-chip').count()) === 1 && (await alpha.getByText('메시지 수정 중').count()) === 1, '2: 답글 while a held message is edited: the chip shows at once beside the edit, the text stays');
    await alpha.getByRole('button', { name: '답글 취소' }).click();
    check((await alpha.getByTestId('reply-chip').count()) === 0 && (await editBox.inputValue()) === 'held words more', '2: × removes the chip during the edit, the text stays');
    await alpha.getByTestId('message-actions').first().getByRole('button', { name: '답글' }).dispatchEvent('click');
    await alpha.getByTestId('reply-chip').waitFor({ timeout: 1_000 });
    await editBox.press('Enter');
    await held.getByText('수정함').waitFor({ timeout: 10_000 });
    check((await held.getByTestId('reply-quote').count()) === 1 && (await alpha.getByTestId('reply-chip').count()) === 0 && (await editBox.inputValue()) === '', '2: saving the edit carries the reply to the held message (its quote), the composer is clear');
    await held.hover();
    await held.getByRole('button', { name: '취소' }).click();
    await held.waitFor({ state: 'detached', timeout: 10_000 });
    await card.getByRole('button', { name: /거부/ }).click();
    await until('the card folded', async () => (await card.count()) === 0, 20_000);
    done('toolu_q4');
    await wait(1_000);

    // ── 4. 게임 효과 끔 ──
    await page.evaluate(() => localStorage.setItem('cld.game-effects', 'off'));
    await page.reload();
    if (font) await page.addStyleTag({ content: FONT_CSS });
    const off = await openAlpha(page);
    check((await page.evaluate(() => document.documentElement.dataset.gameMotion)) === 'off', '4: 게임 효과 끔: data-game-motion off');
    await until('the conversation', async () => (await off.alpha.locator('.dlg-box').count()) >= 4);
    say('효과를 끄면 글이 바로 보여요.');
    await until('the line', async () => (await off.alpha.locator('.dlg-box').last().innerText()).includes('바로 보여요'));
    check((await off.alpha.getByTestId('dlg-typing').count()) === 0, '4: no typing without game motion');
    ask('toolu_q3', 'Tag the release', 'git tag v1.2.0');
    const card3 = off.alpha.getByTestId('permission-card');
    await card3.waitFor({ timeout: 40_000 });
    await until('the third card read', async () => ((await card3.getByTestId('permission-call').textContent()) ?? '').includes('git tag'));
    await card3.getByRole('button', { name: /허용/ }).click();
    await until('the record at once', async () => (await off.alpha.getByTestId('quest-record').count()) >= 1 && (await card3.count()) === 0, 20_000);
    check(answers().length === 4, '4: answered, folded at once into its record (no stamp moment)');
    done('toolu_q3');
    await off.alpha.getByRole('textbox', { name: '보낼 글' }).fill('효과 끔에서도 보내져요');
    await off.alpha.getByRole('textbox', { name: '보낼 글' }).press('Enter');
    await wait(300);
    check((await page.getByTestId('mail-envelope').count()) === 0, '4: no envelope flies');
    await wait(500);
    await shot('10-effects-off');
    await page.evaluate(() => localStorage.setItem('cld.game-effects', 'on'));
    const state = await ctx.storageState();
    await ctx.close();

    // ── 5. phone ──
    const ph = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: state });
    await ph.page.goto(`http://127.0.0.1:${port}/`);
    if (font) await ph.page.addStyleTag({ content: FONT_CSS });
    const pa = await openAlpha(ph.page, true);
    await until('the phone conversation', async () => (await pa.alpha.locator('.dlg-box').count()) >= 4);
    await wait(500);
    check(await ph.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), '5: no horizontal page scroll at 390 px');
    const phoneBox = pa.alpha.getByRole('textbox', { name: '보낼 글' });
    await phoneBox.fill('phone draft');
    const cdp = await ph.ctx.newCDPSession(ph.page);
    await pa.alpha.locator('.dlg-box').last().scrollIntoViewIfNeeded();
    const target = (await pa.alpha.locator('.dlg-box').last().boundingBox())!;
    const point = { x: target.x + Math.min(24, target.width / 2), y: target.y + Math.min(12, target.height / 2) };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] }); // a hold opens the message's sheet
    await wait(800);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await ph.page.getByTestId('message-sheet').getByRole('menuitem', { name: '답글' }).tap();
    await pa.alpha.getByTestId('reply-chip').waitFor({ timeout: 1_000 });
    check((await phoneBox.inputValue()) === 'phone draft', '5: phone: 답글 with text in the composer shows the chip at once, the text stays');
    await shot('11-phone', ph.page);
    await ph.ctx.close();

    // ── beside the mock ──
    const side = await browser.newPage({ viewport: { width: 1420, height: 900 } });
    const img = (f: string) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
    const pair = (mock: string, ours: string) =>
      `<div style="display:flex;gap:20px"><figure style="margin:0;width:700px"><figcaption>mock ${mock}</figcaption><img src="${img(path.join(MOCK, mock))}" style="width:700px"></figure>` +
      `<figure style="margin:0;width:700px"><figcaption>G1 ${ours}</figcaption><img src="${img(path.join(OUT, ours))}" style="width:700px"></figure></div>`;
    await side.setContent(
      `<body style="margin:0;font:14px sans-serif;background:white">${pair('01-dialogue.png', '02-typing-end.png')}${pair('02-quest-card.png', '06-stamp-end.png')}${pair('04-envelope.png', '09-envelope-middle.png')}</body>`,
    );
    await side.screenshot({ path: path.join(OUT, '12-beside-mock.png'), fullPage: true });
    await side.close();
    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    console.error(`daemon log (end):\n${daemon.log.join('').split('\n').slice(-40).join('\n')}`);
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
