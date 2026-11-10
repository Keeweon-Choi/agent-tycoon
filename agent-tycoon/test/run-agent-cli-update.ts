/**
 * AGENT-UPDATE (owner 11-06 20:35): dist/cli.js in a temp HOME with a fake `claude` and a fake `codex`
 * that print their versions and answer `update` (claude: to the next patch after a short wait, then
 * "up to date"; codex: says it is an npm install and exits 1). Headless Chromium (--disable-gpu) at
 * 1600x1000 in 모던 and 픽셀 감성. Checks: the control center's usage rows show each agent's version and
 * an 업데이트 button; pressing it shows progress, then "<old> → <new>" with the restart note; again,
 * 최신 버전이에요; codex's own message when it cannot update itself; the fakes saw exactly `update`.
 * Photos in agent-tycoon/artifacts/feat-agent-cli-update/.
 *
 *   npx tsx agent-tycoon/test/run-agent-cli-update.ts [port 19280-19289]
 */
import type { Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  type Daemon,
  FAKE_CLAUDE,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  removeTestHome,
  REPO_ROOT,
  startDaemon,
  topBarReady,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]) || 19280;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/feat-agent-cli-update');
const DEADLINE_MS = 240_000;
let oks = 0;
const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};

/** Fake CLIs: `--version` and `update` answered here (calls logged), anything else by the engine's fakes. */
function writeFakes(bin: string): void {
  const common = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const HOME = process.env.HOME;
const state = path.join(HOME, 'fake-cli-versions.json');
const read = () => { try { return JSON.parse(fs.readFileSync(state, 'utf8')); } catch { return { claude: '2.1.319', pending: true }; } };
const log = (cli) => fs.appendFileSync(path.join(HOME, 'fake-cli-calls.log'), JSON.stringify({ cli, self: __filename, argv: process.argv.slice(2) }) + '\\n');
const a = process.argv[2];
`;
  fs.rmSync(path.join(bin, 'claude'));
  fs.writeFileSync(
    path.join(bin, 'claude'),
    `${common}
if (a === '--version') { process.stdout.write(read().claude + ' (Claude Code)\\n'); process.exit(0); }
if (a === 'update') {
  log('claude');
  const v = read();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); // long enough to see the progress
  if (v.pending) {
    const next = v.claude.replace(/\\d+$/, (n) => String(Number(n) + 1));
    fs.writeFileSync(state, JSON.stringify({ claude: next }));
    process.stdout.write('Current version: ' + v.claude + '\\nChecking for updates...\\n\\x1b[32mSuccessfully updated from ' + v.claude + ' to version ' + next + '\\x1b[0m\\n');
  } else process.stdout.write('Current version: ' + v.claude + '\\nChecking for updates...\\nClaude Code is up to date (' + v.claude + ')\\n');
  process.exit(0);
}
require(${JSON.stringify(path.join(FAKE_CLAUDE, 'engine.cjs'))});
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'codex'),
    `${common}
if (a === '--version') { process.stdout.write('codex-cli 0.156.1\\n'); process.exit(0); }
if (a === 'update') {
  log('codex');
  process.stderr.write('Codex was installed with npm.\\nUpdate it with your package manager: npm install -g @openai/codex@latest\\n');
  process.exit(1);
}
require(${JSON.stringify(path.join(REPO_ROOT, 'agent-tycoon/test/fake-codex/codex'))});
`,
    { mode: 0o755 },
  );
}

const row = (page: Page, agent: string) => page.locator(`[data-testid="cc-usage-pop"] [data-testid="cc-agent"][data-agent="${agent}"]`);

async function pass(page: Page, theme: 'modern' | 'pixel', home: string) {
  // A new Claude release is out: `update` goes from the installed version to the next patch.
  const file = path.join(home, 'fake-cli-versions.json');
  const from = theme === 'modern' ? '2.1.319' : '2.1.320';
  const to = theme === 'modern' ? '2.1.320' : '2.1.321';
  fs.writeFileSync(file, JSON.stringify({ claude: from, pending: true }));
  await topBarReady(page, 30_000);
  check((await page.evaluate(() => document.documentElement.dataset.uiTheme)) === theme, `${theme}: the style is on`);
  await page.locator('[data-testid="cc-seg-usage"]').first().click();
  await page.locator('[data-testid="cc-usage-pop"]').waitFor();
  const claude = row(page, 'claude');
  const codex = row(page, 'codex');
  await claude.locator('[data-testid="cc-update-btn"]').waitFor({ timeout: 30_000 });
  await codex.locator('[data-testid="cc-update-btn"]').waitFor({ timeout: 30_000 });
  check((await claude.locator('[data-testid="cc-version"]').textContent()) === from, `${theme}: Claude shows ${from}`);
  check((await codex.locator('[data-testid="cc-version"]').textContent()) === '0.156.1', `${theme}: Codex shows 0.156.1`);
  await page.screenshot({ path: path.join(OUT, `${theme}-1-versions.png`) });

  await claude.locator('[data-testid="cc-update-btn"]').click();
  await claude.locator('[data-testid="cc-update"][data-phase="running"]').waitFor({ timeout: 5_000 });
  check(await claude.locator('[data-testid="cc-update-btn"]').isDisabled(), `${theme}: the button waits while it runs`);
  await page.screenshot({ path: path.join(OUT, `${theme}-2-running.png`) });
  await claude.locator('[data-testid="cc-update"][data-phase="done"]').waitFor({ timeout: 30_000 });
  const changed = (await claude.locator('[data-testid="cc-update"]').textContent()) ?? '';
  console.log(`${theme} claude:`, changed);
  check(changed.includes(`${from} → ${to}`), `${theme}: Claude says ${from} → ${to}`);
  check(changed.includes('다시 시작할 때 새 버전'), `${theme}: the restart note shows`);
  check((await claude.locator('[data-testid="cc-version"]').textContent()) === to, `${theme}: the row shows ${to}`);
  await page.screenshot({ path: path.join(OUT, `${theme}-3-updated.png`) });

  await claude.locator('[data-testid="cc-update-btn"]').click();
  await claude.locator('[data-testid="cc-update"][data-phase="running"]').waitFor({ timeout: 5_000 });
  await claude.locator('[data-testid="cc-update"][data-phase="done"]').waitFor({ timeout: 30_000 });
  const latest = (await claude.locator('[data-testid="cc-update"]').textContent()) ?? '';
  check(latest.includes('최신 버전이에요') && latest.includes(`up to date (${to})`), `${theme}: again, 최신 버전이에요 and the CLI's line`);

  await codex.locator('[data-testid="cc-update-btn"]').click();
  await codex.locator('[data-testid="cc-update"][data-phase="done"]').waitFor({ timeout: 30_000 });
  const npm = (await codex.locator('[data-testid="cc-update"]').textContent()) ?? '';
  console.log(`${theme} codex:`, npm);
  check(npm.includes('업데이트하지 못했어요') && npm.includes('npm install -g @openai/codex@latest'), `${theme}: Codex shows its own package-manager message`);
  await codex.locator('[data-testid="cc-update-lines"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUT, `${theme}-4-latest-and-npm.png`) });
}

async function main() {
  if (port < 19280 || port > 19289) throw new Error('port 19280-19289');
  await assertPortFree(port);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  writeFakes(bin);
  const daemon: Daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--allow-actions']);
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
    process.exit(1);
  }, DEADLINE_MS);
  const browser = await launchBrowser();
  try {
    for (const theme of ['modern', 'pixel'] as const) {
      const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
      await ctx.addInitScript((v) => {
        try {
          localStorage.setItem('agty.ui-theme', v);
        } catch {
          /* about:blank */
        }
      }, theme);
      const page = await ctx.newPage();
      await page.goto(await daemon.loginUrl());
      await pass(page, theme, home);
      await ctx.close();
    }
    const calls = fs
      .readFileSync(path.join(home, 'fake-cli-calls.log'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { cli: string; self: string; argv: string[] });
    console.log('calls', JSON.stringify(calls));
    check(calls.length === 6, 'six update runs (claude twice and codex once, per style)');
    check(calls.every((c) => c.argv.length === 1 && c.argv[0] === 'update'), 'every run got exactly `update`');
    check(calls.every((c) => c.self === path.join(bin, c.cli)), "every run was the engine's binary");
    console.log(`\n${oks} checks passed; photos in ${OUT}`);
  } finally {
    clearTimeout(deadline);
    await browser.close();
    await daemon.stop();
    killFakeSessions(home);
    removeTestHome(home);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
