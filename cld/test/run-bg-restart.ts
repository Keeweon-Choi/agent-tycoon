/**
 * Background sub-agents across a daemon restart: dist/cli.js with an isolated
 * HOME on a spare port, headless Chromium (no GPU), office hours off.
 *
 * A Claude session `lead` spawns an unnamed background Agent (async launch,
 * sidecar + transcript under <projectDir>/<session>/subagents/). The temp
 * comes in; the daemon restarts (the lead is then watched from the end of its
 * transcript, the spawn is behind it); after the restart the temp is in the
 * office again, working, and its card shows +1.
 *
 *   npx tsx cld/test/run-bg-restart.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  type Daemon,
  launchBrowser,
  makeFakeHome,
  sparePort,
  startDaemon,
  waitForDaemon,
} from '../../server/src/cld/testHome.js';

const SPAWN = 'toolu_bg_restart_01';
const AGENT = 'a0b1c2d3e4f5a6b7c';

type Rec = Record<string, unknown>;
const line = (r: Rec) => JSON.stringify(r) + '\n';
const said = (content: Rec[]): Rec => ({ type: 'assistant', message: { content } });

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

const temps = (page: Page) =>
  page.$$eval('[data-testid="status-icon-anchor"][data-kind="subagent"]', (nodes) =>
    nodes.map((n) => n.getAttribute('data-phase') ?? ''),
  );

async function main() {
  const port = sparePort();
  await assertPortFree(port);
  const fake = makeFakeHome({});
  // The lead: a live Claude session (a `sleep` of ours) in /work/alpha.
  const sleeper = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = sleeper.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c0b90000-0000-4000-8000-000000000001';
  const projectDir = path.join(fake.home, '.claude/projects', normalizeProjectPath('/work/alpha'));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  const subDir = path.join(projectDir, sessionId, 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(transcript, '');
  fs.mkdirSync(path.join(fake.home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(fake.home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      cwd: '/work/alpha',
      startedAt: Date.now() - 600_000,
      procStart,
      version: '2.1.306',
      kind: 'interactive',
      name: 'lead',
      status: 'busy',
    }),
  );
  const subJsonl = path.join(subDir, `agent-${AGENT}.jsonl`);
  const subCall = (k: number) =>
    line(
      said([
        { type: 'tool_use', id: `toolu_sub_${k}`, name: 'Bash', input: { command: `make ${k}` } },
      ]),
    );

  let daemon: Daemon | null = null;
  const logs: string[] = [];
  /** Everything the daemons of this run said, the current one included. */
  const logText = () => logs.join('') + (daemon?.log.join('') ?? '');
  const start = () => {
    daemon = startDaemon(fake, port, ['--no-terminal']);
  };
  const stop = async () => {
    const d = daemon;
    daemon = null;
    if (!d) return;
    await d.stop();
    logs.push(...d.log);
  };

  const browser = await launchBrowser({ officeHours: true });
  try {
    start();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await ctx.addInitScript(
      "globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true; try { localStorage.setItem('cld.office-hours', JSON.stringify({ on: false })) } catch {}",
    );
    const page = await ctx.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.goto(await daemon!.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await until('the lead is in', async () =>
      (
        await page.$$eval('[data-testid="agent-name"]', (n) => n.map((x) => x.textContent ?? ''))
      ).includes('lead'),
    );

    // 1. The lead spawns a background sub-agent: it comes in and works.
    fs.writeFileSync(
      path.join(subDir, `agent-${AGENT}.meta.json`),
      JSON.stringify({
        agentType: 'general-purpose',
        description: 'fix login',
        toolUseId: SPAWN,
        spawnDepth: 1,
        requestShape: 'background',
      }),
    );
    fs.writeFileSync(subJsonl, subCall(1));
    fs.appendFileSync(
      transcript,
      line(
        said([
          {
            type: 'tool_use',
            id: SPAWN,
            name: 'Agent',
            input: { description: 'fix login', prompt: 'x', subagent_type: 'general-purpose' },
          },
        ]),
      ) +
        line({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: SPAWN,
                content: [
                  { type: 'text', text: `Async agent launched successfully.\nagentId: ${AGENT}` },
                ],
              },
            ],
          },
        }) +
        line({ type: 'system', subtype: 'turn_duration', durationMs: 1000 }),
    );
    await until('the temp comes in', async () => (await temps(page)).includes('working'));
    check(true, 'before the restart: the background sub-agent is a working temp');

    // 2. The daemon restarts; the sub-agent keeps working meanwhile.
    await stop();
    fs.appendFileSync(subJsonl, subCall(2));
    start();
    await until('the daemon is back', async () => {
      try {
        await waitForDaemon(port, daemon!.child.pid!, 1_000, fake.home);
        return true;
      } catch {
        return false;
      }
    });
    await page.reload();
    await until('the temp is back after the restart', async () =>
      (await temps(page)).includes('working'),
    ).catch((err) => {
      console.error(logText().split('\n').slice(-40).join('\n'));
      throw err;
    });
    check(true, 'after the restart: the background sub-agent is a working temp again');
    const chip = page
      .locator('[data-testid="agent-card"]')
      .filter({
        has: page.locator('[data-testid="card-name"]', { hasText: /^lead$/ }),
      })
      .locator('[data-testid="temp-chip"]');
    await until('+1 on the lead card', async () => (await chip.textContent()) === '+1');
    check(true, "the lead's card shows +1");
    check(
      logText().includes(`background agent recovered: ${SPAWN}`),
      'the daemon log says it recovered the spawn',
    );
    check(pageErrors.length === 0, `no page errors (${pageErrors.join('; ')})`);
  } finally {
    await browser.close();
    await stop();
    sleeper.kill();
    fs.rmSync(fake.home, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
