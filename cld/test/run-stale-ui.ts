/**
 * STALE-UI3 browser check. It serves a private copy of dist/, so each simulated
 * deploy can rename its entry module without touching a developer's build.
 *
 *   npx tsx cld/test/run-stale-ui.ts [port, default 18258]
 */
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  testDaemonPath,
  waitForDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2] ?? '18258');
if (!Number.isInteger(port) || port === 18240 || port < 1024 || port > 65535)
  throw new Error('port must be a non-18240 TCP port');

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out: ${what}`);
}

function entryFromHtml(staticDir: string): string {
  const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
  const match = /<script[^>]+type="module"[^>]+src="\/([^"?]+)"/.exec(html);
  if (!match) throw new Error('the copied webview has no module entry');
  return match[1];
}

function hostToken(home: string): string {
  const server = path.join(home, '.pixel-agents', 'server.json');
  try {
    const token = (JSON.parse(fs.readFileSync(server, 'utf8')) as { token?: unknown }).token;
    if (typeof token === 'string' && token) return token;
  } catch {
    // The daemon may still be writing its host record.
  }
  throw new Error('temporary daemon did not write its host token');
}

async function loginUrl(home: string, child: ChildProcess): Promise<string> {
  await waitForDaemon(port, child.pid!, 30_000, home);
  const token = hostToken(home);
  const response = await fetch(`http://127.0.0.1:${port}/api/login-code`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`login code: ${response.status}`);
  const { code } = (await response.json()) as { code: string };
  return `http://127.0.0.1:${port}/login?code=${encodeURIComponent(code)}`;
}

async function main() {
  await assertPortFree(port);
  const fake = makeFakeHome({ accessChosen: true });
  const tempDist = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-stale-ui-'));
  fs.cpSync(path.join(REPO_ROOT, 'dist'), tempDist, { recursive: true });
  const staticDir = path.join(tempDist, 'webview');
  let daemon: ChildProcess | undefined;
  const logs: string[] = [];
  const start = () => {
    daemon = spawn(process.execPath, [path.join(tempDist, 'cli.js'), '--port', String(port), '--no-terminal'], {
      env: {
        ...process.env,
        ...fake.env,
        XDG_RUNTIME_DIR: fake.home,
        PATH: testDaemonPath([path.dirname(fake.claudePath)]),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    daemon.stdout.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    daemon.stderr.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    return daemon;
  };
  const stop = async () => {
    const child = daemon;
    daemon = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill('SIGTERM');
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  let currentEntry = entryFromHtml(staticDir);
  const deploy = async () => {
    const nextEntry = currentEntry.replace(/\.js$/, `-deploy-${Date.now()}.js`);
    fs.renameSync(path.join(staticDir, currentEntry), path.join(staticDir, nextEntry));
    const index = path.join(staticDir, 'index.html');
    fs.writeFileSync(index, fs.readFileSync(index, 'utf8').replace(currentEntry, nextEntry));
    currentEntry = nextEntry;
    await stop();
    const child = start();
    await waitForDaemon(port, child.pid!, 30_000, fake.home);
  };

  const browser = await launchBrowser();
  try {
    const child = start();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto(await loginUrl(fake.home, child));
    await page.waitForURL(`http://127.0.0.1:${port}/`);

    // An idle page follows the first renamed entry immediately.
    const idleReload = page.waitForEvent('framenavigated');
    await deploy();
    await idleReload;
    check(!(await page.getByTestId('stale-build-banner').isVisible().catch(() => false)), 'idle page reloads');

    // The app only needs an actual focused text field; a tiny fixture avoids
    // coupling this stale-build runner to any particular office panel.
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.id = 'stale-ui-fixture-input';
      input.value = 'draft';
      document.body.append(input);
      input.focus();
    });
    await deploy();
    await until('typing banner', async () => page.getByTestId('stale-build-banner').isVisible());
    check(await page.getByTestId('stale-build-banner').isVisible(), 'focused text shows the banner');
    const clearedReload = page.waitForEvent('framenavigated', { timeout: 2_000 });
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('#stale-ui-fixture-input')!;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clearedReload;
    check(true, 'clearing focused text reloads within 2 seconds');

    await page.evaluate(() => {
      const dialog = document.createElement('div');
      dialog.id = 'stale-ui-fixture-dialog';
      dialog.setAttribute('role', 'dialog');
      dialog.textContent = 'fixture';
      document.body.append(dialog);
    });
    await deploy();
    await until('dialog banner', async () => page.getByTestId('stale-build-banner').isVisible());
    check(await page.getByTestId('stale-build-banner').isVisible(), 'open dialog shows the banner');
    await page.evaluate(() => document.querySelector('#stale-ui-fixture-dialog')?.remove());
    await until('dialog close reload', async () => !(await page.getByTestId('stale-build-banner').isVisible().catch(() => false)));

    // Serve the previous HTML for the reload itself: the page did reload for
    // this build, but is deliberately still old when it reconnects, exercising
    // the once-per-build manual-refresh copy.
    const oldEntry = currentEntry;
    const staleHtml = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8');
    const staleScript = fs.readFileSync(path.join(staticDir, oldEntry));
    await page.route(`http://127.0.0.1:${port}/`, (route) =>
      route.fulfill({ body: staleHtml, contentType: 'text/html' }),
    );
    await page.route(`**/${oldEntry}`, (route) => route.fulfill({ body: staleScript }));
    const onceReload = page.waitForEvent('framenavigated');
    await deploy();
    await onceReload;
    await page.unroute(`http://127.0.0.1:${port}/`);
    await page.unroute(`**/${oldEntry}`);
    await until('manual refresh copy', async () => page.getByTestId('stale-build-banner').isVisible());
    check(
      (await page.getByTestId('stale-build-banner').textContent())?.includes('\uc9c0\uae08 \uc0c8\ub85c\uace0\uce68\uc744 \ub20c\ub7ec \uc8fc\uc138\uc694'),
      'a reloaded but still stale page asks for manual refresh',
    );
    await context.close();
  } finally {
    await browser.close();
    await stop();
    fs.rmSync(fake.home, { recursive: true, force: true });
    fs.rmSync(tempDist, { recursive: true, force: true });
    if (logs.some((line) => /Error/.test(line))) console.error(logs.join(''));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
