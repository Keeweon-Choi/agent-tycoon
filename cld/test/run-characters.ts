/**
 * CHARS-1104 check: dist/cli.js with an isolated HOME on a spare port, headless Chromium (no GPU),
 * fake sessions only (a `sleep` with a transcript we write), no model is ever called.
 *
 * characters.json is an install past CH-3: `lead` was pinned automatically to Coral. The daemon
 * re-picks it once as a built-in person ($meta v3); `lead2` (new) gets another person, the Codex
 * temporary of project alpha (an employee) its mascot. Then the office: the Leads seated (reading,
 * typing), a Task sub-agent of lead2 (a mascot, not a copy of lead2), lead's coffee after a
 * compaction, all 23 built-in people walking and at desks (1x, 2x, 4x, isometric) and the phone.
 * Screenshots: cld/artifacts/chars-1104/.
 *
 * CH-1 (then, or alone with `pin`): another HOME with five fake sessions and three engine
 * agents (two Leads, a Worker), one look chosen beforehand, the rest never chosen. The first
 * start pins every name's palette in characters.json; three restarts each draw every
 * character the same (the palette each was made with, the look the webview applies, its card
 * portrait) and write nothing. Screenshots: cld/artifacts/ch1/.
 *
 *   npx tsx cld/test/run-characters.ts <spare port> [pin]
 */
import type { Page } from '@playwright/test';
import { spawn } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CHAR_COUNT } from '../../core/src/assets/constants.js';
import { MASCOT_COLORS } from '../../core/src/cld/looks.js';
import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import { loadRegistry, registryPath, saveRegistry } from '../../server/src/cld/engine/registry.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  makeFakeHome,
  REPO_ROOT,
  seedCodexTask,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/chars-1104');

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean> | boolean, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out: ${what}`);
}

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

/** A live Claude Code session (a `sleep` of ours) named `name` in `cwd`; its transcript. */
function session(home: string, name: string, cwd: string, n: number) {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = `c1104000-0000-4000-8000-00000000000${n}`;
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

type Drawn = { id: number; isSubagent?: boolean; palette?: number };
const hook = <T>(page: Page, call: string) =>
  page.evaluate(`window.__agentTycoonTestHooks.${call}`) as Promise<T>;

/** CH-1: looks stay the same across restarts (see the header). */
async function pinAcrossRestarts(): Promise<void> {
  const out = path.join(REPO_ROOT, 'cld/artifacts/ch1');
  fs.mkdirSync(out, { recursive: true });
  const fake = makeFakeHome({ claude: 'R-8', agentsJson: true });
  const reg = registryPath(fake.home);
  const work = (n: string) => path.join(fake.home, 'work', n);
  for (const n of ['proj-a', 'proj-b']) fs.mkdirSync(work(n), { recursive: true });
  saveRegistry(reg, [
    { name: 'proj-a', folder: work('proj-a'), wantRunning: false },
    { name: 'proj-b', folder: work('proj-b'), wantRunning: false },
  ]);
  const projA = loadRegistry(reg).projects[0];
  saveRegistry(reg, [
    ...loadRegistry(reg).projects,
    {
      projectId: projA.projectId,
      role: 'worker',
      name: 'worker-a',
      folder: work('proj-a'),
      wantRunning: false,
    },
  ]);
  const store = path.join(configDirectory(fake.home), 'characters.json');
  // beta was chosen before this version; eta has a v2 look this build cannot draw yet (it is
  // drawn on its base sheet); the other six names never were chosen.
  fs.writeFileSync(
    store,
    JSON.stringify(
      {
        beta: { palette: 5, hueShift: 120 },
        // eslint-disable-next-line agent-tycoon/no-inline-colors -- a stored look's colour
        eta: { v: 2, kind: 'humanoid', base: 2, colors: { hair: '#101010' }, acc: ['cap'] },
      },
      null,
      2,
    ) + '\n',
  );
  const names = ['alpha', 'beta', 'delta', 'eta', 'theta', 'proj-a', 'proj-b', 'worker-a'];
  const browser = await launchBrowser();
  type Look = { made: string; drawn: string; card: string };
  const runs: Array<Record<string, Look>> = [];
  const files: string[] = [];
  try {
    for (let run = 0; run < 4; run++) {
      const daemon = startDaemon(fake, port, ['--no-terminal']);
      try {
        const ctx = await browser.newContext({
          viewport: { width: 1400, height: 900 },
          deviceScaleFactor: 1,
        });
        const page = await ctx.newPage();
        const frames: Array<Record<string, unknown>> = [];
        page.on('websocket', (ws) =>
          ws.on('framereceived', (f) => {
            try {
              frames.push(JSON.parse(String(f.payload)) as Record<string, unknown>);
            } catch {
              /* binary */
            }
          }),
        );
        await page.goto(await daemon.loginUrl());
        await page.waitForURL(`http://127.0.0.1:${port}/`);
        type Snap = { orchestrators: Array<{ name: string; agentId: number | null }> };
        const ids = new Map<string, number>();
        await until(
          `run ${run}: all ${names.length} characters`,
          async () => {
            const snap = [...frames].reverse().find((m) => m.type === 'officeSnapshot') as
              Snap | undefined;
            ids.clear();
            for (const o of snap?.orchestrators ?? [])
              if (o.agentId !== null) ids.set(o.name, o.agentId);
            return names.every((n) => ids.has(n));
          },
          30_000,
        );
        for (const n of names)
          await page
            .locator(`[data-testid="agent-card"][data-agent-id="${ids.get(n)}"] canvas`)
            .first()
            .waitFor();
        await page.waitForTimeout(1500); // sheets drawn, cards painted
        // The palette the daemon made each character with (agentCreated / existingAgents).
        const made = new Map<number, string>();
        for (const m of frames) {
          if (m.type === 'agentCreated')
            made.set(m.id as number, `${m.palette}:${m.hueShift ?? 0}`);
          if (m.type === 'existingAgents')
            for (const [id, meta] of Object.entries(
              m.agentMeta as Record<string, { palette?: number; hueShift?: number }>,
            ))
              made.set(Number(id), `${meta.palette}:${meta.hueShift ?? 0}`);
        }
        const presets = [...frames].reverse().find((m) => m.type === 'characterPresets') as
          | {
              assignments: Record<
                string,
                { palette?: number; hueShift?: number; base?: number; species?: string; color?: string }
              >;
            }
          | undefined;
        const looks: Record<string, Look> = {};
        for (const n of names) {
          const a = presets?.assignments[n];
          const card = await page
            .locator(`[data-testid="agent-card"][data-agent-id="${ids.get(n)}"] canvas`)
            .first()
            .evaluate((c: HTMLCanvasElement) => c.toDataURL());
          looks[n] = {
            made: made.get(ids.get(n)!) ?? '?',
            // a mascot is drawn from its own sheet over whatever palette the daemon made
            drawn: a?.species
              ? `${a.species}:${a.color}`
              : a
                ? `${a.palette ?? a.base}:${a.hueShift ?? 0}`
                : 'none',
            card: crypto.createHash('sha1').update(card).digest('hex').slice(0, 12),
          };
        }
        runs.push(looks);
        files.push(fs.readFileSync(store, 'utf-8'));
        await page.screenshot({ path: path.join(out, `restart-${run}.png`) });
        console.log(
          `run ${run}: ` +
            names
              .map(
                (n) =>
                  `${n}=${looks[n].drawn}${looks[n].made === looks[n].drawn ? '' : `(made ${looks[n].made})`}`,
              )
              .join(' '),
        );
        await ctx.close();
      } finally {
        await daemon.stop();
      }
    }
  } finally {
    await browser.close();
  }
  const pinned = JSON.parse(files[0]) as Record<
    string,
    { palette?: number; hueShift?: number; v?: number }
  >;
  // The Claude sessions are listed only once a viewer is there, after the first pin: new names
  // then, so they get the least used built-in person (CHARS-1104); the engine's names are pinned
  // at once.
  const sessions = ['alpha', 'delta', 'theta'];
  check(
    names.every((n) => n === 'eta' || pinned[n]?.palette !== undefined) &&
      sessions.every((n) => pinned[n]?.hueShift === 0) &&
      pinned.eta?.v === 2 &&
      typeof pinned.$meta === 'object',
    `first start: every name but eta has a v1 look (the Claude sessions a built-in person), eta keeps its v2 look, and $meta (${Object.keys(pinned).join(', ')})`,
  );
  check(
    pinned.beta?.palette === 5 && pinned.beta.hueShift === 120,
    'first start: the look chosen before is kept',
  );
  check(
    files.every((f) => f === files[0]),
    'restarts 1-3: characters.json not rewritten',
  );
  for (const run of [1, 2, 3])
    for (const n of names) {
      const [a, b] = [runs[0][n], runs[run][n]];
      check(
        a.drawn === b.drawn && (b.made === b.drawn || sessions.includes(n)) && a.card === b.card,
        `restart ${run}: ${n} looks the same (${b.drawn}, made with ${b.made}, same card portrait)`,
      );
    }
  fs.rmSync(fake.home, { recursive: true, force: true });
}

async function main() {
  await assertPortFree(port);
  if (process.argv[3] === 'pin') {
    await pinAcrossRestarts();
    console.log('all checks passed');
    return;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const store = path.join(configDirectory(home), 'characters.json');
  // CH-3's automatic Coral for the Lead, as a v2 file has it
  const coral = MASCOT_COLORS.coral[0];
  const today = Math.floor(Date.now() / 86_400_000);
  fs.writeFileSync(
    store,
    JSON.stringify({
      lead: { v: 2, kind: 'mascot', species: 'coral', color: coral },
      $meta: { v: 2, pinnedAt: 'x', auto: { lead: { d: today, species: 'coral', color: coral } } },
    }),
  );
  const sleeper = spawn('sleep', ['900'], { stdio: 'ignore' });
  seedCodexTask(home, {
    id: '1104-160000-alpha',
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
  const open = async (opts: Parameters<typeof browser.newContext>[0], iso = false) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;');
    await ctx.addInitScript(
      `try { localStorage.setItem('cld.office-iso', '${iso ? 'on' : 'off'}') } catch {}`,
    );
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
  const looks = () => JSON.parse(fs.readFileSync(store, 'utf-8')) as Record<string, Rec>;
  const isPerson = (l: Rec | undefined) =>
    typeof l?.palette === 'number' && l.palette < CHAR_COUNT && l.hueShift === 0;
  /** All 23 people from id 9000: every other one at a desk typing, the rest walking about. */
  const spawnAll = (page: Page) => hook<number[]>(page, `spawnLook({ palette: 0 }, ${CHAR_COUNT}, 9000)`);

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

    // The saved looks: the migration and the new rule.
    await until('the new names are pinned', () => Object.keys(looks()).some((k) => k.startsWith('emp:')));
    await until('lead2 is pinned', () => !!looks().lead2);
    const file = looks();
    check(isPerson(file.lead), `$meta v2 -> v3: the auto-pinned Coral Lead is a built-in person now (${JSON.stringify(file.lead)})`);
    check((file.$meta as Rec).v === 3, `$meta.v is 3 (${JSON.stringify(file.$meta)})`);
    check(isPerson(file.lead2) && file.lead2.palette !== file.lead.palette, `lead2 is another person (${JSON.stringify(file.lead2)})`);
    const emp = Object.entries(file).find(([k]) => k.startsWith('emp:'))!;
    check(emp[1].kind === 'mascot' && emp[1].species === 'byte', `the Codex temporary (${emp[0]}) is its mascot Byte (${JSON.stringify(emp[1])})`);

    // Work: lead reads, lead2 types (seated at their desks).
    const ids = Object.fromEntries((await plates(page)).map((p) => [p.name, p.id]));
    lead.append(said([call('tu-r', 'Read', { file_path: '/work/alpha/README.md' })], usage(170_000)));
    lead2.append(said([call('tu-w', 'Edit', { file_path: '/work/beta/a.ts' })], usage(60_000)));
    await page.waitForTimeout(6_000); // to the desks
    await shot(page, 'office-leads-seated');
    await closeUp(page, ids.lead, 'lead-reading');
    await closeUp(page, ids.lead2, 'lead2-typing');
    const codex = (await plates(page)).find((x) => x.kind === 'codex')!;
    await closeUp(page, codex.id, 'codex-temporary-mascot');

    // A sub-agent of lead2 (a Task): a mascot, not a second lead2.
    lead2.append(said([call('tu-t', 'Task', { description: 'Look around', prompt: 'look' })]));
    let sub: Drawn | undefined;
    let parent: Drawn | undefined;
    await until('lead2 has a sub-agent', async () => {
      const all = await hook<Drawn[]>(page, 'getCharacters()');
      sub = all.find((c) => c.isSubagent);
      parent = all.find((c) => c.id === ids.lead2);
      return !!sub && sub.palette !== parent?.palette;
    }, 15_000);
    check(
      sub!.palette! >= CHAR_COUNT && sub!.palette !== parent!.palette,
      `the sub-agent is drawn as a composed look (a mascot, palette ${sub!.palette}), not lead2's person (${parent!.palette})`,
    );
    const temp = (await hook<Drawn[]>(page, 'getCharacters()')).find((c) => c.id === codex.id);
    check(
      temp?.palette !== undefined && temp.palette !== sub!.palette,
      `the sub-agent and the Codex temporary are different mascots (palettes ${sub!.palette} and ${temp?.palette})`,
    );
    await page.waitForTimeout(1500);
    await hook(page, 'setZoom(4)');
    await hook(page, `centerOn(${sub!.id})`);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(1500);
    await shot(page, 'subagent-mascot-zoom4');

    // A compaction seen live: lead's context falls from 85% to 10%, it drinks at its mouth.
    await hook(page, `centerOn(${ids.lead})`);
    await page.waitForTimeout(800);
    lead.append(said([call('tu-r2', 'Read', { file_path: '/work/alpha/b.md' })], usage(20_000)));
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(400);
      await closeUp(page, ids.lead, `lead-coffee-${i}`);
    }
    // the cup at the mouth (BUILT_IN_SIP): at the machine, its drink phase
    await hook(page, `follow(${ids.lead})`);
    await until(
      'lead drinks',
      async () => (await hook<{ rest?: string } | null>(page, `getCharacterTile(${ids.lead})`))?.rest === 'drink',
      60_000,
    );
    await page.waitForTimeout(1200);
    await closeUp(page, ids.lead, 'lead-drinking');

    // All 23 people: walking and at desks, 1x, 2x and 4x.
    const spawned = await spawnAll(page);
    check(spawned.length === CHAR_COUNT, `${CHAR_COUNT} built-in people spawned`);
    await page.waitForTimeout(5_000);
    for (const zoom of [1, 2, 4]) {
      await hook(page, `setZoom(${zoom})`);
      await hook(page, `centerOn(${zoom === 4 ? 9001 : 9000})`);
      await page.mouse.move(2, 2);
      await page.waitForTimeout(1500);
      await shot(page, `people-23-zoom${zoom}`);
    }
    await hook(page, `centerOn(9002)`);
    await page.waitForTimeout(1500);
    await shot(page, 'people-23-zoom4-desk');
    const cookies = await desk.cookies();
    await desk.close();

    // Isometric, and the phone.
    for (const [name, opts, isoOn] of [
      ['people-23-iso', { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }, true],
      ['people-23-phone', { viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }, false],
    ] as const) {
      const { ctx, page: p } = await open(opts, isoOn);
      await ctx.addCookies(cookies);
      await p.goto(`http://127.0.0.1:${port}/`);
      await until('the office has its characters', async () => (await hook<Drawn[]>(p, 'getCharacters()')).length > 2);
      await p.waitForTimeout(2500);
      await spawnAll(p);
      await p.waitForTimeout(5_000);
      if (isoOn) await hook(p, 'setZoom(2)');
      await hook(p, isoOn ? 'follow(9000)' : 'centerOn(9000)');
      await p.mouse.move(2, 2);
      await p.waitForTimeout(2_000);
      await shot(p, name);
      await ctx.close();
    }

    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ')})`);
  } finally {
    await browser.close();
    started.child.kill();
    lead.proc.kill();
    lead2.proc.kill();
    sleeper.kill();
    killFakeSessions(home);
  }
  await pinAcrossRestarts();
  console.log('all checks passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
