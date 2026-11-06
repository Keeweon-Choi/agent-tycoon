/**
 * CLONE-PROGRESS (owner 11-03 11:51), 주소로 클론 with git's real progress, end to end: dist/cli.js in
 * a temp HOME on a spare port, the engine's fake claude (never a real claude), and a slow smart-HTTP
 * git source of our own (git http-backend behind a Node server that sends the pack at ~400 KiB/s,
 * on the second port) holding a repository of ~6 MiB of random bytes.
 * Desktop (Chromium --disable-gpu, 1280x800): the clone shows its phase, a moving percentage bar,
 * the received size and speed, at most ~4 reports a second (counted on the socket), and ends in the
 * add form. Phone (390x844, touch): a second clone, 취소 mid-way: the half-made folder is gone and no
 * git of it is left running. Screenshots in cld/artifacts/clone-progress/.
 *
 *   nice -n 10 npx tsx cld/test/run-clone-progress.ts <port 18266> (the source takes port + 1)
 */
import type { Browser, Page } from '@playwright/test';
import { execFileSync, spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { makeTempRepo } from '../../server/src/cld/engine/git/testRepo.js';
import { assertPortFree, killFakeSessions, launchBrowser, makeEngineHome, REPO_ROOT, startDaemon } from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (port !== 18266) throw new Error('port: 18266 (the git source takes 18267)');
const SOURCE_PORT = port + 1;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/clone-progress');
const DEADLINE_MS = 240_000;
const RATE_BYTES = 24 * 1024;
const RATE_TICK_MS = 60;
const MIB = 1024 * 1024;
const BLOBS = 60;
let oks = 0;
const check = (ok: unknown, text: string) => {
  if (!ok) throw new Error(`check failed: ${text}`);
  oks++;
  console.log(`ok - ${text}`);
};

/** A smart-HTTP git source whose pack comes slowly (git http-backend, CGI by hand). */
function slowSource(root: string): http.Server {
  return http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    const child = spawn('git', ['http-backend'], {
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: u.pathname,
        QUERY_STRING: u.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        ...(req.headers['content-length'] && { CONTENT_LENGTH: req.headers['content-length'] }),
        ...(req.headers['content-encoding'] && { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) }),
        ...(req.headers['git-protocol'] && { GIT_PROTOCOL: String(req.headers['git-protocol']) }),
        REMOTE_ADDR: '127.0.0.1',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    req.pipe(child.stdin);
    const slow = req.method === 'POST';
    void (async () => {
      let head = Buffer.alloc(0);
      let started = false;
      for await (const b of child.stdout as AsyncIterable<Buffer>) {
        let chunk = b;
        if (!started) {
          head = Buffer.concat([head, b]);
          const at = head.indexOf('\r\n\r\n');
          if (at < 0) continue;
          const headers: Record<string, string> = {};
          let status = 200;
          for (const line of head.subarray(0, at).toString('latin1').split('\r\n')) {
            const i = line.indexOf(':');
            const [k, v] = [line.slice(0, i).trim(), line.slice(i + 1).trim()];
            if (k.toLowerCase() === 'status') status = Number(v.split(' ')[0]);
            else headers[k] = v;
          }
          res.writeHead(status, headers);
          chunk = head.subarray(at + 4);
          started = true;
        }
        // The pack (POST) at the source's rate; the ref list at once.
        const step = slow ? RATE_BYTES : Math.max(chunk.length, 1);
        for (let i = 0; i < chunk.length; i += step) {
          res.write(chunk.subarray(i, i + step));
          if (slow) await new Promise((resolve) => setTimeout(resolve, RATE_TICK_MS));
        }
      }
      if (!started) res.writeHead(500);
      res.end();
    })().catch(() => res.destroy());
    // The response closing (not the request: its 'close' comes once its body is read) ends the backend.
    res.on('close', () => child.kill());
  });
}

async function main() {
  await assertPortFree(port);
  await assertPortFree(SOURCE_PORT);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const cfg = configDirectory(home);
  fs.writeFileSync(path.join(cfg, 'config.json'), JSON.stringify({ accessChosen: true, port }));
  // The source: ~6 MiB that does not compress, so the pack takes ~15 s at the source's rate.
  const repo = makeTempRepo();
  // Many objects, so git's percent (counted in objects) moves in small steps.
  for (let i = 0; i < BLOBS; i++) repo.write(`data/blob${i}.bin`, randomBytes((6 * MIB) / BLOBS).toString('latin1'));
  repo.git(['add', '-A']);
  repo.git(['commit', '-q', '-m', 'big']);
  repo.git(['push', '-q', 'origin', 'main']);
  const source = slowSource(repo.root);
  await new Promise<void>((resolve) => source.listen(SOURCE_PORT, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${SOURCE_PORT}/remote.git`;
  const projects = path.join(home, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const PATH = [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':');
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--allow-actions', '--no-terminal'],
    { PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', LANG: 'C.UTF-8' },
    true,
  );
  console.log(`daemon pid ${daemon.child.pid} on ${port}, source ${url}, HOME ${home}`);
  let browser: Browser | undefined;
  const deadline = setTimeout(() => {
    console.error('deadline');
    daemon.child.kill('SIGKILL');
  }, DEADLINE_MS);
  try {
    await daemon.loginUrl();
    browser = await launchBrowser();
    const seen = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version.split('.').slice(0, 2).join('.');
    /** Each projectRepoProgress the page receives, with its time. */
    const reports: Array<{ t: number; phase: string }> = [];
    const newPage = async (b: Browser, opts: Parameters<Browser['newContext']>[0]) => {
      const ctx = await b.newContext(opts);
      await ctx.addInitScript((v) => localStorage.setItem('cld.changelogSeen', v), seen);
      const p = await ctx.newPage();
      p.on('websocket', (ws) =>
        ws.on('framereceived', (f) => {
          if (typeof f.payload === 'string' && f.payload.includes('"projectRepoProgress"'))
            reports.push({ t: Date.now(), phase: (JSON.parse(f.payload) as { phase: string }).phase });
        }),
      );
      await p.goto(await daemon.loginUrl());
      await p.waitForURL(`http://127.0.0.1:${port}/`);
      return p;
    };
    const shot = (p: Page, name: string) => p.screenshot({ path: path.join(OUT, `${name}.png`) });
    const openDialog = async (p: Page, phone: boolean) => {
      if (phone) {
        await p.locator('[data-dock="devroom"]').tap();
        await p.getByTestId('devroom-phone').getByTestId('devroom-add-empty').or(p.getByTestId('devroom-phone').getByTestId('devroom-add')).first().tap();
      } else {
        await p.locator('[data-hud-id="icon:devroom"] button').click();
        const win = p.locator('[data-hud-window="devroom"]');
        await win.waitFor({ timeout: 20_000 });
        await win.getByTestId('hud-title-devroom').dblclick();
        // DV4: with projects, 프로젝트 추가 is in the project menu (the rail's + makes a worktree).
        const empty = win.getByTestId('devroom-add-empty');
        if (await empty.count()) await empty.click();
        else {
          await win.getByTestId('devroom-filter').click();
          await win.getByTestId('devroom-add').click();
        }
      }
      const d = p.getByTestId('devroom-add-dialog');
      await d.waitFor();
      await d.getByTestId('devroom-add-mode-clone').click();
      await d.getByTestId('devroom-add-url').fill(url);
      return d;
    };

    // ── Desktop: the whole clone with its phases, bar, size and speed; then the add form. ──
    const desk = await newPage(browser, { viewport: { width: 1280, height: 800 } });
    const d = await openDialog(desk, false);
    await d.getByTestId('devroom-add-name').fill('slow-app');
    await d.getByTestId('devroom-add-next').click();
    const prog = d.getByTestId('devroom-add-progress');
    await desk.waitForFunction(() => {
      const el = document.querySelector('[data-testid="devroom-add-progress"]');
      const pct = Number(el?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'));
      return el?.getAttribute('data-phase') === 'receiving' && pct >= 15 && pct <= 70 && !!el.querySelector('[data-testid="devroom-add-speed"]');
    }, undefined, { timeout: 60_000 });
    const mid = await prog.innerText();
    check(/받는 중/.test(mid) && /\d+%/.test(mid) && /(KiB|MiB)\/s/.test(mid), `desktop: phase, percent, size and speed shown (${mid.replace(/\n/g, ' | ')})`);
    await shot(desk, 'desktop-receiving');
    const pctA = Number(await prog.getByRole('progressbar').getAttribute('aria-valuenow'));
    await desk.waitForTimeout(1500);
    const pctB = Number(await prog.getByRole('progressbar').getAttribute('aria-valuenow'));
    check(pctB > pctA, `desktop: the bar moves (${pctA}% -> ${pctB}%)`);
    const form = desk.getByRole('form', { name: '오케스트레이터 추가' });
    await form.waitFor({ timeout: 90_000 });
    check(fs.existsSync(path.join(projects, 'slow-app', 'data', `blob${BLOBS - 1}.bin`)), 'desktop: the clone finished and the add form took it');
    // Within one phase at most one per 250 ms (a new phase goes out at once, on top).
    const receiving = reports.filter((r) => r.phase === 'receiving').map((r) => r.t);
    const perSecond = Math.max(...receiving.map((t) => receiving.filter((u) => u >= t && u < t + 1000).length));
    const phases = [...new Set(reports.map((r) => r.phase))];
    check(receiving.length >= 8 && perSecond <= 4, `desktop: ${reports.length} progress reports (${phases.join(', ')}), at most ${perSecond} a second while receiving`);
    await shot(desk, 'desktop-done-form');
    await form.getByRole('button', { name: '취소' }).click();

    // ── Phone: a second clone, 취소 while it receives: the half folder is gone, no git left. ──
    const phone = await newPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const pd = await openDialog(phone, true);
    await pd.getByTestId('devroom-add-name').fill('stopped-app');
    await pd.getByTestId('devroom-add-next').tap();
    await phone.waitForFunction(() => {
      const el = document.querySelector('[data-testid="devroom-add-progress"]');
      return el?.getAttribute('data-phase') === 'receiving' && Number(el.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')) >= 10;
    }, undefined, { timeout: 60_000 });
    check(fs.existsSync(path.join(projects, 'stopped-app')), 'phone: the clone is writing its folder');
    await shot(phone, 'phone-receiving');
    await pd.getByTestId('devroom-add-cancel').tap();
    await pd.getByTestId('devroom-add-error').waitFor({ timeout: 20_000 });
    check((await pd.getByTestId('devroom-add-error').innerText()).includes('멈추고'), 'phone: 취소 says the clone stopped');
    check(!fs.existsSync(path.join(projects, 'stopped-app')), 'phone: the half-made folder is removed');
    let left = '';
    try {
      left = execFileSync('pgrep', ['-af', path.join(projects, 'stopped-app')], { encoding: 'utf8' });
    } catch {
      /* exit 1: nothing found */
    }
    check(!left.trim(), `phone: no git of the stopped clone is left (${left.trim() || 'none'})`);
    await shot(phone, 'phone-cancelled');
    console.log(`\n${oks} checks passed; screenshots in ${OUT}`);
  } catch (err) {
    fs.writeFileSync(path.join(os.tmpdir(), 'run-clone-progress.daemon.log'), daemon.log.join(''));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    await daemon.stop();
    source.close();
    killFakeSessions(home);
    repo.cleanup();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
