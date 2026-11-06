/**
 * MHO 3.6 (multi-host v1 step 1): two daemons on two localhost ports, one browser context (one
 * cookie jar). Log into A, then into B: both stay logged in (each host names its own session
 * cookie). Also: the host name in the tab title, the login page title and 설정 (renamed from there).
 * Temp HOMEs, ports 19032-19033, headless Chromium with --disable-gpu; only our daemons are stopped.
 *
 *   npx tsx cld/test/run-multi-host-login.ts
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import {
  assertPortFree,
  type Daemon,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  startDaemon,
  topBarButton,
  topBarReady,
} from '../../server/src/cld/testHome.js';

const PORTS = [19032, 19033] as const;
const NAMES = ['Laptop A', 'Desk B'] as const;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/multi-host-v1a');
const DEADLINE_MS = 180_000;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(...PORTS);
  fs.mkdirSync(OUT, { recursive: true });
  const homes: string[] = [];
  const daemons: Daemon[] = [];
  const cleanup = async () => {
    for (const d of daemons) await d.stop();
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  };
  const deadline = setTimeout(() => {
    console.error('aborted: deadline');
    for (const d of daemons) d.child.kill('SIGKILL');
    process.exit(1);
  }, DEADLINE_MS);

  const browser = await launchBrowser();
  try {
    const links: string[] = [];
    for (const [i, port] of PORTS.entries()) {
      const fake = makeFakeHome({ claude: 'S-8', agentsJson: true });
      homes.push(fake.home);
      // A host.json with a name set, as 설정 leaves it (the daemon keeps the id and the name).
      const dir = configDirectory(fake.home);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'host.json'),
        JSON.stringify({ v: 1, hostId: randomUUID(), createdAt: new Date().toISOString(), name: NAMES[i] }),
      );
      const d = startDaemon(fake, port, ['--no-terminal']);
      daemons.push(d);
      links.push((await d.loginUrl()).replace('http://127.0.0.1:', 'http://localhost:'));
    }

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const [a, b] = [await ctx.newPage(), await ctx.newPage()];

    // The login page says which host it is for.
    await a.goto(`http://localhost:${PORTS[0]}/`);
    check((await a.title()).includes(NAMES[0]), `the login page title names ${NAMES[0]}`);

    await a.goto(links[0]);
    await topBarReady(a, 30_000);
    await b.goto(links[1]);
    await topBarReady(b, 30_000);
    const cookies = (await ctx.cookies()).filter((c) => c.name.startsWith('cld_session'));
    check(cookies.length === 2 && new Set(cookies.map((c) => c.name)).size === 2, 'two session cookies, one per host');
    check(!cookies.some((c) => c.name === 'cld_session'), 'no shared cld_session cookie');

    // Logging into B did not log A out: A reloads into the office, not the login page.
    await a.reload();
    await topBarReady(a, 30_000);
    check(true, 'A is still logged in after logging into B');
    await b.reload();
    await topBarReady(b, 30_000);
    check(true, 'B is still logged in');
    await a.waitForFunction((name) => document.title.includes(name), NAMES[0]);
    await b.waitForFunction((name) => document.title.includes(name), NAMES[1]);
    check(true, 'each tab title names its host');
    await a.screenshot({ path: path.join(OUT, 'a-logged-in.png') });
    await b.screenshot({ path: path.join(OUT, 'b-logged-in.png') });

    // 설정 > 일반 shows the name and renames the host; the tab title follows.
    await topBarButton(a, '설정');
    const input = a.getByTestId('host-name-input');
    await input.waitFor();
    check((await input.inputValue()) === NAMES[0], '설정 shows the host name');
    await input.fill('Laptop A2');
    await a.getByTestId('host-name-option').getByRole('button', { name: '저장' }).click();
    await a.waitForFunction(() => document.title.includes('Laptop A2'));
    check(true, 'renaming in 설정 changes the tab title');
    await a.getByTestId('host-name-option').screenshot({ path: path.join(OUT, 'a-settings-host-name.png') });
    await b.reload();
    await topBarReady(b, 30_000);
    check(!(await b.title()).includes('Laptop A2'), 'B keeps its own name');
  } finally {
    clearTimeout(deadline);
    await browser.close();
    await cleanup();
  }
}

main().then(
  () => console.log('PASS run-multi-host-login'),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
