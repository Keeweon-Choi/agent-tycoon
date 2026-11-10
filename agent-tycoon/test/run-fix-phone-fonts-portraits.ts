/**
 * FIX-PHONE-FONTS-PORTRAITS: the 모던 face and the portraits on a phone. dist/cli.js with an isolated
 * HOME (a `lead` session, a `sleep` with a transcript) on its own port, signed in by a login code
 * (the session cookie every browser and the desktop app use), 모던 style. Headless WebKit as an
 * iPhone, then headless Chromium (--disable-gpu) as the desktop. For each: every /fonts/ response
 * and its status, the Pretendard faces' state after document.fonts.ready, and how many opaque
 * pixels every portrait canvas holds. Log and screenshots: agent-tycoon/artifacts/fix-phone-fonts-portraits/.
 *
 *   npx tsx agent-tycoon/test/run-fix-phone-fonts-portraits.ts <port 19040-19049> [tag]
 */
import type { Browser, BrowserContextOptions } from '@playwright/test';
import { devices } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  removeTestHome,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 19040 && port <= 19049)) throw new Error('port must be 19040-19049');
const TAG = process.argv[3] ?? 'after';
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/fix-phone-fonts-portraits');
const lines: string[] = [];
const say = (s: string) => (lines.push(s), console.log(s));
let failed = 0;
function check(ok: unknown, what: string): void {
  say(`${ok ? 'ok' : 'FAIL'} - ${what}`);
  if (!ok) failed++;
}

/** `lead` as a live Claude Code session (a `sleep`) with an empty transcript. */
function startLead(home: string) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'f1f0f000-0000-4000-8000-000000000001';
  const cwd = '/work/alpha';
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, startedAt: Date.now() - 600_000, procStart, version: '2.1.306', kind: 'interactive', name: 'lead', status: 'busy' }),
  );
  return proc;
}

async function look(browser: Browser, name: string, opts: BrowserContextOptions, loginUrl: string) {
  const ctx = await browser.newContext(opts);
  await ctx.addInitScript(`try { localStorage.setItem('agty.ui-theme', 'modern'); } catch {}`);
  const page = await ctx.newPage();
  const fonts: string[] = [];
  const problems: string[] = [];
  const images: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' || m.type() === 'error') problems.push(m.text().slice(0, 300));
  });
  page.on('pageerror', (e) => problems.push(String(e).slice(0, 300)));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/fonts/')) fonts.push(`${u.pathname} ${r.status()}`);
    else if (/\.(png|webp)$/.test(u.pathname)) images.push(`${u.pathname} ${r.status()}`);
  });
  await page.goto(loginUrl);
  await page.waitForURL(`http://127.0.0.1:${port}/`);
  await page.locator('[data-testid="agent-name"]', { hasText: 'lead' }).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(3_000);
  const fontState = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      theme: document.documentElement.dataset.uiTheme ?? '',
      faces: [...document.fonts]
        .filter((f) => f.family.replace(/["']/g, '') === 'Pretendard')
        .map((f) => `${f.weight}:${f.status}`),
      check: document.fonts.check('16px Pretendard'),
      body: getComputedStyle(document.body).fontFamily,
      // a font fetch that carries no session (what the phone's CSS fetch did)
      anonymous: (await fetch('/fonts/pretendard/Pretendard-Regular.woff2', { credentials: 'omit' })).status,
    };
  });
  // Every portrait (a mug shot canvas: square, small) and its opaque pixels.
  const portraits = await page.evaluate(() =>
    [...document.querySelectorAll('canvas')]
      .filter((c) => c.width === c.height && c.clientWidth > 0 && c.clientWidth <= 200)
      .map((c) => {
        const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
      }),
  );
  say(`[${name}] theme=${fontState.theme} body font: ${fontState.body}`);
  say(`[${name}] font responses: ${fonts.join(', ') || 'none'}`);
  say(`[${name}] Pretendard faces: ${fontState.faces.join(', ')}; check('16px Pretendard')=${fontState.check}`);
  say(`[${name}] image responses: ${images.join(', ') || 'none'}`);
  say(`[${name}] console warnings/errors: ${problems.join(' | ') || 'none'}`);
  say(`[${name}] portrait canvases (opaque px): ${portraits.join(', ') || 'none'}`);
  check(fonts.some((f) => f.startsWith('/fonts/pretendard/') && f.endsWith(' 200')), `${name}: Pretendard fetched with 200`);
  check(fontState.anonymous === 200, `${name}: Pretendard without a session: ${fontState.anonymous}`);
  check(fontState.check && fontState.faces.some((f) => f.endsWith(':loaded')), `${name}: Pretendard loaded`);
  check(portraits.length > 0 && portraits.every((n) => n > 0), `${name}: every portrait has a face`);
  await page.screenshot({ path: path.join(OUT, `${TAG}-${name}.png`) });
  await ctx.close();
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({});
  const lead = startLead(fake.home);
  const daemon = startDaemon(fake, port, ['--no-terminal']);
  try {
    const wk = await launchBrowser({ webkit: true });
    try {
      await look(wk, 'iphone-webkit', { ...devices['iPhone 13'] }, await daemon.loginUrl());
    } finally {
      await wk.close();
    }
    const cr = await launchBrowser({ args: ['--disable-gpu'] });
    try {
      await look(cr, 'desktop-chromium', { viewport: { width: 1280, height: 800 } }, await daemon.loginUrl());
    } finally {
      await cr.close();
    }
  } finally {
    await daemon.stop();
    lead.kill('SIGTERM');
    removeTestHome(fake.home);
    fs.writeFileSync(path.join(OUT, `${TAG}.log`), lines.join('\n') + '\n');
  }
  say(failed ? `${failed} checks failed` : 'all checks passed');
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
