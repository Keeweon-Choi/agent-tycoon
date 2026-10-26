/**
 * CH-6 custom character editor check: dist/cli.js with an isolated HOME on a spare port, headless
 * Chromium (no GPU), desktop 1280x800 and phone 393x852. One fake Claude session (a `sleep` with
 * a transcript), no model is ever called.
 *
 * Desktop: 꾸미기 → 커스텀 → PNG 가져오기 refuses three bad sheets with their reason, opens a
 * good one; a pixel is painted, undone and redone (Ctrl+Z / Ctrl+Y), a stroke is one step; the
 * sheet is exported, re-imported and exported again (same bytes); 저장 writes custom-<time>.png,
 * assigns it, and the card face follows. Phone: 꾸미기 page → 커스텀 → 지금 모습 편집, a finger
 * paints, the 되돌리기 button undoes. Screenshots: cld/artifacts/ch6/.
 *
 *   npx tsx cld/test/run-editor.ts <port 18256-18259>
 */
import type { Locator, Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { rgbaToHex } from '../../core/src/assets/colorUtils.js';
import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/ch6');
const CHAR_0 = fs.readFileSync(
  path.join(REPO_ROOT, 'webview-ui/public/assets/characters/char_0.png'),
);
const ZOOM = 12; // PIXEL_EDITOR_ZOOM
const RED = rgbaToHex(255, 0, 0, 255).toLowerCase();

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(
  what: string,
  fn: () => Promise<boolean> | boolean,
  ms = 30_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

function session(home: string, name: string, cwd: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c1024600-0000-4000-8000-000000000001';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: `${cwd}/README.md` } },
        ],
      },
    }) + '\n',
  );
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      cwd,
      startedAt: Date.now() - 600_000,
      procStart,
      version: '2.1.306',
      kind: 'interactive',
      name,
      status: 'busy',
    }),
  );
  return proc;
}

/** CHAR_0 with `edit` applied to its pixels. */
function edited(edit: (d: Buffer) => void): Buffer {
  const img = PNG.sync.read(CHAR_0);
  edit(img.data);
  return PNG.sync.write(img, { colorType: 6 });
}

/** The editor canvas's colour at frame pixel (x, y), as #rrggbb (or '' when clear). */
const pixelAt = (canvas: Locator, x: number, y: number) =>
  canvas.evaluate(
    (c: HTMLCanvasElement, [px, py]: number[]) => {
      const d = c.getContext('2d')!.getImageData(px, py, 1, 1).data;
      return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    },
    [(x + 0.5) * ZOOM, (y + 0.5) * ZOOM],
  );

/** True when the card portrait of character `id` has a pixel of colour `hex`. */
const cardHas = (page: Page, id: number, hex: string) =>
  page
    .locator(`[data-testid="agent-card"][data-agent-id="${id}"] canvas`)
    .first()
    .evaluate((c: HTMLCanvasElement, hex: string) => {
      const want = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4)
        if (d[i + 3] > 200 && want.every((v, k) => Math.abs(d[i + k] - v) <= 2)) return true;
      return false;
    }, hex);

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const store = path.join(configDirectory(home), 'characters.json');
  const presetDir = path.join(configDirectory(home), 'characters');
  fs.writeFileSync(store, JSON.stringify({ $meta: { v: 2, pinnedAt: 'x' } }));
  const lead = session(home, 'lead', '/work/alpha');
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal'], {});
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const looks = () =>
    JSON.parse(fs.readFileSync(store, 'utf-8')) as Record<string, Record<string, unknown>>;

  try {
    const loginUrl = await started.loginUrl();
    const { ctx: desk, page } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const card = page.locator('[data-testid="agent-card"]').first();
    await card.waitFor();
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.click();
    await until('lead is pinned to Coral', () => looks().lead?.species === 'coral');
    const id = Number(await card.getAttribute('data-agent-id'));

    await card.click({ button: 'right' });
    const win = page.locator('[data-testid="looks-window"]');
    await win.waitFor();
    await win.getByRole('button', { name: '커스텀', exact: true }).click();

    // Import: three bad sheets are refused with their reason; the good one opens the editor.
    const importFile = (name: string, buffer: Buffer) =>
      page.getByTestId('editor-import').setInputFiles({ name, mimeType: 'image/png', buffer });
    const problem = page.getByTestId('editor-import-problem');
    const bad: Array<[string, Buffer, RegExp]> = [
      [
        'empty.png',
        edited((d) => {
          for (let y = 32; y < 64; y++) d.fill(0, (y * 112 + 48) * 4, (y * 112 + 64) * 4);
        }),
        /2줄 4칸이 비었어요/,
      ],
      ['interlaced.png', Buffer.from(CHAR_0).fill(1, 28, 29), /인터레이스/],
      ['small.png', PNG.sync.write(new PNG({ width: 64, height: 96 })), /64×96/],
    ];
    for (const [name, buffer, reason] of bad) {
      await importFile(name, buffer);
      await problem.waitFor();
      const text = await problem.innerText();
      check(reason.test(text), `${name} is refused: "${text}"`);
      if (name === 'empty.png')
        await win.screenshot({ path: path.join(OUT, 'desktop-import-refused.png') });
    }
    check((await page.getByTestId('pixel-editor').count()) === 0, 'no bad sheet opened the editor');
    await importFile('good.png', CHAR_0);
    const editor = page.getByTestId('pixel-editor');
    await editor.waitFor();
    check(true, 'a good PNG opens in the editor');

    // Paint one pixel, undo, redo (keys).
    const canvas = page.getByTestId('editor-canvas');
    const before = await pixelAt(canvas, 5, 10);
    await editor.locator('input[type="color"]').fill(RED);
    const box = (await canvas.boundingBox())!;
    const cell = (x: number, y: number) =>
      [box.x + (x + 0.5) * ZOOM, box.y + (y + 0.5) * ZOOM] as const;
    await page.mouse.click(...cell(5, 10));
    check((await pixelAt(canvas, 5, 10)) === RED, 'the pencil paints the pixel');
    await page.keyboard.press('Control+z');
    check((await pixelAt(canvas, 5, 10)) === before, 'Ctrl+Z undoes it');
    await page.keyboard.press('Control+y');
    check((await pixelAt(canvas, 5, 10)) === RED, 'Ctrl+Y redoes it');
    // A stroke across four pixels is one step.
    await page.mouse.move(...cell(4, 14));
    await page.mouse.down();
    for (const x of [5, 6, 7]) await page.mouse.move(...cell(x, 14));
    await page.mouse.up();
    const stroke = await Promise.all([4, 5, 6, 7].map((x) => pixelAt(canvas, x, 14)));
    check(
      stroke.every((c) => c === RED),
      'a drag paints every pixel it crosses',
    );
    await editor.getByTestId('editor-undo').click();
    const undone = await Promise.all([4, 5, 6, 7].map((x) => pixelAt(canvas, x, 14)));
    check(
      undone.every((c) => c !== RED),
      'one 되돌리기 removes the whole stroke',
    );
    check((await pixelAt(canvas, 5, 10)) === RED, '...and only it');
    await editor.getByTestId('editor-redo').click();
    await page.waitForTimeout(600);
    await shot(page, 'desktop-editor');
    await editor.screenshot({ path: path.join(OUT, 'desktop-editor-close.png') });

    // Export, re-import, export again: the same bytes.
    const exportBytes = async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByTestId('editor-export').click(),
      ]);
      return fs.readFileSync((await download.path())!);
    };
    const first = await exportBytes();
    check(
      PNG.sync.read(first).width === 112 && PNG.sync.read(first).height === 96,
      'the export is a 112×96 PNG',
    );
    await editor.getByRole('button', { name: '뒤로' }).click();
    await importFile('exported.png', first);
    await editor.waitFor();
    const second = await exportBytes();
    check(
      first.equals(second),
      `export → import → export gives the same bytes (${first.length} B)`,
    );

    // Save: custom-<time>.png, assigned, the card follows.
    await page.getByTestId('editor-save').click();
    await until('the custom sheet is assigned', () =>
      String(looks().lead?.preset ?? '').startsWith('custom-'),
    );
    const preset = String(looks().lead.preset);
    check(
      fs.existsSync(path.join(presetDir, `${preset}.png`)),
      `${preset}.png is in the preset folder`,
    );
    check(
      fs.existsSync(path.join(presetDir, `${preset}.mug.png`)),
      'with its 16×16 face cut from the front frame',
    );
    await until('the card face has the red pixel', () => cardHas(page, id, RED));
    check(true, 'the card face follows the saved sheet');
    await page.waitForTimeout(500);
    await shot(page, 'desktop-saved');
    await page.getByRole('button', { name: '꾸미기 닫기' }).click();
    await page.waitForTimeout(800);
    await shot(page, 'desktop-office-after');

    // The phone: the 꾸미기 page → 커스텀 → 지금 모습 편집, a finger paints, the button undoes.
    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await phoneCtx.addCookies(await desk.cookies());
    await phone.goto(`http://127.0.0.1:${port}/`);
    const phoneCard = phone.locator('[data-testid="agent-card"]').first();
    await phoneCard.waitFor();
    const phoneInfo = phone.getByRole('button', { name: '정보 창 닫기' });
    if (await phoneInfo.count()) await phoneInfo.click();
    await phone.locator('[data-testid="agent-overlay"]').first().waitFor();
    await phone.waitForTimeout(500);
    await phoneCard.tap();
    await phone.getByRole('menuitem', { name: '꾸미기' }).tap({ timeout: 5_000 });
    const page2 = phone.locator('[data-testid="looks-window"]');
    await page2.waitFor();
    await page2.getByRole('button', { name: '커스텀', exact: true }).tap();
    await phone.getByTestId('editor-open').tap();
    const phoneCanvas = phone.getByTestId('editor-canvas');
    await phoneCanvas.waitFor();
    await phoneCanvas.scrollIntoViewIfNeeded();
    check((await pixelAt(phoneCanvas, 5, 10)) === RED, 'the phone opens the saved sheet');
    await phone.getByTestId('editor-tool-eraser').tap();
    const pbox = (await phoneCanvas.boundingBox())!;
    await phone.touchscreen.tap(pbox.x + 5.5 * ZOOM, pbox.y + 10.5 * ZOOM);
    check((await pixelAt(phoneCanvas, 5, 10)) !== RED, 'a finger tap erases the pixel');
    await phone.getByTestId('editor-undo').tap();
    check((await pixelAt(phoneCanvas, 5, 10)) === RED, 'the 되돌리기 button brings it back');
    await phone.waitForTimeout(500);
    await shot(phone, 'phone-editor');
    await phoneCtx.close();

    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
    console.log('all checks passed');
  } finally {
    await browser.close();
    started.child.kill();
    lead.kill();
    killFakeSessions(home);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
