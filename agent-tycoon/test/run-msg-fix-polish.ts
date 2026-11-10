/**
 * FIX-MESSENGER-POLISH (owner 11-06 16:22): the messenger's waiting message (fainter), one alignment grid, the 더보기 toggle
 * inside every bubble, the thinking bubble, the jump-to-newest button. REAL API: dist/cli.js --engine on --allow-chat in a
 * temp HOME whose `claude` is the engine fake, headless Chromium (--disable-gpu), a 1440x1000 desktop and a 390x844
 * touch phone, both at 2x. delta has a transcript the runner writes (runs of messages on both sides, a reply quote, files, a
 * long message each side); the run then sends two messages through the composer: the first starts a (long) fake turn, so
 * the thinking bubble shows; the second waits in the queue. FIXPOLISH_PHASE=before|after names the photos.
 * Photos in agent-tycoon/artifacts/fix-messenger-polish/.
 *
 *   npx tsx agent-tycoon/test/run-msg-fix-polish.ts <port 18860-18869>
 */
import type { Browser, BrowserContextOptions } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { transcriptPath } from '../../server/src/agent-tycoon/providers/claudeProvider.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (port < 18860 || port > 18869) throw new Error('port must be 18860-18869');
const PHASE = process.env.FIXPOLISH_PHASE === 'before' ? 'before' : 'after';
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/fix-messenger-polish');
const SAFE_AREA = ':root { --agty-safe-top: 47px !important; --agty-safe-bottom: 34px !important; }';
/** The update and notice toasts are not the messenger's: out of the picture. */
const NO_TOASTS = '.floating-toast-frame { display: none !important; }';
/** The desktop shot puts the window where the mockup has it (about 1190x820); the 2x zooms keep the default size. */
const MOCK_PLACE = `localStorage.setItem('agty.hud.layout.v1', ${JSON.stringify(
  JSON.stringify({
    v: 1,
    items: { messenger: { place: { corner: 'tl', dx: 118, dy: 104, w: 1190, h: 836 } } },
  }),
)});`;
const DEADLINE_MS = 300_000;
const IPHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();
const LEADS = ['delta'];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LONG_MINE = `줄이 긴 메시지를 하나 더 보냅니다. ${'대기 중인 메시지가 길어도 상자 안에서 접히고 펼쳐져야 해요. '.repeat(10)}`;

function picture(w: number, h: number, base: [number, number, number]): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) png.data[i + c] = Math.round((base[c] * (x + y)) / (w + h));
      png.data[i + 3] = 255;
    }
  return PNG.sync.write(png);
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
  const folderOf = (name: string) => path.join(home, 'work', name);
  for (const name of LEADS)
    fs.mkdirSync(path.join(folderOf(name), '.agty-inbox'), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(
      LEADS.map((name) => ({ name, folder: folderOf(name), room: '개발실', wantRunning: true })),
    ),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '90000' },
    false,
  );
  const { child: server } = daemon;
  let browser: Browser | undefined;
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL'); // our own daemon only
    void browser?.close();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  type Sess = { pid: number; sessionId: string; cwd: string; name: string };
  const sessionFile = (name: string): Sess | null => {
    for (const f of fs.readdirSync(sessions)) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Sess;
        if (s.name === name) return s;
      } catch {
        /* being written */
      }
    }
    return null;
  };
  const rec = (i: number, role: 'user' | 'assistant', text: string, at: number) =>
    `${JSON.stringify({
      type: role,
      uuid: `${i.toString(16).padStart(8, '0')}-6200-4000-8000-000000000000`,
      timestamp: new Date(at).toISOString(),
      message:
        role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
    })}\n`;

  try {
    for (const end = Date.now() + 40_000; LEADS.some((n) => !sessionFile(n));) {
      if (Date.now() > end) throw new Error('the engine did not revive the sessions');
      await wait(300);
    }
    const inbox = path.join(folderOf('delta'), '.agty-inbox');
    const notes = '20261106-100000-review-notes.md';
    fs.writeFileSync(path.join(inbox, notes), '# review\n- build\n- docs\n');
    const zip = path.join(folderOf('delta'), 'build-v0.9.3.zip');
    fs.writeFileSync(zip, Buffer.alloc(286 * 1024, 7));
    fs.writeFileSync(path.join(folderOf('delta'), 'shot.png'), picture(200, 120, [60, 200, 120]));
    const H0 = Date.now() - 50 * 60_000;
    const lines: [role: 'user' | 'assistant', text: string][] = [
      ['user', 'T-42 공개 준비는 어떻게 되고 있나요?'],
      [
        'assistant',
        `네, 빌드 87%까지 끝났어요.\n남은 이슈는 2건이고 오늘 안에 정리할게요.\n[첨부] ${zip}`,
      ],
      ['user', '좋아요. 내일 오전에 내부 리뷰 해요. 체크리스트도 같이 주세요.'],
      ['assistant', '배포 전에 정할 게 있어요. 배포 순서를 정해 주실래요? ⟨q:deploy-order⟩'],
      ['user', `리뷰 메모 보낼게요\n[첨부] ${path.join(inbox, notes)} (text/markdown, 1 KB)`],
      ['assistant', `화면을 캡처했어요\n[첨부] ${path.join(folderOf('delta'), 'shot.png')}`],
      ['user', `제가 길게 적어 봅니다. ${'긴 이야기를 이어서 적어요. '.repeat(10)}`],
      ['assistant', `네, 길게 답해 드릴게요. ${'긴 이야기를 이어서 적어요. '.repeat(10)}`],
      ['assistant', '다시 여쭤요: 배포 순서 ⟨q:deploy-order⟩'],
      // runs on both sides: bubbles of one sender follow each other
      ['user', '그럼 이 순서로 가요.'],
      ['user', '첫째 빌드, 둘째 문서, 셋째 배포예요.'],
      ['assistant', '알겠어요. 빌드부터 시작할게요.'],
      ['assistant', '문서는 빌드가 끝난 뒤에 이어서 정리할게요.'],
      ['assistant', '배포 전에 한 번 더 확인 요청드릴게요.'],
      // a reply: ⟨re:id⟩ names the line it answers (the 2nd of the run above)
      [
        'user',
        `[사장 · 메신저 · 11-06 17:00] ⟨m:abcdefgh⟩ ⟨re:00000004-6200-4000-8000-000000000000⟩\n> delta: 배포 전에 정할 게 있어요. 배포 순서를 정해 주실래요?\n순서는 방금 정했어요, 확인해 주세요.`,
      ],
      ['assistant', '확인했어요. 지금 진행할게요.'],
    ];
    for (const name of LEADS) {
      const s = sessionFile(name)!;
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const liveText = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
      const mine =
        name === 'delta'
          ? lines
          : ([
              ['user', `${name}: 오늘 할 일 정리해 줘`],
              ['assistant', `${name} 할 일을 정리할게요.`],
            ] as const);
      const body = mine
        .map(([role, text], i) => rec(i + 1, role, text, H0 + i * 5 * 60_000))
        .join('');
      fs.writeFileSync(`${file}.tmp`, body + liveText);
      fs.renameSync(`${file}.tmp`, file);
    }
    await wait(3_000);

    browser = await launchBrowser();
    for (const [label, opts] of [
      ['desktop', { viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 }],
      ['phone', { ...IPHONE, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }],
    ] as const) {
      const touch = label === 'phone';
      const ctx = await browser.newContext(opts);
      await ctx.addInitScript('window.__name = (f) => f;');
      if (!touch) await ctx.addInitScript(MOCK_PLACE);
      const page = await ctx.newPage();
      const shot = (name: string) => path.join(OUT, `${label}-${name}-${PHASE}.png`);
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(`http://127.0.0.1:${port}/`);
      await page.addStyleTag({ content: NO_TOASTS + (touch ? SAFE_AREA : '') });
      await page.evaluate(() => document.fonts.ready);
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      const conv = messenger.getByRole('region', { name: 'delta 대화' });
      const tapOn = (l: ReturnType<typeof page.locator>) => (touch ? l.tap() : l.click());
      await tapOn(page.getByRole('button', { name: /^메신저($| \()/ }));
      const delta = messenger
        .getByRole('list', { name: '연락처' })
        .getByRole('button', { name: /^delta/ });
      await delta.waitFor();
      await wait(800);
      await tapOn(delta);
      await conv.getByText('확인했어요').waitFor();
      await wait(800);
      await page.mouse.move(0, 0);
      const scroll = conv.getByTestId('chat-scroll');
      // the clip of the conversation (the whole window on a phone) for the 2x crops
      const crop = async (name: string, from = 0, to = 1) => {
        const box = (await (touch ? conv : messenger).boundingBox())!;
        await page.screenshot({
          path: shot(name),
          clip: {
            x: box.x,
            y: box.y + box.height * from,
            width: box.width,
            height: box.height * (to - from),
          },
        });
      };
      await page.screenshot({ path: shot('full-bottom') });
      await crop('crop-bottom');
      // a long message on each side, folded then opened
      for (const who of ['user', 'assistant'] as const) {
        const row = conv
          .locator(
            `[data-chat-id]:has([data-testid=fold-toggle])${who === 'user' ? '[data-chat-id]:has([data-from=boss])' : ':not(:has([data-from=boss]))'}`,
          )
          .first();
        await row.scrollIntoViewIfNeeded();
        await scroll.evaluate((el) => (el.scrollTop += 120));
        await wait(300);
        await crop(`crop-long-${who}-folded`);
        await row.getByTestId('fold-toggle').click();
        await wait(300);
        await crop(`crop-long-${who}-open`);
        await row.getByTestId('fold-toggle').click();
      }
      // a turn is running (its prompt is the transcript's newest record, the session says busy): the thinking
      // bubble, with the tool the agent is on; a message sent now waits in the queue
      const box = conv.getByRole('textbox', { name: '보낼 글' });
      const s = sessionFile('delta')!;
      const record = (type: 'user' | 'assistant', n: number, message: object) =>
        fs.appendFileSync(
          transcriptPath(s.cwd, s.sessionId, home),
          `${JSON.stringify({ type, uuid: `000000f${n}-6200-4000-8000-000000000000`, timestamp: new Date().toISOString(), message })}\n`,
        );
      record('user', 1, { role: 'user', content: '빌드 돌려 줘' });
      for (const f of fs.readdirSync(sessions)) {
        const file = path.join(sessions, f);
        const x = JSON.parse(fs.readFileSync(file, 'utf-8')) as Sess;
        if (x.name === 'delta')
          fs.writeFileSync(
            file,
            JSON.stringify({ ...x, status: 'busy', statusUpdatedAt: Date.now() }),
          );
      }
      record('assistant', 2, {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'npm run build', description: '빌드 돌리는 중' },
          },
        ],
      });
      await conv.getByTestId('typing').waitFor({ timeout: 20_000 });
      await conv
        .locator('input[type=file]')
        .setInputFiles({
          name: 'build-log.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('ok\n'),
        });
      await wait(1_000);
      await box.fill(LONG_MINE);
      await conv.getByRole('button', { name: '보내기', exact: true }).click();
      await conv.getByTestId('pending').first().waitFor({ timeout: 20_000 });
      await wait(1_200);
      await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight));
      await wait(500);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: shot('full-waiting') });
      await crop('crop-waiting', 0.35, 1);
      // fold toggle of the waiting one, opened
      const pendingFold = conv.getByTestId('pending').getByTestId('fold-toggle');
      if (await pendingFold.count()) {
        await pendingFold.first().click();
        await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight));
        await wait(300);
        await crop('crop-waiting-open', 0.35, 1);
        await pendingFold.first().click();
      }
      // away from the bottom: the jump button
      await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight - el.clientHeight - 700));
      await wait(600);
      await page.mouse.move(0, 0);
      await page.screenshot({ path: shot('full-jump') });
      await crop('crop-jump');
      await ctx.close();
    }
    console.log(`photos in ${OUT}`);
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM'); // our own daemon only
    killFakeSessions(home);
    await wait(500);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
