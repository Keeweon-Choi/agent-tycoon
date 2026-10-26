/**
 * T-0088 browser check: group rooms with the built-in engine fake.  It makes
 * a room, fans a tagged post to two fake sessions, gathers only their started
 * turns below the post, exercises `전체` and the CLI, then captures desktop and
 * phone views.  This is intentionally a runner, not a unit test:
 *
 *   npx tsx cld/test/run-rooms.ts <port 18256-18259> <push port 18256-18259>
 *
 * C3 (the room post `@alpha @beta`, both reply): the room shows the unread, the
 * two DMs show none, and the fake push service gets ONE push, for the room.
 * Two ports: the daemon's, and the fake push service's (a different one).
 */
import type { Browser, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as path from 'path';

import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';

if (process.argv.length < 4 || process.argv[2] === process.argv[3])
  throw new Error(
    'usage: run-rooms.ts <port 18256-18259> <push port 18256-18259>: two different ports (daemon, fake push service)',
  );
const port = sparePort();
const pushPort = sparePort(3);
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0088');
const FIXTURES = path.join(REPO_ROOT, 'cld/test/fixtures/t0088');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0088/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 180_000;

const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function eventually(what: string, test: () => boolean, timeout = 20_000): Promise<void> {
  for (const end = Date.now() + timeout; ; await wait(200)) {
    if (test()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}

/** A throwaway self-signed certificate for 127.0.0.1, in the test HOME. */
function makeCert(home: string): { key: Buffer; cert: Buffer; certFile: string } {
  const dir = fs.mkdtempSync(path.join(home, 'tls-'));
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const r = spawnSync('openssl', [
    ...['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'],
    ...['-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=127.0.0.1'],
    ...['-addext', 'subjectAltName=IP:127.0.0.1'],
  ]);
  if (r.status !== 0) throw new Error(`openssl: ${r.stderr}`);
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile), certFile };
}

const hkdf = (ikm: Buffer, salt: Buffer, info: string, len: number) =>
  Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), len));
/** The browser's side of RFC 8291: what the fake push service received, opened. */
function decrypt(body: Buffer, ua: crypto.ECDH, auth: Buffer): Record<string, unknown> {
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 21 + body[20]);
  const record = body.subarray(21 + body[20]);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ua.computeSecret(asPublic), auth, info, 32));
  const d = crypto.createDecipheriv(
    'aes-128-gcm',
    hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16),
    hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12),
  );
  d.setAuthTag(record.subarray(-16));
  const plain = Buffer.concat([d.update(record.subarray(0, -16)), d.final()]);
  return JSON.parse(plain.subarray(0, -1).toString()) as Record<string, unknown>;
}

async function main() {
  await assertPortFree(port, pushPort);
  fs.mkdirSync(OUT, { recursive: true });
  const fixture = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'room-replies.json'), 'utf8')) as {
    members: string[];
    replies: Record<string, string>;
  };
  const unrelated = JSON.parse(
    fs.readFileSync(path.join(FIXTURES, 'unrelated-turn.json'), 'utf8'),
  ) as {
    prompt: string;
    reply: string;
  };
  const { home, bin } = makeEngineHome();
  // Our own temp HOME: its daemon's port is the spare one, never the live daemon's.
  fs.writeFileSync(
    path.join(configDirectory(home), 'config.json'),
    JSON.stringify({ accessChosen: true, port }),
  );
  const folders = Object.fromEntries(
    fixture.members.map((name) => [name, path.join(home, 'work', name)]),
  );
  for (const folder of Object.values(folders)) fs.mkdirSync(folder, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(
      fixture.members.map((name) => ({
        name,
        folder: folders[name],
        room: '개발실',
        wantRunning: true,
      })),
    ),
  );
  // C3: one device that is subscribed to push and never looks (its id is no open page's). The
  // fake push service is on https://127.0.0.1, its certificate trusted by the daemon alone.
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const uaAuth = crypto.randomBytes(16);
  const vapid = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
    format: 'jwk',
  });
  fs.writeFileSync(
    path.join(configDirectory(home), 'push.json'),
    JSON.stringify({
      vapid: {
        publicKey: Buffer.concat([
          Buffer.from([4]),
          Buffer.from(vapid.x!, 'base64url'),
          Buffer.from(vapid.y!, 'base64url'),
        ]).toString('base64url'),
        privateKey: vapid,
      },
      subscriptions: [
        {
          device: 'c3-phone',
          endpoint: `https://127.0.0.1:${pushPort}/push/c3`,
          p256dh: ua.getPublicKey().toString('base64url'),
          auth: uaAuth.toString('base64url'),
          kinds: ['turnEnd', 'attention', 'job'],
          subagents: false,
          createdAt: Date.now(),
        },
      ],
    }),
    { mode: 0o600 },
  );
  const tls = makeCert(home);
  const pushed: Array<Record<string, unknown>> = [];
  const pushServer = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        pushed.push(decrypt(Buffer.concat(chunks), ua, uaAuth));
      } catch (error) {
        console.error('push body unreadable', error);
      }
      res.writeHead(201).end();
    });
  });
  await new Promise<void>((resolve) => pushServer.listen(pushPort, '127.0.0.1', resolve));
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { FAKE_TURN_MS: '400', NODE_EXTRA_CA_CERTS: tls.certFile },
  );
  let browser: Browser | undefined;
  let replier: ReturnType<typeof setInterval> | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    type Session = { name: string; jobId: string; cwd: string; sessionId: string };
    const session = (name: string): Session | null => {
      const dir = path.join(home, '.claude/sessions');
      for (const file of fs.readdirSync(dir)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Session;
          if (parsed.name === name) return parsed;
        } catch {
          /* a fake is writing */
        }
      }
      return null;
    };
    await eventually('fake sessions', () => fixture.members.every((name) => session(name)));
    let serial = 0;
    const say = (name: string, role: 'user' | 'assistant', text: string) => {
      const s = session(name)!;
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const uuid = `${(++serial).toString(16).padStart(8, '0')}-0088-4000-8000-000000000000`;
      const message =
        role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] };
      fs.appendFileSync(
        file,
        `${JSON.stringify({ type: role, uuid, timestamp: new Date().toISOString(), message })}\n`,
      );
    };
    const typed = () => {
      const file = path.join(home, 'fake-claude-typed.log');
      return fs.existsSync(file)
        ? fs
            .readFileSync(file, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as { id: string; text: string })
        : [];
    };
    let seen = 0;
    /** True: the fake sessions do not answer yet (the replies land while the list is on screen). */
    let hold = false;
    replier = setInterval(() => {
      if (hold) return;
      const all = typed();
      for (const item of all.slice(seen)) {
        const name = fixture.members.find((member) => session(member)?.jobId === item.id);
        if (!name) continue;
        say(name, 'user', item.text.replaceAll('\r', '\n'));
        // Only a room post gets the room reply: the engine's own turns (its recovery notice, typed
        // when a session starts) are one-to-one turns, and answering them with a room reply
        // lands a reply in the DM (and a 💬 notice) at a time that depends on the start order.
        if (fixture.replies[name] && item.text.includes("단톡방 '출시팀'"))
          say(name, 'assistant', fixture.replies[name]);
      }
      seen = all.length;
    }, 100);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    if (fs.existsSync(FONT))
      await context.route('**/__t0088/malgun.ttf', (route) =>
        route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }),
      );
    const page = await context.newPage();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    await page.getByRole('button', { name: /^메신저/ }).click();
    const messenger = page.getByRole('region', { name: '메신저', exact: true });
    const rooms = messenger.getByRole('region', { name: '단톡방' });
    await rooms.getByRole('button', { name: '+ 방 만들기' }).click();
    await rooms.getByRole('textbox', { name: '방 이름' }).fill('출시팀');
    for (const name of ['alpha', 'beta']) await rooms.getByLabel(name).check();
    await rooms.getByRole('button', { name: '저장' }).click();
    await rooms.getByRole('button', { name: /^출시팀/ }).click();
    const room = messenger.getByTestId(/group-room-screen-/);
    await room.waitFor();
    check((await room.count()) === 1, 'the room row opens its own conversation screen');
    const composer = room.getByRole('textbox', { name: '출시팀 메시지' });
    await composer.fill('@');
    await room.getByRole('option', { name: '@전체' }).click();
    await composer.fill('@전체 출시 준비를 알려줘');
    hold = true;
    await room.getByRole('button', { name: '보내기', exact: true }).click();
    await eventually(
      'two group sends',
      () => typed().filter((item) => item.text.includes("단톡방 '출시팀'")).length === 2,
    );
    // C3: leave the room before alpha and beta answer; the answers land on the list.
    await room.getByText('출시 준비를 알려줘').first().waitFor({ timeout: 20_000 });
    await messenger.getByRole('button', { name: '출시팀 방 닫기' }).click();
    hold = false;
    const roomLabel = () =>
      rooms
        .getByRole('button', { name: /^출시팀/ })
        .first()
        .getAttribute('aria-label');
    for (
      const end = Date.now() + 20_000;
      (await roomLabel()) !== '출시팀 안 읽음 2';
      await wait(200)
    )
      if (Date.now() > end)
        throw new Error(`room row label is "${await roomLabel()}", not unread 2`);
    check(true, 'C3: the room shows the two replies as unread (2)');
    check(
      (await messenger.getByRole('button', { name: /^(alpha|beta)$/ }).count()) === 2,
      'C3: alpha and beta DMs show no unread (their room turns are not DM replies)',
    );
    // The two turns end by themselves (the text-idle timer): U-49, one push per message, each
    // titled `<room> · <member>` and opening the room (a new-device push may come first).
    const roomPushes = () => pushed.filter((p) => String(p.url).includes('open=room'));
    await eventually('both room pushes went out', () => roomPushes().length >= 2, 40_000);
    await wait(15_000);
    console.log(`pushes: ${JSON.stringify(pushed)}`);
    check(
      roomPushes().length === 2 &&
        roomPushes()
          .map((p) => p.title)
          .sort()
          .join('|') === '출시팀 · alpha|출시팀 · beta',
      'C3: one push per room reply, titled room · member, none for the alpha or beta DM',
    );
    // The open page's bell says the same: ROOM-NOTICE / U-49, one notice per room reply, titled
    // room · member (and none for the alpha or beta DM).
    await page.locator('[data-testid="notice-bell"]').click();
    const notices = page.locator('[data-testid="notice-item"]');
    const noticeTexts = await notices.allInnerTexts();
    console.log(`bell: ${JSON.stringify(noticeTexts)}`);
    check(
      noticeTexts.length === 2 &&
        noticeTexts.every((t) => t.includes('출시팀')) &&
        ['alpha', 'beta'].every((m) => noticeTexts.some((t) => t.includes(`출시팀 · ${m}`))),
      'C3: the bell has one notice per room reply, for the room, none for the alpha or beta DM',
    );
    await page.locator('[data-testid="notice-bell"]').click();
    await rooms.getByRole('button', { name: /^출시팀/ }).click();
    await room.waitFor();
    check(
      typed()
        .filter((item) => item.text.includes("단톡방 '출시팀'"))
        .every((item) => item.text.includes('출시 준비를 알려줘')),
      'both tagged fake sessions receive the room header and text',
    );
    await room.getByText(fixture.replies.alpha).waitFor({ timeout: 20_000 });
    await room.getByText(fixture.replies.beta).waitFor({ timeout: 20_000 });
    check(
      (await room.getByText('전달됨').count()) === 2,
      'delivery chips change from pending to delivered',
    );
    say('alpha', 'user', unrelated.prompt);
    say('alpha', 'assistant', unrelated.reply);
    await wait(1_000);
    check(
      (await room.getByText(unrelated.reply).count()) === 0,
      'a later unrelated turn is not gathered as a room reply',
    );
    // Tagged delivery only: `@alpha` reaches alpha alone, an untagged post reaches nobody.
    const groupTyped = () => typed().filter((item) => item.text.includes("단톡방 '출시팀'"));
    const before = groupTyped().length;
    await composer.fill('@alpha 혼자 확인해줘');
    await room.getByRole('button', { name: '보내기', exact: true }).click();
    await eventually('the @alpha post is typed', () => groupTyped().length === before + 1);
    check(
      groupTyped()
        .slice(before)
        .every((item) => item.id === session('alpha')!.jobId && item.id !== session('beta')!.jobId),
      'a post tagging @alpha reaches only alpha',
    );
    await composer.fill('공지: 점검은 내일입니다');
    await room.getByRole('button', { name: '보내기', exact: true }).click();
    await room.getByText('공지: 점검은 내일입니다').waitFor({ timeout: 20_000 });
    await wait(1_500);
    check(
      groupTyped().length === before + 1 && (await room.getByText('기록만 남김').count()) === 1,
      'an untagged post is recorded and delivered to nobody',
    );
    await composer.fill('@없는사람 안녕');
    await room.getByRole('button', { name: '보내기', exact: true }).click();
    await room
      .getByRole('alert')
      .getByText(/없는사람/)
      .waitFor({ timeout: 10_000 });
    check(
      (await composer.inputValue()) === '@없는사람 안녕' && groupTyped().length === before + 1,
      'an unknown @tag is refused with a message and the draft comes back',
    );
    await composer.fill('');
    // T-0037c: in a room `/` is plain text: no command menu, and `/compact` is an ordinary untagged post.
    await composer.fill('/');
    await wait(800);
    check(
      (await page.getByRole('listbox', { name: '/ 명령' }).count()) === 0,
      'a room composer: / opens no command menu',
    );
    await composer.fill('/compact');
    await room.getByRole('button', { name: '보내기', exact: true }).click();
    await room.getByText('/compact', { exact: true }).waitFor({ timeout: 10_000 });
    await wait(1_500);
    check(
      typed().filter((item) => item.text === '/compact').length === 0 &&
        groupTyped().length === before + 1,
      'a room post starting with / is recorded as text, never typed as a raw command',
    );
    // MSG-ROOM-SCROLL: a room opens at its newest post like a DM, follows new posts while the
    // reader is at the bottom, holds their place once they scroll up, and keeps it through a
    // minimize/show.
    for (let i = 1; i <= 8; i++) {
      await composer.fill(`기록 ${i}번째 공지입니다`);
      await room.getByRole('button', { name: '보내기', exact: true }).click();
      await room.getByText(`기록 ${i}번째 공지입니다`).waitFor({ timeout: 10_000 });
    }
    const roomScroll = room.getByTestId('room-scroll');
    const metrics = () =>
      roomScroll.evaluate((el) => ({
        gap: el.scrollHeight - el.scrollTop - el.clientHeight,
        top: el.scrollTop,
        scrollable: el.scrollHeight > el.clientHeight + 100,
      }));
    await messenger.getByRole('button', { name: '출시팀 방 닫기' }).click();
    await rooms.getByRole('button', { name: /^출시팀/ }).click();
    await room.waitFor();
    await wait(600);
    const opened = await metrics();
    check(
      opened.scrollable && opened.gap <= 48,
      `a room opens at its newest post (${opened.top}, ${opened.gap} px from the bottom)`,
    );
    const sendToRoom = (text: string) =>
      spawnSync(
        process.execPath,
        [
          path.join(REPO_ROOT, 'cld/bin/cld-gui'),
          'send',
          '--group',
          '출시팀',
          '--from',
          'ops',
          text,
        ],
        { env: { ...process.env, HOME: home, CLD_OUTPUT: 'json' }, encoding: 'utf8' },
      );
    sendToRoom('바닥에서 받은 공지');
    await room.getByText('바닥에서 받은 공지').waitFor({ timeout: 20_000 });
    await wait(600);
    check((await metrics()).gap <= 48, 'at the bottom, a new post is followed');
    const rowOffset = (text: string) =>
      room
        .getByText(text, { exact: true })
        .first()
        .evaluate((node) => {
          const box = node.closest('[data-testid="room-scroll"]')!.getBoundingClientRect();
          return node.getBoundingClientRect().top - box.top;
        });
    await roomScroll.evaluate((el) => (el.scrollTop = el.scrollTop / 2));
    await wait(400);
    const heldAt = await rowOffset('기록 4번째 공지입니다');
    sendToRoom('위에서 받은 공지');
    await room.getByText('위에서 받은 공지').waitFor({ timeout: 20_000 });
    await wait(600);
    const heldAfter = await rowOffset('기록 4번째 공지입니다');
    check(
      Math.abs(heldAfter - heldAt) <= 8 && (await metrics()).gap > 48,
      `scrolled up, a new post leaves the view alone (${Math.round(heldAt)} -> ${Math.round(heldAfter)} px)`,
    );
    const minimize = page
      .locator('[data-hud-window="messenger"]')
      .getByRole('button', { name: '최소화' });
    for (let i = 1; i <= 2; i++) {
      await minimize.click();
      await wait(300);
      await page.getByRole('button', { name: /^메신저/ }).click();
      await wait(600);
      const back = await rowOffset('기록 4번째 공지입니다');
      check(
        Math.abs(back - heldAt) <= 8,
        `room minimize/show ${i} keeps the reader's row (${Math.round(heldAt)} -> ${Math.round(back)} px)`,
      );
    }
    await roomScroll.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await wait(400);
    await minimize.click();
    await wait(300);
    await page.getByRole('button', { name: /^메신저/ }).click();
    await wait(600);
    check(
      (await metrics()).gap <= 48,
      'a room left at the bottom is at the bottom after minimize/show',
    );
    await page.screenshot({ path: path.join(OUT, 'desktop.png') });
    await messenger.getByRole('button', { name: '출시팀 방 닫기' }).click();
    await rooms.getByRole('button', { name: /^출시팀/ }).waitFor();
    check((await room.count()) === 0, 'room back returns to the conversation list');
    await messenger.getByRole('button', { name: /^alpha/ }).click();
    // The list row's preview shows the same reply: wait for the bubble in the transcript.
    await messenger
      .getByTestId('chat-scroll')
      .getByText(unrelated.reply, { exact: true })
      .waitFor({ timeout: 10_000 });
    check(
      (await messenger.getByText('출시 준비를 알려줘', { exact: true }).count()) === 0,
      'the tagged member DM does not show the room post',
    );
    await rooms.getByRole('button', { name: /^출시팀/ }).click();
    await messenger.getByRole('button', { name: '출시팀 방 닫기' }).click();
    const cli = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, 'cld/bin/cld-gui'),
        'send',
        '--group',
        '전체',
        '--from',
        'ops',
        '점검 공지',
      ],
      { env: { ...process.env, HOME: home, CLD_OUTPUT: 'json' }, encoding: 'utf8' },
    );
    check(
      cli.status === 0 && cli.stdout.includes('"ok":true'),
      'cld-gui send --group 전체 posts through the daemon',
    );
    await rooms.getByRole('button', { name: /^전체/ }).click();
    const allRoom = messenger.getByTestId('group-room-screen-all');
    await allRoom.getByText('점검 공지').waitFor({ timeout: 20_000 });
    // MSG-UI2: the members are behind the pill now.
    await allRoom.getByTestId('member-pill').click();
    check(
      (await allRoom.getByText('alpha').count()) > 0 &&
        (await allRoom.getByText('beta').count()) > 0 &&
        (await allRoom.getByText('gamma').count()) > 0,
      '전체 follows every registered orchestrator',
    );
    await allRoom.getByTestId('member-pill').click();
    check(
      (await allRoom.getByText('ops', { exact: true }).count()) > 0,
      'the CLI post shows in the room with its sender',
    );
    check(
      (await allRoom.getByRole('button', { name: '방 삭제' }).count()) === 0,
      '전체 has no delete or rename button',
    );
    const cliOut = (...args: string[]) =>
      spawnSync(process.execPath, [path.join(REPO_ROOT, 'cld/bin/cld-gui'), ...args], {
        env: { ...process.env, HOME: home, CLD_OUTPUT: 'json' },
        encoding: 'utf8',
      });
    const boss = cliOut('send', '--group', '출시팀', '--from', '사장', '@alpha 사장인 척');
    check(
      boss.status !== 0 && groupTyped().length === before + 1,
      'the CLI cannot send as 사장 (nothing was typed)',
    );
    const read = cliOut('groups', 'read', '출시팀');
    check(
      read.status === 0 && read.stdout.includes('공지: 점검은 내일입니다'),
      'cld-gui groups read prints the room posts',
    );
    // A second device the office shows read-only (the daemon marks no real client so; the socket
    // is rewritten the way run-whiteboard does). The server-side refusal is office.test.ts.
    const second = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const secondPage = await second.newPage();
    await secondPage.routeWebSocket(/\/ws(\?|$)/, (ws) => {
      const server = ws.connectToServer();
      server.onMessage((m) => {
        try {
          const j = JSON.parse(String(m)) as { type: string; readOnly?: boolean };
          if (j.type === 'officeAccess') j.readOnly = true;
          ws.send(JSON.stringify(j));
        } catch {
          ws.send(m);
        }
      });
      ws.onMessage((m) => server.send(m));
    });
    await secondPage.goto(await daemon.loginUrl());
    await secondPage.waitForURL(`http://127.0.0.1:${port}/`);
    await secondPage.getByRole('button', { name: /^메신저/ }).click();
    await secondPage.getByRole('region', { name: '메신저', exact: true }).waitFor();
    const secondRooms = secondPage.getByRole('region', { name: '단톡방' });
    check(
      (await secondRooms.getByText('출시팀').count()) === 1,
      'a second browser context sees the same rooms',
    );
    await secondRooms.getByRole('button', { name: /^출시팀/ }).click();
    const secondRoom = secondPage.getByTestId(/group-room-screen-/);
    await secondRoom.getByText('공지: 점검은 내일입니다').waitFor({ timeout: 20_000 });
    check(
      (await secondRooms.getByRole('button', { name: '+ 방 만들기' }).count()) === 0 &&
        (await secondRoom.getByRole('textbox').count()) === 0 &&
        (await secondRoom
          .getByRole('button', { name: /^(보내기|방 삭제|이름 바꾸기|구성원)$/ })
          .count()) === 0,
      'a read-only context reads the room but has no composer, create, rename, members or delete',
    );
    await second.close();
    // Rename keeps the gathered replies; a user room can be deleted.
    await messenger.getByRole('button', { name: '전체 방 닫기' }).click();
    await rooms.getByRole('button', { name: /^출시팀/ }).click();
    await room.getByRole('button', { name: '이름 바꾸기' }).click();
    await room.getByRole('textbox', { name: '방 이름' }).fill('출시팀2');
    await room.getByRole('button', { name: '저장' }).click();
    const renamed = messenger.getByTestId(/group-room-screen-/);
    await renamed.getByText('출시팀2').waitFor();
    check(
      (await renamed.getByText(fixture.replies.alpha).count()) > 0,
      'a renamed room keeps its replies',
    );
    await renamed.getByRole('button', { name: '구성원' }).click();
    await renamed.getByRole('checkbox', { name: 'beta' }).uncheck();
    await renamed.getByRole('button', { name: '저장' }).click();
    // The member pill counts them now; old posts keep their delivery chips and replies.
    await renamed.getByTestId('member-pill').click();
    const members = renamed.getByTestId('member-list');
    await members.getByText('alpha', { exact: true }).waitFor();
    check(
      !((await members.textContent()) ?? '').includes('beta'),
      'member management removes a member',
    );
    await renamed.getByRole('button', { name: '방 삭제' }).click();
    // The deleted room's screen closes by itself; there is no back button to press.
    await renamed.waitFor({ state: 'detached', timeout: 10_000 });
    await rooms
      .getByRole('button', { name: /^출시팀2/ })
      .waitFor({ state: 'detached', timeout: 10_000 });
    check(true, 'deleting a user room removes it');
    const phone = await browser.newContext({ ...devices['iPhone 13'] });
    const phonePage: Page = await phone.newPage();
    await phonePage.goto(await daemon.loginUrl());
    await phonePage.getByRole('button', { name: /^메신저/ }).click();
    await phonePage.screenshot({ path: path.join(OUT, 'phone.png') });
    // U-36 on a phone: the same two sections.
    await phonePage.getByRole('heading', { name: '단톡방', exact: true }).waitFor();
    check(
      (await phonePage.getByRole('heading', { name: '개인톡', exact: true }).count()) === 1 &&
        (await phonePage.getByRole('region', { name: '단톡방', exact: true }).count()) === 1,
      'U-36 phone: 개인톡 and 단톡방 are two sections in the list',
    );
    const OUT_B1 = path.join(REPO_ROOT, 'cld/artifacts/ui-b1');
    fs.mkdirSync(OUT_B1, { recursive: true });
    await phonePage.screenshot({ path: path.join(OUT_B1, 'u36-after-phone-two-sections.png') });
    await phone.close();
    await context.close();
  } finally {
    if (replier) clearInterval(replier);
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    pushServer.close();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
