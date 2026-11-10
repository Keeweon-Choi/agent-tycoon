/**
 * AGENT-LATEST (owner 11-06 22:03): the usage panel says which version is out. dist/cli.js in a temp HOME with a
 * fake `claude` and `codex` (their `--version` and `update` answered by small scripts, never the real CLIs) and a
 * MOCK npm REGISTRY: a --require preload answers every https://registry.npmjs.org/ fetch from <home>/registry.json
 * (and logs it), and refuses any other non-local request, so no test touches the network. Checks, at 1600x1000
 * (Chromium --disable-gpu): a CLI with a newer version shows "version → newest" and 업데이트; one that is
 * current shows 최신 버전 and no button; one ↻ in the panel's top row; ↻ asks the registry again (past the
 * 30 s gap) and Claude gets a new version; a success result goes after 60 s and closing the panel ends it; then
 * the phone's expanded panel (WebKit 390x844). Photos in agent-tycoon/artifacts/feat-hud-cli-latest-version/.
 *
 *   npx tsx agent-tycoon/test/run-feat-hud-cli-latest-version.ts [port 19290-19299]
 */
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import {
  assertPortFree,
  FAKE_CLAUDE,
  fakeUsage,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
  topBarReady,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]) || 19290;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/feat-hud-cli-latest-version');
const DEADLINE_MS = 420_000;
const GAP_MS = 31_000;
const RESULT_MS = 60_000;
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__lv/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
let oks = 0;
const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fake CLIs: --version and update by files in HOME; anything else by the engine's fakes. */
function writeFakes(bin: string): void {
  const head = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const HOME = process.env.HOME;
const file = (n) => path.join(HOME, n);
const read = (n, d) => { try { return fs.readFileSync(file(n), 'utf8').trim(); } catch { return d; } };
const a = process.argv[2];
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
`;
  fs.rmSync(path.join(bin, 'claude'));
  fs.writeFileSync(
    path.join(bin, 'claude'),
    `${head}
if (a === '--version') { process.stdout.write(read('v-claude', '2.1.319') + ' (Claude Code)\\n'); process.exit(0); }
if (a === 'update') {
  sleep(1500);
  const v = read('v-claude', '2.1.319');
  const next = v.replace(/\\d+$/, (n) => String(Number(n) + 1));
  fs.writeFileSync(file('v-claude'), next);
  process.stdout.write('Successfully updated from ' + v + ' to version ' + next + '\\n');
  process.exit(0);
}
require(${JSON.stringify(path.join(FAKE_CLAUDE, 'engine.cjs'))});
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'codex'),
    `${head}
if (a === '--version') { process.stdout.write('codex-cli ' + read('v-codex', '0.156.1') + '\\n'); process.exit(0); }
if (a === 'update') { sleep(1500); fs.writeFileSync(file('v-codex'), '0.167.0'); process.stdout.write('Updated to 0.167.0\\n'); process.exit(0); }
require(${JSON.stringify(path.join(REPO_ROOT, 'agent-tycoon/test/fake-codex/codex'))});
`,
    { mode: 0o755 },
  );
}

/** The daemon's fetch: the registry from <home>/registry.json (logged), nothing else off this machine. */
function writeRegistryMock(home: string): string {
  const file = path.join(home, 'mock-registry.cjs');
  fs.writeFileSync(
    file,
    `const fs = require('fs');
const path = require('path');
const real = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  const m = /^https:\\/\\/registry\\.npmjs\\.org\\/(.+)\\/([a-z]+)$/.exec(u);
  if (m) {
    fs.appendFileSync(path.join(process.env.HOME, 'registry-calls.log'), u + '\\n');
    const answers = JSON.parse(fs.readFileSync(path.join(process.env.HOME, 'registry.json'), 'utf8'));
    const version = answers[m[1]];
    return version ? new Response(JSON.stringify({ name: m[1], version }), { status: 200 }) : new Response('{}', { status: 503 });
  }
  if (/^https?:\\/\\/(127\\.0\\.0\\.1|localhost|\\[::1\\])[:/]/.test(u)) return real(url, init);
  throw new Error('mock: no network in this run: ' + u);
};
`,
  );
  return file;
}
const setRegistry = (home: string, answers: Record<string, string>) => fs.writeFileSync(path.join(home, 'registry.json'), JSON.stringify(answers));
const registryCalls = (home: string) => {
  try {
    return fs.readFileSync(path.join(home, 'registry-calls.log'), 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

const CLAUDE = '@anthropic-ai/claude-code';
const CODEX = '@openai/codex';
const row = (page: Page, agent: string) => page.locator(`[data-testid="cc-agent"][data-agent="${agent}"]:visible`);

async function main() {
  if (port < 19290 || port > 19299) throw new Error('port 19290-19299');
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  writeFakes(bin);
  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(path.join(configDirectory(home), 'config.json'), JSON.stringify({ accessChosen: true, port }));
  // Claude is current, Codex has a new version out.
  setRegistry(home, { [CLAUDE]: '2.1.319', [CODEX]: '0.167.0' });
  const usage = await fakeUsage(home, { fiveHour: 15, sevenDay: 7, fable: 0 }, { fiveHour: 0, sevenDay: 21 });
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-actions', '--allow-chat', '--no-terminal'],
    { ...usage.env, NODE_OPTIONS: `--require ${writeRegistryMock(home)}` },
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
    process.exit(1);
  }, DEADLINE_MS);
  const font = fs.existsSync(FONT) ? fs.readFileSync(FONT) : null;
  const newPage = async (browser: Awaited<ReturnType<typeof launchBrowser>>, phone: boolean) => {
    const ctx = await browser.newContext(
      phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : { viewport: { width: 1600, height: 1000 } },
    );
    await ctx.addInitScript('globalThis.__name = (fn) => fn;');
    if (font) await ctx.route('**/__lv/malgun.ttf', (r) => r.fulfill({ body: font, contentType: 'font/ttf' }));
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message}`));
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    if (font) await page.addStyleTag({ content: FONT_CSS });
    return { ctx, page };
  };
  const shot = (page: Page, name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const browser = await launchBrowser();
  let phoneBrowser: Awaited<ReturnType<typeof launchBrowser>> | undefined;
  try {
    // ── PC ──
    const { ctx, page } = await newPage(browser, false);
    await topBarReady(page, 30_000);
    await page.locator('[data-testid="cc-seg-usage"]').first().click();
    const pop = page.locator('[data-testid="cc-usage-pop"]');
    await pop.waitFor();
    const claude = row(page, 'claude');
    const codex = row(page, 'codex');
    await codex.locator('[data-testid="cc-latest"]').waitFor({ timeout: 30_000 });
    const first = Date.now();
    check((await codex.locator('[data-testid="cc-version"]').textContent()) === '0.156.1', 'Codex shows its version 0.156.1');
    check((await codex.locator('[data-testid="cc-latest"]').textContent())?.includes('0.167.0'), 'Codex shows → 0.167.0 next to it');
    check((await codex.locator('[data-testid="cc-update-btn"]').count()) === 1, 'Codex has the 업데이트 button');
    check((await claude.locator('[data-testid="cc-newest"]').textContent())?.includes('최신'), 'Claude, current, says it is the newest');
    check((await claude.locator('[data-testid="cc-update-btn"]').count()) === 0, 'Claude has no 업데이트 button');
    check((await claude.locator('[data-testid="cc-version"]').textContent()) === '2.1.319', 'Claude shows its version 2.1.319');
    check((await pop.locator('[data-testid="usage-refresh"]').count()) === 1, 'one ↻ in the panel');
    check((await pop.locator('.cc-head [data-testid="usage-refresh"]').count()) === 1, 'the ↻ is in the top row, the header');
    check((await page.locator('[data-testid="cc-agent"] [data-testid="usage-refresh"]').count()) === 0, 'no ↻ on an agent row any more');
    check(registryCalls(home).length === 2, `two registry lookups on opening (${registryCalls(home).join(' ')})`);
    check(registryCalls(home).some((u) => u === `https://registry.npmjs.org/${CLAUDE}/latest`), 'Claude Code asked its latest dist-tag over HTTPS');
    await shot(page, 'pc-1-update-available-and-newest');

    // Update Codex: a success result, then it is the newest.
    await codex.locator('[data-testid="cc-update-btn"]').click();
    await codex.locator('[data-testid="cc-update"][data-phase="done"]').waitFor({ timeout: 30_000 });
    const changed = (await codex.locator('[data-testid="cc-update"]').textContent()) ?? '';
    check(changed.includes('0.156.1 → 0.167.0') && changed.includes('다시 시작할 때'), `Codex result: "${changed}"`);
    await codex.locator('[data-testid="cc-newest"]').waitFor({ timeout: 10_000 });
    check((await codex.locator('[data-testid="cc-update-btn"]').count()) === 0, 'Codex, updated, is the newest and has no button');
    await shot(page, 'pc-2-result-line');
    // Closing the panel ends the result.
    await page.locator('[data-testid="cc-seg-usage"]').first().click();
    await pop.waitFor({ state: 'detached' });
    await page.locator('[data-testid="cc-seg-usage"]').first().click();
    await pop.waitFor();
    check((await codex.locator('[data-testid="cc-update"]').count()) === 0, 'closing the panel ended the result line');

    // ↻ after the 30 s gap: a new Claude version is out.
    await wait(Math.max(0, first + GAP_MS - Date.now()));
    setRegistry(home, { [CLAUDE]: '2.1.400', [CODEX]: '0.167.0' });
    await pop.locator('[data-testid="usage-refresh"]').click();
    await claude.locator('[data-testid="cc-latest"]').waitFor({ timeout: 20_000 });
    check((await claude.locator('[data-testid="cc-latest"]').textContent())?.includes('2.1.400'), '↻ asked again: Claude shows → 2.1.400');
    check((await claude.locator('[data-testid="cc-update-btn"]').count()) === 1, 'Claude has its button again');
    check(registryCalls(home).length === 4, `↻ made two lookups past the hourly cache (${registryCalls(home).length} in all)`);
    await shot(page, 'pc-3-after-refresh');
    // A second ↻ within 30 s asks nothing.
    await pop.locator('[data-testid="usage-refresh"]').click();
    await wait(1_500);
    check(registryCalls(home).length === 4, 'a second ↻ within 30 s asked the registry nothing');

    // A success result goes by itself after a minute.
    await claude.locator('[data-testid="cc-update-btn"]').click();
    await claude.locator('[data-testid="cc-update"][data-phase="done"]').waitFor({ timeout: 30_000 });
    const t0 = Date.now();
    check(((await claude.locator('[data-testid="cc-update"]').textContent()) ?? '').includes('2.1.319 → 2.1.320'), 'Claude result 2.1.319 → 2.1.320');
    await wait(RESULT_MS - 8_000 - (Date.now() - t0));
    check((await claude.locator('[data-testid="cc-update"]').count()) === 1, 'the result is still there at ~52 s');
    await claude.locator('[data-testid="cc-update"]').waitFor({ state: 'detached', timeout: 20_000 });
    const gone = Date.now() - t0;
    check(gone >= RESULT_MS - 3_000 && gone <= RESULT_MS + 8_000, `the result went after ${Math.round(gone / 1000)} s`);
    await shot(page, 'pc-4-result-gone');
    await ctx.close();

    // ── phone ──
    phoneBrowser = await launchBrowser({ webkit: true });
    const ph = await newPage(phoneBrowser, true);
    const rowBtn = ph.page.getByTestId('cc-seg-usage');
    await rowBtn.waitFor({ timeout: 40_000 });
    await wait(1_500);
    await rowBtn.tap();
    const sheet = ph.page.getByTestId('cc-usage-sheet');
    await sheet.waitFor({ timeout: 5_000 });
    await sheet.locator('[data-testid="cc-latest"]').waitFor({ timeout: 20_000 });
    check((await sheet.locator('[data-testid="usage-refresh"]').count()) === 1, 'phone: one ↻ in the sheet head');
    check((await sheet.locator('[data-testid="cc-update-btn"]').count()) === 1, 'phone: Claude (2.1.320 → 2.1.400) has the button');
    check((await sheet.locator('[data-testid="cc-newest"]').count()) === 1, 'phone: Codex says newest');
    check(await ph.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone: no sideways scroll');
    await wait(400);
    await shot(ph.page, 'phone-1-sheet');
    await sheet.locator('[data-testid="cc-update-btn"]').tap();
    await sheet.locator('[data-testid="cc-update"][data-phase="done"]').waitFor({ timeout: 30_000 });
    await wait(400);
    await shot(ph.page, 'phone-2-sheet-result');
    await ph.page.getByTestId('cc-usage-sheet-close').tap();
    await sheet.waitFor({ state: 'detached' });
    await rowBtn.tap();
    await sheet.waitFor();
    check((await sheet.locator('[data-testid="cc-update"]').count()) === 0, 'phone: closing the sheet ended the result');
    await ph.ctx.close();
    console.log(`\n${oks} checks passed; photos in ${OUT}`);
  } finally {
    clearTimeout(deadline);
    await phoneBrowser?.close();
    await browser.close();
    await daemon.stop();
    killFakeSessions(home);
    removeTestHome(home);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
