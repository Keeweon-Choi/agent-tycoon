/**
 * fix-iso-billboard-phone-gpu-note: the billboard is on the phone's first screen (390x844) and
 * the desktop's (1282x832), and its GPU screen says when the GPU's processes are unknown.
 * dist/cli.js in an isolated HOME on a spare port, headless Chromium without a GPU.
 *
 *   npx tsx agent-tycoon/test/run-fix-iso-billboard-phone-gpu-note.ts <port 18610-18619>
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  startDaemon,
  warmUpOffice,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18610 && port <= 18619)) throw new Error('port must be 18610-18619');
const OUT = path.join(
  REPO_ROOT,
  process.env.OUT_DIR ?? 'agent-tycoon/artifacts/fix-iso-billboard-phone-gpu-note',
);
const DESK: BrowserContextOptions = {
  viewport: { width: 1282, height: 832 },
  deviceScaleFactor: 1,
};
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
};
const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;

let failed = 0;
function check(ok: unknown, what: string): void {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`);
  if (!ok) failed++;
}

/** Rewrites the daemon's gpuBoard to say its GPU processes are unknown (this PC's WSL sampler
 *  always reads them, so the real message never carries the flag here). */
const unknownProcesses = (text: string): string => {
  const fix = (m: { type?: string }) =>
    m?.type === 'gpuBoard' ? { ...m, processesUnknown: true } : m;
  try {
    const o = JSON.parse(text);
    return JSON.stringify(Array.isArray(o) ? o.map(fix) : fix(o));
  } catch {
    return text;
  }
};

async function open(
  browser: Browser,
  daemon: ReturnType<typeof startDaemon>,
  opts: BrowserContextOptions,
  rewrite = false,
) {
  const ctx = await browser.newContext(opts);
  if (rewrite)
    await ctx.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((m) => server.send(m));
      server.onMessage((m) => ws.send(typeof m === 'string' ? unknownProcesses(m) : m));
    });
  await ctx.addInitScript(INIT);
  await ctx.addInitScript(
    (pairs) => {
      for (const [k, v] of pairs)
        try {
          if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
        } catch {
          // about:blank
        }
    },
    Object.entries({ 'agty.title-scene': 'off', 'agty.office-iso': 'on', 'agty.floor': '1' }),
  );
  await warmUpOffice(ctx, daemon);
  const page = await ctx.newPage();
  await page.goto(await daemon.loginUrl());
  await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(5000);
  return { ctx, page };
}

/** The billboard sits wholly inside the window on the first screen. */
async function firstScreen(page: Page, opts: BrowserContextOptions, name: string) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const bb = page.locator('[data-testid="lobby-board"]');
  check((await bb.count()) === 1, `${name}: the billboard is on the page`);
  if (!(await bb.count())) return;
  const b = (await bb.boundingBox())!;
  const v = opts.viewport!;
  console.log(`${name}: billboard ${JSON.stringify(b)} in ${v.width}x${v.height}`);
  check(
    b.x >= 0 && b.y >= 0 && b.x + b.width <= v.width && b.y + b.height <= v.height,
    `${name}: the billboard is wholly inside the window`,
  );
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  // One GPU ticket in the engine's events, so the daemon has a GPU board to send (the engine folds
  // it at start); no hardware sample comes in this HOME, so the GPU's processes are unknown.
  const dir = configDirectory(fake.home);
  fs.mkdirSync(dir, { recursive: true });
  // Three floors, as run-building-a's: the floor panel (and its view toggle) only shows for a building of several.
  fs.writeFileSync(
    path.join(dir, 'building.json'),
    JSON.stringify({
      version: 1,
      perProject: false,
      floors: [
        { id: '1', name: '1F', rooms: [], characters: [] },
        { id: '2', name: '2F', rooms: ['orch-alpha', 'orch-beta'], characters: [] },
        { id: '3', name: '3F', rooms: ['orch-gamma'], characters: [] },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    `${JSON.stringify({ type: 'gpu_lease', id: 'g1', ts: new Date().toISOString(), project: 'alpha', label: 'train', exclusive: true, source: 'engine' })}\n`,
  );
  const daemon = startDaemon(fake, port, ['--no-terminal', '--engine', 'on']);
  try {
    const p = await open(browser, daemon, PHONE);
    await firstScreen(p.page, PHONE, 'phone-first-screen');
    await p.ctx.close();
    // The GPU screen, the daemon's own message (this WSL sampler reads the GPU's processes): no note.
    const d = await open(browser, daemon, DESK);
    await firstScreen(d.page, DESK, 'desktop-first-screen');
    await d.page.getByTestId('iso-view-toggle').click();
    await d.page.waitForTimeout(1800);
    await d.page.locator('[data-testid="lobby-board"] [data-testid="board-tab-gpu"]').click();
    await d.page.waitForTimeout(1500);
    check(
      (await d.page.locator('[data-testid="board-gpu-unknown"]').count()) === 0,
      'processes known: the billboard GPU screen has no note',
    );
    await d.ctx.close();
    // The same with the processes unknown: the note shows on the billboard and on the full board.
    const u = await open(browser, daemon, DESK, true);
    // The lobby's own view: the billboard's pages are live there (in the building view it is a still).
    await u.page.getByTestId('iso-view-toggle').click();
    await u.page.waitForTimeout(1800);
    const bb = u.page.locator('[data-testid="lobby-board"]');
    await bb.locator('[data-testid="board-tab-gpu"]').click();
    await u.page.waitForTimeout(1500);
    check(
      (await bb.locator('[data-testid="board-gpu-unknown"]').count()) === 1,
      'processes unknown: the billboard GPU screen says so',
    );
    const b = (await bb.boundingBox())!;
    await u.page.screenshot({
      path: path.join(OUT, 'billboard-gpu-unknown.png'),
      clip: { x: b.x - 24, y: b.y - 24, width: b.width + 60, height: b.height + 60 },
    });
    await u.page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.7);
    await u.page.waitForTimeout(1200);
    check(
      (await u.page
        .locator('[data-testid="board-full"] [data-testid="board-gpu-unknown"]')
        .count()) === 1,
      'processes unknown: the full board GPU screen says so',
    );
    await u.page.screenshot({ path: path.join(OUT, 'board-gpu-unknown-open.png') });
    await u.ctx.close();
  } finally {
    await browser.close();
    await daemon.stop();
  }
  console.log(failed ? `${failed} check(s) FAILED` : 'all checks passed');
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
