/**
 * assets-1104 check: dist/cli.js in an isolated HOME (fake claude) on a spare port, headless Chromium
 * (no GPU). A decor.json from before 11-04 carries the upstream pets (petType 0 claudio, 1 gitcat): they
 * show as the mascots Coral and Byte. 꾸미기 > Pets lists the twelve mascots; one dropped on a floor
 * tile walks and is saved by species. The three new carpets are painted side by side. Screenshots go
 * to agent-tycoon/artifacts/assets-1104/.
 *
 *   npx tsx agent-tycoon/test/run-assets-1104.ts <port 18420-18429>
 */
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
  warmUpOffice,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/assets-1104');
type Pet = { id: string; name: string; petType: number; x: number; y: number };
type Hooks = {
  getPets: () => Pet[];
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
  // The office's decor before 11-04: two upstream pets, by index into the old pet folders.
  fs.mkdirSync(configDirectory(fake.home), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(fake.home), 'decor.json'),
    JSON.stringify({
      version: 1,
      rooms: {},
      pets: [
        { id: 'old-claudio', petType: 0 },
        { id: 'old-gitcat', petType: 1 },
      ],
    }),
  );
  const daemon = startDaemon(fake, port, ['--no-terminal']);
  const browser = await launchBrowser();
  const sent: Array<Record<string, unknown>> = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(() => {
      const w = window as unknown as {
        __name: (v: unknown) => unknown;
        __AGENT_TYCOON_E2E: boolean;
      };
      w.__name = (v) => v;
      w.__AGENT_TYCOON_E2E = true;
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
    const hooks = <T>(fn: (h: Hooks) => T) =>
      page.evaluate(`(${fn.toString()})(window.__agentTycoonTestHooks)`) as Promise<T>;
    const pets = () => hooks((h) => h.getPets());

    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.waitForTimeout(2000);

    const old = await pets();
    check(
      old.length === 2 &&
        old.find((p) => p.id === 'old-claudio')?.petType === 1 &&
        old.find((p) => p.id === 'old-gitcat')?.petType === 2,
      `the old claudio/gitcat pets are the mascots Coral/Byte (${JSON.stringify(old.map((p) => [p.id, p.name, p.petType]))})`,
    );

    // Floor tiles on screen, away from the panels.
    const floor = await hooks((h) => {
      const canvas = document
        .querySelector('[data-testid="office-canvas"]')!
        .getBoundingClientRect();
      const out: Array<[number, number, number, number]> = [];
      for (let r = 0; r < 60; r++)
        for (let c = 0; c < 80; c++) {
          const p = h.getTileCenter(c, r);
          if (!p || p.x < 450 || p.x > 1050 || p.y < 260 || p.y > 520) continue;
          if (h.isTileWalkable(c, r)) out.push([c, r, canvas.left + p.x, canvas.top + p.y]);
        }
      return out;
    });
    check(floor.length > 12, `floor tiles on screen (${floor.length})`);
    const at = (c: number, r: number) => floor.find(([fc, fr]) => fc === c && fr === r);

    await page.locator('.agty-elevator-decorate').click();
    await page.getByRole('button', { name: 'Pets', exact: true }).click();
    const cards = page.getByTestId('pets-carousel').locator('button');
    check((await cards.count()) === 12, 'the pet list is the twelve mascots');
    await cards.nth(4).click(); // kwak
    const drop = floor[Math.floor(floor.length / 2)];
    await page.mouse.click(drop[2], drop[3]);
    await page.waitForTimeout(500);
    const placed = (await pets()).find((p) => !p.id.startsWith('old-'));
    check(placed?.petType === 4, `a new mascot pet (Kwak) dropped on (${drop[0]},${drop[1]})`);

    // Carpets: three 3x2 patches side by side, one per variant.
    await page.locator('button[title="Place furniture"]').click();
    await page.locator('button[title="Paint carpets"]').click();
    const [c0, r0] = floor[0];
    const patches: Array<Array<[number, number, number, number]>> = [];
    for (let v = 0; v < 3; v++) {
      const cells = [0, 1].flatMap((dr) =>
        [0, 1, 2].map((dc) => at(c0 + v * 4 + dc, r0 + 1 + dr)).filter((x) => !!x),
      ) as Array<[number, number, number, number]>;
      patches.push(cells);
      await page.locator(`[title="Carpet ${v + 1}"]`).click();
      for (const cell of cells) {
        await page.mouse.click(cell[2], cell[3]);
        await page.waitForTimeout(80);
      }
    }
    check(
      patches.every((p) => p.length >= 4),
      `three carpet patches painted (${patches.map((p) => p.length)})`,
    );
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.waitForTimeout(1500);
    const saved = [...sent].reverse().find((m) => m.type === 'saveLayout')?.layout as
      | {
          pets?: Array<{ id: string; species?: string; petType?: unknown }>;
          carpetTiles?: unknown[];
        }
      | undefined;
    const species = Object.fromEntries((saved?.pets ?? []).map((p) => [p.id, p.species]));
    check(
      species['old-claudio'] === 'coral' &&
        species['old-gitcat'] === 'byte' &&
        species[placed!.id] === 'kwak' &&
        saved!.pets!.every((p) => p.petType === undefined),
      `the saved layout stores pets by species (${JSON.stringify(species)})`,
    );
    const variants = new Set(
      (saved?.carpetTiles ?? []).filter(Boolean).map((t) => (t as { variant: number }).variant),
    );
    check(variants.size === 3, 'the saved layout carries all three carpets');
    await page.reload();
    await page.locator('[data-testid="agent-overlay"]').first().waitFor();
    await page.waitForTimeout(2000);
    check((await pets()).length === 3, 'the three pets are back after a reload');

    // It walks (wander pause is up to ~15 s).
    const start = { x: placed!.x, y: placed!.y };
    let walked = false;
    for (let i = 0; i < 30 && !walked; i++) {
      await page.waitForTimeout(1000);
      const p = (await pets()).find((q) => q.id === placed!.id)!;
      walked = p.x !== start.x || p.y !== start.y;
    }
    check(walked, 'the mascot pet walks');

    await page.screenshot({ path: path.join(OUT, 'desktop-office.png') });
    // A close look at the pets and the carpets.
    const canvas = (await page.locator('[data-testid="office-canvas"]').boundingBox())!;
    const spots = await Promise.all(
      (await pets()).map((p) =>
        page.evaluate(
          ([c, r]) =>
            (
              window as unknown as { __agentTycoonTestHooks: Hooks }
            ).__agentTycoonTestHooks.getTileCenter(c, r),
          [Math.floor(p.x / 16), Math.floor(p.y / 16)],
        ),
      ),
    );
    const tile = floor[1][2] - floor[0][2] || 32;
    const xs = spots.map((s) => canvas.x + s!.x);
    const ys = spots.map((s) => canvas.y + s!.y);
    const clip = (x0: number, y0: number, x1: number, y1: number) => ({
      x: Math.max(0, x0),
      y: Math.max(0, y0),
      width: Math.min(1280, x1) - Math.max(0, x0),
      height: Math.min(800, y1) - Math.max(0, y0),
    });
    await page.screenshot({
      path: path.join(OUT, 'desktop-pets.png'),
      clip: clip(
        Math.min(...xs) - 3 * tile,
        Math.min(...ys) - 4 * tile,
        Math.max(...xs) + 3 * tile,
        Math.max(...ys) + 2 * tile,
      ),
    });
    const cx = patches.flat().map((c) => c[2]);
    const cy = patches.flat().map((c) => c[3]);
    await page.screenshot({
      path: path.join(OUT, 'desktop-carpets.png'),
      clip: clip(
        Math.min(...cx) - 1.5 * tile,
        Math.min(...cy) - 1.5 * tile,
        Math.max(...cx) + 1.5 * tile,
        Math.max(...cy) + 1.5 * tile,
      ),
    });
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
