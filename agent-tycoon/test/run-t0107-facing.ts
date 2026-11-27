/**
 * T-107: which way the generated office's furniture faces in the isometric view. dist/cli.js in
 * an isolated HOME (the run-iso-floors building: 1F lobby and lounge, 2F two work rooms, 3F one)
 * on its own port, headless Chromium without a GPU. Shots, at device scale 2: every floor whole
 * (the floor view), and a crop of each room (each work room's desks, its whiteboard, the lounge,
 * the lobby). With `saved`, the home's office first gets a decor.json a user arranged (a sofa
 * moved and turned, a side desk and its chair added, in 2F's lounge): the shots show 2F with it.
 * Screenshots: agent-tycoon/artifacts/t0107/<prefix>-*.png.
 *
 *   npx tsx agent-tycoon/test/run-t0107-facing.ts <port 19430> <before|after> [saved]
 */
import type { Browser, Page } from '@playwright/test';
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
if (port !== 19430) throw new Error('port must be 19430 (T-107)');
const PREFIX = process.argv[3] ?? 'after';
const SAVED = process.argv[4] === 'saved';
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/t0107');
const ISO = { 'agty.title-scene': 'off', 'agty.office-iso': 'on' };
const INIT = `globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;`;
const T = 16;

function makeHome() {
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  fs.writeFileSync(
    path.join(configDirectory(fake.home), 'building.json'),
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
  return fake;
}

type Item = { uid: string; type: string; col: number; row: number };
type Floor = { id: string; row: number; rows: number };
const hook = <T>(page: Page, fn: string): Promise<T> =>
  page.evaluate(
    `(() => { const h = window.__agentTycoonTestHooks; return ${fn}; })()`,
  ) as Promise<T>;

async function open(browser: Browser, daemon: ReturnType<typeof startDaemon>, floor: string) {
  const ctx = await browser.newContext({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 2,
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
    Object.entries({ ...ISO, 'agty.floor': floor }),
  );
  await warmUpOffice(ctx, daemon);
  const page = await ctx.newPage();
  await page.goto(await daemon.loginUrl());
  await page.locator('[data-testid="agent-overlay"]').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(2500);
  // The floor view (one floor, nearer), every window out of the way.
  await page.getByTestId('iso-view-toggle').click();
  await page.waitForTimeout(6000);
  return { ctx, page };
}

/** Groups of furniture to crop: each work room (its desks, chairs, PCs, whiteboard, plant), the
 *  lounge and the lobby. */
function groups(items: Item[], f: Floor): Array<{ name: string; items: Item[] }> {
  const mine = items.filter((i) => i.row >= f.row && i.row < f.row + f.rows);
  const out = new Map<string, Item[]>();
  const add = (k: string, i: Item) => out.set(k, [...(out.get(k) ?? []), i]);
  for (const i of mine) {
    const bare = i.uid.replace(/^\d+\//, '');
    const m = /^(desk|pc|seat|whiteboard|plant):(?:spare@|codex@)?([^:@]+?)(?:[@:].*)?$/.exec(bare);
    if (bare.startsWith('lounge:')) add('lounge', i);
    else if (bare.startsWith('lobby:')) add('lobby', i);
    else if (m) add(m[1] === 'whiteboard' || m[1] === 'plant' ? m[2] : 'desks', i);
  }
  // Desks belong to the room whose whiteboard is nearest above them.
  const boards = mine.filter((i) => /whiteboard:/.test(i.uid));
  const desks = out.get('desks') ?? [];
  out.delete('desks');
  for (const d of desks) {
    const b = boards
      .filter((w) => w.row <= d.row)
      .sort((a, z) => Math.abs(a.col + 1 - d.col) - Math.abs(z.col + 1 - d.col))[0];
    add(b ? b.uid.replace(/^\d+\//, '').slice('whiteboard:'.length) : 'room', d);
  }
  return [...out].map(([name, items]) => ({ name, items }));
}

/**
 * The office as a user arranged it: the saved office is decor.json (decor.ts, the user's edits
 * over the generated plan, by room), not layout.json. In 2F's lounge the user moved the sofa on
 * the table's left down to the front, turned, and put a side desk with its chair on its right
 * by the left wall. A first start (with a browser, for the room's place and name) shows where the room is.
 */
async function saveUserDecor(browser: Browser, fake: ReturnType<typeof makeHome>) {
  const d0 = startDaemon(fake, port, ['--no-terminal']);
  try {
    const { ctx, page } = await open(browser, d0, '2');
    const floors = await hook<Floor[]>(page, 'h.getIso().floors');
    const f = floors.find((x) => x.id === '2')!;
    const items = await hook<Item[]>(page, 'h.getFurniture()');
    const seats = await hook<Array<{ uid: string; areaLabel: string | null }>>(
      page,
      'h.getSeats()',
    );
    await ctx.close();
    const plant = items.find((i) => i.uid === '2/lounge:plant-1')!;
    const label = seats.find((s) => s.uid === '2/lounge:sofa-front')!.areaLabel!;
    const room = { x: plant.col - 1, y: plant.row - f.row - 1 };
    const furniture = [
      { uid: 'lounge:sofa-left', type: 'SOFA_FRONT', x: 2, y: 6 },
      { uid: 'user:desk-1', type: 'DESK_SIDE', x: 2, y: 1 },
      { uid: 'user:chair-1', type: 'CUSHIONED_CHAIR_SIDE:left', x: 3, y: 3 },
    ];
    const decor = {
      version: 1,
      rooms: { [label]: { tiles: [], furniture, removed: ['lounge:sofa-left'] } },
    };
    fs.writeFileSync(path.join(configDirectory(fake.home), 'decor.json'), JSON.stringify(decor));
    fs.writeFileSync(
      path.join(OUT, `${PREFIX}-saved-decor.json`),
      JSON.stringify({ room: { label, ...room }, decor }, null, 1),
    );
  } finally {
    await d0.stop();
  }
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeHome();
  const browser = await launchBrowser();
  if (SAVED) await saveUserDecor(browser, fake);
  const daemon = startDaemon(fake, port, ['--no-terminal']);
  try {
    for (const id of SAVED ? ['2'] : ['1', '2', '3']) {
      const { ctx, page } = await open(browser, daemon, id);
      const tag = SAVED ? `${PREFIX}-saved` : PREFIX;
      await page.screenshot({ path: path.join(OUT, `${tag}-floor${id}.png`) });
      const floors = await hook<Floor[]>(page, 'h.getIso().floors');
      const f = floors.find((x) => x.id === id) ?? floors[0];
      const items = await hook<Item[]>(page, 'h.getFurniture()');
      const box = (await page.getByTestId('office-canvas').boundingBox())!;
      for (const g of groups(items, f)) {
        if (SAVED && g.name !== 'lounge') continue;
        const pts: Array<{ x: number; y: number }> = [];
        for (const i of g.items)
          for (const [dc, dr] of [
            [0, 0],
            [3, 0],
            [0, 4],
            [3, 4],
          ]) {
            const p = await hook<{ x: number; y: number } | null>(
              page,
              `h.isoPoint(${(i.col + dc) * T}, ${(i.row + dr) * T})`,
            );
            if (p) pts.push(p);
          }
        if (!pts.length) continue;
        const pad = 60;
        const x0 = Math.max(0, box.x + Math.min(...pts.map((p) => p.x)) - pad);
        const y0 = Math.max(0, box.y + Math.min(...pts.map((p) => p.y)) - pad * 2);
        const x1 = Math.min(1600, box.x + Math.max(...pts.map((p) => p.x)) + pad);
        const y1 = Math.min(1000, box.y + Math.max(...pts.map((p) => p.y)) + pad);
        if (x1 - x0 < 20 || y1 - y0 < 20) continue;
        await page.screenshot({
          path: path.join(OUT, `${tag}-floor${id}-${g.name}.png`),
          clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 },
        });
      }
      if (id === '2' || SAVED) {
        const seats = await hook<unknown>(page, 'h.getAgentSeats()');
        const dump = {
          furniture: items.filter((i) => i.row >= f.row && i.row < f.row + f.rows),
          seats,
          characters: await hook<unknown>(
            page,
            'h.getAgentSeats().map((a) => ({ ...a, at: h.getCharacterTile(a.id) }))',
          ),
        };
        fs.writeFileSync(path.join(OUT, `${tag}-floor${id}.json`), JSON.stringify(dump, null, 1));
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
    await daemon.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
