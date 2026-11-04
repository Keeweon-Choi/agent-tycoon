/**
 * floors-fill-1104 (owner 11-04 21:11): every floor of the generated office is one size, its rooms
 * filling the plate (no void, no bare floor). dist/cli.js in an isolated HOME on a spare port,
 * headless Chromium without a GPU, the owner's window 1282x832. Three floors with different rooms:
 * 1F the lobby and the lounge only, 2F one room, 3F three rooms (the R-8 office).
 *  - Every floor has the same rows and cols, and no VOID tile below its headroom row.
 *  - Each floor in focus in the building view, and each floor's own view ("이 층", the angle of
 *    the owner's 3F picture).
 * Screenshots: cld/artifacts/floors-fill-1104/.
 *
 *   npx tsx cld/test/run-floors-fill.ts <port 18440-18449>
 */
import type { Browser, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  startDaemon,
  warmUpOffice,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18440 && port <= 18449)) throw new Error('port must be 18440-18449');
const OUT = path.join(REPO_ROOT, 'cld/artifacts/floors-fill-1104');
const VOID = 255;

let failed = 0;
function check(ok: unknown, what: string): void {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${what}`);
  if (!ok) failed++;
}

function makeHome() {
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const dir = configDirectory(fake.home);
  fs.writeFileSync(
    path.join(dir, 'building.json'),
    JSON.stringify({
      version: 1,
      perProject: false,
      floors: [
        { id: '1', name: '1F', rooms: [], characters: [] },
        { id: '2', name: '2F', rooms: ['orch-gamma'], characters: [] },
        { id: '3', name: '3F', rooms: ['orch-alpha', 'orch-beta', 'scratch'], characters: [] },
      ],
    }),
  );
  fs.writeFileSync(path.join(dir, 'background.json'), JSON.stringify({ time: 'night', mix: 'mixed', seed: 1101 }));
  return fake;
}

type Daemon = ReturnType<typeof startDaemon>;
type IsoFloor = { id: string; row: number; rows: number; level: number };

async function open(browser: Browser, daemon: Daemon, floor: string) {
  const ctx = await browser.newContext({ viewport: { width: 1282, height: 832 }, deviceScaleFactor: 1 });
  await ctx.addInitScript(`globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`);
  await ctx.addInitScript(
    (pairs) => {
      for (const [k, v] of pairs)
        try {
          if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
        } catch {
          // about:blank
        }
    },
    Object.entries({ 'cld.title-scene': 'off', 'cld.office-iso': 'on', 'cld.floor': floor }),
  );
  await warmUpOffice(ctx, daemon);
  const page = await ctx.newPage();
  await page.goto(await daemon.loginUrl());
  // 1F has no one in it (no agent overlay): wait for the building's three floors instead.
  await page.waitForFunction(
    () => (window as { __agentTycoonTestHooks?: { getIso?: () => { floors?: unknown[] } | null } })
      .__agentTycoonTestHooks?.getIso?.()?.floors?.length === 3,
    undefined,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(3000);
  return { ctx, page };
}

const hook = <T>(page: Page, fn: string): Promise<T> =>
  page.evaluate(`(() => { const h = window.__agentTycoonTestHooks; return ${fn}; })()`) as Promise<T>;

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await launchBrowser();
  const daemon = startDaemon(makeHome(), port, ['--no-terminal']);
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  try {
    for (const floor of ['1', '2', '3']) {
      const d = await open(browser, daemon, floor);
      if (floor === '1') {
        const floors = await hook<IsoFloor[]>(d.page, 'h.getIso().floors');
        const { cols, tiles } = await hook<{ cols: number; tiles: number[] }>(d.page, 'h.getTiles()');
        check(floors.length === 3, `three floors (${floors.length})`);
        check(new Set(floors.map((f) => f.rows)).size === 1, `every floor has the same rows (${floors.map((f) => f.rows)})`);
        console.log(`plate ${cols} x ${floors[0].rows}`);
        for (const f of floors) {
          let voids = 0;
          for (let r = f.row + 1; r < f.row + f.rows; r++)
            for (let c = 0; c < cols; c++) if (tiles[r * cols + c] === VOID) voids++;
          check(voids === 0, `${f.id}F: no void below its headroom row (${voids})`);
        }
      }
      await shot(d.page, `building-${floor}F`);
      await d.page.getByTestId('iso-view-toggle').click();
      await d.page.waitForTimeout(1800);
      await shot(d.page, `floor-${floor}F`);
      await d.ctx.close();
    }
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
