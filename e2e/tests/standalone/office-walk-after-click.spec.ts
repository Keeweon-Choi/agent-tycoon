/**
 * T-176: after a click on a character the direction keys still do something. The auto camera
 * (gfx.camera.autoHint): the keys walk the character the camera follows, a click on an employee
 * follows that employee; gfx.help.camera: WASD and the arrows look around the office. An employee at
 * work stays at its desk (walk.ts walkDecision), so there the keys look around instead.
 * The office is the top-down one at a desktop size; the engine fake plays alpha.
 */
import type { Page } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import { claudeScenario } from '../../helpers/mock-claude';
import { nameplateOf, ringOf } from '../../helpers/office';
import {
  buildAssistantToolUseRecord,
  buildTurnDurationRecord,
  buildUserToolResultRecord,
} from '../../helpers/team';

/** webview-ui/src/constants.ts OWNER_CHARACTER_ID. */
const OWNER = -2_000_000_000;
/** The prompt the engine types into a session it brings back at its start. */
const RECOVERY_PROMPT = '자동 복구';
/** Zoom steps out at most to find alpha on the canvas. */
const ZOOM_OUT_MAX = 6;

type Hooks = {
  getCharacterTile: (id: number) => { col: number; row: number } | null;
  getCharacterPosition: (id: number) => { x: number; y: number } | null;
  getCameraFollowId: () => number | null;
  getCamera: () => { zoom: number; pan: { x: number; y: number }; cols: number; rows: number };
};
type HookWindow = { __agentTycoonTestHooks: Hooks };

const tileOf = (page: Page, id: number) =>
  page.evaluate(
    (i) => (window as unknown as HookWindow).__agentTycoonTestHooks.getCharacterTile(i),
    id,
  );
const followOf = (page: Page) =>
  page.evaluate(() => (window as unknown as HookWindow).__agentTycoonTestHooks.getCameraFollowId());
const panOf = (page: Page) =>
  page.evaluate(() => (window as unknown as HookWindow).__agentTycoonTestHooks.getCamera().pan);

/** Where character `id` is drawn (the top-down office), in viewport px: its body, above the feet.
 *  Null while it is outside the canvas. */
const onScreen = (page: Page, id: number) =>
  page.evaluate((i) => {
    const h = (window as unknown as HookWindow).__agentTycoonTestHooks;
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="office-canvas"]')!;
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const { zoom: z, pan, cols, rows } = h.getCamera();
    const p = h.getCharacterPosition(i)!;
    const ox = Math.floor((canvas.width - cols * 16 * z) / 2) + pan.x;
    const oy = Math.floor((canvas.height - rows * 16 * z) / 2) + pan.y;
    const at = { x: r.left + (ox + p.x * z) / dpr, y: r.top + (oy + (p.y - 8) * z) / dpr };
    const inside = at.x > r.left && at.x < r.right && at.y > r.top && at.y < r.bottom;
    return inside ? at : null;
  }, id);

/** Hold `key` long enough for a few tiles, then let go. */
async function hold(page: Page, key: string): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(900);
  await page.keyboard.up(key);
  await page.waitForTimeout(400);
}

/** The auto camera on the top-down office, following my character (the fixture pins the runners'
 *  upstream camera 'off'). */
async function autoCamera(page: Page): Promise<void> {
  await page.evaluate(() => {
    localStorage.setItem('agty.camera-mode', 'auto');
    localStorage.setItem('agty.office-iso', 'off');
  });
  await page.reload();
  await expect(nameplateOf(page, 'alpha')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => followOf(page), { timeout: 15_000 }).toBe(OWNER);
}

/** Bring alpha into view the way a user does (its portrait, Esc back to my character, then zoom
 *  out until alpha shows) and click it on the office canvas. */
async function clickAlpha(page: Page): Promise<number> {
  const alpha = Number(await nameplateOf(page, 'alpha').getAttribute('data-agent-id'));
  await page.locator('[data-testid="agent-card"][title="alpha"]').first().click();
  await expect.poll(() => followOf(page)).toBe(alpha);
  await page.mouse.move(640, 700); // the keys reach the office, not a hovered card
  await page.keyboard.press('Escape');
  await expect.poll(() => followOf(page)).toBe(OWNER);
  for (let out = 0; out < ZOOM_OUT_MAX && !(await onScreen(page, alpha)); out++) {
    await page.keyboard.press('-');
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1_000); // the view settles
  const at = (await onScreen(page, alpha))!;
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => followOf(page)).toBe(alpha);
  await page.waitForTimeout(1_200); // the follow's zoom
  return alpha;
}

test.describe('an idle employee', () => {
  test.use({ standaloneOptions: { agents: [{ name: 'alpha' }] } });

  test('after a click on an idle employee, D walks that employee @area:office', async ({
    page,
    standalone,
  }) => {
    expect(standalone.port).not.toBe(18240); // never the real daemon
    await autoCamera(page);
    await expect(await ringOf(page, 'alpha')).toHaveAttribute('data-ring', 'idle', {
      timeout: 30_000,
    });
    const alpha = await clickAlpha(page);
    const before = (await tileOf(page, alpha))!;
    await hold(page, 'd');
    const after = (await tileOf(page, alpha))!;
    expect(after.col, `alpha walked right from column ${before.col}`).toBeGreaterThan(before.col);
  });

  test('after a click on my own character, D walks it @area:office', async ({
    page,
    standalone,
  }) => {
    expect(standalone.port).not.toBe(18240);
    await autoCamera(page);
    await page.waitForTimeout(1_500); // the follow's zoom
    const at = (await onScreen(page, OWNER))!;
    await page.mouse.click(at.x, at.y);
    await expect(page.getByTestId('owner-menu')).toBeVisible();
    const before = (await tileOf(page, OWNER))!;
    await hold(page, 'd');
    const after = (await tileOf(page, OWNER))!;
    expect(after.col, `my character walked right from column ${before.col}`).toBeGreaterThan(
      before.col,
    );
  });
});

test.describe('an employee at work', () => {
  test.use({
    standaloneOptions: {
      agents: [{ name: 'alpha' }],
      scenarios: [
        // The turn the engine starts it with runs a long tool: alpha works at its desk meanwhile.
        claudeScenario('long tool')
          .forAgent('alpha')
          .onPrompt(RECOVERY_PROMPT)
          .at(300)
          .appendJsonl(buildAssistantToolUseRecord('tu-long', 'Bash', { command: 'npm test' }))
          .at(110_000)
          .appendJsonl(buildUserToolResultRecord('tu-long', 'ok'))
          .at(110_200)
          .appendJsonl(buildTurnDurationRecord())
          .build(),
      ],
    },
  });

  test('after a click on an employee at work, D looks around instead of doing nothing @area:office', async ({
    page,
    standalone,
  }) => {
    expect(standalone.port).not.toBe(18240);
    await autoCamera(page);
    await expect(await ringOf(page, 'alpha')).toHaveAttribute('data-ring', 'working', {
      timeout: 30_000,
    });
    const alpha = await clickAlpha(page);
    const tile = (await tileOf(page, alpha))!;
    const pan = await panOf(page);
    await hold(page, 'd');
    // It stays at its desk (it says so once), and the view moves right: the map moves left.
    await expect(page.getByRole('status').filter({ hasText: 'alpha' }).first()).toBeVisible();
    expect(await tileOf(page, alpha)).toMatchObject({ col: tile.col, row: tile.row });
    expect((await panOf(page)).x, 'D panned the view').toBeLessThan(pan.x);
  });
});
