/**
 * The messenger as a user drives it (selectors of agent-tycoon/test/run-pty-agent.ts send() and run-rooms.ts).
 * On the phone (the Dock is there) every press is a tap.
 */
import type { Locator, Page } from '@playwright/test';

const isPhone = async (page: Page) => (await page.locator('[data-dock="messenger"]').count()) > 0;
const press = async (page: Page, target: Locator) =>
  (await isPhone(page)) ? target.tap() : target.click();

/** The messenger's region, opened from the dock (desktop) or the Dock (phone) when it is not showing. */
export async function openMessenger(page: Page): Promise<Locator> {
  const messenger = page.getByRole('region', { name: '메신저', exact: true });
  if (!(await messenger.isVisible())) {
    const phoneDock = page.locator('[data-dock="messenger"]');
    if (await phoneDock.count()) await phoneDock.tap();
    else
      await page
        .getByRole('button', { name: /^메신저/ })
        .first()
        .click();
    await messenger.waitFor();
  }
  return messenger;
}

/** `name`'s conversation (picked in 연락처 unless it is open). */
export async function openConversation(page: Page, name: string): Promise<Locator> {
  const messenger = await openMessenger(page);
  const conv = messenger.getByRole('region', { name: `${name} 대화` });
  if (!(await conv.isVisible())) {
    const contact = messenger
      .getByRole('list', { name: '연락처' })
      .getByRole('button', { name: new RegExp(`^${name}`) });
    await contact.waitFor({ timeout: 15_000 });
    await press(page, contact);
    await conv.waitFor();
  }
  return conv;
}

/** Types `text` into `name`'s 보낼 글 and presses Enter (on the phone, where Enter is a new line,
 *  taps 보내기). Returns the conversation. */
export async function sendMessage(page: Page, name: string, text: string): Promise<Locator> {
  const conv = await openConversation(page, name);
  const box = conv.getByRole('textbox', { name: '보낼 글' });
  await box.fill(text);
  if (await isPhone(page)) await conv.getByRole('button', { name: '보내기', exact: true }).tap();
  else await box.press('Enter');
  return conv;
}

/** The room `room`'s screen (opened from 단톡방 unless it is open). */
export async function openRoom(page: Page, room: string): Promise<Locator> {
  const messenger = await openMessenger(page);
  const screen = messenger.getByTestId(/group-room-screen-/);
  if (!(await screen.isVisible())) {
    await press(
      page,
      messenger
        .getByRole('region', { name: '단톡방' })
        .getByRole('button', { name: new RegExp(`^${room}`) }),
    );
    await screen.waitFor();
  }
  return screen;
}

/** Creates the room `room` with `members` ticked (단톡방 → + 방 만들기 → 저장). */
export async function createRoom(page: Page, room: string, members: string[]): Promise<void> {
  const rooms = (await openMessenger(page)).getByRole('region', { name: '단톡방' });
  await press(page, rooms.getByRole('button', { name: '+ 방 만들기' }));
  await rooms.getByRole('textbox', { name: '방 이름' }).fill(room);
  for (const name of members) await rooms.getByLabel(name).check();
  await press(page, rooms.getByRole('button', { name: '저장' }));
  await rooms.getByRole('button', { name: new RegExp(`^${room}`) }).waitFor();
}

/** Posts `text` in the room `room` with its 보내기 button. Returns the room's screen. */
export async function sendToRoom(page: Page, room: string, text: string): Promise<Locator> {
  const screen = await openRoom(page, room);
  await screen.getByRole('textbox', { name: `${room} 메시지` }).fill(text);
  await press(page, screen.getByRole('button', { name: '보내기', exact: true }));
  return screen;
}
