/**
 * T-0052 + T-0069 + T-0078 check: the terminal workspace, only on trusted devices. dist/cli.js with
 * --allow-terminal in an isolated HOME (SHELL=/bin/sh, so the login shell
 * reads only that temp HOME's profile; every shell starts in a temp folder),
 * headless Chromium with --disable-gpu and office hours off.
 *
 * 0. A second daemon without --allow-terminal: /api/shell is 404 (the step-up route is not: S1
 *    made it the step-up for every dangerous action, so it answers 401 without a login).
 * 1. Phone B logs in with a code (its device key registers by itself).
 * 2. Desktop C logs in with IndexedDB refusing: no device key, a code-only
 *    session. Its 터미널 tab says it can't open one; POST /api/shell is 403.
 * 3. Desktop A logs in. Before any step-up POST /api/shell is 403 "proof".
 *    새 터미널: folder picker, the automatic device-key step-up, a shell in
 *    work/; `pwd` prints it. B gets "<A>에서 터미널을 열었어요"; A does not.
 * 4. A opens a second shell. B's device list shows both under A, closes one
 *    with 닫기 (A's tab follows), then logs A out: A's last shell is killed
 *    and A's page goes to the login page.
 * 5. B opens its own shell; with the software keyboard up (a shorter
 *    viewport while xterm has focus) the MobileKeyBar shows, above it the
 *    terminal's input line (U-33: no Korean compose row); `pwd`; 닫기.
 * 6. The daemon log has open/close audit lines and none of the typed text or
 *    the output. No securitypolicyviolation on any page.
 *
 * 7. (T-0078) The workspace on a desktop: two shells side by side
 *    (split right), each with its own pid; x on a tab only detaches (both
 *    shells stay in the daemon) and 닫은 터미널 reopens it with the SAME pid.
 * 8. (T-0069) The daemon restarts (a deploy): both panes say "서버가 다시
 *    시작돼 다시 연결하는 중…" and come back with the same pids; the screen
 *    never shows "exited with code". shells.json is 0600.
 * 9. (T-0078) Korean through the browser's IME (CDP imeSetComposition then
 *    insertText) reaches the shell as composed syllables.
 *    Fast typing reaches it whole: ASCII at no delay, and Korean whose Enter
 *    goes down before the IME's commit (10-22: the guard held that key).
 *    A pane draws with WebGL when the browser has it and falls back to the
 *    DOM renderer on a lost context.
 * 10. Negative controls: with persistence off (CLD_GUI_SHELL_PERSIST=off)
 *    a restart loses the shell and a new one has another pid; with the old
 *    input path (?imeLegacy=1) the same Korean arrives as jamo.
 *
 * Screenshots go to cld/artifacts/t0078/. The daemons are stopped with
 * SIGTERM and only processes whose cwd is inside this run's temp HOME are
 * killed after that. Shells run in a tmux server on a test-only socket
 * (CLD_GUI_SHELL_TMUX_SOCKET=cld-test-<random>), killed at the end: the
 * host's cld-gui-shell server is never touched.
 *
 *   npx tsx cld/test/run-terminal.ts <port> <port>   (two of 18256-18259; 18258 18259)
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import type { ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { findTmux, Tmux } from '../../server/src/cld/shell/tmux.js';
import {
  assertPortFree,
  daemonLoginUrl,
  type FakeHome,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon as launchDaemon,
  waitForDaemon,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort(2);
const offPort = sparePort(3);
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0078');
const CHROME =
  process.env.T0052_CHROME ??
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const DEADLINE_MS = 540_000;
const MARKER = 'T0052-TYPED-MARKER';
const TMUX_SOCKET = `cld-test-${randomBytes(6).toString('hex')}`;
const tmuxBin = findTmux();
const testTmux = tmuxBin ? new Tmux(tmuxBin, TMUX_SOCKET) : null;
const HANGUL = 'unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3;';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0078/malgun.ttf'); ${HANGUL} }
@font-face { font-family: 'Menlo'; src: url('/__t0078/malgun.ttf'); ${HANGUL} }`;
const FONT_BYTES = fs.readFileSync('/mnt/c/Windows/Fonts/malgun.ttf');
const IPHONE13 = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();
const WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until<T>(probe: () => Promise<T>, what: string, ms = 15_000): Promise<T> {
  for (const end = Date.now() + ms; ; await sleep(200)) {
    const v = await probe();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}
interface Daemon {
  process: ChildProcess;
  log: string[];
  home: string;
}

/** The daemon of this check (shared harness: isolated HOME, our own pid), with a shell that is sh. */
async function startDaemon(
  p: number,
  fake: FakeHome,
  extra: string[],
  env: Record<string, string> = {},
): Promise<Daemon> {
  const d = launchDaemon(fake, p, ['--engine', 'off', '--no-terminal', ...extra], {
    SHELL: '/bin/sh',
    // Shells run in a tmux server of this run's own (never the host's cld-gui-shell).
    CLD_GUI_SHELL_TMUX_SOCKET: TMUX_SOCKET,
    ...env,
  });
  await waitForDaemon(p, d.child.pid!, 30_000, fake.home);
  return { process: d.child, log: d.log, home: fake.home };
}

async function stopDaemon(d: Daemon): Promise<void> {
  const child = d.process;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const killer = setTimeout(() => child.kill('SIGKILL'), 5_000);
  await exited;
  clearTimeout(killer);
}

/** Processes still running in this run's temp HOME: only shells this check made. */
function leftovers(home: string): number[] {
  const pids: number[] = [];
  // Only under a real temp HOME, never init or the kernel (these pids get SIGKILL).
  if (!home.startsWith(os.tmpdir() + path.sep)) return pids;
  for (const entry of fs.readdirSync('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) continue;
    try {
      if (fs.readlinkSync(`/proc/${pid}/cwd`).startsWith(home + path.sep)) pids.push(pid);
    } catch {
      // gone, or not ours to read
    }
  }
  return pids;
}

async function main() {
  if (port === offPort) throw new Error('ports: two different ones of 18256-18259');
  if (!testTmux) throw new Error('this check needs tmux (shells run in it)');
  await assertPortFree(port, offPort);
  fs.mkdirSync(OUT, { recursive: true });
  // The fake claude on PATH: the daemon never runs the real one.
  const fake = makeFakeHome({ claude: 'S-8' });
  const offFake = makeFakeHome({ claude: 'S-8' });
  const work = path.join(fake.home, 'work');
  fs.mkdirSync(work);
  const daemons: Daemon[] = [];
  const cleanup = () => {
    for (const d of daemons)
      if (d.process.exitCode === null && d.process.signalCode === null) d.process.kill('SIGKILL');
    testTmux?.killServer();
    for (const pid of leftovers(fake.home)) process.kill(pid, 'SIGKILL');
    fs.rmSync(fake.home, { recursive: true, force: true });
    fs.rmSync(offFake.home, { recursive: true, force: true });
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    cleanup();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  let browser: Browser | undefined;
  const local = `http://localhost:${port}`;
  const login = async () =>
    (await daemonLoginUrl(fake.home, port, daemons.at(-1)!.process.pid!)).replace(
      'http://127.0.0.1:',
      'http://localhost:',
    );
  try {
    // ── 0. The flag off ──
    const off = await startDaemon(offPort, offFake, []);
    daemons.push(off);
    for (const [method, url] of [
      ['GET', '/api/shell'],
      ['POST', '/api/shell'],
      ['DELETE', '/api/shell/x'],
      ['GET', '/cld/shell/x'],
    ])
      check(
        (await fetch(`http://127.0.0.1:${offPort}${url}`, { method })).status === 404,
        `flag off: ${method} ${url} is 404`,
      );
    // S1: the step-up route serves every dangerous action (invites, passkeys, exposure...), so it
    // exists with the terminal off; it asks for a login like any other session route.
    check(
      (await fetch(`http://127.0.0.1:${offPort}/api/auth/stepup/device`, { method: 'POST' }))
        .status === 401,
      'flag off: POST /api/auth/stepup/device asks for a login (it is not a terminal route)',
    );
    await stopDaemon(off);
    const on = await startDaemon(port, fake, ['--allow-terminal']);
    daemons.push(on);
    check(
      (await fetch(`http://127.0.0.1:${port}/api/shell`)).status === 401,
      'flag on: /api/shell asks for a login',
    );

    browser = await launchBrowser({ executablePath: CHROME });
    const violations: string[] = [];
    const open = async (opts: BrowserContextOptions, view: string, noKey = false) => {
      const ctx = await browser!.newContext(opts);
      // T-0041: office hours off, so nobody goes home when this runs at night.
      await ctx.addInitScript(() => localStorage.setItem('cld.office-hours', '{"on":false}'));
      await ctx.addInitScript(() =>
        document.addEventListener('securitypolicyviolation', (e) =>
          console.error(`CSPV ${e.violatedDirective} ${e.blockedURI}`),
        ),
      );
      if (noKey)
        // A browser that can't keep a key (a private window): IndexedDB refuses.
        await ctx.addInitScript(() => {
          IDBFactory.prototype.open = () => {
            throw new DOMException('blocked for the check', 'SecurityError');
          };
        });
      // Hangul from Malgun Gothic in the UI and in xterm (the screenshots; this PC's Chromium has none).
      await ctx.route('**/__t0078/malgun.ttf', (route) =>
        route.fulfill({ body: FONT_BYTES, contentType: 'font/ttf' }),
      );
      // A stylesheet from the page's own origin (an inline one would break its CSP).
      await ctx.route('**/__t0078/font.css', (route) =>
        route.fulfill({ body: FONT_CSS, contentType: 'text/css' }),
      );
      const page = await ctx.newPage();
      page.on(
        'domcontentloaded',
        () => void page.addStyleTag({ url: '/__t0078/font.css' }).catch(() => undefined),
      );
      page.on('console', (m) => {
        if (m.text().startsWith('CSPV') || /Content Security Policy/i.test(m.text()))
          violations.push(`${view}: ${m.text().slice(0, 200)}`);
      });
      return { ctx, page };
    };
    const me = (page: Page) =>
      page.evaluate(async () => {
        const r = await fetch('/api/auth/me');
        return r.ok
          ? ((await r.json()) as { id: string; label: string; deviceId: string | null })
          : null;
      });
    const postShell = (page: Page, cwd: string) =>
      page.evaluate(async (folder) => {
        const r = await fetch('/api/shell', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd: folder }),
        });
        return { status: r.status, body: (await r.json()) as { error?: string } };
      }, cwd);
    const shells = (page: Page) =>
      page.evaluate(
        async () =>
          (
            (await (await fetch('/api/shell')).json()) as {
              shells: Array<{ id: string; deviceId: string; cwd: string }>;
            }
          ).shells,
      );
    const shot = (page: Page, name: string) =>
      page.screenshot({ path: path.join(OUT, `${name}.png`) });
    const desktopTab = async (page: Page) => {
      // T-0077: the 터미널 icon opens the terminal's own window (it left the 현황판 tabs).
      const terminalIcon = page
        .locator('[data-hud-id^="icon:"]')
        .getByRole('button', { name: /^터미널/ });
      await terminalIcon.waitFor();
      if (!(await page.locator('[data-hud-window="terminal"]').isVisible()))
        await terminalIcon.click();
    };
    /** + then 새 터미널, the folder picker, the work folder. */
    const pickWork = async (page: Page) => {
      await page.getByRole('button', { name: '터미널 추가' }).click();
      await page.getByRole('menuitem', { name: '새 터미널' }).click();
      const picker = page
        .getByRole('dialog')
        .filter({ hasText: '폴더 고르기' })
        .or(page.locator('[aria-label="폴더 고르기"]'))
        .first();
      await picker.waitFor();
      await page.locator('ul[aria-label="하위 폴더"] button', { hasText: /^▸ work$/ }).click();
      await page.getByRole('button', { name: '이 폴더 선택' }).click();
    };
    /** The pane showing shell `id`, or the first one on screen. */
    const paneOf = (page: Page, id?: string) =>
      id
        ? page.locator(`[data-testid="terminal-pane"][data-tab="shell:${id}"]`)
        : page.locator('[data-testid="terminal-pane"]:not(.hidden)').first();
    const screenText = (page: Page, id?: string) =>
      paneOf(page, id).locator('.xterm-rows').innerText();
    /** Every terminal of the page, shown or not. */
    const everything = async (page: Page) =>
      (await page.locator('[data-testid="terminal-pane"] .xterm-rows').allInnerTexts()).join('\n');
    const typeIn = async (page: Page, text: string, id?: string) => {
      await paneOf(page, id).locator('.xterm-helper-textarea').focus();
      await page.keyboard.type(text);
      await page.keyboard.press('Enter');
    };
    const waitLoggedInWithKey = (page: Page, what: string) =>
      until(async () => (await me(page))?.deviceId, `${what} has a device key`);
    const pidFile = (name: string) => path.join(fake.home, `pid-${name}`);
    const readPid = (name: string) => {
      try {
        return fs.readFileSync(pidFile(name), 'utf8').trim();
      } catch {
        return '';
      }
    };
    /** `echo $$ > file` in a shell until the file shows up (typing is dropped while its socket is down). */
    const pidIn = async (page: Page, id: string | undefined, name: string) => {
      for (const end = Date.now() + 60_000; Date.now() < end; await sleep(1_500)) {
        if (/^\d+$/.test(readPid(name))) return readPid(name);
        await typeIn(page, `echo $$ > ${pidFile(name)}`, id).catch(() => undefined);
      }
      throw new Error(`no pid from ${name}`);
    };
    /**
     * Korean the way a browser's IME delivers it: each syllable is composed
     * jamo by jamo (imeSetComposition) and committed (insertText). `cat` writes
     * what the shell received to a file.
     */
    /**
     * Chromium reports an IME composition honestly, and xterm handles that.
     * WebKit (an iPhone) is the browser where the jamo came through, and is
     * not available here: this makes Chromium label a composition's `input`
     * events the way the suspected WebKit path does (inputType insertText,
     * not composed) so xterm's own send path is exercised.
     */
    const emulateWebKitLabels = (page: Page) =>
      page.evaluate(() => {
        window.addEventListener(
          'input',
          (e) => {
            if ((e as InputEvent).isComposing) {
              Object.defineProperty(e, 'inputType', { value: 'insertText' });
              Object.defineProperty(e, 'composed', { value: false });
            }
          },
          true,
        );
      });
    const koreanFile = (name: string) => path.join(fake.home, `kor-${name}.txt`);
    /**
     * Korean typed fast (30 ms a jamo), the last syllable still composing when
     * Enter goes down: the browser has not committed it yet, so Chrome sends
     * that keydown with isComposing set (Windows Chrome, the IME a step behind).
     * xterm finishes the composition on it; the guard must let it through.
     */
    const typeKoreanFast = async (page: Page, id: string | undefined) => {
      const file = koreanFile('fast');
      await typeIn(page, `cat > ${file}`, id);
      await sleep(500);
      await paneOf(page, id).locator('.xterm-helper-textarea').focus();
      const cdp = await page.context().newCDPSession(page);
      const set = async (text: string) => {
        await cdp.send('Input.imeSetComposition', {
          text,
          selectionStart: text.length,
          selectionEnd: text.length,
        });
        await sleep(30);
      };
      const commit = async (steps: string[]) => {
        for (const step of steps) await set(step);
        await cdp.send('Input.insertText', { text: steps.at(-1)! });
        await sleep(30);
      };
      await commit(['ㅇ', '아', '안']);
      await commit(['ㄴ', '녀', '녕']);
      await page.keyboard.type(' ');
      await commit(['ㅎ', '하']);
      await commit(['ㅅ', '세']);
      await set('ㅇ');
      await set('요');
      await page.keyboard.press('Enter');
      await set(''); // the IME lets go of the composition
      await page.keyboard.press('Control+d');
      await cdp.detach();
      return until(async () => {
        try {
          return fs.readFileSync(file, 'utf8') || false;
        } catch {
          return false;
        }
      }, 'the fast Korean line');
    };

    const typeKorean = async (page: Page, id: string | undefined, name: string) => {
      const file = koreanFile(name);
      await typeIn(page, `cat > ${file}`, id);
      await sleep(500);
      await paneOf(page, id).locator('.xterm-helper-textarea').focus();
      const cdp = await page.context().newCDPSession(page);
      const compose = async (steps: string[]) => {
        for (const step of steps)
          await cdp.send('Input.imeSetComposition', {
            text: step,
            selectionStart: step.length,
            selectionEnd: step.length,
          });
        await cdp.send('Input.insertText', { text: steps.at(-1)! });
        await sleep(150);
      };
      await compose(['ㅇ', '아']);
      await compose(['ㄴ', '니']);
      await page.keyboard.type(' ');
      await compose(['ㄸ', '또']);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Control+d');
      await cdp.detach();
      return until(async () => {
        try {
          return fs.readFileSync(file, 'utf8') || false;
        } catch {
          return false;
        }
      }, `${name}: the shell got the Korean`);
    };

    // ── 1. Phone B ──
    const { page: b } = await open(IPHONE13, 'phone');
    await b.goto(await login());
    await b.waitForURL(`${local}/`);
    await waitLoggedInWithKey(b, 'phone B');
    // T-0077: the phone's tab bar is floating icons now.
    const bar = b.locator('[data-hud-id^="icon:"]');
    await bar.first().waitFor();
    const ptabs = await bar
      .locator('button')
      .evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
    check(ptabs.includes('터미널'), `phone icons include 터미널 (${ptabs.join(' | ')})`);

    // ── 2. Code-only C ──
    const { page: c, ctx: cctx } = await open(
      { viewport: { width: 1280, height: 800 }, userAgent: WINDOWS_UA },
      'code-only',
      true,
    );
    await c.goto(await login());
    await c.waitForURL(`${local}/`);
    await sleep(2_000); // ensureDeviceKey has had its chance
    check(
      (await me(c))?.deviceId === null,
      'C (no IndexedDB) has no device key: a code-only session',
    );
    await desktopTab(c);
    await c.getByText('이 기기에서는 터미널을 열 수 없어요').waitFor();
    check((await c.getByRole('button', { name: '새 터미널' }).count()) === 0, 'C has no 새 터미널');
    const cPost = await postShell(c, work);
    check(
      cPost.status === 403 && cPost.body.error === 'device',
      `C: POST /api/shell refused (${cPost.status} ${cPost.body.error})`,
    );
    const cStep = await c.evaluate(
      async () =>
        (
          await fetch('/api/auth/stepup/device', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
    );
    check(cStep === 403, `C: a step-up without a key is refused (${cStep})`);
    await shot(c, 'desktop-code-only-refused');
    await cctx.close();

    // ── 3. Desktop A ──
    const { page: a } = await open(
      { viewport: { width: 1440, height: 900 }, userAgent: WINDOWS_UA },
      'desktop',
    );
    await a.goto(await login());
    await a.waitForURL(`${local}/`);
    await waitLoggedInWithKey(a, 'desktop A');
    const aMe = (await me(a))!;
    const noProof = await postShell(a, work);
    check(
      noProof.status === 403 && noProof.body.error === 'proof',
      `A without a step-up: refused (${noProof.status} ${noProof.body.error})`,
    );
    await desktopTab(a);
    await pickWork(a);
    await a.locator('[data-testid="shell-tab"]').first().waitFor();
    await a.locator('[data-testid="shell-panel"] .xterm-rows').first().waitFor();
    await typeIn(a, `pwd; echo ${MARKER}`);
    const realWork = fs.realpathSync(work);
    await until(
      async () => (await screenText(a)).includes(realWork),
      'A: pwd prints the work folder',
    );
    check((await screenText(a)).includes(MARKER), 'A: the shell runs what was typed');
    check(true, `A: a login shell in ${realWork} after the automatic step-up`);
    check(
      (await a.getByRole('button', { name: '한글 입력줄' }).count()) === 0 &&
        (await a.getByRole('textbox', { name: '한글 입력' }).count()) === 0,
      'desktop: no Korean compose row or 가 key',
    );
    await shot(a, 'desktop-shell-pwd');
    const toast = b.getByTestId('auth-toast');
    await until(
      async () =>
        (await toast.innerText().catch(() => '')).includes(`${aMe.label}에서 터미널을 열었어요`),
      'B gets the open notice',
    );
    check(true, `B: "${aMe.label}에서 터미널을 열었어요"`);
    await shot(b, 'phone-notice-open');
    check(
      !(
        await a
          .getByTestId('auth-toast')
          .innerText()
          .catch(() => '')
      ).includes('터미널을'),
      'A gets no notice about itself',
    );

    // ── 4. A's second shell; B closes one, then logs A out ──
    await pickWork(a);
    await until(
      async () => (await a.locator('[data-testid="shell-tab"]').count()) === 2,
      'A has two shells',
    );
    await b.getByTestId('auth-toast').getByRole('button', { name: '기기 목록' }).click();
    const security = b.getByTestId('security');
    await security.waitFor();
    // C has the same label (same browser): A's row is the one with shells.
    const aRow = security
      .getByTestId('session-row')
      .filter({ hasText: aMe.label, has: b.getByTestId('session-shell') });
    await until(
      async () => (await aRow.getByTestId('session-shell').count()) === 2,
      "B's device list shows A's two shells",
    );
    await aRow.scrollIntoViewIfNeeded();
    await shot(b, 'phone-device-list-shells');
    await aRow.getByTestId('session-shell').first().getByRole('button', { name: '닫기' }).click();
    await until(
      async () => (await aRow.getByTestId('session-shell').count()) === 1,
      "B closed one of A's shells",
    );
    // The tab stays (x is the only thing that closes one) and says what happened to its shell.
    // A pane that is not on screen draws nothing (xterm pauses), so each tab is brought forward.
    let gone = false;
    for (const tabIndex of [0, 1]) {
      await a.locator('[data-testid="shell-tab"]').nth(tabIndex).getByRole('tab').click();
      await a.waitForTimeout(400);
      if ((await everything(a)).includes('터미널이 닫혔어요. 다시 열어 주세요.')) gone = true;
    }
    check(gone, 'A: the pane of the shell B closed says it is closed');
    check(
      (await a.locator('[data-testid="shell-tab"]').count()) === 2 &&
        !(await everything(a)).includes('exited with code'),
      "A: the closed shell's tab stays with a Korean line, never an exit code",
    );
    await aRow.getByRole('button', { name: '로그아웃' }).click();
    await until(
      async () => (await shells(b)).every((s) => s.deviceId !== aMe.id),
      "A's shells are gone after the logout",
    );
    check(true, "logging A out killed A's last shell");
    await a.locator('#code').waitFor({ timeout: 15_000 });
    check(true, "A's page is on the login page");
    await b.getByRole('button', { name: 'x', exact: true }).last().click();

    // The logout's notice toast stays until tapped: out of the picture.
    if (await b.getByTestId('auth-toast').isVisible())
      await b.getByTestId('auth-toast').click({ position: { x: 4, y: 4 } });
    // ── 5. B's own shell with the key bar ──
    await bar.getByRole('button', { name: '터미널', exact: true }).click();
    await pickWork(b);
    await b.locator('[data-testid="shell-panel"] .xterm-rows').first().waitFor();
    const vp = b.viewportSize()!;
    await paneOf(b).locator('.xterm-helper-textarea').focus();
    await b.setViewportSize({ width: vp.width, height: vp.height - 300 }); // the keyboard comes up
    const keys = b.getByRole('button', { name: 'Esc 키' });
    await keys.first().waitFor();
    check(true, 'phone: the MobileKeyBar shows over the keyboard');
    // The phone's own keyboard sends `c` through xterm's onData path, while
    // pgup comes from the accessory bar. Record both raw sequences to pin the
    // one-shot modifier store and the new navigation key against the real PTY.
    const modifierFile = path.join(fake.home, 'phone-key-modifiers.bin');
    const modifierBytes = '\x03\x1b[5~';
    await typeIn(
      b,
      `stty raw -echo; dd bs=1 count=${Buffer.byteLength(modifierBytes)} of=${modifierFile}; stty sane`,
    );
    await b.getByRole('button', { name: '컨트롤 키' }).tap();
    await paneOf(b).locator('.xterm-helper-textarea').focus();
    await b.keyboard.type('c');
    await b.getByRole('button', { name: '페이지 위 키' }).tap();
    await until(() => {
      try {
        return fs.readFileSync(modifierFile).equals(Buffer.from(modifierBytes));
      } catch {
        return false;
      }
    }, 'phone: Ctrl+C from the native keyboard and pgup from the bar reach the PTY');
    check(
      fs.readFileSync(modifierFile).equals(Buffer.from(modifierBytes)),
      `phone: Ctrl+C and pgup record ${JSON.stringify(modifierBytes)}`,
    );
    // U-33: Korean goes straight into the terminal; no 가 key or compose row. The two-row key
    // bar is inside the visible viewport and the terminal's input line stays above it.
    check(
      (await b.getByRole('button', { name: '한글 입력줄' }).count()) === 0,
      'phone: no 가 key (Korean is typed into the terminal)',
    );
    const rects = (await b.evaluate(`(() => {
      const esc = document.querySelector('button[aria-label="Esc 키"]');
      // U-33: the keys sit in a grid inside the bar's border-t-2 box (one parent up no longer reaches it).
      const keyBar = esc.closest('div.border-t-2');
      const cursor = document.querySelector('[data-testid="terminal-pane"]:not(.hidden) .xterm-rows .xterm-cursor');
      return {
        vv: window.visualViewport.height,
        keyBar: keyBar.getBoundingClientRect().toJSON(),
        cursor: cursor ? cursor.getBoundingClientRect().toJSON() : null,
      };
    })()`)) as {
      vv: number;
      keyBar: { top: number; bottom: number };
      cursor: { bottom: number } | null;
    };
    check(
      rects.keyBar.bottom <= rects.vv + 1,
      'phone: key bar is inside the visible viewport (above the keyboard)',
    );
    check(
      rects.cursor !== null && rects.cursor.bottom <= rects.keyBar.top + 1,
      "phone: the terminal's input line is above the key bar",
    );
    await typeIn(b, 'pwd');
    await until(
      async () => (await screenText(b)).includes(realWork),
      'B: pwd prints the work folder',
    );
    check(true, 'phone: pwd in the shell');
    // T-0077: no tab bar any more; the floating icons are under the terminal page, out of the key bar's way.
    check(
      await bar.evaluateAll((els) =>
        els.every((el) => {
          const r = el.getBoundingClientRect();
          const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return !top || !el.contains(top);
        }),
      ),
      'phone: the icons are out of the way of the key bar',
    );
    await shot(b, 'phone-shell-keybar');
    await b.setViewportSize(vp);
    const phoneKorean = await typeKorean(b, undefined, 'phone');
    check(
      phoneKorean === '아니 또\n',
      `phone: Korean arrives as syllables (${JSON.stringify(phoneKorean)})`,
    );
    await shot(b, 'phone-workspace');
    // x only detaches: the shell is still there, listed to reopen or to end.
    await b
      .locator('[data-testid="shell-tab"]')
      .getByRole('button', { name: /터미널 닫기/ })
      .click();
    await b.waitForTimeout(500);
    check((await shells(b)).length === 1, 'phone: x detached the tab, the shell kept running');
    await b.getByRole('button', { name: '터미널 추가' }).click();
    await b.getByTestId('closed-shell').waitFor();
    await b.getByRole('button', { name: /터미널 끝내기/ }).click();
    await until(async () => (await shells(b)).length === 0, "B's 끝내기 ended its shell");
    check(true, 'phone: 끝내기 in 닫은 터미널 ended the shell');
    await shot(b, 'phone-shell-closed');

    // ── 6. Audit ──
    await stopDaemon(on);
    const log = on.log.join('');
    const opens = log.match(/\[cld shell\] open /g)?.length ?? 0;
    const closes = log.match(/\[cld shell\] close /g)?.length ?? 0;
    check(opens === 3 && closes === 3, `audit: 3 open and 3 close lines (${opens}/${closes})`);
    check(
      log.includes('reason=revoked') && log.includes('reason=requested by='),
      'audit: the logout and the 끝내기 are named',
    );
    check(
      !log.includes(MARKER) && !log.includes('pwd'),
      'audit: no typed text or output in the daemon log',
    );
    fs.writeFileSync(
      path.join(OUT, 'daemon-audit.txt'),
      log
        .split('\n')
        .filter((l) => l.includes('[cld shell]'))
        .join('\n') + '\n',
    );
    check(leftovers(fake.home).length === 0, 'no shell left running in the temp HOME');

    // ── 7. The workspace: two shells side by side; x only detaches ──
    const w1 = await startDaemon(port, fake, ['--allow-terminal']);
    daemons.push(w1);
    const { page: d } = await open(
      { viewport: { width: 1440, height: 900 }, userAgent: WINDOWS_UA },
      'workspace',
    );
    await d.goto(await login());
    await d.waitForURL(`${local}/`);
    await waitLoggedInWithKey(d, 'workspace desktop');
    await desktopTab(d);
    await pickWork(d);
    await d.locator('[data-testid="shell-tab"]').first().waitFor();
    await d.getByRole('button', { name: '오른쪽으로 나누기' }).click();
    await pickWork(d);
    await until(
      async () => (await d.locator('[data-testid="shell-tab"]').count()) === 2,
      'D has two shell tabs',
    );
    const [id1, id2] = (await shells(d)).map((x) => x.id);
    await paneOf(d, id1).locator('.xterm-rows').waitFor();
    await paneOf(d, id2).locator('.xterm-rows').waitFor();
    const [box1, box2] = [await paneOf(d, id1).boundingBox(), await paneOf(d, id2).boundingBox()];
    check(
      box1 &&
        box2 &&
        box1.x < box2.x &&
        Math.abs(box1.y - box2.y) < 2 &&
        box1.width > 250 &&
        box2.width > 250,
      'D: two shells side by side (split right)',
    );
    const pid1 = await pidIn(d, id1, 'one');
    const pid2 = await pidIn(d, id2, 'two');
    check(pid1 !== pid2, `D: each pane has its own shell (pids ${pid1} and ${pid2})`);
    await shot(d, 'desktop-split');
    // x on the first tab: it only detaches.
    await d
      .locator('[data-testid="shell-tab"]')
      .nth(0)
      .getByRole('button', { name: /터미널 닫기/ })
      .click();
    await d.waitForTimeout(500);
    check(
      (await shells(d)).length === 2 &&
        (await d.locator('[data-testid="shell-tab"]').count()) === 1,
      'D: x closed the tab, both shells still run in the daemon',
    );
    await d.getByRole('button', { name: '터미널 추가' }).click();
    await d
      .getByTestId('closed-shell')
      .getByRole('menuitem', { name: /다시 열기/ })
      .click();
    const again = await pidIn(d, id1, 'one-again');
    check(again === pid1, `D: 닫은 터미널 reopens the same shell (pid ${again} = ${pid1})`);
    await d.getByRole('button', { name: '오른쪽으로 나누기' }).click();
    await shot(d, 'desktop-reopened');
    check(
      !(await everything(d)).includes('exited with code'),
      'D: no "exited with code" on any pane so far',
    );

    // ── 8. A deploy: the daemon restarts, the shells stay ──
    await stopDaemon(w1);
    const reconnect = '서버가 다시 시작돼 다시 연결하는 중…';
    await until(
      async () => (await everything(d)).split(reconnect).length - 1 >= 2,
      'both panes say they are reconnecting',
      30_000,
    );
    check(
      !(await everything(d)).includes('exited with code'),
      'D: the outage shows the reconnect line, never an exit code',
    );
    await shot(d, 'desktop-reconnecting');
    const w2 = await startDaemon(port, fake, ['--allow-terminal']);
    daemons.push(w2);
    const back1 = await pidIn(d, id1, 'one-after');
    const back2 = await pidIn(d, id2, 'two-after');
    check(
      back1 === pid1 && back2 === pid2,
      `D: after the restart both panes are back with the same shells (pids ${back1}, ${back2})`,
    );
    check(
      !(await everything(d)).includes('exited with code'),
      'D: after the restart still no exit code',
    );
    check(
      w2.log.join('').includes('2 shell(s) restored'),
      'the new daemon says it restored 2 shells',
    );
    const saved = path.join(configDirectory(fake.home), 'shells.json');
    check(
      (fs.statSync(saved).mode & 0o777) === 0o600 &&
        (JSON.parse(fs.readFileSync(saved, 'utf8')) as { shells: unknown[] }).shells.length === 2,
      'shells.json is 0600 and lists both shells',
    );
    await shot(d, 'desktop-after-restart');

    // ── 9. Korean on the desktop ──
    const desktopKorean = await typeKorean(d, id1, 'desktop');
    check(
      desktopKorean === '아니 또\n',
      `D: Korean arrives as syllables (${JSON.stringify(desktopKorean)})`,
    );
    // Fast typing (10-22: "빨리 입력하면 글자가 지워져"): ASCII with no delay, and
    // Korean where Enter comes before the IME's commit (Chrome marks that keydown isComposing).
    const fastFile = path.join(fake.home, 'fast-ascii.txt');
    const ascii = 'the quick brown fox jumps over the lazy dog 0123456789 '.repeat(4).trim();
    await typeIn(d, `cat > ${fastFile}`, id1);
    await sleep(500);
    await paneOf(d, id1).locator('.xterm-helper-textarea').focus();
    await d.keyboard.type(ascii);
    await d.keyboard.press('Enter');
    await d.keyboard.press('Control+d');
    const fastAscii = await until(async () => {
      try {
        return fs.readFileSync(fastFile, 'utf8') || false;
      } catch {
        return false;
      }
    }, 'D: the fast ASCII line');
    check(
      fastAscii === `${ascii}\n`,
      `D: fast ASCII arrives whole (${String(fastAscii).length} chars)`,
    );
    const fastKorean = await typeKoreanFast(d, id1);
    check(
      fastKorean === '안녕 하세요\n',
      `D: fast Korean with Enter before the commit arrives whole (${JSON.stringify(fastKorean)})`,
    );
    await emulateWebKitLabels(d);
    const guarded = await typeKorean(d, id1, 'desktop-webkit');
    check(
      guarded === '아니 또\n',
      `D: also when the browser labels composition updates as plain text (the guard; ${JSON.stringify(guarded)})`,
    );
    await shot(d, 'desktop-korean');

    // ── Keys are the shell's (no tmux prefix), no status line, copy with the mouse ──
    const keysFile = path.join(fake.home, 'keys-ctrl-b.txt');
    await typeIn(d, `cat > ${keysFile}`, id1);
    await sleep(500);
    await d.keyboard.press('Control+b');
    await d.keyboard.type('x');
    await d.keyboard.press('Enter');
    await d.keyboard.press('Control+d');
    const ctrlB = await until(async () => {
      try {
        return fs.readFileSync(keysFile, 'utf8') || false;
      } catch {
        return false;
      }
    }, 'D: the Ctrl+B line');
    check(ctrlB === '\x02x\n', `D: Ctrl+B reaches the shell, not tmux (${JSON.stringify(ctrlB)})`);
    check(!(await screenText(d, id1)).includes(id1!), 'D: no tmux status line in the pane');
    await d.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: local });
    const copied = async (shift: boolean) => {
      await d.evaluate(() => navigator.clipboard.writeText('-'));
      const row = paneOf(d, id1).locator('.xterm-rows > div', { hasText: 'CPY42MARK' }).last();
      const box = (await row.boundingBox())!;
      const y = box.y + box.height / 2;
      if (shift) await d.keyboard.down('Shift');
      await d.mouse.move(box.x + 2, y);
      await d.mouse.down();
      await d.mouse.move(box.x + box.width / 2, y, { steps: 5 });
      await d.mouse.move(box.x + box.width - 3, y, { steps: 5 });
      await d.mouse.up();
      if (shift) await d.keyboard.up('Shift');
      if (shift) await d.keyboard.press('Control+c');
      await sleep(1_000);
      return d.evaluate(() => navigator.clipboard.readText());
    };
    await typeIn(d, 'echo CPY$((6*7))MARK', id1);
    await sleep(500);
    // tmux `mouse on` (the wheel scrolls its history): a drag selects in tmux,
    // which copies through OSC 52; Shift+drag is xterm's own selection.
    const plain = await copied(false);
    check(plain === 'CPY42MARK', `D: a drag copies (tmux, OSC 52: ${JSON.stringify(plain)})`);
    const shifted = await copied(true);
    check(shifted === 'CPY42MARK', `D: Shift+drag and Ctrl+C copy (${JSON.stringify(shifted)})`);
    const after = path.join(fake.home, 'after-copy.txt');
    await typeIn(d, `echo ok > ${after}`, id1);
    await until(async () => fs.existsSync(after), 'D: typing after the drags reaches the shell');
    check(true, 'D: typing after the drags reaches the shell (tmux left copy mode)');

    // The old input path (the guard off, as the page had it before): the same keys, jamo.
    const { page: e } = await open(
      { viewport: { width: 1440, height: 900 }, userAgent: WINDOWS_UA },
      'old-input-path',
    );
    await e.context().addInitScript(() => localStorage.setItem('cld.ime-guard', 'off'));
    // And the renderer the product uses (the harness pins the DOM one for reading rows).
    await e.context().addInitScript(() => localStorage.removeItem('cld.terminal-renderer'));
    await e.goto(await login());
    await e.waitForURL(`${local}/`);
    await waitLoggedInWithKey(e, 'old-input-path desktop');
    await desktopTab(e);
    await pickWork(e);
    await paneOf(e).locator('.xterm-screen').waitFor();
    await emulateWebKitLabels(e);
    // WebGL draws the pane when the browser has WebGL2 (headless Chromium: SwiftShader), and a
    // lost GPU context hands it back to the DOM renderer, which keeps drawing what is typed.
    const hasWebgl2 = await e.evaluate(
      () => !!document.createElement('canvas').getContext('webgl2'),
    );
    const rendererOf = () =>
      paneOf(e)
        .locator('[data-renderer]')
        .getAttribute('data-renderer', { timeout: 1_000 })
        .catch(() => null);
    await until(async () => (await rendererOf()) !== null, 'E: the pane says its renderer');
    if (hasWebgl2) {
      check((await rendererOf()) === 'webgl', 'E: the pane draws with WebGL');
      check((await paneOf(e).locator('.xterm-rows').count()) === 0, 'E: no DOM rows under WebGL');
      await paneOf(e).evaluate((host) => {
        for (const c of host.querySelectorAll('canvas'))
          c.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext();
      });
      await until(async () => (await rendererOf()) === 'dom', 'E: a lost context falls back');
    } else {
      check((await rendererOf()) === 'dom', 'E: no WebGL2 here: the DOM renderer draws');
    }
    await typeIn(e, 'echo RENDER$((6*7))OK');
    await until(
      async () => (await screenText(e)).includes('RENDER42OK'),
      'E: the DOM renderer draws what is typed',
    );
    check(true, `E: ${hasWebgl2 ? 'after the context loss ' : ''}the DOM renderer draws the shell`);
    const old = await typeKorean(e, undefined, 'old');
    check(
      old !== '아니 또\n' && /[\u3131-\u318e]/.test(old),
      `negative control: with the old input path the same keys arrive as jamo (${JSON.stringify(old)})`,
    );
    check(violations.length === 0, `no CSP violation (${violations.join('; ')})`);
    await stopDaemon(w2);
    testTmux.killServer();
    check(leftovers(fake.home).length === 0, 'no shell left running after the tmux server is gone');

    // ── 10. Negative control: persistence off ──
    const negFake = makeFakeHome({ claude: 'S-8' });
    fs.mkdirSync(path.join(negFake.home, 'work'));
    const neg1 = await startDaemon(offPort, negFake, ['--allow-terminal'], {
      CLD_GUI_SHELL_PERSIST: 'off',
    });
    daemons.push(neg1);
    const negLocal = `http://localhost:${offPort}`;
    const negLogin = async () =>
      (await daemonLoginUrl(negFake.home, offPort, daemons.at(-1)!.process.pid!)).replace(
        'http://127.0.0.1:',
        'http://localhost:',
      );
    const { page: n } = await open(
      { viewport: { width: 1440, height: 900 }, userAgent: WINDOWS_UA },
      'persistence-off',
    );
    await n.goto(await negLogin());
    await n.waitForURL(`${negLocal}/`);
    await waitLoggedInWithKey(n, 'persistence-off desktop');
    await desktopTab(n);
    await pickWork(n);
    await paneOf(n).locator('.xterm-rows').waitFor();
    check(
      neg1.log.join('').includes('no tmux: shells end with the daemon'),
      'persistence off: the daemon runs shells without tmux',
    );
    const negFile = (name: string) => path.join(negFake.home, `pid-${name}`);
    const negPid = async (name: string) => {
      for (const end = Date.now() + 60_000; Date.now() < end; await sleep(1_500)) {
        try {
          const v = fs.readFileSync(negFile(name), 'utf8').trim();
          if (/^\d+$/.test(v)) return v;
        } catch {
          // not yet
        }
        await typeIn(n, `echo $$ > ${negFile(name)}`).catch(() => undefined);
      }
      throw new Error(`no pid from ${name}`);
    };
    const offPid = await negPid('before');
    await stopDaemon(neg1);
    const neg2 = await startDaemon(offPort, negFake, ['--allow-terminal'], {
      CLD_GUI_SHELL_PERSIST: 'off',
    });
    daemons.push(neg2);
    await until(
      async () => (await everything(n)).includes('터미널이 닫혔어요. 다시 열어 주세요.'),
      'persistence off: after the restart the shell is gone and the pane says so',
      60_000,
    );
    check(
      !(await everything(n)).includes('exited with code'),
      'persistence off: even then no exit code (the shell is gone, said in Korean)',
    );
    await pickWork(n);
    await until(async () => (await shells(n)).length === 1, 'a new shell opened');
    const offAfter = await negPid('after');
    check(
      offAfter !== offPid,
      `negative control: with persistence off the pid changes (${offPid} -> ${offAfter})`,
    );
    await stopDaemon(neg2);
    fs.rmSync(negFake.home, { recursive: true, force: true });
    check(leftovers(negFake.home).length === 0, 'persistence off: no shell left over');
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    for (const d of daemons) await stopDaemon(d);
    cleanup();
  }
}

main().then(
  () => console.log('done'),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
