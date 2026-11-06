/**
 * UI-DEPTH (feat/ui-depth-primitives): before/after pictures of the shared parts' depth and
 * interaction. dist/cli.js in an isolated HOME on a spare port, headless Chromium without a GPU.
 * Desktop 1600x1000: the office, the messenger window, the 개발실, 설정; a button at rest, hovered
 * and pressed, cut out at 2x (nearest neighbour). Phone 390x844: the office and the messenger.
 * TAG=before|after (default after) prefixes the files in cld/artifacts/feat-ui-depth-primitives/.
 *
 *   npx tsx cld/test/run-ui-depth.ts <port 18700-18709>
 */
import type { Locator, Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
  topBarButton,
  topBarReady,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18700 && port <= 18709)) throw new Error('port must be 18700-18709');
const TAG = process.env.TAG ?? 'after';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/feat-ui-depth-primitives');
const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;
for (const [k, v] of [['cld.title-scene', 'off'], ['cld.office-iso', 'on'], ['cld.floor-view', 'one']])
  try { if (localStorage.getItem(k) === null) localStorage.setItem(k, v); } catch {}`;

function session(home: string, k: number, name: string) {
  const cwd = `/work/${name}`;
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `d0610000-0000-4000-8000-${String(k).padStart(12, '0')}`;
  const dir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const transcript = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(transcript, '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() - 600_000, procStart, version: '2.1.306', kind: 'interactive', name, status: 'idle' }),
  );
  return { proc, transcript };
}

/** A 2x nearest-neighbour cut of `loc` (4 px around it). */
async function cut2x(page: Page, loc: Locator, name: string) {
  const b = await loc.boundingBox();
  if (!b) return console.log(`no box for ${name}`);
  const clip = { x: Math.max(0, b.x - 4), y: Math.max(0, b.y - 4), width: b.width + 8, height: b.height + 8 };
  const src = PNG.sync.read(await page.screenshot({ clip }));
  const big = new PNG({ width: src.width * 2, height: src.height * 2 });
  for (let y = 0; y < big.height; y++)
    for (let x = 0; x < big.width; x++) {
      const si = ((y >> 1) * src.width + (x >> 1)) << 2;
      big.data.set(src.data.subarray(si, si + 4), (y * big.width + x) << 2);
    }
  fs.writeFileSync(path.join(OUT, `${TAG}-${name}-2x.png`), PNG.sync.write(big));
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const crew = ['alpha', 'beta', 'gamma'].map((n, i) => session(home, i + 1, n));
  for (const c of crew)
    fs.appendFileSync(
      c.transcript,
      JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-5', content: [{ type: 'text', text: 'Done.' }] } }) + '\n',
    );
  const daemon = startDaemon({ home, claudePath }, port, ['--no-terminal', '--allow-chat'], {});
  const browser = await launchBrowser();
  const errors: string[] = [];
  try {
    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(await daemon.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await login.cookies();
    await login.close();

    const open = async (viewport: { width: number; height: number }, phone: boolean) => {
      const ctx = await browser.newContext({ viewport, deviceScaleFactor: phone ? 3 : 1, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
      await ctx.addInitScript(INIT);
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto(`http://127.0.0.1:${port}/`);
      await topBarReady(page, 60_000);
      await page.waitForTimeout(6_000);
      const ask = page.getByRole('button', { name: '계속 물어보기' });
      if (await ask.count()) await ask.first().click();
      return { ctx, page };
    };
    const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${TAG}-${name}.png`) });

    // ── Desktop ──
    const pc = await open({ width: 1600, height: 1000 }, false);
    const page = pc.page;
    await shot(page, 'office');
    const icon = (id: string) => page.locator(`[data-hud-id="icon:${id}"] button`).first();
    for (const id of ['messenger', 'devroom']) {
      await icon(id).click();
      await page.locator(`[data-hud-window="${id}"]`).waitFor({ timeout: 15_000 });
      await page.waitForTimeout(1_500);
      await shot(page, id);
      await cut2x(page, page.getByTestId(`hud-title-${id}`), `${id}-title`);
      await icon(id).click(); // in front: a press minimizes it
      await page.waitForTimeout(400);
    }
    await topBarButton(page, '설정');
    const dialog = page.getByRole('dialog').last();
    await dialog.waitFor();
    await page.waitForTimeout(800);
    await shot(page, 'settings');
    // A tab at rest (not the chosen one), hovered, pressed; the chosen one beside it.
    const tabs = page.getByTestId('settings-tabs');
    const idle = tabs.getByRole('tab', { selected: false }).first();
    await page.mouse.move(2, 2);
    await page.waitForTimeout(300);
    await cut2x(page, tabs, 'button-rest');
    const b = (await idle.boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(300);
    await cut2x(page, tabs, 'button-hover');
    await page.mouse.down();
    await page.waitForTimeout(300);
    await cut2x(page, tabs, 'button-pressed');
    await page.mouse.move(2, 2); // leave before the release: no tab change
    await page.mouse.up();
    // Keyboard focus ring.
    await idle.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await page.waitForTimeout(300);
    await cut2x(page, tabs, 'button-focus');
    await pc.ctx.close();

    // ── Phone ──
    const ph = await open({ width: 390, height: 844 }, true);
    await shot(ph.page, 'phone-office');
    const dock = ph.page.getByTestId('mobile-dock');
    if (await dock.count()) {
      const btn = dock.getByRole('button').nth(1);
      await btn.tap();
      await ph.page.waitForTimeout(1_500);
      await shot(ph.page, 'phone-dock-tab');
    } else console.log('no mobile dock');
    await ph.ctx.close();
    console.log(errors.length ? `page errors:\n${errors.join('\n')}` : 'no page errors');
  } finally {
    await browser.close();
    await daemon.stop();
    for (const c of crew) c.proc.kill();
    killFakeSessions(home);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
