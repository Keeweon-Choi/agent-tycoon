/**
 * AUTH-PK2 check (10-24): the owner's iPhone pressed 패스키 필수 off twice and
 * nothing visibly happened. dist/cli.js with an isolated HOME on a spare
 * port, headless Chromium. The owner's state: three devices with device keys
 * at an IP address (no passkey can ever be made there), 필수 on, no passkey,
 * sessions and devices restored from files after a restart. All three reach
 * the daemon from one address (127.0.0.1), like a home behind hairpin NAT.
 *   D, W: Windows desktops. P: an iPhone (Chrome), 390x844.
 *
 * S0. P turns 필수 off by its key; the note shows next to the checkbox, on screen.
 * S1. P's page asks for 30+ nonces (many terminal panes re-proving): only P's
 *     session pauses -- D, at the same address, still makes a 기기 추가 code;
 *     P's 필수 press says "too many tries" next to the checkbox; a minute
 *     later P's 기기 추가 works again.
 * S2. P's browser loses its key (IndexedDB cleared, the cookie kept); after a
 *     restart a reload writes no key; P's 필수 press says the key is gone, next to the
 *     checkbox (and in 기기 추가), with "이 기기 로그아웃하고 코드로 다시 로그인"; that button
 *     signs P out to the code login; D makes a 기기 추가 code, P types it,
 *     gets a new row and key, and turns 필수 off by that key.
 *
 * Screenshots go to cld/artifacts/auth-pk2/. A hard deadline and signals kill
 * the daemon. The real claude is never run.
 *
 *   npx tsx cld/test/run-auth-pk2.ts <port>   (18256-18259)
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  type Daemon,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort(2);
const OUT = path.join(REPO_ROOT, 'cld/artifacts/auth-pk2');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__font/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 420_000;
const DESKTOP: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 2,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
};

const failures: string[] = [];
function check(ok: unknown, what: string): void {
  if (ok) console.log(`ok - ${what}`);
  else {
    failures.push(what);
    console.log(`not ok - ${what}`);
  }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Device {
  name: string;
  page: Page;
  phone: boolean;
  base: string;
}

async function main(): Promise<void> {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({});
  const configDir = configDirectory(fake.home);
  const devicesFile = path.join(configDir, 'devices.json');
  fs.writeFileSync(
    path.join(configDir, 'passkeys.json'),
    JSON.stringify({ v: 2, userId: 'dXNlcg', revoked: [], byRp: {} }),
    { mode: 0o600 },
  );
  fs.writeFileSync(devicesFile, JSON.stringify({ v: 1, passkeyRequired: true, devices: [] }), { mode: 0o600 });
  let daemon: Daemon | undefined;
  let browser: Browser | undefined;
  const killAll = () => {
    if (daemon && daemon.child.exitCode === null) daemon.child.kill('SIGKILL');
    fs.rmSync(fake.home, { recursive: true, force: true });
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    killAll();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));
  const logs: string[] = [];
  const boot = async () => {
    daemon = startDaemon(fake, port, ['--no-terminal']);
    logs.push('');
    daemon.child.stdout?.on('data', (b: Buffer) => (logs[logs.length - 1] += b.toString()));
    daemon.child.stderr?.on('data', (b: Buffer) => (logs[logs.length - 1] += b.toString()));
    return daemon.loginUrl();
  };
  /** The owner's files again: 필수 on (only a file can, at an IP address), then a restart. */
  const requiredOnByFile = async () => {
    await daemon!.stop();
    const file = JSON.parse(fs.readFileSync(devicesFile, 'utf-8')) as { passkeyRequired: boolean };
    fs.writeFileSync(devicesFile, JSON.stringify({ ...file, passkeyRequired: true }), { mode: 0o600 });
    await boot();
  };
  const font = fs.readFileSync(FONT);

  const open = async (name: string, base: string, opts: BrowserContextOptions): Promise<Device> => {
    const ctx = await browser!.newContext({ ...opts, bypassCSP: true });
    await ctx.route('**/__font/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
    const page = await ctx.newPage();
    page.on('dialog', (dialog) => void dialog.accept());
    page.on('pageerror', (err) => console.log(`[${name}] page error: ${err.stack ?? err.message}`));
    return { name, page, phone: !!opts.isMobile, base };
  };
  const me = (d: Device) =>
    d.page.evaluate(async () => {
      const res = await fetch('/api/auth/me');
      return res.ok ? ((await res.json()) as { deviceId: string | null; passkeyRequired: boolean }) : null;
    });
  const waitDevice = async (d: Device) => {
    for (const until = Date.now() + 20_000; Date.now() < until; await sleep(300))
      if ((await me(d))?.deviceId) return;
    throw new Error(`${d.name}: no device key registered`);
  };
  const login = async (d: Device, link: string) => {
    await d.page.goto(link.replace(/^http:\/\/127\.0\.0\.1:\d+/, d.base));
    await d.page.waitForURL(`${d.base}/`);
    await waitDevice(d);
  };
  /** The key this browser holds, as the app keeps it (IndexedDB), or null. */
  const storedId = (d: Device) =>
    d.page.evaluate(
      () =>
        new Promise<string | null>((resolve) => {
          const open = indexedDB.open('cld-gui');
          open.onerror = () => resolve(null);
          open.onupgradeneeded = () => open.result.createObjectStore('device');
          open.onsuccess = () => {
            const db = open.result;
            if (!db.objectStoreNames.contains('device')) return resolve(null);
            const get = db.transaction('device').objectStore('device').get('key');
            get.onsuccess = () => resolve((get.result as { id?: string } | undefined)?.id ?? null);
            get.onerror = () => resolve(null);
          };
        }),
    );
  const shot = async (d: Device, name: string) => {
    await d.page.addStyleTag({ content: FONT_CSS });
    await d.page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    await d.page.screenshot({ path: path.join(OUT, `${name}.png`) });
  };
  const press = async (d: Device, name: string) => {
    if (d.phone) await d.page.getByRole('button', { name: '설정', exact: true }).click();
    await d.page.getByRole('button', { name, exact: true }).first().click();
  };
  const closeModal = async (d: Device) => {
    const x = d.page.getByRole('button', { name: 'x', exact: true });
    for (let n = 0; n < 4 && (await x.count()) > 0; n++) await x.last().click();
  };
  const reloadApp = async (d: Device) => {
    await d.page.goto(`${d.base}/`);
    await d.page.waitForURL(`${d.base}/`);
    await d.page.getByRole('button', { name: d.phone ? '설정' : '기기 추가', exact: true }).waitFor({ timeout: 20_000 });
  };
  const addDevice = async (d: Device): Promise<string> => {
    await press(d, '기기 추가');
    const panel = d.page.getByTestId('add-device');
    const code = d.page.getByTestId('device-code');
    for (const until = Date.now() + 20_000; Date.now() < until; await sleep(200)) {
      if (await code.isVisible()) return ((await code.textContent()) ?? '').replace(/\s/g, '');
      const text = (await panel.textContent().catch(() => '')) ?? '';
      if (text.includes('코드를 만들지 못했어요')) return text;
    }
    return 'timed out';
  };
  const requiredBox = (d: Device) =>
    d.page.getByTestId('security').getByRole('button', { name: /패스키\(생체 인증\) 필수/ });
  /** 보안 → 패스키 필수: the note, and whether it sits on screen within 300 px of the checkbox. */
  const pressRequired = async (d: Device): Promise<{ text: string; near: boolean }> => {
    await press(d, '보안');
    const security = d.page.getByTestId('security');
    await security.waitFor();
    await requiredBox(d).waitFor();
    await requiredBox(d).click();
    const note = security.getByTestId('security-note');
    await note.waitFor({ timeout: 20_000 });
    await sleep(300); // the scroll into view
    const box = await requiredBox(d).boundingBox();
    const at = await note.boundingBox();
    const height = d.page.viewportSize()!.height;
    const near = !!box && !!at && at.y >= 0 && at.y + at.height <= height && Math.abs(at.y - box.y) < 300;
    return { text: (await note.textContent()) ?? '', near };
  };

  try {
    browser = await launchBrowser();
    const firstLink = await boot();
    const ip = `http://127.0.0.1:${port}`;
    const D = await open('desktop-d', ip, DESKTOP);
    const W = await open('desktop-w', ip, DESKTOP);
    const P = await open('phone', ip, PHONE);
    await login(D, firstLink);
    for (const d of [W, P]) await login(d, await daemon!.loginUrl());
    // The owner's state: restored from files.
    await daemon!.stop();
    await boot();
    for (const d of [D, W, P]) await reloadApp(d);
    const pFirst = (await me(P))!.deviceId!;
    check((await me(P))?.passkeyRequired === true, 'owner state: 필수 on, three devices with keys at an IP address, after a restart');

    // ── S0 ──
    const s0 = await pressRequired(P);
    check((await me(P))?.passkeyRequired === false, `S0: P turns 필수 off by its key (${s0.text})`);
    check(s0.near, 'S0: the note is next to the checkbox, on the phone screen');
    await shot(P, 's0-phone-required-off');
    await closeModal(P);
    await requiredOnByFile();
    for (const d of [D, W, P]) await reloadApp(d);

    // ── S1 ──
    const statuses = await P.page.evaluate(async () => {
      const out: number[] = [];
      for (let i = 0; i < 31; i++) out.push((await fetch('/login/device/challenge')).status);
      return out;
    });
    check(
      statuses.slice(0, 30).every((s) => s === 200) && statuses[30] === 429,
      `S1: P's session gets 30 nonces, then pauses (${statuses.filter((s) => s === 200).length} x 200, last ${statuses[30]})`,
    );
    const dCode = await addDevice(D);
    check(/^\d{8}$/.test(dCode), `S1: D, at the same address, still steps up by key (${dCode.slice(0, 60)})`);
    await closeModal(D);
    const s1 = await pressRequired(P);
    check(s1.text.includes('시도가 너무 많아요'), `S1: P's press says too many tries (${s1.text})`);
    check(s1.near, 'S1: next to the checkbox, on screen');
    check((await me(P))?.passkeyRequired === true, 'S1: 필수 is unchanged');
    await shot(P, 's1-phone-rate');
    await closeModal(P);
    await sleep(61_000);
    const pCode = await addDevice(P);
    check(/^\d{8}$/.test(pCode), `S1: a minute later P steps up again (${pCode.slice(0, 60)})`);
    await shot(P, 's1-phone-recovered');
    await closeModal(P);

    // ── S2 ──
    await P.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const del = indexedDB.deleteDatabase('cld-gui');
          del.onsuccess = del.onerror = del.onblocked = () => resolve();
        }),
    );
    // A restart, as the owner's: no step-up from before is left (S1's is a key's, still fresh).
    await requiredOnByFile();
    for (const d of [D, W, P]) await reloadApp(d);
    await sleep(3000); // ensureDeviceKey has had its chance
    check((await storedId(P)) === null, 'S2: a reload with the key gone writes no key (no random id left behind)');
    check((await me(P))?.deviceId === pFirst, 'S2: the cookie still is the same device row');
    // 기기 추가 says the same, with the same way out.
    const pAdd = await addDevice(P);
    check(pAdd.includes('이 브라우저에는 이 기기의 키가 없어요'), `S2: P's 기기 추가 says the key is gone (${pAdd.slice(0, 60)})`);
    check(
      await P.page.getByTestId('add-device').getByTestId('security-relogin').isVisible(),
      'S2: and offers "이 기기 로그아웃하고 코드로 다시 로그인" there too',
    );
    await shot(P, 's2-phone-add-device-lost-key');
    await closeModal(P);
    const s2 = await pressRequired(P);
    check(s2.text.includes('이 브라우저에는 이 기기의 키가 없어요'), `S2: P's press says the key is gone (${s2.text.slice(0, 60)})`);
    check(s2.near, 'S2: next to the checkbox, on screen');
    const relogin = P.page.getByTestId('security-relogin');
    check(await relogin.isVisible(), 'S2: with "이 기기 로그아웃하고 코드로 다시 로그인"');
    check((await me(P))?.passkeyRequired === true, 'S2: 필수 is unchanged');
    await shot(P, 's2-phone-lost-key');
    await relogin.click();
    await P.page.locator('#code').waitFor({ timeout: 20_000 });
    await shot(P, 's2-phone-code-login');
    const code = await addDevice(D);
    check(/^\d{8}$/.test(code), `S2: D makes a 기기 추가 code by its key (${code.slice(0, 60)})`);
    await closeModal(D);
    await P.page.locator('#code').fill(code);
    await P.page.getByRole('button', { name: '로그인', exact: true }).click();
    await P.page.waitForURL(`${P.base}/`);
    await waitDevice(P);
    const pNew = (await me(P))!.deviceId!;
    check(pNew !== pFirst && (await storedId(P)) === pNew, 'S2: P is a new row whose key this browser holds');
    const rows = await D.page.evaluate(async () => {
      const res = await fetch('/api/auth/sessions');
      return ((await res.json()) as { sessions: Array<{ id: string }> }).sessions.map((s) => s.id);
    });
    check(rows.length === 3 && !rows.includes(pFirst), 'S2: three rows, the old one gone');
    const off = await pressRequired(P);
    check((await me(P))?.passkeyRequired === false, `S2: P turns 필수 off by its new key (${off.text})`);
    await shot(P, 's2-phone-recovered');

    const all = logs.join('');
    check(!/[?&]code=[\w-]{8,}/.test(all), 'the daemon log holds no login code');
  } catch (err) {
    failures.push(String(err));
    console.error(err);
    // What each page showed when it failed: outside the artifacts.
    for (const page of browser?.contexts().flatMap((c) => c.pages()) ?? [])
      await page.screenshot({ path: `/tmp/auth-pk2-fail-${browser!.contexts().indexOf(page.context())}.png` }).catch(() => undefined);
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon?.stop().catch(() => undefined);
    killAll();
  }
  if (failures.length) {
    console.error(`${failures.length} failed:\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
}

main().then(
  () => console.log('done'),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
