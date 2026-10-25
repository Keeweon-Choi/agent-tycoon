/**
 * 10-24 check: passkeys per device, and step-ups with "패스키 필수" on.
 * dist/cli.js with an isolated HOME on a spare port, headless Chromium,
 * CDP virtual platform authenticators (Face ID's stand-in). The home starts
 * with an empty v1 passkeys.json, which the daemon migrates to v2 -- the
 * owner's file. Four devices, each with its own device key:
 *   D (Windows desktop) and P (iPhone) at http://127.0.0.1 -- an IP address,
 *   like the owner's direct address, where no passkey can ever be made;
 *   L (desktop) and M (phone) at http://localhost, where passkeys work.
 *
 * 0. The owner's state (필수 on, no passkey anywhere): D and P make 기기 추가
 *    codes by their device keys; D's 보안 says why an IP address has no
 *    passkey; D turns 필수 off by its key, and can't turn it on again there.
 * A. 필수 off. L registers a passkey; M, whose authenticator holds L's
 *    credential too (a synced one: Google Password Manager on both), registers
 *    its own. Each is tied to its device. M's copy of L's is then removed.
 * B. L turns 필수 on with a tap of its own passkey. After a restart (step-ups
 *    are memory only) D, at the IP address, is refused 기기 추가; L's asks for
 *    Face ID and the code comes after the tap; M deletes its passkey through
 *    the same tap; L deletes its own.
 * C. 필수 on and no passkey left: after a restart P's 기기 추가 works by its key
 *    again, and D turns 필수 off by its key.
 *
 * Screenshots go to cld/artifacts/auth-pk/. A hard deadline and signals kill
 * the daemon. The real claude is never run.
 *
 *   npx tsx cld/test/run-auth-pk.ts <port>   (18256-18259)
 */
import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import * as crypto from 'crypto';
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

const port = sparePort(2);
const OUT = path.join(REPO_ROOT, 'cld/artifacts/auth-pk');
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__font/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const DEADLINE_MS = 360_000;
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
  ctx: BrowserContext;
  page: Page;
  phone: boolean;
  base: string;
  /** CDP session and authenticator id, where passkeys work. */
  authenticator?: { cdp: import('@playwright/test').CDPSession; id: string };
}

async function main(): Promise<void> {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({});
  const configDir = path.join(fake.home, '.config/cld-gui');
  // The owner's passkeys.json before S5: v1, no passkey in it.
  fs.writeFileSync(
    path.join(configDir, 'passkeys.json'),
    JSON.stringify({ v: 1, userId: crypto.randomBytes(32).toString('base64url'), byRp: {} }),
    { mode: 0o600 },
  );
  // 패스키 필수 on, set before any device registered: the owner's devices.json.
  fs.writeFileSync(
    path.join(configDir, 'devices.json'),
    JSON.stringify({ v: 1, passkeyRequired: true, devices: [] }),
    { mode: 0o600 },
  );
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
  const font = fs.readFileSync(FONT);

  const open = async (name: string, base: string, opts: BrowserContextOptions, passkeys: boolean) => {
    const ctx = await browser!.newContext({ ...opts, bypassCSP: true });
    await ctx.route('**/__font/malgun.ttf', (route) => route.fulfill({ body: font, contentType: 'font/ttf' }));
    const page = await ctx.newPage();
    page.on('dialog', (dialog) => void dialog.accept());
    const device: Device = { name, ctx, page, phone: !!opts.isMobile, base };
    if (passkeys) {
      const cdp = await ctx.newCDPSession(page);
      await cdp.send('WebAuthn.enable');
      const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      });
      device.authenticator = { cdp, id: authenticatorId };
    }
    return device;
  };
  const me = (d: Device) =>
    d.page.evaluate(async () => {
      const res = await fetch('/api/auth/me');
      return res.ok
        ? ((await res.json()) as { deviceId: string | null; passkeyRequired: boolean; passkeyHere: boolean })
        : null;
    });
  const passkeyList = (d: Device) =>
    d.page.evaluate(async () => {
      const res = await fetch('/api/auth/passkeys');
      return ((await res.json()) as { passkeys: Array<{ id: string; deviceId: string | null }> }).passkeys;
    });
  const login = async (d: Device, link: string) => {
    await d.page.goto(link.replace(/^http:\/\/127\.0\.0\.1:\d+/, d.base));
    await d.page.waitForURL(`${d.base}/`);
    for (const until = Date.now() + 20_000; Date.now() < until; await sleep(300))
      if ((await me(d))?.deviceId) return;
    throw new Error(`${d.name}: no device key registered`);
  };
  const shot = async (d: Device, name: string) => {
    await d.page.addStyleTag({ content: FONT_CSS });
    await d.page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));
    await d.page.screenshot({ path: path.join(OUT, `${name}.png`) });
  };
  /** A top-bar button; on the phone it sits in 설정. */
  const press = async (d: Device, name: string) => {
    if (d.phone) await d.page.getByRole('button', { name: '설정', exact: true }).click();
    await d.page.getByRole('button', { name, exact: true }).first().click();
  };
  /** Every open modal (on the phone 설정 stays under the panel it opened). */
  const closeModal = async (d: Device) => {
    const x = d.page.getByRole('button', { name: 'x', exact: true });
    for (let n = 0; n < 4 && (await x.count()) > 0; n++) await x.last().click();
  };
  const reloadApp = async (d: Device) => {
    await d.page.goto(`${d.base}/`);
    await d.page.waitForURL(`${d.base}/`);
    await d.page.getByRole('button', { name: d.phone ? '설정' : '기기 추가', exact: true }).waitFor({ timeout: 20_000 });
  };
  /** 기기 추가: the 8-digit code, or the error the panel shows. */
  const addDevice = async (d: Device, tap = false): Promise<string> => {
    await press(d, '기기 추가');
    const panel = d.page.getByTestId('add-device');
    const code = d.page.getByTestId('device-code');
    const prompt = d.page.getByTestId('stepup-prompt');
    for (const until = Date.now() + 20_000; Date.now() < until; await sleep(200)) {
      if (await code.isVisible()) return ((await code.textContent()) ?? '').replace(/\s/g, '');
      if (tap && (await prompt.isVisible())) {
        await shot(d, `${d.name}-stepup-prompt`);
        await prompt.getByRole('button', { name: 'Face ID로 확인', exact: true }).click();
        tap = false;
      }
      const text = (await panel.textContent().catch(() => '')) ?? '';
      if (text.includes('코드를 만들지 못했어요')) return text;
    }
    return 'timed out';
  };
  const requiredBox = (d: Device) =>
    d.page.getByTestId('security').getByRole('button', { name: /패스키\(생체 인증\) 필수/ });
  /** In an open 보안 panel: click 패스키 필수, the note it ends with. */
  const toggleRequired = async (d: Device): Promise<string> => {
    const security = d.page.getByTestId('security');
    await security.waitFor();
    await requiredBox(d).click();
    const status = security.getByRole('status');
    await status.waitFor({ timeout: 20_000 });
    return (await status.textContent()) ?? '';
  };
  /** 보안 → 패스키 등록: the note the panel shows after it. */
  const registerPasskey = async (d: Device): Promise<string> => {
    await press(d, '보안');
    const security = d.page.getByTestId('security');
    await security.waitFor();
    await security.getByRole('button', { name: '패스키 등록', exact: true }).click();
    const status = security.getByRole('status');
    await status.waitFor({ timeout: 20_000 });
    return (await status.textContent()) ?? '';
  };
  /** 보안 → its own passkey's 삭제; `tap`: answer a Face ID step-up. */
  const deletePasskey = async (d: Device, tap = false): Promise<string> => {
    const deviceId = (await me(d))!.deviceId!;
    const own = (await passkeyList(d)).find((k) => k.deviceId === deviceId);
    if (!own) return 'no passkey of its own';
    await press(d, '보안');
    const security = d.page.getByTestId('security');
    await security.getByTestId('passkey-row').first().waitFor();
    const rows = security.getByTestId('passkey-row');
    const name = (await d.page.evaluate(async (id) => {
      const res = await fetch('/api/auth/sessions');
      return ((await res.json()) as { sessions: Array<{ id: string; label: string }> }).sessions.find((s) => s.id === id)?.label;
    }, deviceId))!;
    await rows.filter({ hasText: name }).getByRole('button', { name: '삭제', exact: true }).click();
    if (tap) {
      const prompt = d.page.getByTestId('stepup-prompt');
      await prompt.waitFor({ timeout: 15_000 });
      await prompt.getByRole('button', { name: 'Face ID로 확인', exact: true }).click();
    }
    const status = security.getByRole('status');
    await status.waitFor({ timeout: 20_000 });
    return (await status.textContent()) ?? '';
  };

  try {
    browser = await launchBrowser();
    const firstLink = await boot();
    check(
      logs[0].includes('passkeys.json migrated to v2'),
      'the empty v1 passkeys.json is migrated to v2 (the owner’s file)',
    );
    const ip = `http://127.0.0.1:${port}`;
    const local = `http://localhost:${port}`;
    const D = await open('desktop-ip', ip, DESKTOP, false);
    const P = await open('phone-ip', ip, PHONE, false);
    const L = await open('desktop-local', local, DESKTOP, true);
    const M = await open('phone-local', local, PHONE, true);
    await login(D, firstLink);
    for (const d of [P, L, M]) await login(d, await daemon!.loginUrl());
    check(true, 'four devices logged in, each with its own device key');

    // ── 0. The owner's state: device keys, 필수 on, no passkey anywhere ──
    check((await me(D))?.passkeyRequired === true, '0: 패스키 필수 is on (seeded), with no passkey');
    for (const d of [D, P]) {
      const result = await addDevice(d);
      await shot(d, `0-${d.name}-add-device`);
      check(/^\d{8}$/.test(result), `0: ${d.name} 기기 추가 makes a code by its device key (${result.slice(0, 80)})`);
      await closeModal(d);
    }
    await press(D, '보안');
    const dSecurity = D.page.getByTestId('security');
    await dSecurity.waitFor();
    check(
      await dSecurity.getByRole('button', { name: '패스키 등록', exact: true }).isDisabled(),
      '0: at the IP address D cannot register a passkey',
    );
    check(
      ((await dSecurity.textContent()) ?? '').includes('IP 주소에는 패스키를 만들 수 없어서'),
      '0: and 보안 says why (an IP address can’t have one)',
    );
    await shot(D, '0-desktop-ip-security');
    const dOff = await toggleRequired(D);
    check((await me(D))?.passkeyRequired === false, `0: D turns 필수 off by its device key (${dOff})`);
    check(await requiredBox(D).isDisabled(), '0: and can’t turn it on again (no passkey of its own here)');
    check(await dSecurity.getByTestId('passkey-required-warning').isVisible(), '0: the warning line says why');
    await shot(D, '0-desktop-ip-required-off');
    await closeModal(D);

    // ── A. 필수 off: one passkey per device, a synced authenticator included ──
    const lNote = await registerPasskey(L);
    check(lNote.includes('패스키를 등록했어요'), `A: L registers a passkey (${lNote})`);
    await closeModal(L);
    // M's authenticator holds L's credential too: a synced passkey.
    const { credentials } = await L.authenticator!.cdp.send('WebAuthn.getCredentials', {
      authenticatorId: L.authenticator!.id,
    });
    for (const credential of credentials)
      await M.authenticator!.cdp.send('WebAuthn.addCredential', {
        authenticatorId: M.authenticator!.id,
        credential,
      });
    const mNote = await registerPasskey(M);
    check(mNote.includes('패스키를 등록했어요'), `A: M (synced authenticator) registers its own passkey (${mNote})`);
    await shot(M, 'a-phone-passkeys');
    await closeModal(M);
    const lId = (await me(L))!.deviceId;
    const mId = (await me(M))!.deviceId;
    const owners = (await passkeyList(L)).map((k) => k.deviceId).sort();
    check(
      JSON.stringify(owners) === JSON.stringify([lId, mId].sort()),
      'A: two passkeys, each tied to the device that made it',
    );
    // From here M is a phone with only its own passkey.
    for (const credential of credentials)
      await M.authenticator!.cdp.send('WebAuthn.removeCredential', {
        authenticatorId: M.authenticator!.id,
        credentialId: credential.credentialId,
      });

    // ── B. L turns 필수 on with a Face ID tap; then every step-up is a tap ──
    await press(L, '보안');
    const lOn = await toggleRequired(L);
    check((await me(L))?.passkeyRequired === true, `B: L turns 필수 on after a tap of its own passkey (${lOn})`);
    await shot(L, 'b-desktop-local-required-on');
    await closeModal(L);
    // A restart drops every step-up (memory only).
    await daemon!.stop();
    await boot();
    for (const d of [D, P, L, M]) await reloadApp(d);
    const dRefused = await addDevice(D);
    check(
      dRefused.includes('패스키 필수가 켜져 있어 이 주소에서는 할 수 없어요'),
      `B: D (no passkey at the IP address) is refused 기기 추가 while 필수 is on (${dRefused.slice(0, 60)})`,
    );
    await shot(D, 'b-desktop-ip-add-device-refused');
    await closeModal(D);
    const lCode = await addDevice(L, true);
    check(/^\d{8}$/.test(lCode), `B: L 기기 추가 asks for Face ID, then makes a code (${lCode.slice(0, 80)})`);
    await shot(L, 'b-desktop-local-add-device');
    await closeModal(L);
    const mDel = await deletePasskey(M, true);
    check(mDel.includes('패스키를 지웠어요'), `B: M deletes its passkey after a Face ID tap (${mDel})`);
    await shot(M, 'b-phone-local-deleted');
    await closeModal(M);
    const lDel = await deletePasskey(L);
    check(lDel.includes('패스키를 지웠어요'), `B: L deletes its passkey (the Face ID proof is fresh) (${lDel})`);
    await closeModal(L);

    // ── C. 필수 on and no passkey left: the device keys work again ──
    await daemon!.stop();
    await boot();
    for (const d of [D, P, L, M]) await reloadApp(d);
    const pCode = await addDevice(P);
    check(/^\d{8}$/.test(pCode), `C: P 기기 추가 makes a code by its device key again (${pCode.slice(0, 80)})`);
    await shot(P, 'c-phone-ip-add-device');
    await closeModal(P);
    await press(D, '보안');
    const cOff = await toggleRequired(D);
    check((await me(D))?.passkeyRequired === false, `C: D turns 필수 off by its device key (${cOff})`);
    await shot(D, 'c-desktop-ip-required-off');

    const audit = fs.readFileSync(path.join(configDir, 'audit.jsonl'), 'utf-8');
    check(audit.includes('"stepUpPassed"') && audit.includes('"passkey"'), 'audit.jsonl records the step-ups (key and passkey)');
    const all = logs.join('');
    check(!/[?&]code=[\w-]{8,}/.test(all), 'the daemon log holds no login code');
  } catch (err) {
    failures.push(String(err));
    console.error(err);
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
