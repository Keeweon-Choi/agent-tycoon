/**
 * CH-2 + CH-3 + REST-ANIM check: dist/cli.js with an isolated HOME on a spare port, headless
 * Chromium (no GPU), desktop 1280x800 and phone 393x852. Fake sessions only (a `sleep` with a
 * transcript we write), no model is ever called.
 *
 * characters.json already has `$meta` (an install past the pin migration) and one old pinned
 * name, so every name here is new: two Claude session Leads (`lead` reading, `lead2` typing)
 * get Coral in two colours, the Codex temporary of project alpha gets Byte; the old name keeps
 * its palette. Cards show the mascot faces. Then `lead`'s context drops (a compaction seen
 * live) and it drinks its coffee: a burst of close-ups.
 * Screenshots go to cld/artifacts/ch3/.
 *
 *   npx tsx cld/test/run-mascots.ts <port 18256-18259>
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { MASCOT_COLORS } from '../../core/src/cld/looks.js';
import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  seedCodexTask,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/ch3');

type Rec = Record<string, unknown>;
const said = (content: Rec[], usage?: Rec): Rec => ({
  type: 'assistant',
  message: { model: 'claude-haiku-4-5', content, ...(usage && { usage }) },
});
const call = (id: string, name: string, input: Rec) => ({ type: 'tool_use', id, name, input });
const usage = (tokens: number) => ({
  input_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: tokens,
  output_tokens: 100,
});

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

/** A live Claude Code session (a `sleep` of ours) named `name` in `cwd`; its transcript. */
function session(home: string, name: string, cwd: string, n: number) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `c1024000-0000-4000-8000-00000000000${n}`;
  const projectDir = path.join(home, '.claude/projects', normalizeProjectPath(cwd));
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(transcript, '');
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude/sessions', `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId,
      cwd,
      startedAt: Date.now() - 600_000,
      procStart,
      version: '2.1.306',
      kind: 'interactive',
      name,
      status: 'busy',
    }),
  );
  const append = (r: Rec) => fs.appendFileSync(transcript, JSON.stringify(r) + '\n');
  return { proc, append };
}

const plates = (page: Page) =>
  page.$$eval('[data-testid="agent-overlay"]', (nodes) =>
    nodes.map((n) => ({
      id: Number(n.getAttribute('data-agent-id')),
      kind: n.getAttribute('data-kind') ?? '',
      name: n.querySelector('[data-testid="agent-name"]')?.textContent ?? '',
    })),
  );

/** True when the card portrait of character `id` has a pixel of colour `hex`. */
const cardHas = (page: Page, id: number, hex: string) =>
  page
    .locator(`[data-testid="agent-card"][data-agent-id="${id}"] canvas`)
    .first()
    .evaluate((c: HTMLCanvasElement, hex: string) => {
      const want = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16));
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4)
        if (d[i + 3] > 200 && want.every((v, k) => Math.abs(d[i + k] - v) <= 2)) return true;
      return false;
    }, hex);

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const store = path.join(home, '.config/cld-gui/characters.json');
  fs.writeFileSync(
    store,
    JSON.stringify({ veteran: { palette: 2, hueShift: 0 }, $meta: { v: 2, pinnedAt: 'x' } }),
  );
  const sleeper = spawn('sleep', ['900'], { stdio: 'ignore' });
  seedCodexTask(home, {
    id: '1024-180000-alpha',
    project: 'alpha',
    state: 'running',
    spec: 'T-9.md',
    started: new Date(Date.now() - 300_000).toISOString(),
    pid: sleeper.pid!,
  });
  const lead = session(home, 'lead', '/work/alpha', 1);
  const lead2 = session(home, 'lead2', '/work/beta', 2);
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal', '--engine', 'on'], {});
  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const shot = (page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`), clip });
  /** A close-up around character `id` (its nameplate marks where it stands). */
  const closeUp = async (page: Page, id: number, name: string) => {
    const box = await page.locator(`[data-testid="agent-overlay"][data-agent-id="${id}"]`).boundingBox();
    if (!box) throw new Error(`no overlay for ${id}`);
    const cx = box.x + box.width / 2;
    await shot(page, name, { x: Math.max(0, cx - 110), y: Math.max(0, box.y - 10), width: 220, height: 170 });
  };

  try {
    const loginUrl = await started.loginUrl();
    const { ctx: desk, page } = await open({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
    await page.goto(loginUrl);
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await until('two Leads and the Codex temporary', async () => {
      const all = await plates(page);
      return ['lead', 'lead2'].every((n) => all.some((x) => x.name === n)) && all.some((x) => x.kind === 'codex');
    });
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.click();
    await page.waitForTimeout(400);
    await shot(page, 'desktop-arrive'); // walking in

    // New names got their provider's mascot, in different colours; the old pin stayed.
    const looks = () => JSON.parse(fs.readFileSync(store, 'utf-8')) as Record<string, Rec>;
    await until('the new names are pinned', async () => Object.keys(looks()).some((k) => k.startsWith('emp:')));
    const file = looks();
    const coral = (c: string) => ({ v: 2, kind: 'mascot', species: 'coral', color: c });
    check(
      JSON.stringify([file.lead, file.lead2].map((l) => l.color).sort()) ===
        JSON.stringify([MASCOT_COLORS.coral[0], MASCOT_COLORS.coral[1]].sort()) &&
        [file.lead, file.lead2].every((l) => JSON.stringify(l) === JSON.stringify(coral(String(l.color)))),
      `the two Claude Leads are Coral in two colours (${JSON.stringify([file.lead, file.lead2])})`,
    );
    const emp = Object.entries(file).find(([k]) => k.startsWith('emp:'))!;
    check(
      emp[1].kind === 'mascot' && emp[1].species === 'byte',
      `the Codex temporary (${emp[0]}) is Byte (${JSON.stringify(emp[1])})`,
    );
    check(JSON.stringify(file.veteran) === '{"palette":2,"hueShift":0}', 'the name pinned before keeps its palette');

    // Work: lead reads, lead2 types (seated at their desks).
    const ids = Object.fromEntries((await plates(page)).map((p) => [p.name, p.id]));
    lead.append(said([call('tu-r', 'Read', { file_path: '/work/alpha/README.md' })], usage(170_000)));
    lead2.append(said([call('tu-w', 'Edit', { file_path: '/work/beta/a.ts' })], usage(60_000)));
    for (const [name, color] of [
      ['lead', String(file.lead.color)],
      ['lead2', String(file.lead2.color)],
    ])
      await until(`${name}'s card shows its mascot face`, () => cardHas(page, ids[name], color));
    check(true, 'both cards show their Coral faces in their own colours');
    await page.waitForTimeout(6_000); // to the desks
    await shot(page, 'desktop-seated');
    await closeUp(page, ids.lead, 'desktop-reading-lead');
    await closeUp(page, ids.lead2, 'desktop-typing-lead2');

    // A compaction seen live: lead's context falls from 85% to 10%.
    lead.append(said([call('tu-r2', 'Read', { file_path: '/work/alpha/b.md' })], usage(20_000)));
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(400);
      await closeUp(page, ids.lead, `desktop-coffee-${i}`);
    }

    // The phone: the same looks in the office and the card bar.
    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await phoneCtx.addCookies(await desk.cookies());
    await phone.goto(`http://127.0.0.1:${port}/`);
    await until('the phone shows the Leads', async () => (await plates(phone)).some((x) => x.name === 'lead2'));
    await phone.waitForTimeout(2_000);
    await shot(phone, 'phone-office');
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
    console.log('all checks passed');
  } finally {
    await browser.close();
    started.child.kill();
    lead.proc.kill();
    lead2.proc.kill();
    sleeper.kill();
    killFakeSessions(home);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
