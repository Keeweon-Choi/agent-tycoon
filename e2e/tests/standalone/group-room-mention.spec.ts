/**
 * T-99 flow 8: make a group room, mention everyone, read the replies under the post.
 * alpha and beta answer the room's line with text only (no turn_duration): the 5 s text-idle path.
 * Selectors: agent-tycoon/test/run-rooms.ts and run-room-reply-count-first.ts.
 */
import { expect, test } from '../../fixtures/standalone';
import { createRoom, openMessenger, openRoom, sendToRoom } from '../../helpers/messenger';
import { claudeScenario } from '../../helpers/mock-claude';
import { ringOf } from '../../helpers/office';
import { buildAssistantTextRecord } from '../../helpers/team';

const ROOM = '출시팀';
const MEMBERS = ['alpha', 'beta'];
const reply = (name: string) => `${name}: 준비됐어요`;

test.use({
  standaloneOptions: {
    agents: MEMBERS.map((name) => ({ name })),
    // 4 s before the reply: the room is closed by then, so the replies land as unread.
    scenarios: MEMBERS.map((name) =>
      claudeScenario(`${name} room reply`)
        .forAgent(name)
        .onPrompt(`단톡방 '${ROOM}'`)
        .at(4_000)
        .appendJsonl(buildAssistantTextRecord(reply(name)))
        .build(),
    ),
  },
});

test('a group room post mentioning everyone gathers both replies under it @area:messenger', async ({
  page,
  standalone,
}) => {
  expect(standalone.port).not.toBe(18240); // a daemon of our own, never the real one
  // Seeded agents open with the engine's recovery turn: post only once both are idle.
  for (const name of MEMBERS)
    await expect(await ringOf(page, name)).toHaveAttribute('data-ring', 'idle', {
      timeout: 30_000,
    });

  await createRoom(page, ROOM, MEMBERS);
  const messenger = await openMessenger(page);
  const rooms = messenger.getByRole('region', { name: '단톡방' });
  const contacts = messenger.getByRole('list', { name: '연락처' });
  const roomRow = rooms.getByRole('button', { name: new RegExp(`^${ROOM}`) }).first();
  await expect(roomRow).toBeVisible();
  // Each lead's recovery turn leaves one reply (the fake's 'ok: ' echo) on its own row. Whether it
  // counts as unread depends on whether this page saw the row before that reply came (a lead's
  // first reply counts, T-128), so note each row once the reply is in: the room's replies below
  // must not change it.
  const dmRow = (name: string) => contacts.getByRole('button', { name: new RegExp(`^${name}`) });
  const dmBefore: Record<string, string> = {};
  for (const name of MEMBERS) {
    await expect(dmRow(name)).toContainText('ok: ');
    dmBefore[name] = (await dmRow(name).getAttribute('aria-label')) ?? name;
  }
  await expect(contacts.getByRole('button', { name: new RegExp(`^${ROOM}`) })).toHaveCount(0);

  const room = await openRoom(page, ROOM);
  const composer = room.getByRole('textbox', { name: `${ROOM} 메시지` });
  await composer.fill('@');
  await room.getByRole('option', { name: '@전체' }).click();
  await expect(composer).toHaveValue(/^@전체/);
  await composer.fill('@전체 출시 준비 알려 줘');
  await room.getByRole('button', { name: '보내기', exact: true }).click();
  await expect(room.getByText('출시 준비 알려 줘').first()).toBeVisible();
  await messenger.getByRole('button', { name: `${ROOM} 방 닫기` }).click();

  // Closed: the two replies count on the room's row, not on alpha's or beta's.
  await expect(roomRow).toHaveAttribute('aria-label', `${ROOM} 안 읽음 2`, { timeout: 30_000 });
  for (const name of MEMBERS) await expect(dmRow(name)).toHaveAccessibleName(dmBefore[name]);

  // Reopened: the post says both got it and holds two replies, folded until opened.
  await openRoom(page, ROOM);
  const post = room.getByTestId('room-thread').filter({ hasText: '출시 준비 알려 줘' });
  for (const name of MEMBERS) await expect(post.getByText(`${name}: 전달됨`)).toBeVisible();
  const fold = post.getByTestId('thread-fold');
  await expect(fold).toContainText('답글 2개');
  await fold.click();
  for (const name of MEMBERS) await expect(post.getByText(reply(name)).first()).toBeVisible();

  // An untagged post is a 공지: nobody is woken for it.
  await sendToRoom(page, ROOM, '공지: 점검은 내일');
  const notice = room.getByTestId('room-thread').filter({ hasText: '공지: 점검은 내일' });
  await expect(notice.getByTestId('room-mode')).toContainText('0/2 전달됨');

  // An unknown tag is refused and the draft stays in the box.
  await composer.fill('@없는사람 안녕');
  await room.getByRole('button', { name: '보내기', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '없는사람' })).toBeVisible();
  await expect(composer).toHaveValue('@없는사람 안녕');
});
