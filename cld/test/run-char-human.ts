/**
 * CHAR-HUMAN check: dist/cli.js with an isolated HOME on a spare port, headless Chromium (no GPU),
 * desktop 1280x800 and a phone 390x844. One fake Claude session (a `sleep` with a transcript); no
 * model is ever called. Build first (`node esbuild.js && npm run build:webview`).
 *
 * The card's 꾸미기 → 사람 꾸미기: 성별 여, a hair, a top and its colour are picked and saved
 * (characters.json holds the v3 person); a ×20 drawing on the row template (made here, shifted
 * and blurred like a generator's) goes through 부품 가져오기: preview, save (the part folder in the
 * temp HOME, its thumbnail in the window); the look is saved under a name (presets.json). The
 * saved person is also drawn in all 21 frames ×4 off the compositor. Screenshots:
 * cld/artifacts/char-human/.
 *
 *   npx tsx cld/test/run-char-human.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { HUMANOID_SWATCHES } from '../../core/src/cld/looks.js';
import type { CharacterChoice } from '../../core/src/messages.js';
import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { bigRow, source } from '../../server/src/cld/partFixture.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { composePerson } from '../../webview-ui/src/cld/characters/parts.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/char-human');
const ZOOM = 4;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

/** The import's 21-frame preview lies wholly inside its scrolling area and the viewport. */
async function previewInSight(panel: ReturnType<Page['locator']>, what: string): Promise<void> {
  const preview = panel.getByTestId('part-import-preview');
  await preview.scrollIntoViewIfNeeded();
  const box = await preview.evaluate((el) => {
    let s = el.parentElement;
    while (s && getComputedStyle(s).overflowY !== 'auto') s = s.parentElement;
    const a = el.getBoundingClientRect();
    const b = (s ?? document.documentElement).getBoundingClientRect();
    const inside =
      a.top >= b.top - 0.5 &&
      a.bottom <= b.bottom + 0.5 &&
      a.left >= b.left - 0.5 &&
      a.right <= b.right + 0.5 &&
      a.bottom <= innerHeight &&
      a.right <= innerWidth;
    return { inside, w: Math.round(a.width), h: Math.round(a.height), area: Math.round(b.height) };
  });
  check(
    box.inside,
    `${what}: the 21-frame preview (${box.w}x${box.h}) is fully in sight (area ${box.area} high)`,
  );
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
  const sessionId = 'c1025180-0000-4000-8000-000000000001';
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

/** The owner's drawing: a red top (top-0's shape) on one row's ×20 template, a little off. */
function drawing(file: string, view: number) {
  const img = bigRow(view, (x, y) => (source(view)(x, y) ? 'c03028' : ''), { shift: [6, 4] });
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data);
  fs.writeFileSync(file, PNG.sync.write(png));
}

/** The look in all 21 frames, ×ZOOM, on a light checker. */
function writeSheet(
  file: string,
  look: CharacterChoice,
  custom: Parameters<typeof composePerson>[1],
) {
  const { sheet } = composePerson(look, custom);
  const out = new PNG({ width: 112 * ZOOM, height: 96 * ZOOM });
  (['down', 'up', 'right'] as const).forEach((view, r) =>
    sheet[view].forEach((frame, f) =>
      frame.forEach((row, y) =>
        row.forEach((c, x) => {
          const bg = (f + r) % 2 ? 214 : 232;
          const rgb = c ? [1, 3, 5].map((k) => parseInt(c.slice(k, k + 2), 16)) : [bg, bg, bg];
          for (let dy = 0; dy < ZOOM; dy++)
            for (let dx = 0; dx < ZOOM; dx++)
              out.data.set(
                [...rgb, 255],
                (((r * 32 + y) * ZOOM + dy) * out.width + (f * 16 + x) * ZOOM + dx) * 4,
              );
        }),
      ),
    ),
  );
  fs.writeFileSync(file, PNG.sync.write(out));
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const store = path.join(home, '.config/cld-gui/characters.json');
  const partsDir = path.join(home, '.config/cld-gui/parts');
  fs.writeFileSync(store, JSON.stringify({ $meta: { v: 2, pinnedAt: 'x' } }));
  const rows = ['down', 'up', 'right'] as const;
  const drawingFile = (row: string) => path.join(home, `top-redhoodie-f-${row}.png`);
  rows.forEach((row, view) => drawing(drawingFile(row), view));
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
  const looks = () =>
    JSON.parse(fs.readFileSync(store, 'utf-8')) as Record<string, CharacterChoice>;

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
    await until('lead is pinned', () => !!looks().lead);

    await card.click({ button: 'right' });
    const win = page.locator('[data-testid="looks-window"]');
    await win.waitFor();
    await win.getByRole('button', { name: '사람 꾸미기' }).click();
    await win.getByTestId('looks-gender-f').click();
    check(
      (await win.getByTestId('looks-part-face-basic-f').getAttribute('aria-pressed')) === 'true',
      '여: the female face is worn',
    );
    await win.getByTestId('looks-part-hair-1').click();
    await win.getByTestId('looks-part-top-3').click();
    const red = HUMANOID_SWATCHES.clothes[4];
    await win.getByTestId(`looks-color-top-${red}`).click();
    await page.waitForTimeout(500);
    await win.screenshot({ path: path.join(OUT, 'looks-window-person.png') });
    await win.getByTestId('looks-save').click();
    await until('the person is saved', () => looks().lead?.kind === 'person');
    const saved = looks().lead;
    check(
      saved.v === 3 &&
        saved.gender === 'f' &&
        saved.parts?.hair === 'hair-1' &&
        saved.parts?.top === 'top-3' &&
        saved.colors?.top === red,
      `characters.json holds the v3 person (${JSON.stringify(saved)})`,
    );

    // 부품 가져오기: the ×20 drawing → preview on the person → save.
    const panel = win.getByTestId('part-import');
    await panel.scrollIntoViewIfNeeded();
    await panel.getByTestId('part-import-file').setInputFiles(drawingFile('down'));
    check(
      (await panel.locator('input').nth(1).inputValue()) === 'redhoodie',
      'the file name fills the name field',
    );
    await panel.getByTestId('part-import-run').click();
    await panel.getByTestId('part-import-preview').waitFor({ timeout: 20_000 });
    await previewInSight(panel, '1280x800');
    await page.waitForTimeout(300);
    await win.screenshot({ path: path.join(OUT, 'import-preview.png') });
    await panel.getByTestId('part-import-save').click();
    await until('the part folder is written', () =>
      fs.existsSync(path.join(partsDir, 'p-top-redhoodie', 'part.json')),
    );
    // the back and side rows, one file each, into the same part
    for (const row of ['up', 'right']) {
      const before = fs.statSync(path.join(partsDir, 'p-top-redhoodie', 'part.json')).mtimeMs;
      await panel.getByTestId('part-import-file').setInputFiles(drawingFile(row));
      await panel.getByTestId('part-import-run').click();
      await page.waitForTimeout(300);
      await until(
        `the ${row} row previews`,
        async () => !(await panel.getByTestId('part-import-save').isDisabled()),
        20_000,
      );
      await panel.getByTestId('part-import-save').click();
      await until(
        `the ${row} row is saved`,
        () => fs.statSync(path.join(partsDir, 'p-top-redhoodie', 'part.json')).mtimeMs > before,
      );
    }
    const part = JSON.parse(
      fs.readFileSync(path.join(partsDir, 'p-top-redhoodie', 'part.json'), 'utf-8'),
    );
    check(
      [0, 1, 2].every((r) =>
        [...part.pixels.slice(r * 32 * 112, (r + 1) * 32 * 112)].some((k: string) => k !== '.'),
      ),
      'all three rows are in the part',
    );
    check(
      part.gender === 'f' && part.slot === 'top' && part.kind === 'sheet',
      'the imported part is a female top',
    );
    await win.getByTestId('looks-part-p-top-redhoodie').waitFor();
    check(
      (await win.getByTestId('looks-part-p-top-redhoodie').getAttribute('aria-pressed')) === 'true',
      'the saved part is worn in the window',
    );
    await win.getByTestId('looks-slot-top').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await win.screenshot({ path: path.join(OUT, 'looks-window-imported.png') });

    // A named look.
    await win.getByTestId('looks-preset-name').scrollIntoViewIfNeeded();
    await win.getByTestId('looks-preset-name').fill('출근룩');
    await win.getByTestId('looks-preset-save').click();
    await until('presets.json has the look', () => {
      const file = path.join(partsDir, 'presets.json');
      return (
        fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf-8'))[0]?.name === '출근룩'
      );
    });
    await win.getByTestId('looks-preset-출근룩').waitFor();
    check(true, 'the saved look is listed');
    await win.getByTestId('looks-save').click();
    await until(
      'the imported top is saved on lead',
      () => looks().lead?.parts?.top === 'p-top-redhoodie',
    );
    await page.getByRole('button', { name: '꾸미기 닫기' }).click();
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'office.png') });

    // The phone's 꾸미기 page on the saved person.
    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 390, height: 844 },
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
    await phone.waitForTimeout(800);
    await phoneCard.tap();
    await phone.getByRole('menuitem', { name: '꾸미기' }).tap({ timeout: 5_000 });
    const page2 = phone.locator('[data-testid="looks-window"]');
    await page2.waitFor();
    await phone.waitForTimeout(500);
    await phone.screenshot({ path: path.join(OUT, 'phone-person-tab.png') });
    const phonePanel = page2.getByTestId('part-import');
    await phonePanel.scrollIntoViewIfNeeded();
    await phonePanel.getByTestId('part-import-file').setInputFiles(drawingFile('down'));
    await phonePanel.getByTestId('part-import-run').click();
    await phonePanel.getByTestId('part-import-preview').waitFor({ timeout: 20_000 });
    await previewInSight(phonePanel, '390x844');
    await phone.waitForTimeout(300);
    await phone.screenshot({ path: path.join(OUT, 'import-preview-phone.png') });
    await phoneCtx.close();

    writeSheet(path.join(OUT, 'person-21-frames-x4.png'), looks().lead, [part]);
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
