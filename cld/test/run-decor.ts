/**
 * T-0053 decor check: isolated R-8 HOME (Claude sessions in three rooms), a logged-in desktop Chromium office,
 * a saved floor and plant, regeneration, and the room reset UI. The second
 * WebSocket uses the page's login cookie; no live host daemon is contacted.
 * T-0066: the same save moves a member's desk unit and deletes another
 * member's chair (adding a chair of the user's); after the regeneration the
 * unit is at the user's spot with its member seated, the other member sits at
 * the user's chair, and the reset brings the generator's unit back.
 *
 *   npx tsx cld/test/run-decor.ts <port 18256-18259>
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
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0053');
const OUT66 = path.join(REPO_ROOT, 'cld/artifacts/t0066');
const color = { h: 120, s: 60, b: 0, c: 0 };
type Furniture = { uid: string; type: string; col: number; row: number };
type Layout = {
  cols: number;
  rows: number;
  tiles: number[];
  tileColors: unknown[];
  areaTiles: Array<string | null>;
  furniture: Furniture[];
  cldBase: string;
  cldSeats?: Record<string, string | null>;
};
type Hooks = {
  getAgentSeats: () => Array<{ id: number; seatId: string | null }>;
  getSeats: () => Array<{ uid: string; col: number; row: number; assigned: boolean }>;
  getCharacterTile: (id: number) => { col: number; row: number } | null;
  getTileCenter: (col: number, row: number) => { x: number; y: number } | null;
};
type Rect = { x: number; y: number; w: number; h: number };
type Building = {
  floors: Array<{ id: string; rooms: string[] }>;
  decor?: Array<{ room: string; stored: number }>;
};

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
async function until(what: string, fn: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out: ${what}`);
}
function rectOf(layout: Layout, label: string): Rect {
  const indices = layout.areaTiles.flatMap((value, i) => (value === label ? [i] : []));
  if (!indices.length) throw new Error(`no area ${label}`);
  const cols = indices.map((i) => i % layout.cols);
  const rows = indices.map((i) => Math.floor(i / layout.cols));
  const x = Math.min(...cols) - 1,
    y = Math.min(...rows) - 1;
  return { x, y, w: Math.max(...cols) - x + 2, h: Math.max(...rows) - y + 2 };
}
function painted(layout: Layout, room: Rect): boolean {
  return [1, 2, 3].every((x) => {
    const i = (room.y + 1) * layout.cols + room.x + x;
    return layout.tiles[i] === 2 && (layout.tileColors[i] as { h?: number } | null)?.h === 120;
  });
}
function decorated(layout: Layout, room: Rect): boolean {
  return (
    painted(layout, room) &&
    layout.furniture.some(
      (f) => f.uid === 'decor-test-plant' && f.col === room.x + 1 && f.row === room.y + 2,
    )
  );
}

async function main(): Promise<void> {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(OUT66, { recursive: true });
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const daemon = startDaemon(fake, port, ['--no-terminal']);
  const browser = await launchBrowser();
  const received: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  try {
    await Promise.race([
      (async () => {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        await ctx.addInitScript(() => {
          const w = window as unknown as {
            __name: (value: unknown) => unknown;
            __PIXEL_AGENTS_E2E: boolean;
          };
          w.__name = (value) => value;
          w.__PIXEL_AGENTS_E2E = true; // upstream's test hooks: seats and tiles, read only
        });
        await warmUpOffice(ctx, daemon);
        const page = await ctx.newPage();
        const log = (into: Array<Record<string, unknown>>) => (frame: { payload: unknown }) => {
          try {
            into.push(JSON.parse(String(frame.payload)) as Record<string, unknown>);
          } catch {
            /* binary frame */
          }
        };
        page.on('websocket', (ws) => {
          ws.on('framereceived', log(received));
          ws.on('framesent', log(sent));
        });
        page.on('pageerror', (error) => errors.push(String(error)));
        const lastLayout = () =>
          [...received].reverse().find((m) => m.type === 'layoutLoaded')?.layout as
            Layout | undefined;
        const lastBuilding = () =>
          [...received].reverse().find((m) => m.type === 'buildingState') as Building | undefined;
        await page.goto(await daemon.loginUrl());
        await page.waitForURL(BASE);
        await page.locator('[data-testid="agent-overlay"]').first().waitFor();
        await until('initial layout', () => !!lastLayout());
        const l0 = lastLayout()!,
          first = rectOf(l0, 'orch-gamma');
        check(!decorated(l0, first), 'undecorated office fails the decoration check');

        await page.evaluate(
          () =>
            new Promise<void>((resolve, reject) => {
              const socket = new WebSocket(location.origin.replace(/^http/, 'ws') + '/ws');
              (window as unknown as { decorSocket: WebSocket }).decorSocket = socket;
              socket.addEventListener('open', () => resolve(), { once: true });
              socket.addEventListener('error', () => reject(new Error('decor socket failed')), {
                once: true,
              });
            }),
        );
        const send = (message: Record<string, unknown>) =>
          page.evaluate((body) => {
            (window as unknown as { decorSocket: WebSocket }).decorSocket.send(
              JSON.stringify(body),
            );
          }, message);
        const edited = structuredClone(l0);
        for (const x of [1, 2, 3]) {
          const i = (first.y + 1) * edited.cols + first.x + x;
          edited.tiles[i] = 2;
          edited.tileColors[i] = color;
        }
        edited.furniture.push({
          uid: 'decor-test-plant',
          type: 'PLANT',
          col: first.x + 1,
          row: first.y + 2,
        });
        // T-0066: member A's desk unit one row down, member B's chair deleted, a chair of ours.
        const inside = (r: Rect, f: Furniture) =>
          f.col >= r.x && f.col < r.x + r.w && f.row >= r.y && f.row < r.y + r.h;
        const desks = l0.furniture.filter(
          (f) => f.uid.startsWith('desk:') && !f.uid.includes('@') && inside(first, f),
        );
        check(desks.length >= 2, `orch-gamma has two members' desks (${desks.length})`);
        const [keyA, keyB] = desks.map((f) => f.uid.slice('desk:'.length));
        const unitA = [`desk:${keyA}`, `pc:${keyA}`, `seat:${keyA}`];
        const relA = unitA.map((uid) => {
          const f = l0.furniture.find((v) => v.uid === uid)!;
          return { uid, x: f.col - first.x, y: f.row + 1 - first.y };
        });
        const chairB = l0.furniture.find((v) => v.uid === `seat:${keyB}`)!;
        const relChair = { x: chairB.col + 2 - first.x, y: chairB.row - first.y };
        for (const f of edited.furniture) if (unitA.includes(f.uid)) f.row += 1;
        edited.furniture = edited.furniture.filter((f) => f.uid !== `seat:${keyB}`);
        edited.furniture.push({
          uid: 'decor-test-chair',
          type: 'CUSHIONED_BENCH',
          col: first.x + relChair.x,
          row: first.y + relChair.y,
        });
        type W = { __pixelAgentsTestHooks: Hooks };
        const agentSeats = () =>
          page.evaluate(() => (window as unknown as W).__pixelAgentsTestHooks.getAgentSeats());
        const tileCenter = (c: number, r: number) =>
          page.evaluate(
            ({ c, r }) => (window as unknown as W).__pixelAgentsTestHooks.getTileCenter(c, r),
            { c, r },
          );
        // The Claude sessions are read when the first viewer arrives: give the characters their seats.
        let seats0 = await agentSeats();
        for (let n = 0; n < 50 && !seats0.some((v) => v.seatId === `seat:${keyB}`); n++) {
          await new Promise((r) => setTimeout(r, 200));
          seats0 = await agentSeats();
        }
        const idA = seats0.find((v) => v.seatId === `seat:${keyA}`)?.id;
        const idB = seats0.find((v) => v.seatId === `seat:${keyB}`)?.id;
        check(idA !== undefined && idB !== undefined, `members ${keyA} and ${keyB} are seated`);
        /** The user's arrangement in room r of layout l, as the server and the page show it. */
        const arranged = async (l: Layout, r: Rect) => {
          const unitOk = relA.every(({ uid, x, y }) =>
            l.furniture.some((f) => f.uid === uid && f.col === r.x + x && f.row === r.y + y),
          );
          const chairAt = { col: r.x + relChair.x, row: r.y + relChair.y };
          const hint = l.cldSeats?.[`seat:${keyB}`] === 'decor-test-chair';
          const seats = await agentSeats();
          const pageSeats = await page.evaluate(() =>
            (window as unknown as W).__pixelAgentsTestHooks.getSeats(),
          );
          const seatA = pageSeats.find((v) => v.uid === `seat:${keyA}`);
          const seatB = pageSeats.find((v) => v.uid === 'decor-test-chair');
          const tileA = await page.evaluate(
            (id) => (window as unknown as W).__pixelAgentsTestHooks.getCharacterTile(id),
            idA!,
          );
          return {
            unitOk,
            hint,
            aSeated:
              seats.find((v) => v.id === idA)?.seatId === `seat:${keyA}` &&
              seatA?.col === r.x + relA[2].x &&
              seatA?.row === r.y + relA[2].y &&
              tileA?.col === seatA.col &&
              tileA?.row === seatA.row,
            bSeated:
              seats.find((v) => v.id === idB)?.seatId === 'decor-test-chair' &&
              seatB?.col === chairAt.col &&
              seatB?.row === chairAt.row &&
              seatB.assigned,
          };
        };
        const count0 = received.length;
        await send({ type: 'saveLayout', layout: edited });
        await until('decorated save response', () =>
          received
            .slice(count0)
            .some(
              (m) =>
                m.type === 'layoutLoaded' &&
                decorated(m.layout as Layout, rectOf(m.layout as Layout, 'orch-gamma')),
            ),
        );
        check(
          decorated(lastLayout()!, rectOf(lastLayout()!, 'orch-gamma')),
          'save composes the painted room and plant',
        );
        const decorFile = path.join(configDirectory(fake.home), 'decor.json');
        check(
          fs.existsSync(decorFile) && (fs.statSync(decorFile).mode & 0o777) === 0o600,
          'decor.json exists with mode 0600',
        );
        check(
          !fs.existsSync(path.join(fake.home, '.pixel-agents/layout.json')),
          'layout.json was not written',
        );

        await send({ type: 'addFloor' });
        await until('new floor', () => (lastBuilding()?.floors.length ?? 0) === 2);
        const floorId = lastBuilding()!.floors[1].id;
        await send({ type: 'moveToFloor', floorId, room: 'orch-alpha' });
        await until('room regeneration', () => {
          const l = lastLayout(),
            b = lastBuilding();
          return (
            !!l &&
            !!b?.floors[1].rooms.includes('orch-alpha') &&
            l.cldBase !== l0.cldBase &&
            JSON.stringify(rectOf(l, 'orch-gamma')) !== JSON.stringify(first)
          );
        });
        const l2 = lastLayout()!,
          moved = rectOf(l2, 'orch-gamma');
        check(decorated(l2, moved), 'decor follows the regenerated room');
        check(!decorated(l2, first), 'old absolute position does not pass the decoration check');
        await page.screenshot({ path: path.join(OUT, 'decor.png') });
        // T-0066 after the regeneration (the room moved): the user's arrangement holds.
        let after = await arranged(l2, moved);
        for (let i = 0; i < 30 && !(after.aSeated && after.bSeated); i++) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          after = await arranged(lastLayout()!, rectOf(lastLayout()!, 'orch-gamma'));
        }
        check(after.unitOk, `${keyA}'s desk unit stays at the user's spot in the moved room`);
        check(after.hint, `the server names the user's chair for ${keyB} (cldSeats)`);
        check(after.aSeated, `${keyA} sits at the moved chair`);
        check(after.bSeated, `${keyB} sits at the user's free chair`);
        check(
          !(await arranged(l2, first)).unitOk,
          'the old absolute spot does not pass the unit check',
        );
        // Pan (middle drag) so the room sits in the free part of the canvas, left of the panels.
        {
          const box = (await page.locator('canvas').first().boundingBox())!;
          const mid = (await tileCenter(moved.x + moved.w / 2, moved.y + moved.h / 2))!;
          await page.mouse.move(box.x + 450, box.y + 250);
          await page.mouse.down({ button: 'middle' });
          await page.mouse.move(box.x + 450 - (mid.x - 450), box.y + 250 - (mid.y - 250), {
            steps: 8,
          });
          await page.mouse.up({ button: 'middle' });
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        const roomTopLeft = await tileCenter(moved.x, moved.y);
        const roomBottomRight = await tileCenter(moved.x + moved.w, moved.y + moved.h);
        await page.screenshot({ path: path.join(OUT66, 'office.png') });
        if (roomTopLeft && roomBottomRight) {
          const canvasBox = (await page.locator('canvas').first().boundingBox())!;
          const x = Math.max(0, canvasBox.x + roomTopLeft.x - 24),
            y = Math.max(0, canvasBox.y + roomTopLeft.y - 48);
          const w = Math.min(1280 - x, roomBottomRight.x - roomTopLeft.x + 48),
            h = Math.min(800 - y, roomBottomRight.y - roomTopLeft.y + 72);
          if (w > 50 && h > 50)
            await page.screenshot({
              path: path.join(OUT66, 'room.png'),
              clip: { x, y, width: w, height: h },
            });
        }

        await page.locator('.cld-elevator-edit').click();
        await page
          .locator('[data-testid="floor-editor"] [data-decor-room="orch-gamma"] button')
          .click();
        await page.getByRole('button', { name: '되돌리기', exact: true }).click();
        await until('room reset', () => {
          const l = lastLayout(),
            b = lastBuilding();
          return (
            !!l &&
            !!b &&
            !b.decor?.some((row) => row.room === 'orch-gamma') &&
            !painted(l, rectOf(l, 'orch-gamma')) &&
            !l.furniture.some((f) => f.uid === 'decor-test-plant')
          );
        });
        check(
          !painted(lastLayout()!, rectOf(lastLayout()!, 'orch-gamma')) &&
            !lastLayout()!.furniture.some((f) => f.uid === 'decor-test-plant'),
          'reset removes painted tiles and plant',
        );
        check(
          !lastBuilding()?.decor?.some((row) => row.room === 'orch-gamma'),
          'reset clears the decor row',
        );
        {
          const l = lastLayout()!,
            r = rectOf(l, 'orch-gamma');
          const rel = (uid: string) => {
            const f = l.furniture.find((v) => v.uid === uid);
            return f && [f.col - r.x, f.row - r.y];
          };
          check(
            JSON.stringify(rel(`desk:${keyA}`)) === JSON.stringify([relA[0].x, relA[0].y - 1]) &&
              !!rel(`seat:${keyB}`) &&
              !l.cldSeats &&
              !l.furniture.some((f) => f.uid === 'decor-test-chair'),
            `reset puts ${keyA}'s unit and ${keyB}'s chair back where the generator puts them`,
          );
        }

        // The real editor: paint, undo, paint, Save. Every saveLayout it sends
        // (the debounced ones and the Save) must name the office it was built
        // from, or a save across a regeneration is diffed against the wrong plan.
        await page.keyboard.press('Escape');
        const base = lastLayout()!.cldBase;
        const sent0 = sent.length;
        await page.getByRole('button', { name: '인테리어', exact: true }).click();
        await page.getByRole('button', { name: 'Floor', exact: true }).click();
        const saveButton = page.locator('button[title="Save layout"]');
        const canvas = page.locator('canvas').first();
        const box = (await canvas.boundingBox())!;
        const paintSomewhere = async () => {
          for (const [fx, fy] of [
            [0.5, 0.5],
            [0.4, 0.45],
            [0.6, 0.55],
            [0.3, 0.6],
          ]) {
            await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
            if (await saveButton.isVisible()) return;
          }
          throw new Error('no floor tile under the probed points');
        };
        const settle = () => new Promise((resolve) => setTimeout(resolve, 800)); // past the 500 ms save debounce
        await paintSomewhere();
        await settle();
        await page.keyboard.press('Control+z');
        await settle();
        await paintSomewhere();
        await saveButton.click();
        await until('editor saves sent', () =>
          sent.slice(sent0).some((m) => m.type === 'saveLayout'),
        );
        await new Promise((resolve) => setTimeout(resolve, 1_000)); // debounced saves land too
        const saves = sent.slice(sent0).filter((m) => m.type === 'saveLayout');
        check(
          saves.length >= 3 &&
            saves.every((m) => (m.layout as { cldBase?: unknown }).cldBase === base),
          `editor saves (paint, undo, Save: ${saves.length}) carry the loaded cldBase ${base}: ${saves.map((m) => (m.layout as { cldBase?: unknown }).cldBase).join(',')}`,
        );
        check(
          errors.length === 0,
          `no page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`,
        );
        await ctx.close();
      })(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('hard deadline')), 120_000),
      ),
    ]);
  } catch (error) {
    console.error(daemon.log.join('').slice(-3000));
    throw error;
  } finally {
    await browser.close();
    await daemon.stop();
    fs.rmSync(fake.home, { recursive: true, force: true });
  }
}
main().then(
  () => process.exit(0),
  (error) => {
    console.error(String(error instanceof Error ? error.message : error));
    process.exit(1);
  },
);
