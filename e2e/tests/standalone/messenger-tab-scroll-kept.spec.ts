/**
 * T-170: a conversation read scrolled up keeps the reader's row where it was after its tab is left
 * and taken again (the conversation tabs, a dock icon, the split layouts); one left at the bottom comes
 * back at the bottom. alpha's long reply fills the list; beta is the other tab. The second test does the
 * same for the 전체 room, filled with the boss's own notices (a post tagging no one reaches no agent).
 */
import type { Locator } from '@playwright/test';

import { expect, test } from '../../fixtures/standalone';
import {
  openConversation,
  openMessenger,
  openRoom,
  sendMessage,
  sendToRoom,
} from '../../helpers/messenger';
import { claudeScenario } from '../../helpers/mock-claude';
import { ringOf } from '../../helpers/office';
import { buildAssistantTextRecord, buildTurnDurationRecord } from '../../helpers/team';

const LINES = 30;
const line = (i: number) => `긴 답 ${i}번째 줄\n자리 확인용 둘째 줄\n자리 확인용 셋째 줄`;
const LAST = line(LINES).split('\n')[0];
// Same place: the row's top within this many px of where it was.
const SLACK_PX = 8;

const long = claudeScenario('long reply').forAgent('alpha').onPrompt('긴 답');
for (let i = 1; i <= LINES; i++)
  long.at(300 + i * 40).appendJsonl(buildAssistantTextRecord(line(i)));
long.at(300 + (LINES + 1) * 40).appendJsonl(buildTurnDurationRecord());

test.use({
  standaloneOptions: {
    agents: [{ name: 'alpha' }, { name: 'beta' }],
    scenarios: [long.build()],
  },
});

const shot = (name: string) => test.info().outputPath(name);

// A conversation's rows, a room's rows.
const ROWS = '[data-chat-id],[data-keep]';

/** The first row in view and how far below the list's top it sits. */
const placeOf = (list: Locator) =>
  list.evaluate((el, rows) => {
    const top = el.getBoundingClientRect().top;
    const row = Array.from(el.querySelectorAll<HTMLElement>(rows)).find(
      (r) => r.getBoundingClientRect().bottom > top,
    )!;
    return {
      id: (row.dataset.chatId ?? row.dataset.keep)!,
      top: row.getBoundingClientRect().top - top,
    };
  }, ROWS);
/** Where row `id` sits now, below the list's top. */
const topOf = (list: Locator, id: string) =>
  list.evaluate(
    (el, rowId) =>
      el
        .querySelector<HTMLElement>(`[data-chat-id="${rowId}"],[data-keep="${rowId}"]`)!
        .getBoundingClientRect().top - el.getBoundingClientRect().top,
    id,
  );
const atBottom = (list: Locator) =>
  list.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight <= 48);

test('a conversation scrolled up keeps its place across tabs, the dock and split layouts @area:messenger', async ({
  page,
  standalone,
}) => {
  expect(standalone.port).not.toBe(18240); // a daemon of our own, never the real one
  for (const name of ['alpha', 'beta'])
    await expect(await ringOf(page, name)).toHaveAttribute('data-ring', 'idle', {
      timeout: 45_000,
    });
  const messenger = await openMessenger(page);
  await openConversation(page, 'beta');
  const conv = await sendMessage(page, 'alpha', '긴 답 보여 줘');
  await expect(conv.getByText(LAST).first()).toBeVisible({ timeout: 20_000 });
  const tabs = messenger.getByRole('navigation', { name: '열린 대화' });
  const list = conv.getByTestId('chat-scroll');

  /** Scroll the list to its middle as a reader would; the place it shows once the scroll is handled. */
  const readMiddle = async () => {
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight / 2;
    });
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    await expect(conv.getByRole('button', { name: '맨 아래로' })).toBeVisible();
    return await placeOf(list);
  };
  const keptAt = async (at: { id: string; top: number }, where: string) =>
    expect
      .soft(Math.abs((await topOf(list, at.id)) - at.top), `${where}: the row kept its place`)
      .toBeLessThanOrEqual(SLACK_PX);
  const toTab = async (name: string) => {
    await tabs.getByRole('tab', { name: new RegExp(`^${name}`) }).click();
    await expect(messenger.getByRole('region', { name: `${name} 대화` })).toBeVisible();
  };

  // Conversation tabs: read from the middle, go to beta's tab and back.
  const reading = await readMiddle();
  await page.screenshot({ path: shot('01-scrolled-up.png') });
  await toTab('beta');
  await toTab('alpha');
  await page.screenshot({ path: shot('02-back-from-tab.png') });
  await keptAt(reading, 'conversation tab');

  // The dock: minimized with its icon and shown again.
  const docked = await readMiddle();
  const icon = page.locator('[data-hud-id="icon:messenger"] button');
  await icon.click();
  await expect(conv).toBeHidden();
  await icon.click();
  await expect(conv).toBeVisible();
  await keptAt(docked, 'dock icon');

  // Split layouts: the messenger filled (wide enough for panes), 2 then 1 again.
  await page.getByTestId('hud-title-messenger').getByRole('button', { name: '최대화' }).click();
  await expect(page.getByTestId('split-layout-2')).toBeVisible();
  const wide = await readMiddle();
  await page.getByTestId('split-layout-2').click();
  const paneList = page.getByTestId('split-pane-0').getByTestId('chat-scroll');
  await expect(paneList).toBeVisible();
  // A pane is narrower and its rows wrap otherwise: the same row is still the first in view.
  expect.soft((await placeOf(paneList)).id, 'split 2: the same row first in view').toBe(wide.id);
  await page.getByTestId('split-layout-1').click();
  await expect(page.getByTestId('split-pane-0')).toHaveCount(0);
  await expect(conv).toBeVisible();
  await keptAt(wide, 'split back to 1');

  // Left at the bottom, it comes back at the bottom.
  await conv.getByRole('button', { name: '맨 아래로' }).click();
  await expect.poll(() => atBottom(list)).toBe(true);
  await toTab('beta');
  await toTab('alpha');
  expect(await atBottom(list), 'left at the bottom: back at the bottom').toBe(true);
});

const ROOM = '전체';
const NOTICES = 16;
const notice = (i: number) => `공지 ${i}번\n자리 확인용 둘째 줄\n자리 확인용 셋째 줄`;

test('a group room scrolled up keeps its place across tabs and split layouts @area:messenger', async ({
  page,
  standalone,
}) => {
  expect(standalone.port).not.toBe(18240); // a daemon of our own, never the real one
  const messenger = await openMessenger(page);
  await openConversation(page, 'alpha');
  for (let i = 1; i <= NOTICES; i++) {
    const room = await sendToRoom(page, ROOM, notice(i));
    await expect(room.getByText(`공지 ${i}번`).first()).toBeVisible({ timeout: 15_000 });
  }
  const room = await openRoom(page, ROOM);
  const list = room.getByTestId('room-scroll');
  const tabs = messenger.getByRole('navigation', { name: '열린 대화' });
  const roomTab = messenger.getByTestId('room-tab-all');

  const readMiddle = async () => {
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight / 2;
    });
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    expect(await atBottom(list)).toBe(false);
    return await placeOf(list);
  };
  const keptAt = async (at: { id: string; top: number }, where: string) =>
    expect
      .soft(Math.abs((await topOf(list, at.id)) - at.top), `${where}: the row kept its place`)
      .toBeLessThanOrEqual(SLACK_PX);
  const awayAndBack = async () => {
    await tabs.getByRole('tab', { name: /^alpha/ }).click();
    await expect(messenger.getByRole('region', { name: 'alpha 대화' })).toBeVisible();
    await roomTab.click();
    await expect(list).toBeVisible();
  };

  // The room's tab: read from the middle, go to alpha's tab and back.
  const reading = await readMiddle();
  await page.screenshot({ path: shot('room-01-scrolled-up.png') });
  await awayAndBack();
  // The room's posts come again once its view is back (its subscription went with it).
  await expect(room.getByText(`공지 ${NOTICES}번`).first()).toBeAttached();
  await page.screenshot({ path: shot('room-02-back-from-tab.png') });
  await keptAt(reading, 'room tab');

  // Split layouts: the messenger filled (wide enough for panes), 2 then 1 again.
  await page.getByTestId('hud-title-messenger').getByRole('button', { name: '최대화' }).click();
  await expect(page.getByTestId('split-layout-2')).toBeVisible();
  const wide = await readMiddle();
  await page.getByTestId('split-layout-2').click();
  const paneList = page.getByTestId('split-pane-0').getByTestId('room-scroll');
  await expect(paneList).toBeVisible();
  expect.soft((await placeOf(paneList)).id, 'split 2: the same row first in view').toBe(wide.id);
  await page.getByTestId('split-layout-1').click();
  await expect(page.getByTestId('split-pane-0')).toHaveCount(0);
  await expect(list).toBeVisible();
  await keptAt(wide, 'split back to 1');

  // Left at the bottom, it comes back at the bottom.
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(() => atBottom(list)).toBe(true);
  await awayAndBack();
  expect(await atBottom(list), 'left at the bottom: back at the bottom').toBe(true);
});
