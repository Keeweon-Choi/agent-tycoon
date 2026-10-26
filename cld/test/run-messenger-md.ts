/**
 * T-0054 follow-ups, in the real messenger: dist/cli.js with --engine on
 * --allow-chat in an isolated HOME whose `claude` is the engine fake
 * (cld/test/fake-claude/engine.cjs), headless Chromium with --disable-gpu.
 *
 * 1. Markdown in a lead's reply: bold, a table, a code block, lists, a quote,
 *    a good link and malicious ones (javascript:, <img onerror>, <script>,
 *    <iframe>), desktop and iPhone 13 (touch). Nothing executes, the unsafe
 *    link is text, a wide table scrolls inside the bubble and never widens the
 *    page, and the page reports zero `securitypolicyviolation` events.
 * 2. Enter in the input: on touch it inserts a newline and only 보내기 sends a
 *    multi-line message; on desktop Enter sends and Shift+Enter breaks the line.
 * 3. Screenshots for the Hangul/Latin balance, in the messenger.
 *
 *   npx tsx cld/test/run-messenger-md.ts <port 18256-18259> [tag]
 *
 * With G9_WOFF2=<Galmuri9.woff2> the page loads that face at full size instead
 * (the pre-balance look, for the "before" screenshots; CSP is bypassed then and
 * the CSP/XSS checks are skipped). Screenshots: cld/artifacts/t0054/<tag>-*.png
 * (tag defaults to "md").
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

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
import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';

const port = sparePort();
const TAG = process.argv[3] ?? 'md';
const G9 = process.env.G9_WOFF2;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0054');
const DEADLINE_MS = 280_000;
const IPHONE13 = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

/** The lead's reply: every construct, and every attack, once. */
const REPLY = [
  '# 오늘 정리',
  '**배포는 끝났어요** and *조심할 점* 하나, `npm run build` 도 돌렸어요.',
  '',
  '| 프로젝트 | 상태 | 마지막 빌드 | 담당자 이름이 아주 긴 칸 | 메모가 길게 이어지는 칸 |',
  '| :-- | :-: | --: | --- | --- |',
  '| alpha | **성공** | 12:03 | Keeweon Choi (cld-gui owner) | 배포 후 확인 완료 |',
  '| beta | 실패 | 11:48 | someone-with-a-long-name | 테스트 2개 실패, 재시도 필요 |',
  '',
  '```bash',
  'npm run build && npm test -- --runInBand --reporter=verbose --some-very-long-flag-that-scrolls',
  '```',
  '',
  '- 첫째 항목',
  '- 둘째 항목',
  '  - 안쪽 항목',
  '',
  '1. 순서 하나',
  '2. 순서 둘',
  '',
  '> 인용문 **굵게**',
  '',
  '[문서](https://example.com/docs) 와 [나쁜 링크](javascript:window.__xss=1) 그리고',
  '<img src=x onerror="window.__xss=1"> <script>window.__xss=1</script> <iframe src="https://evil.example"></iframe>',
].join('\n');

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
    JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true }]),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
  );
  const { child: server } = daemon;
  console.log(`port ${port}, tag ${TAG}, daemon pid ${server.pid}${G9 ? ', G9 override' : ''}`);

  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null) server.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort('deadline'), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  // ── Claude, played ──
  type Sess = { pid: number; sessionId: string; cwd: string; name: string; jobId: string };
  const sessionOf = (): Sess | null => {
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
  const say = (role: 'user' | 'assistant', text: string) => {
    const s = sessionOf()!;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const id = `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
    const timestamp = new Date().toISOString();
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
  };
  const typedLog = path.join(home, 'fake-claude-typed.log');
  const typed = () =>
    fs.existsSync(typedLog)
      ? fs
          .readFileSync(typedLog, 'utf-8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { id: string; text: string })
      : [];
  const sent = (needle: string) =>
    typed()
      .find((t) => t.text.includes(needle))
      ?.text.replaceAll('\r', '\n');

  const browser = await launchBrowser();
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${TAG}-${name}.png`) });
  const violations: string[] = [];
  const open = async (opts: BrowserContextOptions) => {
    const ctx = await browser.newContext({ ...opts, bypassCSP: Boolean(G9) });
    await ctx.addInitScript(`globalThis.__name = (fn) => fn;
      window.__csp = [];
      document.addEventListener('securitypolicyviolation', (e) =>
        window.__csp.push(e.violatedDirective + ' ' + e.blockedURI));`);
    if (G9)
      await ctx.route('**/__t0054/g9.woff2', (route) =>
        route.fulfill({ body: fs.readFileSync(G9), contentType: 'font/woff2' }),
      );
    const page = await ctx.newPage();
    page.on('console', (m) => {
      if (/Content Security Policy|violates/i.test(m.text())) violations.push(m.text());
    });
    page.on('pageerror', (e) => violations.push(`pageerror ${e}`));
    return { ctx, page };
  };
  const g9Style = `@font-face { font-family: 'Galmuri11'; src: url('/__t0054/g9.woff2'); size-adjust: 100%;
    unicode-range: U+1100-11FF, U+3000-303F, U+3130-318F, U+AC00-D7A3, U+FF01-FF5E; }`;

  try {
    for (const end = Date.now() + 40_000; !sessionOf();) {
      if (Date.now() > end) throw new Error('the engine did not revive alpha');
      await new Promise((r) => setTimeout(r, 300));
    }
    say('user', '오늘 할 일 정리해 줘');
    say('assistant', REPLY);
    await new Promise((r) => setTimeout(r, 4_000));
    const url = await daemon.loginUrl();

    const conversation = async (page: Page, touch: boolean) => {
      const tap = (l: ReturnType<Page['locator']>) => (touch ? l.tap() : l.click());
      await tap(page.getByRole('button', { name: /^메신저/ }));
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      await tap(
        messenger.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }),
      );
      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      await conv.getByText('오늘 정리').waitFor();
      // A long reply is folded (12 lines): unfold it.
      const more = conv.getByRole('button', { name: '더 보기' });
      if (await more.count()) await tap(more);
      await conv.getByText('javascript:window.__xss=1', { exact: false }).waitFor();
      return { messenger, conv };
    };
    const fits = (page: Page) =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

    // ════ Desktop ════
    const { ctx: deskCtx, page } = await open({ viewport: { width: 1280, height: 800 } });
    await page.goto(url);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    if (G9) await page.addStyleTag({ content: g9Style });
    const infoClose = page.getByRole('button', { name: '정보 창 닫기' });
    if (await infoClose.count()) await infoClose.click();
    const desk = await conversation(page, false);
    await page.waitForTimeout(600);
    await shot(page, 'desktop-messenger');

    if (!G9) {
      const bubble = desk.conv
        .locator('[data-testid="md-table"]')
        .locator('xpath=ancestor::div[contains(@class,"border-border")][1]');
      check(
        (await desk.conv.locator('strong', { hasText: '배포는 끝났어요' }).count()) === 1 &&
          (await desk.conv.locator('em', { hasText: '조심할 점' }).count()) === 1 &&
          (await desk.conv.locator('code', { hasText: 'npm run build' }).count()) >= 1,
        'desktop: bold, italic and inline code render (no literal **)',
      );
      check(!(await desk.conv.innerText()).includes('**'), 'desktop: no ** left in the text');
      check(
        (await desk.conv.locator('table th').count()) === 5 &&
          (await desk.conv.locator('table tbody tr').count()) === 2,
        'desktop: the GFM table has 5 columns and 2 rows',
      );
      check(
        (await desk.conv.locator('pre code').count()) === 1 &&
          (await desk.conv.locator('ul li').count()) >= 3 &&
          (await desk.conv.locator('ol li').count()) === 2 &&
          (await desk.conv.locator('blockquote').count()) === 1,
        'desktop: a code block, bullet (nested) and numbered lists, a quote',
      );
      void bubble;
      const links = await desk.conv.locator('a').evaluateAll((as) =>
        as.map((a) => ({
          href: a.getAttribute('href'),
          rel: a.getAttribute('rel'),
          target: a.getAttribute('target'),
        })),
      );
      check(
        links.length >= 1 &&
          links.every(
            (l) =>
              /^https:\/\//.test(l.href ?? '') &&
              l.rel === 'noopener noreferrer' &&
              l.target === '_blank',
          ) &&
          links.some((l) => l.href === 'https://example.com/docs'),
        `desktop: every link is https and opens safely, none is javascript: (${JSON.stringify(links)})`,
      );
      check(
        (await desk.conv.innerText()).includes('[나쁜 링크](javascript:window.__xss=1)') &&
          (await desk.conv.innerText()).includes('<img src=x onerror=') &&
          (await desk.conv.innerText()).includes('<script>') &&
          (await desk.conv.innerText()).includes('<iframe'),
        'desktop: the javascript: link and the raw HTML show as text',
      );
      check(
        (await desk.conv.locator('img, script, iframe, [onerror]').count()) === 0,
        'desktop: no img, script, iframe or onerror element in the conversation',
      );
      await page.getByText('[나쁜 링크]', { exact: false }).first().click();
      check(
        (await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)) === undefined,
        'desktop: nothing executed (window.__xss unset), also after clicking the text',
      );
      const wrap = desk.conv.locator('[data-testid="md-table"]');
      const scroll = await wrap.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
      check(
        scroll.sw > scroll.cw && (await fits(page)),
        `desktop: the wide table scrolls inside its bubble (${scroll.sw} > ${scroll.cw}) and the page does not widen`,
      );
      const csp = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
      check(
        csp.length === 0 && violations.length === 0,
        `desktop: 0 CSP violations (${csp.join('; ')} ${violations.join('; ')})`,
      );
    }

    // ── Enter on desktop ──
    const box = desk.conv.getByRole('textbox', { name: '보낼 글' });
    await box.fill('줄1');
    await box.press('Shift+Enter');
    await box.type('줄2');
    check((await box.inputValue()) === '줄1\n줄2', 'desktop: Shift+Enter inserts a newline');
    await box.press('Enter');
    await desk.conv
      .getByText('보냄')
      .or(desk.conv.getByText('받음'))
      .first()
      .waitFor({ timeout: 20_000 });
    for (const end = Date.now() + 15_000; !sent('줄2') && Date.now() < end;)
      await new Promise((r) => setTimeout(r, 200));
    check(
      /줄1\n줄2$/.test(sent('줄2') ?? '') && (await box.inputValue()) === '',
      'desktop: Enter sends the two-line message and clears the box',
    );

    // ════ Phone (touch) ════
    const { page: phone } = await open({
      ...IPHONE13,
      storageState: await deskCtx.storageState(),
    });
    await phone.goto(`http://127.0.0.1:${port}/`);
    if (G9) await phone.addStyleTag({ content: g9Style });
    await phone.getByRole('button', { name: /^메신저/ }).waitFor();
    const ph = await conversation(phone, true);
    await phone.waitForTimeout(600);
    await shot(phone, 'phone-messenger');
    if (!G9) {
      check(
        await phone.evaluate(() => matchMedia('(pointer: coarse) and (hover: none)').matches),
        'phone: the emulated device is a coarse pointer with no hover',
      );
      check(await fits(phone), 'phone: the conversation fits the width');
      const wrap = ph.conv.locator('[data-testid="md-table"]');
      const sc = await wrap.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
      check(sc.sw > sc.cw, `phone: the wide table scrolls inside its bubble (${sc.sw} > ${sc.cw})`);
      await wrap.evaluate((el) => (el.scrollLeft = 120));
      check(await fits(phone), 'phone: scrolling the table does not widen the page');
      await shot(phone, 'phone-table-scrolled');
      check(
        (await phone.evaluate(() => (window as unknown as { __xss?: number }).__xss)) === undefined,
        'phone: nothing executed',
      );
      const csp = await phone.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
      check(csp.length === 0, `phone: 0 CSP violations (${csp.join('; ')})`);

      const pbox = ph.conv.getByRole('textbox', { name: '보낼 글' });
      const before = typed().length;
      await pbox.tap();
      await pbox.fill('폰 첫줄');
      await pbox.press('Enter');
      await pbox.type('폰 둘째줄');
      await pbox.press('Enter');
      await pbox.type('폰 셋째줄');
      check(
        (await pbox.inputValue()) === '폰 첫줄\n폰 둘째줄\n폰 셋째줄' && typed().length === before,
        'phone: Enter inserts a newline and sends nothing',
      );
      await shot(phone, 'phone-multiline-input');
      await ph.conv.getByRole('button', { name: '보내기' }).tap();
      for (const end = Date.now() + 20_000; !sent('폰 셋째줄') && Date.now() < end;)
        await new Promise((r) => setTimeout(r, 200));
      check(
        /폰 첫줄\n폰 둘째줄\n폰 셋째줄$/.test(sent('폰 셋째줄') ?? '') &&
          (await pbox.inputValue()) === '',
        'phone: the 보내기 button sends the three-line message and clears the box',
      );
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
