/**
 * CH-6b furniture art check: dist/cli.js with an isolated HOME on a spare port, headless Chromium
 * (no GPU), desktop 1280x800 and phone 393x852. One fake Claude session (a `sleep` with a
 * transcript) so the office has a desk; no model is ever called.
 *
 * Desktop: 인테리어 → click the lead's desk → 그림 고치기 → paint a red line → 저장. The daemon
 * writes its settings/furniture/custom-desk-front-<time>/ (png + its own manifest, 0600),
 * the desk switches to it (Ctrl+Z / Ctrl+Y move between the two), Save, a reload keeps it. Phone:
 * the office shows the custom desk. Desktop: 이 그림 지우기 removes the folder and the placed
 * copy goes like a missing asset. Screenshots: cld/artifacts/ch6b/.
 *
 *   npx tsx cld/test/run-ch6b.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/ch6b');
const ZOOM = 8; // PixelEditor: 32×12 / 48 for a 48 px wide desk
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
  const sessionId = 'c1024600-0000-4000-8000-0000000006b1';
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

type Placed = { uid: string; type: string; col: number; row: number };
const furniture = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __pixelAgentsTestHooks?: { getFurniture?: () => Placed[] };
        }
      ).__pixelAgentsTestHooks?.getFurniture?.() ?? [],
  );
const instances = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __pixelAgentsTestHooks?: { getFurnitureCount?: () => number };
        }
      ).__pixelAgentsTestHooks?.getFurnitureCount?.() ?? 0,
  );
/** The lead's desk (the user's items come after the generator's in a composed layout). */
const deskOf = async (page: Page) =>
  (await furniture(page)).find((f) => f.uid === 'desk:name:lead');

/** Page point of tile (col,row)'s centre, through the renderer's own projection. */
async function tilePoint(page: Page, col: number, row: number) {
  const canvas = page.locator('[data-testid="office-canvas"]');
  const box = (await canvas.boundingBox())!;
  const c = await page.evaluate(
    ([x, y]) =>
      (
        window as unknown as {
          __pixelAgentsTestHooks?: {
            getTileCenter?: (c: number, r: number) => { x: number; y: number } | null;
          };
        }
      ).__pixelAgentsTestHooks?.getTileCenter?.(x, y) ?? null,
    [col, row] as const,
  );
  if (!c) throw new Error(`tile ${col},${row} has no projection`);
  return { x: box.x + c.x, y: box.y + c.y };
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const custom = path.join(configDirectory(home), 'furniture');
  const lead = session(home, 'lead', '/work/alpha');
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal'], {});
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('dialog', (d) => void d.accept());
    return { ctx, page };
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });

  try {
    const loginUrl = await started.loginUrl();
    const { ctx: desk, page } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.locator('[data-testid="agent-card"]').first().waitFor();
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.click();
    await until('the lead has a desk', async () => !!(await deskOf(page)));
    const original = (await deskOf(page))!;
    check(original.type === 'DESK_FRONT', `the lead's desk is ${original.type}`);

    // 인테리어 → the desk (its bottom-left tile: the PC stands on the middle of the top row).
    await page.locator('.cld-elevator-decorate').click();
    await page.waitForTimeout(500);
    const p = await tilePoint(page, original.col, original.row + 1);
    await page.mouse.click(p.x, p.y);
    const editArt = page.getByTestId('furniture-art-edit');
    await editArt.waitFor({ timeout: 5_000 });
    check(
      (await page.getByTestId('furniture-art-remove').count()) === 0,
      'a bundled desk offers 그림 고치기 and no remove',
    );
    await shot(page, 'desktop-selected');
    await editArt.click();
    const editor = page.getByTestId('pixel-editor');
    await editor.waitFor();
    const canvas = page.getByTestId('editor-canvas');
    const size = await canvas.evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
    check(size[0] === 48 * ZOOM && size[1] === 32 * ZOOM, `the editor opens 48×32 at ${ZOOM}x`);
    check((await editor.getByTestId('editor-sheet').count()) === 0, 'no character frame picker');

    // A red line across the desk top, one stroke.
    await editor.locator('input[type="color"]').fill(RED);
    const box = (await canvas.boundingBox())!;
    const cell = (x: number, y: number) =>
      [box.x + (x + 0.5) * ZOOM, box.y + (y + 0.5) * ZOOM] as const;
    await page.mouse.move(...cell(6, 10));
    await page.mouse.down();
    for (let x = 7; x <= 41; x++) await page.mouse.move(...cell(x, 10));
    await page.mouse.up();
    await page.waitForTimeout(300);
    await shot(page, 'desktop-editor');
    await page.getByTestId('editor-save').click();
    await until('the desk switches to its custom copy', async () =>
      /^custom-desk-front-\d+$/.test((await deskOf(page))?.type ?? ''),
    );
    const id = (await deskOf(page))!.type;
    check(true, `the desk is now ${id}`);
    const folder = path.join(custom, id);
    check(
      fs.readdirSync(folder).sort().join(',') === `${id}.png,manifest.json`,
      `${folder} holds the png and the manifest only`,
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(folder, 'manifest.json'), 'utf-8'));
    check(
      manifest.category === 'desks' &&
        manifest.footprintW === 3 &&
        manifest.backgroundTiles === 1 &&
        manifest.width === 48,
      `the daemon built the manifest from the desk's catalog fields (${manifest.name})`,
    );
    check((fs.statSync(path.join(folder, `${id}.png`)).mode & 0o777) === 0o600, 'the png is 0600');
    await until(
      'the remove button follows the custom item',
      async () => (await page.getByTestId('furniture-art-remove').count()) === 1,
    );
    await page.keyboard.press('Control+z');
    await until(
      'Ctrl+Z gives the bundled desk back',
      async () => (await deskOf(page))?.type === 'DESK_FRONT',
    );
    await page.keyboard.press('Control+y');
    await until('Ctrl+Y the custom one', async () => (await deskOf(page))?.type === id);
    await page.locator('button[title="Save layout"]').click();
    await page.waitForTimeout(1_200); // the 500 ms save debounce and the daemon's decor write
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await shot(page, 'desktop-saved');

    await page.reload();
    await page.locator('[data-testid="agent-card"]').first().waitFor();
    await until('a reload keeps the custom desk', async () => (await deskOf(page))?.type === id);
    check(true, 'a reload keeps the custom desk');
    await page.waitForTimeout(800);
    await shot(page, 'desktop-reloaded');

    // The phone sees the same office.
    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await phoneCtx.addCookies(await desk.cookies());
    await phone.goto(`http://127.0.0.1:${port}/`);
    await phone.locator('[data-testid="agent-card"]').first().waitFor();
    const phoneInfo = phone.getByRole('button', { name: '정보 창 닫기' });
    if (await phoneInfo.count()) await phoneInfo.click();
    await until('the phone has the custom desk', async () => (await deskOf(phone))?.type === id);
    check(true, 'the phone office shows the custom desk');
    await phone.waitForTimeout(800);
    await shot(phone, 'phone-office');

    // Remove it: the folder goes, the placed copy is drawn no more.
    await page.locator('.cld-elevator-decorate').click();
    await page.waitForTimeout(500);
    const before = await instances(page);
    const q = await tilePoint(page, original.col, original.row + 1);
    await page.mouse.click(q.x, q.y);
    await page.getByTestId('furniture-art-remove').click();
    await until('the folder is removed', () => !fs.existsSync(folder));
    await until(
      'the placed copy is no longer drawn',
      async () => (await instances(page)) === before - 1,
    );
    check(true, 'removing the custom item drops its folder and its drawing');
    await until('the phone drops it too', async () => (await instances(phone)) === before - 1);
    await page.waitForTimeout(500);
    await shot(page, 'desktop-removed');
    await shot(phone, 'phone-removed');
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
