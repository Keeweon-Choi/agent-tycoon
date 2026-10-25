/**
 * U-43 check (pets): dist/cli.js in an isolated HOME (fake claude) on a spare port, logged in, headless
 * Chromium (no GPU). 꾸미기 > Pets: picking a pet only arms it, a click on a wall tile places nothing,
 * a click on a floor tile drops the pet there; it walks, is saved with the layout and is back after a
 * reload; picking it again removes it. Screenshots go to cld/artifacts/u43/.
 *
 *   npx tsx cld/test/run-pets.ts <port 18256-18259> [tag]
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
  warmUpOffice,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const TAG = process.argv[3] ?? 'after';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/u43');
type Layout = { cols: number; pets?: Array<{ id: string; petType: number; col?: number; row?: number }> };
type Hooks = {
  getPets: () => Array<{ id: string; petType: number; x: number; y: number }>;
  getTileCenter: (c: number, r: number) => { x: number; y: number } | null;
  isTileWalkable: (c: number, r: number) => boolean;
};

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main(): Promise<void> {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const daemon = startDaemon(fake, port, ['--no-terminal']);
  const browser = await launchBrowser();
  const sent: Array<Record<string, unknown>> = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => {
      const w = window as unknown as { __name: (v: unknown) => unknown; __PIXEL_AGENTS_E2E: boolean };
      w.__name = (v) => v;
      w.__PIXEL_AGENTS_E2E = true; // upstream's test hooks, read only
    });
    await warmUpOffice(ctx, daemon);
    const page = await ctx.newPage();
    page.on('websocket', (ws) =>
      ws.on('framesent', (f) => {
        try {
          sent.push(JSON.parse(String(f.payload)));
        } catch {
          /* binary */
        }
      }),
    );
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${TAG}-${name}.png`) });
    const hooks = <T>(fn: (h: Hooks) => T) =>
      page.evaluate(
        `(${fn.toString()})(window.__pixelAgentsTestHooks)`,
      ) as Promise<T>;
    const pets = () => hooks((h) => h.getPets());

    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.waitForTimeout(1500);
    await page.locator('.cld-elevator-decorate').click();
    await page.getByRole('button', { name: 'Pets', exact: true }).click();
    check((await pets()).length === 0, 'no pet in the office before one is placed');

    // Pick a pet: only armed, nothing is spawned yet.
    await page.getByTestId('pets-carousel').locator('button').first().click();
    check((await pets()).length === 0, 'picking a pet does not spawn it');
    check(
      (await page.getByTestId('pets-hint').innerText()).includes('Click a floor tile'),
      'the hint says to click a floor tile',
    );
    await page.waitForTimeout(600); // the canvas redraws at its idle rate after the editor opens
    await shot('1-pet-picked');

    // A tile on screen, inside the office, away from the panels: a floor tile and a blocked one.
    const spots = await hooks((h) => {
      const canvas = document.querySelector('[data-testid="office-canvas"]')!.getBoundingClientRect();
      const out: { walk?: [number, number, number, number]; block?: [number, number, number, number] } = {};
      for (let r = 0; r < 60; r++) {
        for (let c = 0; c < 80; c++) {
          const p = h.getTileCenter(c, r);
          if (!p || p.x < 600 || p.x > 1000 || p.y < 300 || p.y > 480) continue;
          const spot: [number, number, number, number] = [c, r, canvas.left + p.x, canvas.top + p.y];
          if (h.isTileWalkable(c, r)) out.walk ??= spot;
          else out.block ??= spot;
        }
      }
      return out;
    });
    check(spots.walk && spots.block, `a floor tile and a blocked tile are on screen (${JSON.stringify(spots)})`);

    await page.mouse.click(spots.block![2], spots.block![3]);
    await page.waitForTimeout(300);
    check((await pets()).length === 0, 'a click on a blocked tile places nothing');

    await page.mouse.click(spots.walk![2], spots.walk![3]);
    await page.waitForTimeout(500);
    const placed = await pets();
    check(placed.length === 1, 'a click on a floor tile drops the pet');
    check(
      Math.floor(placed[0].x / 16) === spots.walk![0] && Math.floor(placed[0].y / 16) === spots.walk![1],
      `it stands on the clicked tile (${spots.walk![0]},${spots.walk![1]})`,
    );
    await shot('2-pet-placed');

    // It walks (wander pause is up to ~10 s).
    const start = { x: placed[0].x, y: placed[0].y };
    let walked = false;
    for (let i = 0; i < 25 && !walked; i++) {
      await page.waitForTimeout(1000);
      const p = (await pets())[0];
      walked = p.x !== start.x || p.y !== start.y;
    }
    check(walked, 'the pet walks');

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(1500);
    const saved = [...sent].reverse().find((m) => m.type === 'saveLayout')?.layout as Layout | undefined;
    check(saved?.pets?.length === 1, 'the saved layout carries the pet');
    check(
      Number.isInteger(saved!.pets![0].col) && Number.isInteger(saved!.pets![0].row),
      `with its tile (${saved!.pets![0].col},${saved!.pets![0].row})`,
    );

    await page.reload();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.waitForTimeout(2000);
    const after = await pets();
    check(after.length === 1 && after[0].id === saved!.pets![0].id, 'the pet is still there after a reload');
    await shot('3-after-reload');

    // Picking a placed pet removes it.
    await page.locator('.cld-elevator-decorate').click();
    await page.getByRole('button', { name: 'Pets', exact: true }).click();
    await page.getByTestId('pets-carousel').locator('button').first().click();
    await page.waitForTimeout(500);
    check((await pets()).length === 0, 'picking a placed pet removes it');
    check(errors.length === 0, `no page errors (${errors.join('; ')})`);
  } finally {
    await browser.close();
    await daemon.stop();
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
