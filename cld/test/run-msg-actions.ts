/**
 * MSG-ACTIONS in the real messenger: dist/cli.js with --engine on --allow-chat in an
 * isolated HOME whose `claude` is the engine fake, headless Chromium (--disable-gpu).
 *
 * Desktop (hover row) and phone 393x852 (hold → action sheet):
 * 1. 복사 on a Lead's message (the Markdown source) and on the boss's (attachments by name):
 *    the clipboard holds exactly that text.
 * 2. 답글 on a Lead's message: the chip shows above the input; the prompt the fake claude
 *    receives carries ` ⟨re:<id>⟩` after the C2 mark and the quote line; written back as the
 *    transcript record, the reply bubble shows the quote; tapping it scrolls to the original
 *    and highlights it.
 * 3. A quote whose original sits in an older page (over 80 items back): older pages load until
 *    it is found; a quote of a message that is gone says 원래 메시지를 찾지 못했어요.
 * 4. F2 (phone room): a long press on a member's reply opens exactly ONE sheet (the reply's:
 *    복사 copies the reply text, not the post).
 * 5. MSG-UI2 (phone 390x844 and desktop): a face beside the Lead's, another agent's and a
 *    sub-agent notice's messages (once per run), no second 목록 button in a room, the room left
 *    for the list stays as a tab, the member pill opens and closes the member list, a composer
 *    attachment opens the viewer, and a queued boss message shows all four dashed borders.
 *
 *   npx tsx cld/test/run-msg-actions.ts <port 18256-18259>
 *
 * Screenshots: cld/artifacts/msg-actions/*.png
 */
import type { BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { spawnSync } from 'child_process';
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

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/msg-actions');
const DEADLINE_MS = 280_000;
const PHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 393, height: 852 } };
})();
const CLIP = ['clipboard-read', 'clipboard-write'];
const PHONE_390 = { ...PHONE, viewport: { width: 390, height: 844 } };
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__msgui2/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const PNG = path.join(REPO_ROOT, 'webview-ui/public/assets/characters/char_0.png');

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(
      ['alpha', 'beta', 'gamma'].map((name) => {
        const dir = path.join(home, 'work', name);
        fs.mkdirSync(dir, { recursive: true });
        return { name, folder: dir, room: '개발실', wantRunning: true };
      }),
    ),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
  );
  const { child: server } = daemon;
  console.log(`port ${port}, daemon pid ${server.pid}`);
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null) server.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort('deadline'), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  // ── Claude, played: records go into the session's transcript; each returns its chat item id ──
  type Sess = { sessionId: string; cwd: string; name: string; jobId: string };
  const sessionOf = (name = 'alpha'): Sess | null => {
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
  // Seeded history an hour back, a second apart; what follows the seeding is written now.
  let clock = Date.now() - 3_600_000;
  let seeding = true;
  const say = (role: 'user' | 'assistant', text: string, who = 'alpha'): string => {
    const s = sessionOf(who)!;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    clock = seeding ? clock + 1000 : Math.max(clock + 1, Date.now());
    const timestamp = new Date(clock).toISOString();
    fs.appendFileSync(
      file,
      `${JSON.stringify(
        role === 'user'
          ? { type: 'user', uuid: id, timestamp, message: { role, content: text } }
          : {
              type: 'assistant',
              uuid: id,
              timestamp,
              message: { role, content: [{ type: 'text', text }] },
            },
      )}\n`,
    );
    return `${clock}-${id.slice(0, 8)}-0`;
  };
  const typedLog = path.join(home, 'fake-claude-typed.log');
  const typed = () =>
    fs.existsSync(typedLog)
      ? fs
          .readFileSync(typedLog, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => (JSON.parse(l) as { text: string }).text.replaceAll('\r', '\n'))
      : [];
  const waitTyped = async (needle: string) => {
    for (const end = Date.now() + 20_000; Date.now() < end;) {
      const hit = typed().find((t) => t.includes(needle));
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`the fake claude never received ${JSON.stringify(needle)}`);
  };

  const browser = await launchBrowser();
  /** tsx names the arrow functions it passes to evaluate: give the page the helper it calls. */
  const nameShim = 'globalThis.__name = (fn) => fn;';
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const clip = (page: Page) => page.evaluate(() => navigator.clipboard.readText());
  const clearClip = (page: Page) => page.evaluate(() => navigator.clipboard.writeText('-'));
  const row = (conv: Locator, id: string) => conv.locator(`[data-chat-id="${id}"]`);
  const inView = (loc: Locator) =>
    loc.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const list = el.closest('[data-testid="chat-scroll"]')!.getBoundingClientRect();
      return r.bottom > list.top && r.top < list.bottom;
    });
  const flashed = (loc: Locator) =>
    loc.evaluate(
      (el) =>
        new Promise<boolean>((done) => {
          const end = Date.now() + 10_000;
          const tick = () =>
            el.dataset.focused === 'true'
              ? done(true)
              : Date.now() > end
                ? done(false)
                : setTimeout(tick, 50);
          tick();
        }),
    );

  try {
    for (const end = Date.now() + 40_000; !['alpha', 'beta', 'gamma'].every((n) => sessionOf(n));) {
      if (Date.now() > end) throw new Error('the engine did not revive alpha, beta and gamma');
      await new Promise((r) => setTimeout(r, 300));
    }
    // An old exchange, then more than a page of items (the view opens on the last 80), then the recent ones.
    say('user', '[사장 · 메신저 · 10-24 09:00] ⟨m:aaaa2222⟩\n어제 배포 어땠어?');
    const oldAnswer = say('assistant', '어제 배포는 **문제없이** 끝났어요');
    for (let i = 0; i < 120; i++) say('assistant', `기록 ${i}`);
    const bossAttach = '[첨부] /tmp/20261024-131122-plan.png (image/png, 2 KB)';
    const bossId = say(
      'user',
      `[사장 · 메신저 · 10-24 12:00] ⟨m:bbbb3333⟩\n계획 봐 줘\n${bossAttach}`,
    );
    const LEAD = '**배포 끝났어요**\n\n- alpha 성공\n- beta `npm test` 재시도';
    const leadId = say('assistant', LEAD);
    seeding = false;
    await new Promise((r) => setTimeout(r, 3_000));
    const url = await daemon.loginUrl();

    const open = async (page: Page, touch: boolean) => {
      const tap = (l: Locator) => (touch ? l.tap() : l.click());
      await tap(page.getByRole('button', { name: /^메신저/ }));
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      await tap(
        messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }),
      );
      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      await row(conv, leadId).waitFor();
      return conv;
    };

    // ════ Desktop ════
    const deskCtx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      permissions: CLIP,
    });
    await deskCtx.addInitScript(nameShim);
    const page = await deskCtx.newPage();
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const infoClose = page.getByRole('button', { name: '정보 창 닫기' });
    if (await infoClose.count()) await infoClose.click();
    const conv = await open(page, false);
    const actionsOf = (id: string) => row(conv, id).getByTestId('message-actions').first();
    check(
      (await actionsOf(leadId).evaluate((el) => getComputedStyle(el).opacity)) === '0',
      'desktop: the action row is hidden until hover or focus',
    );
    await row(conv, leadId).hover();
    await page.waitForTimeout(300);
    await shot(page, 'desktop-hover-actions');
    await clearClip(page);
    await actionsOf(leadId).getByRole('button', { name: '복사' }).click();
    await page.getByText('메시지를 복사했어요').waitFor();
    check(
      (await clip(page)) === LEAD,
      "desktop: 복사 on a Lead's message copies its Markdown source",
    );
    await clearClip(page);
    await row(conv, bossId).hover();
    await actionsOf(bossId).getByRole('button', { name: '복사' }).click();
    for (const end = Date.now() + 5_000; (await clip(page)) === '-' && Date.now() < end;)
      await page.waitForTimeout(100);
    check(
      (await clip(page)) === '계획 봐 줘\nplan.png',
      "desktop: 복사 on the boss's message copies its words and the attachment's name",
    );
    // Keyboard: Tab reaches the row (focus shows it).
    await actionsOf(leadId).getByRole('button', { name: '답글' }).focus();
    check(
      (await actionsOf(leadId).evaluate((el) => getComputedStyle(el).opacity)) === '1',
      'desktop: the row shows on keyboard focus',
    );

    // 답글 on the Lead's message.
    await actionsOf(leadId).getByRole('button', { name: '답글' }).click();
    const box = conv.getByRole('textbox', { name: '보낼 글' });
    const chip = conv.getByTestId('reply-chip');
    check(
      (await chip.innerText()).startsWith('↩ alpha · **배포 끝났어요** - alpha 성공'),
      `desktop: the reply chip names the sender and the start (${await chip.innerText()})`,
    );
    check(
      await box.evaluate((el) => el === document.activeElement),
      'desktop: 답글 focuses the input',
    );
    await box.fill('beta 다시 돌려 줘');
    await shot(page, 'desktop-reply-chip');
    await box.press('Enter');
    const prompt = await waitTyped('beta 다시 돌려 줘');
    console.log(`  typed: ${JSON.stringify(prompt)}`);
    const lines = prompt.split('\n');
    check(
      new RegExp(` ⟨m:[a-z2-7]{8}⟩ ⟨re:${leadId}⟩$`).test(lines[0]) &&
        lines[1].startsWith('> alpha: **배포 끝났어요** - alpha 성공') &&
        lines[2] === 'beta 다시 돌려 줘',
      'desktop: the prompt the agent gets has ⟨re:id⟩ after the C2 mark, then the quote line',
    );
    check((await chip.count()) === 0, 'desktop: sending clears the chip');
    // The transcript records the prompt: the bubble is the reply, with its quote.
    const replyId = say('user', prompt);
    const quote = row(conv, replyId).getByTestId('reply-quote');
    await quote.waitFor();
    check(
      (await row(conv, replyId).innerText()).includes('beta 다시 돌려 줘') &&
        !(await row(conv, replyId).innerText()).includes('⟨re:'),
      'desktop: the reply bubble shows its text without the header marks',
    );
    await shot(page, 'desktop-reply-bubble');
    // Push the original out of view, then go back through the quote.
    await conv.getByTestId('chat-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
    say('assistant', `다른 이야기\n${'x\n'.repeat(80)}`);
    await page.waitForTimeout(1_500);
    await conv.getByTestId('chat-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
    check(
      !(await inView(row(conv, leadId))),
      'desktop: the original is out of view before the tap',
    );
    await quote.click();
    check(await flashed(row(conv, leadId)), 'desktop: tapping the quote highlights the original');
    check(await inView(row(conv, leadId)), 'desktop: … and scrolls it into view');
    await shot(page, 'desktop-quote-jump');

    // A quote of a message over a page back, and one of a message that is gone.
    const farId = say(
      'user',
      `[사장 · 메신저 · 10-24 12:30] ⟨m:cccc4444⟩ ⟨re:${oldAnswer}⟩\n> alpha: 어제 배포는 문제없이 끝났어요\n그때 로그 다시 보여 줘`,
    );
    const goneId = say(
      'user',
      '[사장 · 메신저 · 10-24 12:31] ⟨m:dddd5555⟩ ⟨re:1-gone0000-0⟩\n> alpha: 지워진 말\n이건 원본이 없어요',
    );
    await row(conv, goneId).waitFor();
    check(
      (await row(conv, oldAnswer).count()) === 0,
      'desktop: the old answer is not loaded at first',
    );
    await row(conv, farId).getByTestId('reply-quote').click();
    await row(conv, oldAnswer).waitFor({ timeout: 30_000 });
    check(
      await flashed(row(conv, oldAnswer)),
      'desktop: older pages load until the original is found, then it is highlighted',
    );
    await shot(page, 'desktop-quote-older-page');
    await conv.getByTestId('chat-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await row(conv, goneId).getByTestId('reply-quote').click();
    await page.getByText('원래 메시지를 찾지 못했어요').waitFor({ timeout: 30_000 });
    console.log('ok - desktop: a quote whose original is gone says 원래 메시지를 찾지 못했어요');
    await shot(page, 'desktop-quote-not-found');

    // ════ Phone (touch, 393x852) ════
    const phoneCtx = await browser.newContext({
      ...PHONE,
      permissions: CLIP,
      storageState: await deskCtx.storageState(),
    });
    await phoneCtx.addInitScript(nameShim);
    const phone = await phoneCtx.newPage();
    await phone.goto(`http://127.0.0.1:${port}/`);
    await phone.getByRole('button', { name: /^메신저/ }).waitFor();
    const pconv = await open(phone, true);
    check(
      await phone.evaluate(() => matchMedia('(pointer: coarse)').matches),
      'phone: a coarse pointer (the row is hidden; a hold opens the sheet)',
    );
    const cdp = await phoneCtx.newCDPSession(phone);
    const hold = async (loc: Locator) => {
      await loc.scrollIntoViewIfNeeded();
      // MSG-UI3: rows carry an avatar and a bubble aligned to a side; hold on the bubble itself.
      const b = (await loc.locator('div.border').first().boundingBox())!;
      const point = { x: b.x + Math.min(24, b.width / 2), y: b.y + Math.min(12, b.height / 2) };
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
      await phone.waitForTimeout(800);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const sheet = phone.getByTestId('message-sheet');
    await hold(row(pconv, leadId));
    await sheet.waitFor();
    await shot(phone, 'phone-action-sheet');
    await clearClip(phone);
    await sheet.getByRole('menuitem', { name: '복사' }).tap();
    for (const end = Date.now() + 5_000; (await clip(phone)) === '-' && Date.now() < end;)
      await phone.waitForTimeout(100);
    check(
      (await clip(phone)) === LEAD && (await sheet.count()) === 0,
      "phone: hold → 복사 copies the Lead's message and closes the sheet",
    );
    await hold(row(pconv, bossId));
    await sheet.getByRole('menuitem', { name: '답글' }).tap();
    const pchip = pconv.getByTestId('reply-chip');
    const pbox = pconv.getByRole('textbox', { name: '보낼 글' });
    await pchip.waitFor();
    await pbox.fill('이 계획대로 해 줘');
    const geo = await phone.evaluate(() => {
      const vv = window.visualViewport!;
      const rect = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
      const chip = rect('[data-testid="reply-chip"]');
      const input = (
        document.querySelector('textarea[aria-label="보낼 글"]') as HTMLElement
      ).getBoundingClientRect();
      return {
        chipBottom: chip.bottom,
        inputTop: input.top,
        inputBottom: input.bottom,
        vh: vv.height,
        fits: document.documentElement.scrollWidth <= innerWidth,
      };
    });
    check(
      geo.chipBottom <= geo.inputTop && geo.inputBottom <= geo.vh && geo.fits,
      `phone: the chip sits above the input line, which stays on screen (${JSON.stringify(geo)})`,
    );
    check(
      (await pchip.innerText()).startsWith('↩ 나 · 계획 봐 줘 plan.png'),
      `phone: the chip quotes the boss as 나 (${await pchip.innerText()})`,
    );
    await shot(phone, 'phone-reply-chip');
    await pconv.getByRole('button', { name: '보내기' }).tap();
    const pprompt = await waitTyped('이 계획대로 해 줘');
    check(
      / ⟨m:[a-z2-7]{8}⟩ ⟨re:bbbb3333⟩\n> 사장: 계획 봐 줘 plan\.png\n이 계획대로 해 줘$/.test(
        pprompt,
      ),
      `phone: a reply to the boss's own message names its C2 id and quotes 사장 (${JSON.stringify(pprompt)})`,
    );
    const preply = say('user', pprompt);
    const pquote = row(pconv, preply).getByTestId('reply-quote');
    await pquote.waitFor();
    await pconv.getByTestId('chat-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));
    await shot(phone, 'phone-reply-bubble');
    await pquote.tap();
    check(await flashed(row(pconv, bossId)), 'phone: tapping the quote highlights the original');
    await shot(phone, 'phone-quote-jump');

    // ════ MSG-UI2 + F2: a room, faces, the member pill, attachments, the dashed box ════
    // Beta and gamma answer a room post the way their sessions would: the typed prompt becomes the
    // user record, then a reply goes in below it.
    const REPLIES: Record<string, string> = {
      alpha: '알파 확인했어요: 배포는 문제없어요',
      beta: '베타도 확인했어요',
      gamma: '감마 확인 완료',
    };
    const typedRaw = () =>
      fs.existsSync(typedLog)
        ? fs
            .readFileSync(typedLog, 'utf-8')
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l) as { id: string; text: string })
        : [];
    let seen = typedRaw().length;
    const replier = setInterval(() => {
      const all = typedRaw();
      for (const item of all.slice(seen)) {
        const who = ['alpha', 'beta', 'gamma'].find((n) => sessionOf(n)?.jobId === item.id);
        if (!who || !item.text.includes("단톡방 '출시팀'")) continue;
        say('user', item.text.replaceAll('\r', '\n'), who);
        say('assistant', REPLIES[who], who);
      }
      seen = all.length;
    }, 100);
    try {
      const ctx2 = await browser.newContext({
        ...PHONE_390,
        permissions: CLIP,
        storageState: await deskCtx.storageState(),
      });
      await ctx2.addInitScript(nameShim);
      if (fs.existsSync(FONT))
        await ctx2.route('**/__msgui2/malgun.ttf', (route) =>
          route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
        );
      const p2 = await ctx2.newPage();
      p2.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
      await p2.goto(`http://127.0.0.1:${port}/`);
      await p2.addStyleTag({ content: FONT_CSS });
      await p2.getByRole('button', { name: /^메신저/ }).waitFor();
      const m2 = await open(p2, true);
      const msg2 = p2.getByRole('region', { name: '메신저', exact: true });
      const cdp2 = await ctx2.newCDPSession(p2);
      const hold2 = async (loc: Locator) => {
        await loc.scrollIntoViewIfNeeded();
        const b = (await loc.boundingBox())!;
        const point = { x: b.x + Math.min(24, b.width / 2), y: b.y + Math.min(12, b.height / 2) };
        await cdp2.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
        await p2.waitForTimeout(800);
        await cdp2.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      };
      const bottom = (conv: Locator) =>
        conv.getByTestId('chat-scroll').evaluate((el) => (el.scrollTop = el.scrollHeight));

      // — Faces in the DM: the Lead (once per run), another agent, a sub-agent's work notice.
      const peerId = say('user', '[cld-gui · beta에게서 · 10-24 12:05] ⟨m:eeee6666⟩\n배포 전에 로그를 먼저 확인해 줘');
      const noticeId = say(
        'user',
        '<task-notification>\n<task-id>t1</task-id>\n<tool-use-id>toolu_missing</tool-use-id>\n<status>completed</status>\n<summary>로그 정리 끝</summary>\n<result>오류 0건</result>\n</task-notification>',
      );
      const lead1 = say('assistant', '네, 로그부터 볼게요');
      const lead2 = say('assistant', '로그에는 이상이 없어요');
      await row(m2, lead2).waitFor();
      await bottom(m2);
      const faces = (id: string) => row(m2, id).getByTestId('sender-face').count();
      check(
        (await faces(peerId)) === 1 &&
          (await row(m2, peerId).getByTestId('sender-face').getAttribute('data-sender')) === 'beta',
        'faces: another agent (beta) shows its face',
      );
      check((await faces(noticeId)) === 1, 'faces: a sub-agent work notice shows a face (its initial when no temp employee is known)');
      check(
        (await faces(lead1)) === 1 && (await faces(lead2)) === 0,
        "faces: the Lead's two messages in a row show the face once",
      );
      check(
        (await faces(bossId)) === 0,
        "faces: the boss's own message has none",
      );
      await shot(p2, 'phone390-dm-faces');

      // — The dashed box of a queued boss message: all four sides, a composer attachment opens the viewer.
      const box2 = m2.getByRole('textbox', { name: '보낼 글' });
      await box2.fill(
        '- 터미널 화면에서 이미 어떤 에이전트 터미널 볼지 고를 수 있기 때문에 필요없음\n\n[알림 질문 및 개선 건]\n_ 메신저에서 확인해야 하는 메시지(단톡, 갠톡) 알림은 그대로 유지\n- cld-gui -> cld-gui 메시지, cld-gui \' hub-ops -> cld-gui 메시지 같이 내용 확인할 수 없는 게 출처가 어딘지 파악하고, 필요없으면 알림 아예 안 보내게 막아야 토큰 낭비일듯\n- \'확인 필요\'의 기준이 뭐야?',
      );
      await m2.locator('input[type="file"]').setInputFiles(PNG);
      const draft = m2.getByTestId('draft-open');
      await draft.waitFor();
      await p2.waitForTimeout(800);
      // A tap on the chip first blurs the focused text box, which folds it back (the layout moves): blur first.
      await box2.blur();
      await p2.waitForTimeout(400);
      await draft.tap();
      const viewer = p2.getByTestId('attach-viewer');
      await viewer.first().waitFor({ timeout: 10_000 }).catch(async (e) => {
        await shot(p2, 'debug-no-viewer');
        throw e;
      });
      await p2.waitForTimeout(800);
      await shot(p2, 'phone390-composer-attachment-viewer');
      check(
        (await viewer.first().locator('img').count()) >= 1,
        'attachments: tapping a composer attachment opens the viewer with its image',
      );
      await p2.keyboard.press('Escape');
      await viewer.first().waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
      if (await viewer.count()) await viewer.first().getByRole('button', { name: /닫기/ }).first().tap();
      await m2.getByRole('button', { name: '보내기' }).tap();
      const pend = m2.getByTestId('pending').last();
      await pend.waitFor();
      await p2.waitForTimeout(700);
      await bottom(m2);
      await shot(p2, 'phone390-pending-dashed');
      const sides = await pend.evaluate((wrap) => {
        // MSG-UI3: the row also holds the avatar and name; the dashed box is the bubble.
        const el = wrap.querySelector('.border-dashed') as HTMLElement;
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        const list = el.closest('[data-testid="chat-scroll"]')!.getBoundingClientRect();
        return {
          left: [cs.borderLeftStyle, cs.borderLeftWidth],
          right: [cs.borderRightStyle, cs.borderRightWidth],
          top: [cs.borderTopStyle, cs.borderTopWidth],
          bottom: [cs.borderBottomStyle, cs.borderBottomWidth],
          inside: r.left >= list.left && r.right <= list.right,
          rect: [r.left, r.right, list.left, list.right],
        };
      });
      console.log(`  dashed box: ${JSON.stringify(sides)}`);
      check(
        ['left', 'right', 'top', 'bottom'].every((k) => (sides as Record<string, string[]>)[k][0] === 'dashed' && (sides as Record<string, string[]>)[k][1] !== '0px') &&
          sides.inside,
        'dashed box: four dashed sides, inside the scroll area',
      );

      // A long unbreakable word (a path, a URL) must not make the box wider than its column: it
      // used to push the box out to the left, past the edge it is clipped at.
      await box2.fill(`경로 /tmp/example-home/projects/cld-gui/webview-ui/src/cld/messenger/${'x'.repeat(70)}.tsx 이 파일 봐 줘`);
      await m2.getByRole('button', { name: '보내기' }).tap();
      await m2.getByTestId('pending').nth(1).waitFor();
      await bottom(m2);
      await p2.waitForTimeout(500);
      await shot(p2, 'phone390-pending-long-word');
      const fit = await m2.getByTestId('pending').evaluateAll((all) =>
        all.map((wrap) => {
          const box = (wrap.firstElementChild as HTMLElement).getBoundingClientRect();
          const col = wrap.getBoundingClientRect();
          return box.left >= col.left - 0.5 && box.right <= col.right + 0.5;
        }),
      );
      check(fit.length >= 2 && fit.every(Boolean), `dashed box: every queued box stays inside its column, a long word wraps (${fit})`);

      // — Rooms: make 출시팀 (alpha, beta, gamma), post to everyone, the three answer.
      await msg2.getByRole('button', { name: '‹ 목록' }).first().tap();
      const rooms = msg2.getByRole('region', { name: '단톡방' });
      await rooms.getByRole('button', { name: '+ 방 만들기' }).tap();
      await rooms.getByRole('textbox', { name: '방 이름' }).fill('출시팀');
      for (const name of ['alpha', 'beta', 'gamma']) await rooms.getByLabel(name).check();
      await rooms.getByRole('button', { name: '저장' }).tap();
      await rooms.getByRole('button', { name: /^출시팀/ }).tap();
      const room = msg2.getByTestId(/group-room-screen-/);
      await room.waitFor();
      const composer = room.getByRole('textbox', { name: '출시팀 메시지' });
      await composer.fill('@');
      await room.getByRole('option', { name: '@전체' }).tap();
      await composer.fill('@전체 배포 상황을 알려줘');
      await room.getByRole('button', { name: '보내기', exact: true }).tap();
      await room.getByText(REPLIES.gamma).waitFor({ timeout: 30_000 });
      await room.getByText(REPLIES.alpha).waitFor();
      await room.getByText(REPLIES.beta).waitFor();
      await p2.waitForTimeout(500);
      const lists = msg2.getByRole('button', { name: '‹ 목록' });
      check((await lists.count()) === 1, `room: only the tab row has a 목록 button (${await lists.count()})`);
      check(
        (await room.getByTestId('sender-face').count()) >= 3,
        'room: each member reply carries its face',
      );
      check(
        (await room.getByTestId('member-pill').innerText()).includes('3') &&
          (await room.getByTestId('member-list').count()) === 0,
        'room: one pill with the head count; no member names under the title',
      );
      await shot(p2, 'phone390-room-pill-closed');
      await room.getByTestId('member-pill').tap();
      const members = room.getByTestId('member-list');
      await members.waitFor();
      check(
        (await members.locator('li').count()) === 3 &&
          (await members.locator('li').first().getByTestId('lead-state').count()) === 1,
        'room: the pill opens a vertical list: one row per member with face, name and state',
      );
      await shot(p2, 'phone390-room-pill-open');
      await room.getByTestId('member-pill').tap();
      check((await members.count()) === 0, 'room: tapping the pill again closes the list');

      // — F2: a hold on a member's reply opens ONE sheet, and 복사 acts on the reply.
      const sheet2 = p2.getByTestId('message-sheet');
      const reply = room.locator('[data-chat-id]').filter({ hasText: REPLIES.alpha }).first();
      await hold2(reply);
      await sheet2.first().waitFor();
      check((await sheet2.count()) === 1, `F2: one sheet for a hold on a member's reply (${await sheet2.count()})`);
      await shot(p2, 'phone390-room-reply-sheet');
      await clearClip(p2);
      await sheet2.getByRole('menuitem', { name: '복사' }).tap();
      for (const end = Date.now() + 5_000; (await clip(p2)) === '-' && Date.now() < end;)
        await p2.waitForTimeout(100);
      check((await clip(p2)) === REPLIES.alpha, `F2: 복사 copies the reply's text (${await clip(p2)})`);
      check((await sheet2.count()) === 0, 'F2: the sheet closed');

      // — Leaving the room for the list keeps it as a tab; the tab brings it back.
      await msg2.getByRole('button', { name: '‹ 목록' }).tap();
      await shot(p2, 'phone390-list-after-room');
      await msg2.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^beta/ }).tap();
      const tab = msg2.getByTestId(/^room-tab-/);
      await tab.waitFor();
      await shot(p2, 'phone390-room-minimized-tab');
      await tab.tap();
      await room.waitFor();
      check(true, 'room: left for the list it stays as a tab, and the tab opens it again');
      await ctx2.close();

      // — Desktop: the same room, the member list, a composer attachment.
      const dpage = await deskCtx.newPage();
      await dpage.setViewportSize({ width: 1280, height: 800 });
      if (fs.existsSync(FONT))
        await deskCtx.route('**/__msgui2/malgun.ttf', (route) =>
          route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
        );
      await dpage.goto(`http://127.0.0.1:${port}/`);
      await dpage.addStyleTag({ content: FONT_CSS });
      await dpage.getByRole('button', { name: /^메신저/ }).click();
      const dm = dpage.getByRole('region', { name: '메신저', exact: true });
      await dm.getByRole('region', { name: '단톡방' }).getByRole('button', { name: /^출시팀/ }).click();
      const droom = dm.getByTestId(/group-room-screen-/);
      await droom.waitFor();
      check((await dm.getByRole('button', { name: '‹ 목록' }).count()) === 0, 'desktop room: no 목록 button');
      await droom.getByTestId('member-pill').click();
      await droom.getByTestId('member-list').waitFor();
      await shot(dpage, 'desktop-room-pill-open');
      await droom.getByTestId('member-pill').click();
      await dm.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }).click();
      const dconv = dm.getByRole('region', { name: 'alpha 대화' });
      await dconv.waitFor();
      await dconv.locator('input[type="file"]').setInputFiles(PNG);
      await dconv.getByTestId('draft-open').click();
      await dpage.getByTestId('attach-viewer').waitFor();
      await dpage.waitForTimeout(800);
      await shot(dpage, 'desktop-composer-attachment-viewer');
      check(true, 'desktop: a composer attachment opens the viewer');
      await dpage.keyboard.press('Escape');
      await shot(dpage, 'desktop-room-tabs');
    } finally {
      clearInterval(replier);
    }
    console.log('done');
  } finally {
    await browser.close().catch(() => undefined);
    if (server.exitCode === null) {
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
