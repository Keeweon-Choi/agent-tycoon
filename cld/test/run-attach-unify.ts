/**
 * ATTACH-UNIFY check: every messenger attachment opens in the one viewer frame
 * (top bar, content, one bottom action row). Same harness as run-attach-view.ts:
 * dist/cli.js --engine on in an isolated HOME, a spare port, headless Chromium
 * (--disable-gpu). One user message carries a png, a Markdown file (headings,
 * lists, code, a table and hostile HTML), a txt, a json, a pdf and a zip.
 *
 * Desktop 1280x800 (mouse) and phone 390x844 (touch), for each file: the buttons,
 * a screenshot, 내려받기 starts a download with the file's name, 글 복사 puts the
 * file's text on the clipboard, share only when navigator.canShare({ files });
 * Markdown renders (no raw HTML from the file), 원문/보기 toggle; a mouse drag and
 * selectable touch text (headless has no long-press selection), a finger scrolls the preview without leaving
 * the file; the manual-copy fallback selects the preview.
 * Screenshots go to cld/artifacts/attach-unify/.
 *
 *   npx tsx cld/test/run-attach-unify.ts <port 18256-18259>
 */
import type { BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

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
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/attach-unify');
const DEADLINE_MS = 240_000;
const PHONE = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return { ...d, viewport: { width: 390, height: 844 } };
})();

let failures = 0;
function check(ok: unknown, what: string): void {
  if (!ok) failures++;
  console.log(`${ok ? 'ok' : 'NOT OK'} - ${what}`);
}
async function until(fn: () => Promise<boolean>, ms = 10_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function picture(w: number, h: number): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < w * h * 4; i += 4) {
    png.data[i] = 200;
    png.data[i + 1] = (i / 4) % 255;
    png.data[i + 2] = 80;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

const MD = [
  '# Release notes',
  '## Second heading',
  '- first item',
  '- second item',
  '1. numbered',
  'Some `inline code` here.',
  '```',
  'const x = 1;',
  '```',
  '| col a | col b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '<img src=x onerror="window.__xss=1">',
  '<script>window.__xss=2</script>',
  '[bad link](javascript:window.__xss=3)',
  '<!-- hidden comment -->',
  '',
].join('\n');
const TXT = Array.from({ length: 80 }, (_, i) =>
  i === 3 ? `line 4 ${'wide '.repeat(60)}end` : `line ${i + 1} of the notes`,
).join('\n');
const JSON_TEXT = `${JSON.stringify({ name: 'demo', list: [1, 2, 3] }, null, 2)}\n`;

type Kind = 'image' | 'md' | 'text' | 'card';
const FILES: Array<{ name: string; type: string; data: Buffer; kind: Kind; text?: string }> = [
  { name: 'a.png', type: 'image/png', data: picture(600, 400), kind: 'image' },
  { name: 'notes.md', type: 'text/markdown', data: Buffer.from(MD), kind: 'md', text: MD },
  { name: 'notes.txt', type: 'text/plain', data: Buffer.from(TXT), kind: 'text', text: TXT },
  {
    name: 'data.json',
    type: 'application/json',
    data: Buffer.from(JSON_TEXT),
    kind: 'text',
    text: JSON_TEXT,
  },
  { name: 'doc.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4\n%%EOF\n'), kind: 'card' },
  { name: 'pack.zip', type: 'application/zip', data: Buffer.from('PK\x05\x06'), kind: 'card' },
];

async function main(): Promise<void> {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folder = path.join(home, 'work', 'alpha');
  const inbox = path.join(folder, '.cld-inbox');
  fs.mkdirSync(inbox, { recursive: true });
  fs.mkdirSync(path.join(home, '.config/cld-gui'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/projects.json'),
    JSON.stringify([{ name: 'alpha', folder, room: '개발실', wantRunning: true }]),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '600' },
  );
  const deadline = setTimeout(() => {
    console.error(`deadline ${DEADLINE_MS / 1000} s`);
    void daemon.stop().then(() => {
      killFakeSessions(home);
      process.exit(2);
    });
  }, DEADLINE_MS);
  let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    const stored = FILES.map((f) => ({ ...f, stored: `20261025-180000-${f.name}` }));
    for (const f of stored) fs.writeFileSync(path.join(inbox, f.stored), f.data);
    const line = (f: (typeof stored)[number]) =>
      `[첨부] ${path.join(inbox, f.stored)} (${f.type}, ${Math.max(1, Math.ceil(f.data.length / 1024))} KB)`;

    await daemon.loginUrl();
    let session: { cwd: string; sessionId: string } | undefined;
    for (const end = Date.now() + 40_000; !session; ) {
      if (Date.now() > end) throw new Error('the engine did not revive alpha');
      for (const f of fs.existsSync(sessions) ? fs.readdirSync(sessions) : [])
        try {
          const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8'));
          if (s.name === 'alpha') session = s;
        } catch {
          /* being written */
        }
      await new Promise((r) => setTimeout(r, 300));
    }
    const transcript = transcriptPath(session.cwd, session.sessionId, home);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    const record = (i: number, role: 'user' | 'assistant', text: string) =>
      `${JSON.stringify({
        type: role,
        uuid: `${i.toString(16).padStart(8, '0')}-8400-4000-8000-000000000000`,
        timestamp: new Date(Date.now() - 60_000 + i * 1000).toISOString(),
        message:
          role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
      })}\n`;
    fs.appendFileSync(
      transcript,
      record(1, 'user', `파일 여섯 개\n${stored.map(line).join('\n')}`) +
        record(2, 'assistant', '파일 받았어요'),
    );

    browser = await launchBrowser();
    const pageErrors: string[] = [];
    const open = async (opts: BrowserContextOptions) => {
      const ctx = await browser!.newContext({ ...opts, acceptDownloads: true });
      await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(BASE);
      return { ctx, page };
    };

    for (const touch of [false, true]) {
      const tag = touch ? 'phone' : 'desktop';
      const { ctx, page } = await open(
        touch ? PHONE : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
      );
      const tapOn = (sel: string) =>
        touch ? page.locator(sel).first().tap() : page.locator(sel).first().click();
      const hud = page.getByRole('button', { name: /^메신저/ });
      await hud.waitFor();
      await (touch ? hud.tap() : hud.click());
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      const alpha = messenger
        .getByRole('list', { name: '연락처' })
        .getByRole('button', { name: /^alpha/ });
      await (touch ? alpha.tap() : alpha.click());
      const conv = messenger.getByRole('region', { name: 'alpha 대화' });
      await conv.getByText('파일 받았어요').waitFor({ timeout: 20_000 });
      const png = conv.locator('[title$="a.png"]');
      await png.locator('img').waitFor();
      await (touch ? png.tap() : png.click());
      await page.locator('[data-testid="attach-viewer"]').waitFor();
      const counter = async () => (await page.locator('.attach-title-meta').textContent()) ?? '';
      const canShare = await page.evaluate(
        () =>
          typeof navigator.canShare === 'function' &&
          navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] }),
      );
      const clip = () => page.evaluate(() => navigator.clipboard.readText());
      const selection = () => page.evaluate(() => window.getSelection()?.toString() ?? '');

      for (let i = 0; i < FILES.length; i++) {
        const f = FILES[i];
        const at = `${tag} ${f.name}`;
        if (i > 0) await tapOn('[data-testid="attach-next"]');
        await until(async () => (await counter()).startsWith(`${i + 1} / ${FILES.length} · `));
        const content = {
          image: '[data-testid="attach-img"]',
          md: '[data-testid="attach-markdown-preview"]',
          text: '[data-testid="attach-text-preview"]',
          card: '[data-testid="attach-file"]',
        }[f.kind];
        await page.locator(content).waitFor();
        await page.waitForTimeout(300);
        const buttons = await page
          .locator('[data-testid="attach-actions"] button')
          .allTextContents();
        console.log(`  ${at}: buttons [${buttons.join(' | ')}]`);
        await page.screenshot({ path: path.join(OUT, `${tag}-${f.name.replace('.', '-')}.png`) });
        const ids = await page
          .locator('[data-testid="attach-actions"] button[data-testid]')
          .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
        const share = canShare ? ['attach-share'] : [];
        const want =
          f.kind === 'image'
            ? ['attach-download', ...share, 'attach-copy', 'attach-open']
            : f.kind === 'card'
              ? ['attach-download', ...(f.type === 'application/pdf' ? ['attach-open'] : []), ...share]
              : ['attach-copy', 'attach-download', ...share];
        check(
          JSON.stringify(ids) === JSON.stringify(want),
          `${at}: action row ${ids.join(',')} (canShare ${canShare})`,
        );
        const row = await page.locator('[data-testid="attach-actions-controls"]').boundingBox();
        check(
          row !== null && row.y + row.height <= (touch ? 844 : 800) && row.y > (touch ? 600 : 650),
          `${at}: the action row sits at the bottom (y ${row?.y.toFixed(0)})`,
        );
        check(
          ((await page.locator('[data-testid="attach-zoom-in"]').count()) > 0) ===
            (f.kind === 'image'),
          `${at}: zoom bar only for images`,
        );

        const download = page.waitForEvent('download');
        await tapOn('[data-testid="attach-download"]');
        const got = await download;
        check(
          got.suggestedFilename().endsWith(f.name) && page.url() === BASE,
          `${at}: 내려받기 downloads ${got.suggestedFilename()}`,
        );

        if (f.text !== undefined) {
          await page.evaluate(() => navigator.clipboard.writeText('sentinel'));
          await tapOn('[data-testid="attach-copy"]');
          check(
            await until(async () => (await clip()) === f.text, 3_000),
            `${at}: 글 복사 puts the whole file text on the clipboard (${(await clip()).length} chars)`,
          );
        }

        if (f.kind === 'md') {
          const md = page.locator('[data-testid="attach-markdown-preview"]');
          const dom = await md.evaluate((el) => ({
            // The chat renderer draws headings as role="heading" blocks.
            h1: el.querySelectorAll('[role="heading"][aria-level="1"], h1').length,
            h2: el.querySelectorAll('[role="heading"][aria-level="2"], h2').length,
            li: el.querySelectorAll('li').length,
            code: el.querySelectorAll('code, pre').length,
            table: el.querySelectorAll('table td, table th').length,
            img: el.querySelectorAll('img').length,
            script: el.querySelectorAll('script').length,
            js: [...el.querySelectorAll('a')].filter((a) => /^javascript:/i.test(a.href)).length,
            text: el.textContent ?? '',
          }));
          console.log(`  ${at}: rendered ${JSON.stringify({ ...dom, text: undefined })}`);
          check(
            dom.h1 >= 1 && dom.h2 >= 1 && dom.li >= 3 && dom.code >= 1 && dom.table >= 4,
            `${at}: rendered by default (headings, lists, code, table)`,
          );
          check(
            dom.img === 0 &&
              dom.script === 0 &&
              dom.js === 0 &&
              (await page.evaluate(() => (window as unknown as { __xss?: unknown }).__xss)) ===
                undefined,
            `${at}: no img/script/javascript: link from the file reaches the DOM, nothing ran`,
          );
          check(
            dom.text.includes('onerror') || dom.text.includes('<img'),
            `${at}: hostile HTML shows as text`,
          );
          await (touch
            ? page.getByTestId('attach-actions').getByRole('button', { name: '원문', exact: true }).tap()
            : page.getByTestId('attach-actions').getByRole('button', { name: '원문', exact: true }).click());
          const raw = page.locator('[data-testid="attach-text-preview"]');
          check(
            (await raw.count()) === 1 && (await raw.textContent())?.includes('# Release notes'),
            `${at}: 원문 shows the raw source`,
          );
          await page.screenshot({ path: path.join(OUT, `${tag}-notes-md-raw.png`) });
          await (touch
            ? page.getByTestId('attach-actions').getByRole('button', { name: '보기', exact: true }).tap()
            : page.getByTestId('attach-actions').getByRole('button', { name: '보기', exact: true }).click());
          check((await md.count()) === 1, `${at}: 보기 renders it again`);
        }

        if (f.kind === 'md' || f.kind === 'text') {
          const preview = page.locator(
            f.kind === 'md'
              ? '[data-testid="attach-markdown-preview"]'
              : '[data-testid="attach-text-preview"]',
          );
          const box = (await preview.boundingBox())!;
          await page.evaluate(() => window.getSelection()?.removeAllRanges());
          if (!touch) {
            await page.mouse.move(box.x + 22, box.y + 22);
            await page.mouse.down();
            await page.mouse.move(box.x + 200, box.y + 70, { steps: 8 });
            await page.mouse.up();
            const sel = await selection();
            check(
              sel.length > 3 && (await counter()).startsWith(`${i + 1} / `),
              `${at}: a mouse drag selects text ("${sel.slice(0, 30).replace(/\n/g, '⏎')}"), the file stays`,
            );
          } else {
            const cdp = await ctx.newCDPSession(page);
            const p = { x: box.x + 40, y: box.y + 26 };
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [p] });
            await page.waitForTimeout(1_000);
            await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            await page.waitForTimeout(300);
            // Headless Linux Chromium never selects on a long press (not even on a bare page),
            // so the phone checks what decides it: the preview's text is selectable.
            const selectable = await preview.evaluate(
              (el) => getComputedStyle(el).userSelect === 'text',
            );
            check(
              selectable && (await counter()).startsWith(`${i + 1} / `),
              `${at}: preview text is user-select: text, a long press keeps the file`,
            );
            await page.evaluate(() => window.getSelection()?.removeAllRanges());
            if (f.name === 'notes.txt') {
              const scroll = () => preview.evaluate((el) => [el.scrollLeft, el.scrollTop]);
              const s0 = await scroll();
              const steps = (from: { x: number; y: number }, to: { x: number; y: number }) =>
                Array.from({ length: 12 }, (_, k) => ({
                  x: from.x + ((to.x - from.x) * k) / 11,
                  y: from.y + ((to.y - from.y) * k) / 11,
                }));
              const swipe = async (pts: Array<{ x: number; y: number }>) => {
                await cdp.send('Input.dispatchTouchEvent', {
                  type: 'touchStart',
                  touchPoints: [pts[0]],
                });
                for (const q of pts.slice(1))
                  await cdp.send('Input.dispatchTouchEvent', {
                    type: 'touchMove',
                    touchPoints: [q],
                  });
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                await page.waitForTimeout(500);
              };
              const mid = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
              await swipe(steps({ x: mid.x, y: mid.y + 120 }, { x: mid.x, y: mid.y - 120 }));
              await swipe(steps({ x: mid.x + 120, y: mid.y }, { x: mid.x - 120, y: mid.y }));
              const s1 = await scroll();
              check(
                s1[1] > s0[1] && s1[0] > s0[0] && (await counter()).startsWith(`${i + 1} / `),
                `${at}: a finger scrolls the preview down (${s0[1]}→${s1[1]}) and sideways (${s0[0]}→${s1[0]}), no swipe to another file`,
              );
            }
            await cdp.detach();
          }
        }

        if (f.kind === 'image') {
          const z0 = await page.locator('[data-testid="attach-zoom"]').textContent();
          await tapOn('[data-testid="attach-zoom-in"]');
          check(
            await until(
              async () => (await page.locator('[data-testid="attach-zoom"]').textContent()) !== z0,
            ),
            `${at}: + still zooms (${z0} → ${await page.locator('[data-testid="attach-zoom"]').textContent()})`,
          );
          await tapOn('[data-testid="attach-zoom-out"]');
          await tapOn('[data-testid="attach-copy"]');
          const types = await until(async () =>
            page.evaluate(async () => {
              try {
                const items = await navigator.clipboard.read();
                return items.some((it) => it.types.includes('image/png'));
              } catch {
                return false;
              }
            }),
          );
          check(types, `${at}: 복사 puts an image/png on the clipboard`);
        }
      }

      if (!touch) {
        // No clipboard (a plain-http LAN address): 글 복사 selects the preview for a manual copy.
        for (let k = 0; k < 3; k++) await tapOn('[data-testid="attach-prev"]');
        await until(async () => (await counter()).startsWith(`3 / ${FILES.length} · `));
        await page.locator('[data-testid="attach-text-preview"]').waitFor();
        await page.evaluate(() => {
          Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
          window.getSelection()?.removeAllRanges();
        });
        await tapOn('[data-testid="attach-copy"]');
        const sel = await selection();
        check(
          sel.includes('line 1 of the notes') && sel.includes('line 80 of the notes'),
          `${tag}: without a clipboard 글 복사 selects the whole preview (${sel.length} chars)`,
        );
        check(
          await until(async () => (await page.getByText('직접 복사해 주세요').count()) > 0, 3_000),
          `${tag}: and says why (toast)`,
        );
        await page.screenshot({ path: path.join(OUT, `${tag}-copy-manual.png`) });
      }
      await ctx.close();
    }
    check(pageErrors.length === 0, `no page errors${pageErrors.length ? `: ${pageErrors[0]}` : ''}`);
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
