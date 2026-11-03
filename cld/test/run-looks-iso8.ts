/**
 * LOOKS-ISO8: 꾸미기 > 커스텀 with an iso8 preset (copied into the temp HOME) selected: the big
 * preview draws it (no fall-back note) and the thumbnail is not squeezed. Screenshots:
 * cld/artifacts/looks-iso8/. SHEET_DIR defaults to packs-private/char-iso-1/8dir/pack in the main checkout.
 *
 *   npx tsx cld/test/run-looks-iso8.ts <port 18260-18269>
 */
/* CH-4 꾸미기 check: dist/cli.js with an isolated HOME on a spare port, headless Chromium (no
 * GPU), desktop 1280x800 and phone 393x852. One fake Claude session (a `sleep` with a
 * transcript), no model is ever called.
 *
 * Desktop: the card's right-click opens the window; a mascot is changed (species, colour, face,
 * headgear) and saved: characters.json and the card face follow; 랜덤 then 되돌리기; 기본으로
 * pins the provider's Coral again; a person look is saved. Phone: card tap → the character's
 * menu → 꾸미기 opens as a page; a Dock button minimizes it. Screenshots: cld/artifacts/ch4/.
 *
 * CH-5: on the 사람 tab, part swatches (skin, hair, top, shoes) and two accessories are saved:
 * characters.json holds them, the card face has the hair colour; the phone's 꾸미기 page shows
 * the saved person. Screenshots: cld/artifacts/char-humanoid/.
 *
 *   npx tsx cld/test/run-looks.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { HUMANOID_SWATCHES, MASCOT_COLORS } from '../../core/src/cld/looks.js';
import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
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
const OUT = path.join(REPO_ROOT, 'cld/artifacts/looks-iso8');

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 30_000): Promise<void> {
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
  const sessionId = 'c1024400-0000-4000-8000-000000000001';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  // At work (reading a file), so it stays at its desk and can be selected.
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5',
        content: [{ type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: `${cwd}/README.md` } }],
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
  const dir = path.join(configDirectory(home), 'characters');
  fs.mkdirSync(dir, { recursive: true });
  const from = process.env.SHEET_DIR ?? '/tmp/example-home/projects/cld-gui/packs-private/char-iso-1/8dir/pack';
  for (const f of ['boss-iso.png', 'boss-iso.json']) fs.copyFileSync(path.join(from, f), path.join(dir, f));
  fs.writeFileSync(path.join(configDirectory(home), 'characters.json'), JSON.stringify({ $meta: { v: 2, pinnedAt: 'x' } }));
  const lead = session(home, 'lead', '/work/alpha');
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal'], {});
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  try {
    const loginUrl = await started.loginUrl();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;');
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    const card = page.locator('[data-testid="agent-card"]').first();
    await card.waitFor();
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.click();
    await card.click({ button: 'right' });
    const win = page.locator('[data-testid="looks-window"]');
    await win.waitFor();
    await win.getByRole('button', { name: '커스텀' }).click();
    const preset = win.getByTestId('looks-custom-preset-boss-iso');
    await preset.waitFor({ timeout: 15_000 });
    await preset.click();
    await page.waitForTimeout(1500);
    // the release toast covers the thumbnail: close it
    const toast = page.getByText('새 소식 보기');
    if (await toast.count()) await toast.locator('xpath=ancestor::*[.//button][1]').getByRole('button').last().click();
    await page.waitForTimeout(300);
    await win.screenshot({ path: path.join(OUT, 'desktop-window.png') });
    check((await win.getByText('이 모습을 그리지 못해').count()) === 0, 'no fall-back note');
    check(pageErrors.length === 0, `no page errors (${pageErrors.join('; ')})`);
    await ctx.close();
  } finally {
    await browser.close();
    lead.kill();
    await started.stop();
    killFakeSessions(home);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
