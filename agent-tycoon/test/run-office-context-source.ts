/**
 * K2 check (Project Brain, 컨텍스트 출처): dist/cli.js with an isolated HOME on a spare port, in headless
 * Chromium (--disable-gpu). Four Claude Code sessions (a `sleep` each, as run-activity.ts does) whose
 * transcripts carry:
 * - `table`: a table model (claude-opus-5), 150k tokens: the window is picked from the model name,
 *   so the nameplate reads "≈15%" and the hover says why;
 * - `stated`: a model id ending [1m]: the CLI stated the window, "15%" with no mark;
 * - `proxy`: a model the table does not know (glm-4.6), 52k tokens: tokens only, no bar, no percent;
 * - `relay`: 300k tokens, an auto compaction (412k before, 38k after in its record), a turn, a
 *   manual one: the daemon counts two, with the time, trigger and token counts of each.
 * Checks the wire (limitBasis, agentCompactions), the nameplate and the stat card (the over-head gauge is the
 * fallback of an office with no nameplates, so it is covered by the unit tests only).
 * Hangul from Malgun Gothic (Windows font, read only). Photos go to agent-tycoon/artifacts/office-context-source/.
 *
 *   npx tsx agent-tycoon/test/run-office-context-source.ts <port 18490-18499>
 */
import type { Page } from '@playwright/test';
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
if (port < 18490 || port > 18499) throw new Error('port must be 18490-18499');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/office-context-source');
const MALGUN = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__ctxsrc/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;

type Rec = Record<string, unknown>;
const turn = (model: string, tokens: number): Rec => ({
  type: 'assistant',
  message: {
    model,
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 10, cache_read_input_tokens: tokens - 110, output_tokens: 100 },
  },
});
const boundary = (at: number, trigger: string, preTokens: number, postTokens: number): Rec => ({
  type: 'system',
  subtype: 'compact_boundary',
  timestamp: new Date(at).toISOString(),
  compactMetadata: { trigger, preTokens, postTokens },
});

const CAST: Record<string, { room: string }> = {
  table: { room: 'alpha' },
  stated: { room: 'alpha' },
  proxy: { room: 'beta' },
  relay: { room: 'beta' },
};

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

function startSessions(home: string): { procs: ChildProcess[]; transcript: Map<string, string> } {
  const procs: ChildProcess[] = [];
  const transcript = new Map<string, string>();
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  Object.entries(CAST).forEach(([name, m], i) => {
    const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
    procs.push(proc);
    const pid = proc.pid!;
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
    const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const sessionId = `c0490000-0000-4000-8000-00000000${String(i + 1).padStart(4, '0')}`;
    const cwd = `/work/${m.room}/${name}`;
    const file = path.join(home, '.claude/projects', normalizeProjectPath(cwd), `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '');
    transcript.set(name, file);
    fs.writeFileSync(
      path.join(home, '.claude/sessions', `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId,
        cwd,
        startedAt: Date.now() - 600_000 + i * 1000,
        procStart,
        version: '2.1.306',
        kind: 'interactive',
        name,
        status: 'idle',
      }),
    );
  });
  return { procs, transcript };
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({});
  const { procs, transcript } = startSessions(fake.home);
  const started = startDaemon(fake, port, ['--no-terminal']);
  const daemon = started.child;
  const received: Rec[] = [];
  const pageErrors: string[] = [];
  const font = fs.readFileSync(MALGUN);
  const browser = await launchBrowser(); // --disable-gpu is launchBrowser's own
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    await ctx.addInitScript('globalThis.__name = (fn) => fn;');
    await ctx.route('**/__ctxsrc/malgun.ttf', (r) => r.fulfill({ body: font, contentType: 'font/ttf' }));
    const page: Page = await ctx.newPage();
    page.on('websocket', (ws) =>
      ws.on('framereceived', (f) => {
        try {
          received.push(JSON.parse(String(f.payload)) as Rec);
        } catch {
          /* binary */
        }
      }),
    );
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await page.goto(await started.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가'));

    const nameOf = (id: number): string => {
      const office = [...received].reverse().find((m) => m.type === 'officeSnapshot') as
        | { orchestrators: Array<{ name: string; agentId: number | null }> }
        | undefined;
      return office?.orchestrators.find((o) => o.agentId === id)?.name ?? `#${id}`;
    };
    const idOf = (name: string): number | undefined => {
      const office = [...received].reverse().find((m) => m.type === 'officeSnapshot') as
        | { orchestrators: Array<{ name: string; agentId: number | null }> }
        | undefined;
      return office?.orchestrators.find((o) => o.name === name)?.agentId ?? undefined;
    };
    const lastOf = (type: string, id: number): Rec | undefined =>
      [...received].reverse().find((m) => m.type === type && m.id === id);
    const overlay = (id: number) => page.locator(`[data-testid="agent-overlay"][data-agent-id="${id}"]`);
    const shot = (name: string) => page.screenshot({ path: path.join(OUT, `${name}.png`) });

    await until('four characters', () => Object.keys(CAST).every((n) => idOf(n) !== undefined), 30_000);
    const id = Object.fromEntries(Object.keys(CAST).map((n) => [n, idOf(n)!])) as Record<string, number>;
    const append = (name: string, ...records: Rec[]) =>
      records.forEach((r) => fs.appendFileSync(transcript.get(name)!, JSON.stringify(r) + '\n'));

    // The turns. `relay` first reaches 300k, then compacts twice (the second after one more turn).
    append('table', turn('claude-opus-5', 150_000));
    append('stated', turn('claude-opus-4-1[1m]', 150_000));
    append('proxy', turn('glm-4.6', 52_000));
    append('relay', turn('claude-opus-5', 300_000));
    await until('all four gauges', () => Object.values(id).every((i) => lastOf('agentContextUsage', i)));
    const at1 = Date.now() - 3 * 60_000;
    const at2 = Date.now() - 60_000;
    append('relay', boundary(at1, 'auto', 412_000, 38_000), turn('claude-opus-5', 45_000));
    await until('relay: one compaction', () => (lastOf('agentCompactions', id.relay)?.count as number) === 1);
    append('relay', boundary(at2, 'manual', 61_000, 15_000));
    await until('relay: two compactions', () => (lastOf('agentCompactions', id.relay)?.count as number) === 2);

    // The wire.
    const basis = (n: string) => lastOf('agentContextUsage', id[n])?.limitBasis;
    check(basis('table') === 'estimated', `table model: limitBasis ${basis('table')}`);
    check(basis('stated') === 'reported', `[1m] model: limitBasis ${basis('stated')}`);
    check(basis('proxy') === 'unknown', `unlisted model: limitBasis ${basis('proxy')}`);
    const log = lastOf('agentCompactions', id.relay) as { count: number; partial?: boolean; recent: Rec[] };
    check(!log.partial, 'a conversation read from the start is not a floor');
    check(
      log.recent.length === 2 &&
        log.recent[0].trigger === 'auto' &&
        log.recent[0].preTokens === 412_000 &&
        log.recent[0].postTokens === 38_000 &&
        log.recent[0].at === at1 &&
        log.recent[1].trigger === 'manual' &&
        log.recent[1].at === at2,
      `relay: two compactions with their own time, trigger and tokens (${JSON.stringify(log.recent)})`,
    );
    check(
      ['table', 'stated', 'proxy'].every((n) => !lastOf('agentCompactions', id[n])),
      'a gauge that never fell: no compaction counted for the others',
    );

    // The gauges over the characters.
    await page.waitForTimeout(1_200);

    // The nameplates.
    const meter = (n: string) => overlay(id[n]).locator('[data-testid="fatigue"]');
    const words = async (n: string) => (await meter(n).first().getAttribute('aria-valuetext')) ?? '';
    check((await words('table')) === '피로도 ≈15% · 휴식 0', `table nameplate: "${await words('table')}"`);
    check((await words('stated')) === '피로도 15% · 휴식 0', `[1m] nameplate: "${await words('stated')}"`);
    check((await meter('proxy').count()) === 0, 'unknown: no fatigue bar to mislead');
    const hint = async (n: string) => (await meter(n).first().getAttribute('title')) ?? '';
    check((await hint('table')).includes('추정: 모델 이름으로'), `table: the hover says why (${await hint('table')})`);
    check((await hint('stated')) === '', '[1m]: no hover note');
    check((await words('relay')).endsWith('휴식 2'), `relay nameplate: "${await words('relay')}" (the daemon counted two)`);
    await shot('01-office-nameplates');

    // The stat cards.
    const openStat = async (n: string) => {
      await page.locator(`[data-testid="agent-card"][data-agent-id="${id[n]}"]`).click();
      await page.getByRole('menuitem', { name: '스탯' }).click({ timeout: 10_000 });
      const sheet = page.getByTestId('stat-detail');
      await sheet.waitFor({ timeout: 5_000 });
      if ((await sheet.getByTestId('stat-list').count()) === 0) await sheet.getByTestId('stat-toggle').click();
      await page.waitForTimeout(500);
      return sheet;
    };
    const closeStat = () => page.getByRole('button', { name: 'x', exact: true }).click();
    let sheet = await openStat('relay');
    const rows = async () =>
      Object.fromEntries(
        await sheet.locator('[data-row]').evaluateAll((els) =>
          els.map((e) => [e.getAttribute('data-row'), { text: e.textContent ?? '', hint: e.getAttribute('title') }]),
        ),
      ) as Record<string, { text: string; hint: string | null }>;
    let r = await rows();
    check(r.rest?.text.includes('2'), `relay stat: 휴식 ${r.rest?.text}`);
    check(
      /수동/.test(r.lastRest?.text ?? '') && /61k → 15k/.test(r.lastRest?.text ?? ''),
      `relay stat: last rest "${r.lastRest?.text}"`,
    );
    check(
      (r.lastRest?.hint?.split('\n').length ?? 0) === 3 && /자동 · 412k → 38k/.test(r.lastRest?.hint ?? ''),
      `relay stat: the hover lists both (${r.lastRest?.hint?.replace(/\n/g, ' / ')})`,
    );
    await shot('02-stat-relay-compactions');
    await closeStat();

    sheet = await openStat('table');
    r = await rows();
    check(r.fatigue?.text.includes('≈15%') && (r.fatigue?.hint ?? '').includes('추정'), `table stat: ${r.fatigue?.text}`);
    await shot('03-stat-table-estimated');
    await closeStat();

    sheet = await openStat('proxy');
    r = await rows();
    check(!r.fatigue && r.tokens?.text.includes('52k') && r.tokens.text.includes('한도 모름'), `proxy stat: ${r.tokens?.text}`);
    check(!/%/.test(r.tokens?.text ?? ''), 'proxy stat: no percent anywhere in the context row');
    await shot('04-stat-proxy-unknown');
    await closeStat();

    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
  } finally {
    await browser.close();
    if (daemon.exitCode === null) {
      const exited = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      if (daemon.exitCode === null) daemon.kill('SIGKILL');
    }
    for (const p of procs) p.kill('SIGKILL');
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
