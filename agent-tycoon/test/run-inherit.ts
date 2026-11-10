/**
 * INHERIT (계승) mock-up: dist/cli.js in a temp HOME (the engine fake as `claude`), headless
 * Chromium without a GPU (launchBrowser), the isometric office with ?fx=1 (only for
 * window.__agtyFx.playing/wav: the moment itself is the live one).
 *  - alpha (Lv 3, 환생 2회, a look, a conversation) removed without the purge box (the owner's CLI);
 *  - desktop: 오케스트레이터 추가 in alpha's folder as 'tycoon', the 계승 choice (off) ticked; the
 *    계승 plays when tycoon's character appears; its StatCard and 상세 스탯 say 계승 1대째; the
 *    messenger lists tycoon with alpha's conversation and no "(알 수 없음)";
 *  - phone: tycoon removed the same way, 'tycoon-2' added in the same folder with 계승: 2대째
 *    (levels.json; the stats views are checked on the desktop).
 * Each 계승 is recorded (H.264/yuv420p mp4 with its jingle, rendered offline by the app's synth),
 * with peak stills; a GIF of the desktop one (<= 4 MB). Output: agent-tycoon/artifacts/inherit/ (only the
 * stills are committed).
 *
 *   npx tsx agent-tycoon/test/run-inherit.ts <port 18266|18267>
 */
import type { Browser, BrowserContextOptions, Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/agent-tycoon/configPath.js';
import { transcriptPath } from '../../server/src/agent-tycoon/providers/claudeProvider.js';
import {
  assertPortFree,
  engineCalls,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]) || 18266;
const BASE = `http://127.0.0.1:${port}/`;
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/inherit');
const RAW = fs.mkdtempSync(path.join(os.tmpdir(), 'inherit-video-'));
const FONT = '/mnt/c/Windows/Fonts/malgun.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__ih/malgun.ttf'); unicode-range: U+1100-11FF, U+3130-318F, U+AC00-D7A3; }`;
const HIDE = '[data-testid="fx-dev-bar"], [data-testid="update-notice"] { display: none !important; }';
const DEADLINE_MS = 420_000;
const FX_SEC = 5.2;
const LEAD_SEC = 1;
const TAIL_SEC = 1;
const GIF_MAX_MB = 4;
/** The stills: the ghost raising the flame, the hand-over, the arrival, the title. */
const PEAKS = [
  ['raise', 1.4],
  ['pass', 2.2],
  ['arrive', 2.7],
  ['title', 3.9],
] as const;
const DESKTOP: BrowserContextOptions = {
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  recordVideo: { dir: RAW, size: { width: 1280, height: 800 } },
};
const PHONE: BrowserContextOptions = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  recordVideo: { dir: RAW, size: { width: 780, height: 1688 } },
};

let oks = 0;
const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(what: string, test: () => boolean | Promise<boolean>, timeout = 30_000): Promise<void> {
  for (const end = Date.now() + timeout; ; await wait(100)) {
    if (await test()) return;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
  }
}
const ff = (args: string[]) => execFileSync('nice', ['-n', '10', 'ffmpeg', '-y', '-loglevel', 'error', ...args]);
const hook = (page: Page, call: string) => page.evaluate(`window.__agentTycoonTestHooks.${call}`);

/** 16-bit PCM mono WAV. */
function wav(rate: number, samples: number[]): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s)) * 32767), i * 2));
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

async function main() {
  if (port !== 18266 && port !== 18267) throw new Error('port 18266 or 18267');
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  const put = (rel: string, data: unknown) => {
    fs.mkdirSync(path.dirname(path.join(cfg, rel)), { recursive: true });
    fs.writeFileSync(path.join(cfg, rel), JSON.stringify(data));
  };
  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(cfg, rel), 'utf8')) as Record<string, any>;
  put('config.json', { accessChosen: true, port });
  const folders = { alpha: path.join(home, 'work', 'alpha'), beta: path.join(home, 'work', 'beta') };
  for (const f of Object.values(folders)) fs.mkdirSync(f, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude/sessions'), { recursive: true });
  put('projects.json', {
    v: 2,
    projects: [
      { projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: folders.alpha, room: '개발실', leadAssignmentId: 'a_aaaaaaaaaa' },
      { projectId: 'p_bbbbbbbbbb', name: 'beta', folder: folders.beta, room: '개발실', leadAssignmentId: 'a_bbbbbbbbbb' },
    ],
  });
  put('assignments.json', {
    v: 1,
    assignments: [
      { assignmentId: 'a_aaaaaaaaaa', projectId: 'p_aaaaaaaaaa', role: 'lead', provider: 'claude', wantRunning: true },
      { assignmentId: 'a_bbbbbbbbbb', projectId: 'p_bbbbbbbbbb', role: 'lead', provider: 'claude', wantRunning: true },
    ],
  });
  put('characters.json', { alpha: { palette: 3, hueShift: 90 }, beta: { palette: 1, hueShift: 0 } });
  put('levels.json', { v: 1, levels: { 'engine:alpha': { xp: 350, rebirths: 2 }, 'engine:beta': { xp: 120, rebirths: 1 } } });
  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, [
    '--engine',
    'on',
    '--allow-chat',
    '--allow-actions',
    '--no-terminal',
  ]);
  console.log(`daemon pid ${daemon.child.pid} on ${port}, HOME ${home}`);
  let browser: Browser | undefined;
  const pageErrors: string[] = [];
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL'); // our own daemon only
  }, DEADLINE_MS);
  try {
    const cli = (...args: string[]) =>
      JSON.parse(
        spawnSync(process.execPath, [path.join(REPO_ROOT, 'agent-tycoon/bin/agty'), ...args], {
          env: { ...process.env, HOME: home, AGTY_OUTPUT: 'json' },
          encoding: 'utf8',
          timeout: 60_000,
        }).stdout || '{}',
      ) as Record<string, unknown>;
    type Session = { name: string; cwd: string; sessionId: string };
    const session = (name: string): Session | null => {
      for (const file of fs.readdirSync(path.join(home, '.claude/sessions'))) {
        try {
          const s = JSON.parse(fs.readFileSync(path.join(home, '.claude/sessions', file), 'utf8')) as Session;
          if (s.name === name) return s;
        } catch {
          /* a fake is writing */
        }
      }
      return null;
    };
    let serial = 0;
    const say = (s: Session, role: 'user' | 'assistant', text: string) => {
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const uuid = `${(++serial).toString(16).padStart(8, '0')}-0d30-4000-8000-000000000000`;
      const message = role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] };
      fs.appendFileSync(file, `${JSON.stringify({ type: role, uuid, timestamp: new Date().toISOString(), message })}\n`);
    };
    await daemon.loginUrl();
    await eventually('both Leads revived', () => !!session('alpha') && !!session('beta'));
    const alpha = session('alpha')!;
    say(alpha, 'user', '로그인 화면 정리는 어떻게 됐어?');
    say(alpha, 'assistant', 'alpha 의 지난 대화: 로그인 화면 정리를 마쳤어요');

    /** The owner's CLI removes `name` without the purge box. */
    const remove = (name: string) => {
      const r = cli('project', 'remove', name);
      check(r.ok === true, `${name} removed without the purge box (${JSON.stringify(r).slice(0, 120)})`);
    };
    remove('alpha');
    check(!!read('levels.json').levels['engine:~a_aaaaaaaaaa'], "alpha's Lv kept under its gone name");

    browser = await launchBrowser();
    const jingle = path.join(RAW, 'inherit.wav');
    const open = async (opts: BrowserContextOptions) => {
      const ctx = await browser!.newContext(opts);
      await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;');
      await ctx.addInitScript(() => {
        try {
          localStorage.setItem('agty.office-iso', 'on');
          localStorage.setItem('agty.office-hours', '{"on":false}');
        } catch {
          /* private mode */
        }
      });
      if (fs.existsSync(FONT)) await ctx.route('**/__ih/malgun.ttf', (route) => route.fulfill({ body: fs.readFileSync(FONT), contentType: 'font/ttf' }));
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      await page.goto(await daemon.loginUrl());
      await page.waitForURL(BASE);
      const t0 = Date.now();
      await page.goto(`${BASE}?fx=1`);
      await page.addStyleTag({ content: `${FONT_CSS}\n${HIDE}` });
      await eventually('the office has its characters', async () => ((await hook(page, 'getCharacters().length')) as number) > 0, 30_000);
      await page.evaluate(() => document.fonts.load("36px 'FS Pixel Sans'", 'Aa'));
      await page.waitForTimeout(6000); // past the handshake's settle: what comes next is live
      if (!fs.existsSync(jingle)) {
        const r = (await page.evaluate("window.__agtyFx.wav('inherit')")) as { rate: number; samples: number[] };
        let last = r.samples.length - 1;
        while (last > 0 && Math.abs(r.samples[last]) < 1e-4) last--;
        const peak = r.samples.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
        fs.writeFileSync(jingle, wav(r.rate, r.samples.slice(0, last + r.rate / 10)));
        check(peak > 0.01 && peak <= 1, `the 계승 jingle: ${(last / r.rate).toFixed(2)} s, peak ${peak.toFixed(2)}`);
      }
      return { ctx, page, t0 };
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });

    /** The add dialog (open already): alpha's folder, `name`, the 계승 choice ticked, 추가. */
    const addWithInherit = async (page: Page, view: string, name: string, expect: RegExp, tap: boolean) => {
      const form = page.getByRole('form', { name: '오케스트레이터 추가' });
      await form.waitFor();
      await form.getByLabel('폴더', { exact: true }).fill(folders.alpha);
      await form.getByLabel('이름', { exact: true }).fill(name);
      const choice = form.getByTestId('inherit-choice');
      await choice.waitFor({ timeout: 10_000 });
      const text = (await choice.innerText()).replace(/\s+/g, ' ');
      check(expect.test(text), `${view}: the dialog offers 계승 (${text})`);
      check(!(await choice.getByTestId('inherit-toggle').isChecked()), `${view}: unchecked by default`);
      await shot(page, `${view}-add-dialog`);
      await (tap ? choice.getByTestId('inherit-toggle').tap() : choice.getByTestId('inherit-toggle').check());
      await shot(page, `${view}-add-dialog-checked`);
      const submit = form.getByRole('button', { name: '추가', exact: true });
      await (tap ? submit.tap() : submit.click());
      await form.waitFor({ state: 'detached', timeout: 30_000 });
    };

    /** The heir's session: its conversation file as `claude --bg` makes it (a resume into a copy;
     *  the fake only makes the new id), then the 계승 caught as it starts, the camera on it, the
     *  stills; the recording cut round it with the jingle under it. */
    const recordInherit = async (page: Page, t0: number, view: string, heir: string, from: Session, phone: boolean) => {
      await eventually(`${heir} live`, () => !!session(heir), 60_000);
      const s = session(heir)!;
      const resumed = engineCalls(home)
        .map((c) => c.argv.join(' '))
        .filter((c) => c.includes(`-n ${heir} `));
      check(resumed.some((c) => c.includes(`--resume ${from.sessionId}`)), `${heir} resumes the old conversation (${from.sessionId.slice(0, 8)})`);
      if (s.sessionId !== from.sessionId)
        fs.copyFileSync(transcriptPath(from.cwd, from.sessionId, home), transcriptPath(s.cwd, s.sessionId, home));
      let id: number | null = null;
      await eventually('the 계승 plays', async () => (id = (await page.evaluate('window.__agtyFx.playing()')) as number | null) !== null, 60_000);
      const start = (Date.now() - t0) / 1000;
      if (!phone) await hook(page, 'setZoom(4)');
      await hook(page, `follow(${id})`);
      await hook(page, 'selectAgent(null)');
      await page.mouse.move(2, 2);
      let at = 0;
      for (const [beat, sec] of PEAKS) {
        await wait((sec - at) * 1000);
        at = sec;
        await shot(page, `${view}-inherit-${beat}`);
      }
      await wait((FX_SEC - at + TAIL_SEC + 0.3) * 1000);
      check((await page.evaluate('window.__agtyFx.playing()')) === null, `${view}: the 계승 played once and ended`);
      return { start, id: id! };
    };
    const cut = async (video: string, start: number, view: string) => {
      const silent = path.join(RAW, `${view}-silent.mp4`);
      ff(['-ss', Math.max(0, start - LEAD_SEC).toFixed(2), '-i', video, '-t', (FX_SEC + LEAD_SEC + TAIL_SEC).toFixed(2), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', silent]);
      const mp4 = path.join(OUT, `${view}-inherit.mp4`);
      ff(['-i', silent, '-i', jingle, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-af', `adelay=${LEAD_SEC * 1000}:all=1,apad`, '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', mp4]);
      const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt,width,height', '-of', 'csv=p=0', mp4]).toString().trim().replace(/\n/g, ' | ');
      check(/h264,.*yuv420p/.test(probe) && /aac/.test(probe), `${path.basename(mp4)}: ${probe}`);
      return silent;
    };
    const messengerOf = (p: Page) => p.getByRole('region', { name: '메신저', exact: true });
    const contact = (p: Page, n: string) =>
      messengerOf(p).getByRole('list', { name: '연락처' }).getByRole('button', { name: new RegExp(`^${n.replace(/[()]/g, '\\$&')}( 안 읽음 \\d+)?$`) });

    // ── Desktop: add 'tycoon' with 계승 ──
    {
      const { ctx, page, t0 } = await open(DESKTOP);
      await openOfficeWindow(page);
      await page.getByRole('button', { name: '오케스트레이터 추가', exact: true }).first().click();
      await addWithInherit(page, 'desktop', 'tycoon', /이전 오케스트레이터 기록 계승하기 · Lv 3 · 환생 2회 · 대화 1개/, false);
      // the office window off the canvas while the moment plays
      const win = page.locator('[data-hud-window="office"]');
      if (await win.isVisible()) await win.getByRole('button', { name: '최소화', exact: true }).click();
      const { start } = await recordInherit(page, t0, 'desktop', 'tycoon', alpha, false);
      check(read('levels.json').levels['engine:tycoon']?.inherit === 1 && read('levels.json').levels['engine:tycoon']?.xp >= 350, 'levels.json: tycoon carries Lv 3, 계승 1');
      check(JSON.stringify(read('characters.json').tycoon) === JSON.stringify({ palette: 3, hueShift: 90 }), "tycoon wears alpha's look");

      // its stats: the StatCard tiles and the 상세 스탯 list
      await openOfficeWindow(page);
      const open1 = win.locator('article').filter({ hasText: 'tycoon' }).locator('[data-testid="stat-open"]');
      await eventually('the tycoon card opens', async () => {
        if ((await open1.count()) === 0) {
          const head = win.locator('article').filter({ hasText: 'tycoon' }).locator('h3 button').first();
          if (await head.count()) await head.click();
        }
        return (await open1.count()) > 0;
      });
      await open1.first().click();
      const detail = page.locator('[data-testid="stat-detail"]');
      await detail.waitFor({ timeout: 5_000 });
      const tile = (await detail.locator('[data-testid="stat-inherit"]').innerText()).replace(/\s+/g, ' ');
      check(/계승 1대째/.test(tile), `the StatCard: ${tile}`);
      await shot(page, 'desktop-stat-card');
      await detail.locator('[data-testid="stat-toggle"]').click();
      await detail.locator('[data-testid="stat-list"]').waitFor();
      check(/계승\s*1대째/.test(await detail.innerText()), 'the 상세 스탯 list: 계승 1대째');
      await shot(page, 'desktop-stat-list');
      // the modal's backdrop closes it; the office window goes too (the messenger opens over the office)
      await page.mouse.click(1250, 780);
      await detail.waitFor({ state: 'detached', timeout: 5_000 });
      if (await win.isVisible()) await win.getByRole('button', { name: '최소화', exact: true }).click();

      // the messenger: tycoon with alpha's conversation, no "(알 수 없음)" for alpha
      await page.getByRole('button', { name: /^메신저/ }).first().click();
      await contact(page, 'tycoon').click();
      await messengerOf(page).getByRole('region', { name: 'tycoon 대화' }).getByText('alpha 의 지난 대화: 로그인 화면 정리를 마쳤어요').waitFor({ timeout: 20_000 });
      check(true, "the messenger shows alpha's conversation under tycoon");
      check((await contact(page, '(알 수 없음)').count()) === 0, 'no "(알 수 없음)" contact left for alpha');
      await shot(page, 'desktop-messenger');
      const video = page.video()!;
      await ctx.close();
      const silent = await cut(await video.path(), start, 'desktop');
      const gif = path.join(OUT, 'inherit.gif');
      for (const [fps, w] of [
        [12, 480],
        [10, 400],
        [8, 360],
      ] as const) {
        ff(['-i', silent, '-vf', `fps=${fps},crop=800:640:240:80,scale=${w}:-1:flags=neighbor,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=none`, '-loop', '0', gif]);
        if (fs.statSync(gif).size / 1024 / 1024 <= GIF_MAX_MB) break;
      }
      const mb = fs.statSync(gif).size / 1024 / 1024;
      check(mb <= GIF_MAX_MB, `inherit.gif: ${mb.toFixed(2)} MB`);
    }

    // ── Phone: tycoon removed, 'tycoon-2' added with 계승 (2대째) ──
    {
      const tycoon = session('tycoon')!;
      remove('tycoon');
      const { ctx, page, t0 } = await open(PHONE);
      const icon = page.locator('[data-hud-id^="icon:"]').getByRole('button', { name: '현황판', exact: true });
      await icon.tap();
      await page.getByLabel('현황판 화면').getByRole('button', { name: '오케스트레이터 추가', exact: true }).tap();
      await addWithInherit(page, 'phone', 'tycoon-2', /이전 오케스트레이터 기록 계승하기 · Lv 3 · 환생 2회 · 대화 \d+개/, true);
      // back to the office before the heir's character appears
      await page.getByRole('button', { name: '사무실', exact: true }).first().tap();
      await page.getByLabel('현황판 화면').waitFor({ state: 'hidden', timeout: 5_000 });
      const { start } = await recordInherit(page, t0, 'phone', 'tycoon-2', tycoon, true);
      check(read('levels.json').levels['engine:tycoon-2']?.inherit === 2, 'levels.json: tycoon-2 is 계승 2');
      const video = page.video()!;
      await ctx.close();
      await cut(await video.path(), start, 'phone');
    }
    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
    console.log(`${oks} ok`);
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    killFakeSessions(home);
    for (const dir of [home, RAW])
      try {
        await wait(1000); // the PTY host's last writes
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`left ${dir} (${String(err)})`); // a fake still writing; never masks the result
      }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
