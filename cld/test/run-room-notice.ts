/**
 * ROOM-NOTICE browser check: a room post both members answer gives TWO notices
 * (bell, toast on desktop and phone), each "<room> · <member>" with a preview of
 * what that member wrote, opening the room; the Web Push carries the same title
 * and preview. Headless, temp HOME, the engine fake.
 *
 *   npx tsx cld/test/run-room-notice.ts <port 18256-18259> <push port 18256-18259>
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
    'usage: run-room-notice.ts <port 18256-18259> <push port 18256-18259>: two different ports (daemon, fake push service)',
  );
const port = sparePort();
const pushPort = sparePort(3);
const OUT = path.join(REPO_ROOT, 'cld/artifacts/room-notice');
const FIXTURES = path.join(REPO_ROOT, 'cld/test/fixtures/t0088');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__rn/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
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
      await context.route('**/__rn/malgun.ttf', (route) =>
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
    const composer = room.getByRole('textbox', { name: '출시팀 메시지' });
    await composer.fill('@');
    await room.getByRole('option', { name: '@전체' }).click();
    await composer.fill('@전체 출시 준비를 알려줘');
    // A phone, open on the same daemon before the answers land.
    const phoneCtx = await browser.newContext({ ...devices['iPhone 13'] });
    const phone: Page = await phoneCtx.newPage();
    await phone.goto(await daemon.loginUrl());
    await phone.waitForTimeout(2_000);
    hold = true;
    await room.getByRole('button', { name: '보내기', exact: true }).click();
    await eventually(
      'two group sends',
      () => typed().filter((item) => item.text.includes("단톡방 '출시팀'")).length === 2,
    );
    await room.getByText('출시 준비를 알려줘').first().waitFor({ timeout: 20_000 });
    // The room is not on screen when the answers land (the list is).
    await messenger.getByRole('button', { name: '출시팀 방 닫기' }).click();
    // Record every toast the page shows (they last a few seconds, a poll could miss one).
    await page.evaluate(() => {
      const seen: string[] = [];
      (window as unknown as { __toasts: string[] }).__toasts = seen;
      new MutationObserver(() => {
        const el = document.querySelector<HTMLElement>('[role="status"][data-cause]');
        if (el && seen[seen.length - 1] !== el.innerText) seen.push(el.innerText);
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    hold = false;
    const toast = page.locator('[role="status"][data-cause]');
    const sawToast = await toast.first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    if (sawToast) await page.screenshot({ path: path.join(OUT, 'desktop-toast.png') });
    const items = page.locator('[data-testid="notice-item"]');
    await page.locator('[data-testid="notice-bell"]').click();
    for (const end = Date.now() + 30_000; (await items.count()) < 2; await wait(300))
      if (Date.now() > end) throw new Error(`bell has ${await items.count()} notices, not 2`);
    const texts = await items.allInnerTexts();
    console.log(`bell: ${JSON.stringify(texts)}`);
    await page.screenshot({ path: path.join(OUT, 'desktop-bell.png') });
    check(
      texts.length === 2 &&
        ['alpha', 'beta'].every((m) =>
          texts.some(
            (t) =>
              t.includes(`출시팀 · ${m}`) && t.includes(fixture.replies[m]),
          ),
        ),
      'desktop bell: two notices, "출시팀 · <member>" each with what that member wrote (no generic room line)',
    );
    const toasts = await page.evaluate(() => (window as unknown as { __toasts: string[] }).__toasts);
    console.log(`toasts: ${JSON.stringify(toasts)}`);
    check(
      toasts.some((t) => t.includes('출시팀 · ') && /alpha|beta/.test(t)),
      'desktop: a toast names the room and the member',
    );
    check(
      !texts.some((t) => t.includes('단톡방에 답이 왔어요')),
      'desktop bell: no "a reply arrived in the room" line',
    );
    // The phone has the same two.
    await phone.locator('[data-testid="notice-bell"]').tap();
    const phoneItems = phone.locator('[data-testid="notice-item"]');
    for (const end = Date.now() + 30_000; (await phoneItems.count()) < 2; await wait(300))
      if (Date.now() > end) throw new Error(`phone bell has ${await phoneItems.count()}, not 2`);
    await phone.screenshot({ path: path.join(OUT, 'phone-bell.png') });
    check((await phoneItems.count()) === 2, 'phone bell: two notices');
    // The turns end by themselves later: Web Push, one per member, same title and preview.
    const roomPushes = () => pushed.filter((p) => String(p.url).includes('open=room'));
    await eventually('both room pushes went out', () => roomPushes().length >= 2, 40_000);
    await wait(10_000);
    console.log(`pushes: ${JSON.stringify(roomPushes())}`);
    check(
      roomPushes().length === 2 &&
        ['alpha', 'beta'].every((m) =>
          roomPushes().some(
            (p) => p.title === `출시팀 · ${m}` && String(p.body).includes(fixture.replies[m]),
          ),
        ),
      'push: one per member, titled "출시팀 · <member>", the body is what it wrote',
    );
    // Later turn ends add no second notice to the bell (the text already notified).
    check((await items.count()) === 2, 'desktop bell: the turn ends added nothing');
    // A click opens the room thread.
    await items.first().click();
    await room.waitFor({ timeout: 10_000 });
    check((await room.count()) === 1, 'a notice opens the room');
    await phoneCtx.close();
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
