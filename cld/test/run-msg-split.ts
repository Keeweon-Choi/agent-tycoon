/**
 * MSG-SPLIT in the real messenger: dist/cli.js with --engine on --allow-chat in an isolated HOME
 * whose `claude` is the engine fake, headless Chromium (--disable-gpu). Desktop 1280x800 with the
 * messenger maximized: layouts 1, 2 and 2x2 with a conversation in each pane; a message typed in
 * the second pane lands in that pane's lead only; a lead picked while it is in another pane moves
 * the focus (no copy); the layout comes back after a reload. A long bubble opens (더 보기) and
 * folds again (접기). Phone 390x844: no layout buttons, the list, then one conversation.
 *
 *   npx tsx cld/test/run-msg-split.ts <port 18256-18259>
 *
 * Screenshots: cld/artifacts/msg-split/*.png
 */
import type { BrowserContextOptions, Locator, Page } from '@playwright/test';
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/msg-split');
const DEADLINE_MS = 280_000;
const LEADS = ['alpha', 'beta', 'gamma', 'delta'];
const PHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 390, height: 844 } };
})();
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__msgsplit/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;

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
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(
      LEADS.map((name) => {
        const dir = path.join(home, 'work', name);
        fs.mkdirSync(dir, { recursive: true });
        return { name, folder: dir, room: '개발실', wantRunning: true };
      }),
    ),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
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

  type Sess = { sessionId: string; cwd: string; name: string; jobId: string };
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
  let clock = Date.now() - 3_600_000;
  let seeding = true;
  const say = (who: string, role: 'user' | 'assistant', text: string): string => {
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
          : { type: 'assistant', uuid: id, timestamp, message: { role, content: [{ type: 'text', text }] } },
      )}\n`,
    );
    return `${clock}-${id.slice(0, 8)}-0`;
  };
  const browser = await launchBrowser();
  const nameShim = 'globalThis.__name = (fn) => fn;';
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const withFont = async (ctx: Awaited<ReturnType<typeof browser.newContext>>) => {
    await ctx.addInitScript(nameShim);
    if (fs.existsSync(FONT))
      await ctx.route('**/__msgsplit/malgun.ttf', (route) =>
        route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
      );
  };
  try {
    for (const end = Date.now() + 40_000; !LEADS.every((n) => sessionOf(n)); ) {
      if (Date.now() > end) throw new Error('the engine did not revive every lead');
      await new Promise((r) => setTimeout(r, 300));
    }
    const LONG = Array.from({ length: 20 }, (_, i) => `긴 글 ${i + 1}번째 줄입니다.`).join('\n');
    const last: Record<string, string> = {};
    for (const who of LEADS) {
      say(who, 'user', `[사장 · 메신저 · 11-01 09:00] ⟨m:${who}0001⟩\n${who} 상황 알려 주세요`);
      if (who === 'alpha') say(who, 'user', `[사장 · 메신저 · 11-01 09:01] ⟨m:${who}0002⟩\n${LONG}`);
      last[who] = say(who, 'assistant', `${who} 리드입니다. 지금 테스트를 돌리는 중이에요.`);
    }
    seeding = false;
    await new Promise((r) => setTimeout(r, 3_000));
    const url = await daemon.loginUrl();

    // ── Desktop ──
    const deskCtx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await withFont(deskCtx);
    const page = await deskCtx.newPage();
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    const infoClose = page.getByRole('button', { name: '정보 창 닫기' });
    if (await infoClose.count()) await infoClose.click();
    await page.getByRole('button', { name: /^메신저/ }).click();
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    await messenger.waitFor();
    const win = page
      .locator('div,section')
      .filter({ has: messenger })
      .filter({ has: page.getByRole('button', { name: '최대화' }) })
      .last();
    await win.getByRole('button', { name: '최대화' }).first().click();
    const contactsList = messenger.getByRole('list', { name: '연락처' });
    const pick = (name: string) => contactsList.getByRole('button', { name: new RegExp(`^${name}`) }).click();
    const conv = (name: string) => messenger.getByRole('region', { name: `${name} 대화` });
    const pane = (i: number) => messenger.getByTestId(`split-pane-${i}`);
    const waitLast = (who: string, scope: Locator = messenger) =>
      scope.locator(`[data-chat-id="${last[who]}"]`).waitFor();

    await messenger.getByTestId('split-layout-1').waitFor();
    check(true, 'desktop maximized: the layout buttons 1 · 2 · 2x2 show');
    await messenger.getByTestId('split-layout-1').click();
    await pick('alpha');
    await waitLast('alpha');
    // 더 보기 -> 접기 -> 더 보기 on the boss's long message.
    const fold = conv('alpha').getByTestId('fold-toggle').first();
    await fold.scrollIntoViewIfNeeded();
    check((await fold.textContent()) === '더 보기', 'a long bubble starts folded (더 보기)');
    await shot(page, 'layout-1');
    await fold.click();
    check((await fold.textContent()) === '접기', 'opened, it offers 접기');
    await fold.scrollIntoViewIfNeeded();
    await shot(page, 'fold-open');
    await fold.click();
    check((await fold.textContent()) === '더 보기', 'folded again by 접기');
    await fold.scrollIntoViewIfNeeded();
    await shot(page, 'fold-closed');

    // ── 2 ──
    await messenger.getByTestId('split-layout-2').click();
    await pane(1).waitFor();
    check((await pane(0).getAttribute('data-focused')) === 'true', 'layout 2: the first pane keeps alpha and the focus');
    check(await pane(0).getByRole('region', { name: 'alpha 대화' }).count(), 'pane 1 shows alpha');
    check(await pane(1).getByText('목록에서 대화를 고르면').count(), 'the empty pane shows its hint');
    await pane(1).click();
    check((await pane(1).getAttribute('data-focused')) === 'true', 'a press on the empty pane focuses it');
    await pick('beta');
    await waitLast('beta', pane(1));
    const typed = `두 번째 칸에서 보냄 ${Date.now() % 100000}`;
    await pane(1).getByRole('textbox', { name: '보낼 글' }).fill(typed);
    await pane(1).getByRole('button', { name: '보내기', exact: true }).click();
    await pane(1).getByText(typed).first().waitFor({ timeout: 15_000 });
    check(true, 'the message typed in the second pane shows in beta');
    check((await pane(0).getByText(typed).count()) === 0, 'and not in alpha');
    const box = await pane(1)
      .getByTestId('pending')
      .first()
      .evaluate((p) => {
        const b = p.querySelector<HTMLElement>(':scope > div > div')!;
        const cs = getComputedStyle(b);
        return { left: cs.borderLeftWidth, style: cs.borderLeftStyle };
      });
    check(box.left === '2px' && box.style === 'dashed', `the queued bubble's dashed box is 2px on its left too (${JSON.stringify(box)})`);
    // The fake claude logs what each session got: it must be beta's.
    const typedLog = path.join(home, 'fake-claude-typed.log');
    let got: { id: string; text: string } | undefined;
    for (const end = Date.now() + 20_000; !got && Date.now() < end; ) {
      got = (fs.existsSync(typedLog) ? fs.readFileSync(typedLog, 'utf-8').split('\n') : [])
        .filter(Boolean)
        .map((l) => JSON.parse(l) as { id: string; text: string })
        .find((t) => t.text.includes(typed));
      if (!got) await new Promise((r) => setTimeout(r, 200));
    }
    check(got?.id === sessionOf('beta')!.jobId, `beta's session received it (${got?.id})`);
    // Claude, played: the prompt goes into beta's transcript; the bubble settles there.
    const prompt = say('beta', 'user', got!.text.replaceAll('\r', '\n'));
    await pane(1).locator(`[data-chat-id="${prompt}"]`).waitFor();
    check((await pane(1).getByTestId('pending').count()) === 0, 'and the bubble settled into beta\'s transcript');
    await shot(page, 'layout-2');

    // ── 2x2 ──
    await messenger.getByTestId('split-layout-4').click();
    await pane(3).waitFor();
    await pane(2).click();
    await pick('gamma');
    await waitLast('gamma', pane(2));
    await pane(3).click();
    await pick('delta');
    await waitLast('delta', pane(3));
    check((await messenger.getByTestId('chat-scroll').count()) === 4, '2x2: four conversations on screen');
    await shot(page, 'layout-2x2');
    await pick('alpha');
    check((await pane(0).getAttribute('data-focused')) === 'true', 'picking alpha, shown in pane 1, focuses that pane');
    check((await messenger.getByRole('region', { name: 'alpha 대화' }).count()) === 1, 'alpha is not shown twice');
    check((await pane(3).getByRole('region', { name: 'delta 대화' }).count()) === 1, 'delta stays in pane 4');

    // ── reload: layout and panes come back ──
    await page.reload();
    await page.addStyleTag({ content: FONT_CSS });
    const reopened = page.getByRole('button', { name: /^메신저/ });
    if (!(await messenger.isVisible())) await reopened.click();
    for (const [i, who] of LEADS.entries()) await waitLast(who, pane(i));
    check(true, 'after a reload the 2x2 panes hold alpha, beta, gamma, delta again');
    await shot(page, 'layout-2x2-reloaded');
    await messenger.getByTestId('split-layout-1').click();
    await conv('alpha').waitFor();
    check((await messenger.getByTestId('chat-scroll').count()) === 1, 'back to 1: only the focused pane (alpha)');
    await shot(page, 'layout-1-back');
    await messenger.getByTestId('split-layout-2').click(); // leave the phone context a split choice
    await pane(1).waitFor();

    // ── Phone: one conversation, no layout buttons ──
    const phoneCtx = await browser.newContext({ ...PHONE, storageState: await deskCtx.storageState() });
    await withFont(phoneCtx);
    const p2 = await phoneCtx.newPage();
    p2.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    await p2.goto(`http://127.0.0.1:${port}/`);
    await p2.addStyleTag({ content: FONT_CSS });
    await p2.getByRole('button', { name: /^메신저/ }).tap();
    const m2 = p2.getByRole('region', { name: '메신저', exact: true });
    await m2.getByRole('list', { name: '연락처' }).waitFor();
    check((await m2.getByTestId('split-layout-2').count()) === 0, 'phone: no layout buttons');
    check((await m2.getByTestId('split-pane-0').count()) === 0, 'phone: no panes, the list first');
    await shot(p2, 'phone-list');
    await m2.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^beta/ }).tap();
    await waitLast('beta', m2);
    check((await m2.getByTestId('chat-scroll').count()) === 1, 'phone: one conversation');
    await shot(p2, 'phone-conversation');
    await phoneCtx.close();
    await deskCtx.close();
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
