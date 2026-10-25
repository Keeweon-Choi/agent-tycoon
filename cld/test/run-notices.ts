/**
 * T-0039 check: dist/cli.js with an isolated HOME on a spare port, in headless
 * Chromium, desktop (1280x800) and phone (393x852). The office holds the
 * engine project `veteran` and a Claude session `lead` whose transcript we
 * append to.
 * - a turn end of `lead`: the chime, a toast naming it, a pulse on the canvas,
 *   the bell's unread count; a tap on the toast has the camera follow it;
 * - a job that ended (the engine's events.jsonl): its own notice;
 * - the settings: a kind switched off and the sound muted, kept over a reload;
 * - on the phone: the toast's tap leaves the 현황판 page for the office;
 * - Web Push: a laptop subscribes (a PushManager stand-in pointing at a fake
 *   push service on https://127.0.0.1, never Apple, Google or Mozilla), looks
 *   away, gets lead's turn end encrypted (decrypted here: title, body, id,
 *   url only), its service worker shows it, the url opens the office at lead,
 *   a 410 removes the subscription; an iPhone browser gets the Home-Screen hint.
 * - T-0070: no 소식 tab; a feed event (a compaction) is a line of the 알림 list under
 *   전체 without raising the unread count; 확인 필요 shows a permission notice and hides
 *   it; the same list on the phone. Screenshots go to cld/artifacts/t0070/ too.
 * Hangul from Malgun Gothic and emoji from Segoe UI Emoji (Windows fonts, read
 * only). Screenshots go to cld/artifacts/t0039/.
 *
 *   npx tsx cld/test/run-notices.ts <port 18256-18259> <push port 18256-18259>
 *
 * Two ports: the daemon's, and the fake push service's (a different one).
 */
import type { Page } from '@playwright/test';
import type { ChildProcess } from 'child_process';
import { spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';

import { normalizeProjectPath } from '../../core/src/normalizeProjectPath.js';
import {
  assertPortFree,
  hostHealth,
  launchBrowser,
  killFakeSessions,
  makeEngineHome,
  REPO_ROOT,
  seedJob,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

if (process.argv.length < 4 || process.argv[2] === process.argv[3])
  throw new Error(
    'usage: run-notices.ts <port 18256-18259> <push port 18256-18259>: two different ports (daemon, fake push service)',
  );
const port = sparePort();
const pushPort = sparePort(3);
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0039');
const OUT70 = path.join(REPO_ROOT, 'cld/artifacts/t0070');
/** Full Chromium (headless): the headless shell refuses a service worker's
 *  showNotification ("no notification permission") even when granted. */
const CHROME =
  process.env.T0039_CHROME ??
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const FONTS = {
  malgun: '/mnt/c/Windows/Fonts/malgun.ttf',
  emoji: '/mnt/c/Windows/Fonts/seguiemj.ttf',
};
const FONT_CSS = `
@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0039/malgun.ttf');
  unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }
@font-face { font-family: 'FS Pixel Sans'; src: url('/__t0039/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
/** constants.ts NOTICE_PULSE_COLOR. */
const PULSE_RGB = [0xff, 0xd8, 0x4a];

type Rec = Record<string, unknown>;
let checks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  checks++;
  console.log(`ok - ${what}`);
}

async function until(what: string, fn: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out: ${what}`);
}

/** A throwaway self-signed certificate for 127.0.0.1, in the test HOME. */
function makeCert(home: string): { key: Buffer; cert: Buffer; certFile: string } {
  const dir = fs.mkdtempSync(path.join(home, 'tls-'));
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');
  const r = spawnSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:P-256',
    '-nodes',
    '-keyout',
    keyFile,
    '-out',
    certFile,
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-addext',
    'subjectAltName=IP:127.0.0.1',
  ]);
  if (r.status !== 0) throw new Error(`openssl: ${r.stderr}`);
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile), certFile };
}

const hkdf = (ikm: Buffer, salt: Buffer, info: string, len: number) =>
  Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), len));
/** The browser's side of RFC 8291: what the fake push service received, opened. */
function decrypt(body: Buffer, ua: crypto.ECDH, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 21 + body[20]);
  const record = body.subarray(21 + body[20]);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ua.computeSecret(asPublic), auth, info, 32));
  const d = crypto.createDecipheriv(
    'aes-128-gcm',
    hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16),
    hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12),
  );
  d.setAuthTag(record.subarray(-16));
  const plain = Buffer.concat([d.update(record.subarray(0, -16)), d.final()]);
  return plain.subarray(0, -1).toString();
}

/** `lead` as a live Claude Code session (a `sleep`) and its transcript. */
function startLead(home: string): { proc: ChildProcess; transcript: string } {
  const proc = spawn('sleep', ['900'], { stdio: 'ignore' });
  const pid = proc.pid!;
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const sessionId = 'c0390000-0000-4000-8000-000000000001';
  const cwd = '/work/alpha';
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
      name: 'lead',
      status: 'busy',
    }),
  );
  return { proc, transcript };
}

/** `lead` starts a Bash and nothing answers: the heuristic permission timer asks for approval. */
function leadAsk(transcript: string): string {
  const id = `tu-bash-${++turn}`;
  fs.appendFileSync(
    transcript,
    JSON.stringify({
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'make deploy' } }],
      },
    }) + '\n',
  );
  return id;
}
/** The answer to a tool (no turn end: that would be a second turn-end notice). */
function leadAnswer(transcript: string, id: string): void {
  fs.appendFileSync(
    transcript,
    JSON.stringify({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    }) + '\n',
  );
}

let turn = 0;
/** One turn of `lead`: a Read, its result, the turn's end. */
function leadTurn(transcript: string): void {
  const id = `tu-read-${++turn}`;
  const records: Rec[] = [
    {
      type: 'assistant',
      message: {
        model: 'claude-haiku-4-5',
        content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/work/alpha/a.md' } }],
      },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    },
    { type: 'system', subtype: 'turn_duration', durationMs: 1200 },
  ];
  for (const r of records) fs.appendFileSync(transcript, JSON.stringify(r) + '\n');
}

/** U-49: one turn of `lead` that ends with a message to the user (its last assistant text). */
function leadMessage(transcript: string, text: string): void {
  const records: Rec[] = [
    {
      type: 'assistant',
      message: { model: 'claude-haiku-4-5', content: [{ type: 'text', text }] },
    },
    { type: 'system', subtype: 'turn_duration', durationMs: 900 },
  ];
  for (const r of records) fs.appendFileSync(transcript, JSON.stringify(r) + '\n');
}

// T-0077: the 알림 list is a window (desktop) with its own ×.
const closeModal = (p: Page) => p.getByRole('button', { name: '알림 닫기' }).click();
const toast = (p: Page) => p.locator('[data-testid="notice-toast"]');
const unread = async (p: Page) => {
  const badge = p.locator('[data-testid="notice-unread"]');
  return (await badge.count()) ? Number(await badge.textContent()) : 0;
};
const sounds = (p: Page) =>
  p.evaluate(() => (window.__pixelAgentsTestHooks?.playedSounds ?? []).map((s) => s.kind));
const followed = (p: Page) =>
  p.evaluate(() => window.__pixelAgentsTestHooks?.getCameraFollowId?.() ?? null);
/**
 * T-0063: with a modal open, a label or bubble drawn at the modal's middle must stay under it.
 * Real labels let the pointer through, so a stand-in is put in the label layer (same parent,
 * the layer's top z-index, 43; fixed, so its place is the viewport's) over the modal's centre;
 * the topmost element there must be inside the modal.
 */
const modalOverLabels = (p: Page) =>
  p.evaluate(() => {
    const modal = document
      .querySelector<HTMLElement>('[data-testid="notice-view-toggle"]')!
      .closest<HTMLElement>('.overflow-y-auto')!;
    const m = modal.getBoundingClientRect();
    const real = document.querySelector<HTMLElement>('[data-testid="agent-overlay"]');
    if (!real?.parentElement) return { labels: false, onTop: false };
    const x = m.left + m.width / 2;
    const y = m.top + m.height / 2;
    const fake = document.createElement('div');
    fake.style.cssText = `position:fixed;z-index:43;width:60px;height:30px;left:${x - 30}px;top:${y - 15}px;background:#f0f`;
    real.parentElement.appendChild(fake);
    const hit = document.elementFromPoint(x, y);
    fake.remove();
    return { labels: true, onTop: !!hit && modal.contains(hit) };
  });
/** Pixels of the pulse's colour on the office canvas. */
const pulsePixels = (p: Page) =>
  p.evaluate((rgb) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="office-canvas"]')!;
    const d = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4)
      if (
        Math.abs(d[i] - rgb[0]) < 24 &&
        Math.abs(d[i + 1] - rgb[1]) < 40 &&
        Math.abs(d[i + 2] - rgb[2]) < 40
      )
        n++;
    return n;
  }, PULSE_RGB);

async function main() {
  await assertPortFree(port, pushPort);
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(OUT70, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const fake = { home };
  const vetDir = path.join(home, 'work', 'veteran');
  fs.mkdirSync(vetDir, { recursive: true });
  fs.writeFileSync(
    path.join(home, '.config/cld-gui/projects.json'),
    JSON.stringify([{ name: 'veteran', folder: vetDir, wantRunning: false }]),
  );
  // T-0043: an engine job that ended, so a job-end notice can open its card in the 작업실's Task tab.
  const jobId = seedJob(home, {
    pid: 4242,
    project: 'veteran',
    cmd: 'bash eval.sh',
    started: new Date(Date.now() - 600_000).toISOString(),
    ended: new Date(Date.now() - 300_000).toISOString(),
    exit: 0,
  });
  const { proc, transcript } = startLead(fake.home);
  const events = path.join(fake.home, '.config/cld-gui/events.jsonl');
  // Part B: a fake push service on https://127.0.0.1 (never Apple, Google or
  // Mozilla), its self-signed certificate trusted by the daemon alone.
  const tls = makeCert(fake.home);
  const pushed: Array<{ path: string; headers: Record<string, unknown>; body: Buffer }> = [];
  let pushStatus = 201;
  const pushServer = https.createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      pushed.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(pushStatus).end();
    });
  });
  await new Promise<void>((r) => pushServer.listen(pushPort, '127.0.0.1', r));
  console.log(`fake push service on ${pushPort}`);
  const started = startDaemon({ home, claudePath }, port, ['--no-terminal', '--engine', 'on'], {
    NODE_EXTRA_CA_CERTS: tls.certFile,
  });
  const daemon = started.child;
  const log = started.log;
  const pageErrors: string[] = [];
  const fonts = { malgun: fs.readFileSync(FONTS.malgun), emoji: fs.readFileSync(FONTS.emoji) };
  // The full Chrome (notifications need it); launchBrowser keeps the GPU out of it.
  const browser = await launchBrowser({ executablePath: CHROME });
  const open = async (opts: Parameters<typeof browser.newContext>[0]) => {
    const ctx = await browser.newContext(opts);
    await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__PIXEL_AGENTS_E2E = true;');
    await ctx.route('**/__t0039/*.ttf', (route) =>
      route.fulfill({
        body: route.request().url().endsWith('emoji.ttf') ? fonts.emoji : fonts.malgun,
        contentType: 'font/ttf',
      }),
    );
    const page = await ctx.newPage();
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    return { ctx, page };
  };
  const ready = async (page: Page, url?: string) => {
    if (url) {
      await page.goto(url);
      await page.waitForURL(`http://127.0.0.1:${port}/`);
    }
    await page.addStyleTag({ content: FONT_CSS });
    await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '가🔔'));
    await until('lead and veteran are in the office', async () =>
      page.evaluate(() => {
        const t = [...document.querySelectorAll('[data-testid="agent-name"]')].map(
          (n) => n.textContent,
        );
        return t.includes('lead') && t.includes('veteran');
      }),
    );
    const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
    if (await closeInfo.count()) await closeInfo.click();
  };
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });

  try {
    const loginUrl = await started.loginUrl();
    const health = await hostHealth(port, home);
    check(health.pid === daemon.pid, `the daemon on ${port} is ours (pid ${health.pid})`);
    const { ctx: desk, page } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await ready(page, loginUrl);
    await page.waitForTimeout(1_500); // the transcript watcher is on the lead

    // 1. A turn end of `lead`: chime, toast, pulse, bell.
    check((await unread(page)) === 0, 'desktop: the bell starts with nothing unread');
    // The office opens on its lobby: zoom out (Ctrl+wheel; no follow) so the lead's pulse is in view.
    const view = (await page.getByTestId('office-canvas').boundingBox())!;
    await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
    await page.keyboard.down('Control');
    for (let i = 0; i < 2; i++) await page.mouse.wheel(0, 120);
    await page.keyboard.up('Control');
    await page.waitForTimeout(800);
    leadTurn(transcript);
    await until('desktop: the toast', async () => (await toast(page).count()) > 0, 30_000);
    const text = await toast(page).textContent();
    check(text === '🔔 lead · 일을 마쳤어요', `desktop: the toast says who and what ("${text}")`);
    let most = 0;
    for (let i = 0; i < 8; i++) {
      most = Math.max(most, await pulsePixels(page));
      await page.waitForTimeout(120);
    }
    await shot(page, 'desktop-toast');
    check((await sounds(page)).includes('done'), 'desktop: the turn-end chime played');
    check((await unread(page)) === 1, 'desktop: the bell counts 1 unread');
    const leadId = Number(await toast(page).getAttribute('data-agent-id'));
    // 2. Tap the toast: the camera follows lead.
    await toast(page).click();
    check(
      (await followed(page)) === leadId && (await toast(page).count()) === 0,
      `desktop: a tap on the toast follows lead (#${leadId})`,
    );
    await page.waitForTimeout(3_500);
    const after = await pulsePixels(page);
    check(
      most >= after + 30, // zoomed out the pulse is small: a margin of a few dozen pixels
      `desktop: lead pulsed (${most} pulse-coloured px, ${after} after 3 s)`,
    );
    // Looking at lead now: the next turn end is listed as read, quietly.
    await page.keyboard.press('Escape'); // stop following; the selection stays

    // 3. A job that ended (the engine's feed): its own notice and sound.
    fs.appendFileSync(
      events,
      JSON.stringify({
        type: 'job_end',
        ts: new Date().toISOString(),
        project: 'veteran',
        id: jobId,
        pid: 4242,
        exit: 0,
      }) + '\n',
    );
    await until('desktop: the job toast', async () =>
      ((await toast(page).textContent()) ?? '').includes('작업이 끝났어요'),
    );
    check(
      (await toast(page).getAttribute('data-cause')) === 'job' &&
        (await sounds(page)).includes('job') &&
        !/4242|exit|종료 코드/.test((await toast(page).textContent()) ?? ''),
      `desktop: a job end has its own notice and sound ("${await toast(page).textContent()}")`,
    );

    // 3b. T-0043: opening the bell reads nothing; a click on the job's notice
    // reads it and opens the 작업실 at that job's card.
    check((await unread(page)) === 1, 'desktop: the clicked turn end is read, the job end not');
    await page.locator('[data-testid="notice-bell"]').click();
    check((await unread(page)) === 1, 'desktop: opening the bell reads nothing');
    await page
      .locator('[data-testid="notice-item"]')
      .filter({ hasText: '작업이 끝났어요' })
      .click();
    const card = page.locator(`[data-job-ref="${jobId}"]`);
    await card.waitFor();
    await until(
      'desktop: the job card is marked',
      async () => (await card.getAttribute('data-focused')) === 'true',
    );
    // UI-C1: the 작업실, on the job's project, Task tab; the card is drawn there.
    const bench = page.locator('[data-hud-window="workbench"]');
    check(
      (await bench.getByRole('combobox', { name: '작업실 프로젝트' }).inputValue()) === 'veteran' &&
        (await bench.getByRole('button', { name: 'Task', exact: true }).getAttribute('aria-pressed')) === 'true' &&
        (await bench.locator(`[data-job-ref="${jobId}"]`).count()) === 1 &&
        (await unread(page)) === 0,
      'desktop: a click on the job notice opens the 작업실 (veteran, Task) at its card (pid 4242) and reads it',
    );
    await shot(page, 'desktop-job-card');

    // 4. The bell's list: both, newest first.
    await page.locator('[data-testid="notice-bell"]').click();
    const lines = await page.locator('[data-testid="notice-item"]').allTextContents();
    check(
      lines.length === 2 &&
        lines[0].includes('작업이 끝났어요') &&
        lines[1].includes('lead · 일을 마쳤어요'),
      `desktop: the bell lists the notices (${lines.join(' | ')})`,
    );
    await shot(page, 'desktop-bell');

    // 4b. T-0070: the 소식 tab is gone; its events are lines of this list.
    await closeModal(page);
    check(
      (await page.getByRole('button', { name: '소식', exact: true }).count()) === 0,
      'desktop: there is no 소식 tab',
    );
    await until('desktop: the job toast is gone', async () => (await toast(page).count()) === 0);
    const unreadBefore = await unread(page);
    fs.appendFileSync(
      events,
      JSON.stringify({
        type: 'compacted',
        ts: new Date().toISOString(),
        name: 'veteran',
        count: 3,
      }) + '\n',
    );
    await page.locator('[data-testid="notice-bell"]').click();
    const compaction = page
      .locator('[data-testid="news-event"]')
      .filter({ hasText: 'veteran 휴식 3회' });
    await compaction.waitFor({ timeout: 15_000 });
    check(
      (await unread(page)) === unreadBefore && (await toast(page).count()) === 0,
      `desktop: the compaction is listed under 전체, unread stays ${unreadBefore}, no toast`,
    );
    check(
      (await page.locator('[data-testid="notice-filter-all"]').getAttribute('aria-pressed')) ===
        'true',
      'desktop: the filter row starts on 전체',
    );
    await shot(page, 'desktop-bell');
    await page.screenshot({ path: path.join(OUT70, 'desktop-news-all.png') });
    await compaction.click();
    await page.locator('[data-testid="news-detail"]').waitFor();
    check((await unread(page)) === unreadBefore, 'desktop: a tap on an event only expands it');
    await closeModal(page);
    // A permission ask of lead (7 s heuristic timer): a notice; 확인 필요 shows it, not the event.
    const askId = leadAsk(transcript);
    await page.waitForTimeout(10_000);
    await page.locator('[data-testid="notice-bell"]').click();
    const asked = page
      .locator('[data-testid="notice-item"]')
      .filter({ hasText: '허락을 기다려요' });
    await asked.waitFor({ timeout: 10_000 });
    await page.locator('[data-testid="notice-filter-attention"]').click();
    check(
      (await asked.count()) === 1 && (await compaction.count()) === 0,
      'desktop: 확인 필요 shows the permission notice and hides the compaction event',
    );
    await page.screenshot({ path: path.join(OUT70, 'desktop-news-attention.png') });
    await page.locator('[data-testid="notice-filter-job"]').click();
    check(
      (await page
        .locator('[data-testid="notice-item"]')
        .filter({ hasText: '작업이 끝났어요' })
        .count()) === 1 && (await asked.count()) === 0,
      'desktop: 작업 shows the job end, not the ask',
    );
    await page.locator('[data-testid="notice-filter-chat"]').click();
    check(
      (await page
        .locator('[data-testid="notice-item"]')
        .filter({ hasText: '일을 마쳤어요' })
        .count()) === 1 && (await page.locator('[data-testid="notice-item"]').count()) === 1,
      'desktop: 대화 shows the turn end only',
    );
    await page.locator('[data-testid="notice-filter-all"]').click();
    check(
      (await compaction.count()) === 1 && (await asked.count()) === 1,
      'desktop: 전체 shows both again',
    );
    await page.locator('[data-testid="notice-mark-all"]').click(); // the ask was unread (a notice)
    await closeModal(page);
    leadAnswer(transcript, askId);
    await page.waitForTimeout(500);
    await page.locator('[data-testid="notice-bell"]').click();
    // 5. Settings: turn ends off, sound off.
    await page.locator('[data-testid="notice-view-toggle"]').click();
    await page.getByRole('button', { name: '일을 마쳤을 때' }).click();
    await page.getByRole('button', { name: '소리', exact: true }).click();
    await shot(page, 'desktop-settings');
    const over = await modalOverLabels(page);
    check(
      over.labels && over.onTop,
      'desktop: a label over the modal stays under it (elementFromPoint at its middle is the modal)',
    );
    await closeModal(page);
    check((await unread(page)) === 0, 'desktop: nothing unread after the clicks');
    // A reload: the switches stay (localStorage); the cooldown starts over.
    await page.reload();
    await ready(page);
    await page.waitForTimeout(1_500);
    const before = (await sounds(page)).length;
    leadTurn(transcript);
    await page.waitForTimeout(4_000);
    check(
      (await toast(page).count()) === 0 && (await unread(page)) === 0,
      'desktop: with turn ends off, a turn end makes no toast and no line',
    );
    fs.appendFileSync(
      events,
      JSON.stringify({
        type: 'job_end',
        ts: new Date().toISOString(),
        project: 'veteran',
        pid: 4243,
        exit: 1,
      }) + '\n',
    );
    await until('desktop: the muted job toast', async () => (await toast(page).count()) > 0);
    check(
      (await sounds(page)).length === before,
      'desktop: muted, a notice still shows but plays no sound',
    );
    // Back on, for the phone.
    await page.locator('[data-testid="notice-bell"]').click();
    await page.locator('[data-testid="notice-view-toggle"]').click();
    await page.getByRole('button', { name: '일을 마쳤을 때' }).click();
    await page.getByRole('button', { name: '소리', exact: true }).click();
    await closeModal(page);

    // 6. The phone: a toast over the 현황판 page; its tap goes to the office.
    const { ctx: phoneCtx, page: phone } = await open({
      viewport: { width: 393, height: 852 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    await phoneCtx.addCookies(await desk.cookies());
    await phone.goto(`http://127.0.0.1:${port}/`);
    await ready(phone);
    await phone.waitForTimeout(1_500);
    await phone.locator('[data-hud-id="icon:office"] button').tap(); // T-0077: the 현황판 icon
    await phone.waitForTimeout(500);
    check(
      (await phone.locator('[aria-label$=" 화면"]:visible').count()) === 1,
      'phone: the 현황판 page is open',
    );
    leadTurn(transcript);
    await until('phone: the toast', async () => (await toast(phone).count()) > 0, 30_000);
    await shot(phone, 'phone-toast');
    await toast(phone).tap();
    await phone.waitForTimeout(800);
    check(
      (await followed(phone)) === leadId &&
        // The Dock minimizes a page (still mounted, out of sight) instead of unmounting it.
        (await phone.locator('[aria-label$=" 화면"]:visible').count()) === 0,
      'phone: a tap on the toast follows lead in the office (the 현황판 page is minimized)',
    );
    await shot(phone, 'phone-after-tap');
    await phone.locator('[data-testid="notice-bell"]').tap();
    await shot(phone, 'phone-bell');
    // T-0070: the same list on the phone, inside the screen, filters and all.
    await phone
      .locator('[data-testid="news-event"]')
      .filter({ hasText: 'veteran 휴식 3회' })
      .waitFor({ timeout: 15_000 });
    check(
      await phone.evaluate(() => {
        const list = document.querySelector<HTMLElement>('[data-testid="notice-list"]')!;
        return (
          document.documentElement.scrollWidth <= window.innerWidth &&
          list.getBoundingClientRect().right <= window.innerWidth
        );
      }),
      'phone: the 알림 list (with the compaction event) fits the screen',
    );
    await phone.screenshot({ path: path.join(OUT70, 'phone-news-all.png') });
    await phone.locator('[data-testid="notice-filter-attention"]').tap();
    // The failed job (exit 1, pid 4243) is a 확인 필요 event; the compaction is not.
    check(
      (await phone.locator('[data-testid="news-event"]').filter({ hasText: 'veteran 휴식' }).count()) ===
        0 &&
        (await phone.locator('[data-testid="news-event"]').filter({ hasText: '실패' }).count()) >=
          1,
      'phone: 확인 필요 hides the compaction event and keeps the failed job',
    );
    await phone.screenshot({ path: path.join(OUT70, 'phone-news-attention.png') });
    void desk;

    // 7. Web Push (part B). A laptop: its own login, notification permission,
    // and a PushManager stand-in whose subscription points at the fake push
    // service (a real subscribe would call Google's push service).
    const ua = crypto.createECDH('prime256v1');
    ua.generateKeys();
    const uaAuth = crypto.randomBytes(16);
    const secretPart = `laptop-${crypto.randomBytes(6).toString('hex')}`;
    const endpoint = `https://127.0.0.1:${pushPort}/push/${secretPart}`;
    const { ctx: laptop, page: lap } = await open({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
    });
    await laptop.grantPermissions(['notifications'], { origin: `http://127.0.0.1:${port}` });
    await laptop.addInitScript(
      (sub: { endpoint: string; p256dh: string; auth: string }) => {
        let current: unknown = null;
        const fakeSub = {
          endpoint: sub.endpoint,
          toJSON: () => ({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }),
          unsubscribe: async () => {
            current = null;
            return true;
          },
        };
        PushManager.prototype.subscribe = async function () {
          current = fakeSub;
          return fakeSub as unknown as PushSubscription;
        };
        PushManager.prototype.getSubscription = async function () {
          return current as PushSubscription | null;
        };
      },
      {
        endpoint,
        p256dh: ua.getPublicKey().toString('base64url'),
        auth: uaAuth.toString('base64url'),
      },
    );
    await ready(lap, await started.loginUrl());
    await lap.locator('[data-testid="notice-bell"]').click();
    await lap.locator('[data-testid="notice-view-toggle"]').click();
    const pushButton = lap.getByRole('button', { name: '알림 받기' });
    await pushButton.click();
    await until(
      'laptop: subscribed',
      async () => (await pushButton.getAttribute('aria-pressed')) === 'true',
    );
    await lap.locator('[data-testid="push-row"]').scrollIntoViewIfNeeded();
    await shot(lap, 'desktop-push-on');
    const pushFile = path.join(fake.home, '.config/cld-gui/push.json');
    const saved = JSON.parse(fs.readFileSync(pushFile, 'utf-8')) as {
      subscriptions: Array<{ endpoint: string; kinds: string[] }>;
    };
    check(
      saved.subscriptions.length === 1 &&
        saved.subscriptions[0].endpoint === endpoint &&
        (fs.statSync(pushFile).mode & 0o777) === 0o600,
      `laptop: one subscription for this device in push.json (0600, kinds ${saved.subscriptions[0]?.kinds.join(',')})`,
    );
    // The laptop looks away (its page closes): a turn end of lead is pushed.
    await lap.close();
    await new Promise((r) => setTimeout(r, 1_000));
    leadTurn(transcript);
    await until('the fake push service got a push', async () => pushed.length > 0, 30_000);
    const got = pushed[0];
    const payload = JSON.parse(decrypt(got.body, ua, uaAuth)) as Record<string, unknown>;
    check(
      JSON.stringify(payload) ===
        JSON.stringify({
          title: '🔔 lead',
          body: '일을 마쳤어요',
          agentId: leadId,
          url: `/?agent=${leadId}`,
          tag: 'turnEnd',
        }),
      `push: the payload is title, body, id, url and tag only (${JSON.stringify(payload)})`,
    );
    check(
      got.path === `/push/${secretPart}` &&
        got.headers['content-encoding'] === 'aes128gcm' &&
        String(got.headers.authorization).startsWith('vapid t=') &&
        Number(got.headers.ttl) > 0,
      'push: aes128gcm, VAPID-signed, with a TTL, to the subscription endpoint',
    );
    // U-49: a turn that ends with a message is pushed AS that message (masked preview), and the
    // service worker shows it under the sender's tag, replacing the one before it.
    const beforeMessage = pushed.length;
    leadMessage(
      transcript,
      '배포를 끝냈어요.\ntoken=ghp_abcdefghijklmnopqrstuvwxyz0123 은 쓰지 않았어요',
    );
    await until(
      'the fake push service got the message push',
      async () => pushed.length > beforeMessage,
      30_000,
    );
    const message = JSON.parse(decrypt(pushed[beforeMessage].body, ua, uaAuth)) as Record<
      string,
      unknown
    >;
    check(
      message.title === 'lead' &&
        message.body === '배포를 끝냈어요. token=*** 은 쓰지 않았어요' &&
        message.agentId === leadId &&
        message.tag === `reply:${leadId}` &&
        /^\/\?(open=chat&lead=lead|agent=\d+)/.test(String(message.url)),
      `push: the message is the push, masked (${JSON.stringify(message)})`,
    );
    await new Promise((r) => setTimeout(r, 1_500));
    check(
      pushed.length === beforeMessage + 1,
      `push: one push for the turn, not a message and a turn end (${pushed.length - beforeMessage})`,
    );
    // The notification's url opens the office at lead; the service worker shows the push.
    const lap2 = await laptop.newPage();
    lap2.on('pageerror', (err) => pageErrors.push(String(err)));
    const cdp = await laptop.newCDPSession(lap2);
    const registrations: string[] = [];
    cdp.on(
      'ServiceWorker.workerRegistrationUpdated',
      (e: { registrations: Array<{ registrationId: string; isDeleted: boolean }> }) => {
        for (const r of e.registrations) if (!r.isDeleted) registrations.push(r.registrationId);
      },
    );
    await cdp.send('ServiceWorker.enable');
    await lap2.goto(`http://127.0.0.1:${port}${String(payload.url)}`);
    await ready(lap2);
    await until('laptop: the push url follows lead', async () => (await followed(lap2)) === leadId);
    check(
      !lap2.url().includes('agent='),
      `laptop: opening the push's url (${String(payload.url)}) follows lead`,
    );
    await until('the service worker is registered', async () => registrations.length > 0);
    await until('the service worker runs', async () => laptop.serviceWorkers().length > 0);
    const sw = laptop.serviceWorkers()[0];
    // Record each showNotification call (and still show it): what the push handler asked for.
    await sw.evaluate(() => {
      const g = self as unknown as {
        registration: ServiceWorkerRegistration;
        __shown: Array<{
          title: string;
          body: string;
          agentId: unknown;
          tag?: string;
          error?: string;
        }>;
      };
      g.__shown = [];
      const show = g.registration.showNotification.bind(g.registration);
      g.registration.showNotification = (title: string, options?: NotificationOptions) => {
        const row = {
          title,
          body: options?.body ?? '',
          agentId: (options?.data as { agentId?: unknown } | undefined)?.agentId,
          tag: options?.tag,
        };
        g.__shown.push(row);
        return show(title, options).catch((err: unknown) => {
          Object.assign(row, { error: String(err) });
        });
      };
    });
    await cdp.send('ServiceWorker.deliverPushMessage', {
      origin: `http://127.0.0.1:${port}`,
      registrationId: registrations[0],
      data: JSON.stringify(payload),
    });
    let shown: Array<{
      title: string;
      body: string;
      agentId: unknown;
      tag?: string;
      error?: string;
    }> = [];
    await until('the service worker showed the notification', async () => {
      shown = await sw.evaluate(() => (self as unknown as { __shown: typeof shown }).__shown);
      return shown.length > 0;
    });
    const listed = await lap2.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration('/');
      return ((await reg?.getNotifications()) ?? []).map((n) => n.title);
    });
    console.log(`  (getNotifications in headless Chromium: ${JSON.stringify(listed)})`);
    check(
      shown[0].title === '🔔 lead' &&
        shown[0].body === '일을 마쳤어요' &&
        shown[0].agentId === leadId &&
        !shown[0].error,
      `service worker: showNotification resolved ("${shown[0].title}", "${shown[0].body}", agent ${String(shown[0].agentId)})`,
    );
    await cdp.send('ServiceWorker.deliverPushMessage', {
      origin: `http://127.0.0.1:${port}`,
      registrationId: registrations[0],
      data: JSON.stringify(message),
    });
    await until('the service worker showed the message', async () => {
      shown = await sw.evaluate(() => (self as unknown as { __shown: typeof shown }).__shown);
      return shown.length > 1;
    });
    check(
      shown[1].title === 'lead' &&
        shown[1].body === message.body &&
        shown[1].tag === `reply:${leadId}` &&
        !shown[1].error,
      `service worker: the message is shown with its title, body and tag ("${shown[1].title}", "${shown[1].body}", ${String(shown[1].tag)})`,
    );
    // The push service says the subscription is gone (410): it is removed, no retry.
    await lap2.close();
    await new Promise((r) => setTimeout(r, 1_000));
    pushStatus = 410;
    fs.appendFileSync(
      events,
      JSON.stringify({
        type: 'job_end',
        ts: new Date().toISOString(),
        project: 'veteran',
        pid: 4244,
        exit: 0,
      }) + '\n',
    );
    await until(
      'push.json lost the subscription after a 410',
      async () =>
        (JSON.parse(fs.readFileSync(pushFile, 'utf-8')) as { subscriptions: unknown[] })
          .subscriptions.length === 0,
    );
    await new Promise((r) => setTimeout(r, 1_000));
    check(
      pushed.length === beforeMessage + 2,
      `push: a 410 removed the subscription (${pushed.length} pushes)`,
    );
    check(!log.join('').includes(secretPart), 'the daemon log never names the endpoint');
    // An iPhone outside the Home-Screen app: a hint instead of the switch.
    const { ctx: iosCtx, page: ios } = await open({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    });
    await iosCtx.addCookies(await desk.cookies());
    await ios.goto(`http://127.0.0.1:${port}/`);
    await ready(ios);
    await ios.locator('[data-testid="notice-bell"]').tap();
    await ios.locator('[data-testid="notice-view-toggle"]').tap();
    await ios.locator('[data-testid="push-row"]').scrollIntoViewIfNeeded();
    const hint = (await ios.locator('[data-testid="push-hint"]').textContent()) ?? '';
    check(hint.includes('홈 화면'), `iPhone browser: a hint instead of push ("${hint}")`);
    await shot(ios, 'phone-ios-push-hint');
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
    console.log(`${checks} checks passed`);
  } catch (err) {
    console.error(log.join('').slice(-4000));
    throw err;
  } finally {
    await browser.close();
    if (daemon.exitCode === null) {
      const exited = new Promise((r) => daemon.once('exit', r));
      daemon.kill('SIGTERM');
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      if (daemon.exitCode === null) daemon.kill('SIGKILL');
    }
    proc.kill('SIGKILL');
    killFakeSessions(fake.home);
    fs.rmSync(fake.home, { recursive: true, force: true });
    pushServer.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
