/**
 * T-0050 visual check: the top-level 파일 tab. dist/cli.js with --engine on
 * in an isolated HOME (two registered projects that never start:
 * `alpha`, and `feature`, a worktree under <project>/.claude/worktrees) and a
 * fake WSL /mnt whose C: holds a Windows user with browser profiles, .ssh and
 * an 8.3 alias. HOME also holds a fake of every never-browsable folder.
 *
 * Desktop: tab order, quick picks, folders expanding in place, the name
 * filter, every preview type, 최근 산출물, dimmed ignored files, sensitive
 * files refused, a one-use download, 다른 폴더 열기, the cached tree shown
 * before its refresh lands, the root kept over a reload (and no file name in
 * localStorage), the 현황판 row's 파일 opening the tab at that project, and the
 * refusals over the API (roots, protected folders at depth, case, symlinks,
 * `..`, encoding, 8.3, tickets, Origin, no session). Phone: the tab bar, the
 * tree, a full-screen preview clear of the insets, the picker. Every page
 * counts securitypolicyviolation events and CSP console errors: zero allowed
 * on the app; the HTML report's own blocked script is listed separately.
 *
 *   npx tsx cld/test/run-files.ts <port 18256-18259>
 */
import type { Browser, BrowserContextOptions, Locator, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';

import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0050');
const CHROME =
  process.env.T0050_CHROME ??
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const SAFE_AREA = ':root { --cld-safe-top: 47px !important; --cld-safe-bottom: 34px !important; }';
const DEADLINE_MS = 300_000;
const IPHONE13 = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();
const SECRET = 'T0050-SECRET-CONTENT';
/** Tree rows, not the 최근 산출물 list above them. */
const TREE_BUTTON = 'button:not([aria-label="최근 산출물"] button)';

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

function write(file: string, body: string | Buffer): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function png(): Buffer {
  const img = new PNG({ width: 64, height: 32 });
  for (let i = 0; i < 64 * 32; i++) {
    const x = i % 64;
    img.data.set([x * 4, 120, 255 - x * 4, 255], i * 4);
  }
  return PNG.sync.write(img);
}

/** A one-page PDF with a line of text, xref offsets computed. */
function pdf(): Buffer {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length 44 >>\nstream\nBT /F1 18 Tf 20 60 Td (T0050 PDF) Tj ET\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  const mnt = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-t0050-mnt-'));
  const h = (p: string) => path.join(home, p);
  fs.mkdirSync(h('.claude/sessions'), { recursive: true });

  // ── Never-browsable folders, each with a secret in it ──
  for (const p of [
    '.ssh/id_rsa',
    '.ssh/config',
    '.claude/.credentials.json',
    '.local/share/office/run/state.json',
    '.aws/credentials',
    '.gnupg/pubring.kbx',
    '.kube/config',
    '.docker/config.json',
    '.azure/accessTokens.json',
    '.config/gcloud/credentials.db',
    '.config/google-chrome/Default/Cookies',
    '.mozilla/firefox/profile/key4.db',
    '.codex/auth.json',
    '.config/gh/hosts.yml',
  ])
    write(h(p), SECRET);
  write(path.join(configDirectory(home), 'secret.json'), SECRET);
  write(h('.local/share/office/notes.txt'), 'office notes');
  write(h('.config/app/settings.ini'), 'theme=dark');

  // ── alpha: every preview type, secrets, ignored folders, symlinks out ──
  const alpha = h('work/alpha');
  spawnSync('git', ['init', '-q', alpha], { env: { ...process.env, HOME: home } });
  write(path.join(alpha, '.gitignore'), 'node_modules/\nbuild/\n');
  write(
    path.join(alpha, 'docs/deep/notes.md'),
    '# 노트\n\n깊은 폴더의 **마크다운**.\n\n- 하나\n- 둘\n',
  );
  write(path.join(alpha, 'data.csv'), 'name,count\nalpha,3\nbeta,5\n');
  write(path.join(alpha, 'data.json'), JSON.stringify({ project: 'alpha', items: [1, 2, 3] }));
  write(
    path.join(alpha, 'report.html'),
    '<!doctype html><style>h1{color:#c33}</style><h1>T0050 report</h1><script>document.body.append("ran")</script>',
  );
  write(
    path.join(alpha, 'logo.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#3a6"/><script>alert(1)</script></svg>',
  );
  write(path.join(alpha, 'artifacts/chart.png'), png());
  write(path.join(alpha, 'doc.pdf'), pdf());
  write(path.join(alpha, 'src/main.ts'), 'export const answer = 42;\n');
  for (const s of ['.env', 'vault.kdbx', 'cert.p12', 'id.PFX', 'office.ovpn', 'login.keychain-db'])
    write(path.join(alpha, s), SECRET);
  write(path.join(alpha, 'node_modules/pkg/index.js'), 'module.exports = 1;');
  write(path.join(alpha, 'build/out.txt'), 'built');
  fs.symlinkSync(h('.ssh'), path.join(alpha, 'escape'));
  fs.symlinkSync('/etc/hostname', path.join(alpha, 'etc-link'));
  fs.mkdirSync(path.join(alpha, 'Inner/.GIT'), { recursive: true });
  write(path.join(alpha, 'Inner/.GIT/config'), SECRET);

  // ── feature: a worktree under a project's .claude folder ──
  const feature = h('work/app/.claude/worktrees/feature');
  write(path.join(feature, 'README.md'), '# feature worktree\n');
  write(path.join(feature, '.claude/settings.local.json'), SECRET);

  // ── an unregistered folder for 다른 폴더 열기 ──
  const misc = h('work/misc');
  write(path.join(misc, 'todo.txt'), 'buy milk\n');
  write(path.join(misc, '.AWS/credentials'), SECRET);
  write(path.join(misc, '.config/GCLOUD/key.json'), SECRET);

  // ── the fake C: drive ──
  const bob = path.join(mnt, 'c/Users/Bob');
  for (const p of [
    'AppData/Local/Google/Chrome/User Data/Default/Cookies',
    'AppData/Local/Microsoft/Edge/User Data/Default/Cookies',
    'AppData/Roaming/Mozilla/Firefox/key4.db',
    '.ssh/id_ed25519',
    'SSH~1/id_ed25519', // stands in for the alias drvfs resolves to .ssh
  ])
    write(path.join(bob, p), SECRET);
  write(path.join(bob, 'Documents/report.md'), '# Windows report\n');

  fs.mkdirSync(configDirectory(home), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify([
      { name: 'alpha', folder: alpha, room: '개발실', wantRunning: false },
      { name: 'feature', folder: feature, room: '개발실', wantRunning: false },
    ]),
  );
  const daemon = startDaemon(
    { home, claudePath: path.join(bin, 'claude') },
    port,
    ['--engine', 'on', '--allow-chat', '--no-terminal'],
    { CLD_GUI_TEST_HOST: JSON.stringify({ os: 'wsl', mnt, distro: 'Test' }) },
  );
  const { child: server, log: serverLog } = daemon;
  const loginUrl = daemon.loginUrl();
  const cleanup = () => {
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(mnt, { recursive: true, force: true });
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    cleanup();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));
  process.once('uncaughtException', (err) => abort(String(err)));
  process.once('unhandledRejection', (err) => abort(String(err)));

  let browser: Browser | undefined;
  const csp: string[] = [];
  const frameCsp: string[] = [];
  let current: Page | undefined;
  const shot = (page: Page, name: string) =>
    page.screenshot({ path: path.join(OUT, `${name}.png`) });
  const watchCsp = (page: Page, view: string) => {
    page.on('console', (msg) => {
      if (!/Content Security Policy/i.test(msg.text())) return;
      const url = msg.location().url;
      // The report's own script, refused inside its sandboxed frame, is the point.
      if (url.includes('/api/cld/files/content/'))
        frameCsp.push(`${view}: ${msg.text().slice(0, 160)}`);
      else csp.push(`${view} console: ${msg.text().slice(0, 200)} @ ${url}`);
    });
  };
  const appViolations = async (page: Page) =>
    page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
  try {
    const url = await loginUrl;
    browser = await launchBrowser({ executablePath: CHROME });
    const open = async (opts: BrowserContextOptions, view: string) => {
      const ctx = await browser!.newContext({ ...opts, acceptDownloads: true });
      await ctx.addInitScript(() => {
        const w = window as unknown as { __csp: string[] };
        w.__csp = [];
        document.addEventListener('securitypolicyviolation', (e) =>
          w.__csp.push(`${e.violatedDirective} ${e.blockedURI} ${location.pathname}`),
        );
      });
      const page = await ctx.newPage();
      current = page;
      watchCsp(page, view);
      return { ctx, page };
    };

    // ── Desktop ──
    const { ctx: dctx, page } = await open({ viewport: { width: 1440, height: 900 } }, 'desktop');
    await page.goto(url);
    const nav = page.getByRole('navigation', { name: '사무실 메뉴' });
    // The window opens by itself on a wide screen; else its icon (T-0077).
    const drawer = async () => {
      const icon = page
        .locator('[data-hud-id^="icon:"]')
        .getByRole('button', { name: '현황판', exact: true });
      await icon.waitFor();
      if (!(await nav.isVisible())) await icon.click();
      await nav.waitFor();
    };
    await drawer();
    const tabs = (await nav.getByRole('button').allInnerTexts()).map((t) => t.trim());
    check(
      JSON.stringify(tabs) === JSON.stringify(['현황판', 'HW']),
      `desktop tabs: 현황판 and HW only; 파일, 터미널, 메신저 and the 작업실 are icons (${tabs.join(' | ')})`,
    );
    // UI-C1: 파일 is the folder icon's mode of the window: no tab strip, titled 파일.
    const filesIcon = page.locator('[data-hud-id="icon:files"] button');
    await filesIcon.click();
    check(
      (await nav.count()) === 0 && (await page.locator('[data-hud-window="office"]').getAttribute('aria-label')) === '파일',
      'desktop: the folder icon opens the window as 파일, without a tab strip',
    );
    const explorer = page
      .getByRole('region', { name: '파일 탐색' })
      .or(page.locator('section[aria-label="파일 탐색"]'));
    await explorer.waitFor();
    const pick = (name: string) =>
      explorer.locator('button[aria-pressed]').filter({ hasText: new RegExp(`^${name}$`) });
    await pick('alpha').click();
    check(
      (await pick('alpha').getAttribute('aria-pressed')) === 'true',
      'quick picks: alpha chosen',
    );
    check(
      await pick('feature').isVisible(),
      'quick picks: the .claude worktree project is offered',
    );
    const tree = explorer.locator('[aria-label$="파일 탐색기"]');
    const esc = (n: string) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const node = (name: string) =>
      tree.locator(TREE_BUTTON).filter({ hasText: new RegExp(`^[▸▾▤]\\s*${esc(name)}$`) });
    await node('docs').waitFor();
    const top = (await tree.locator(TREE_BUTTON).allInnerTexts()).map((t) =>
      t.replace(/^[▸▾▤]\s*/, '').trim(),
    );
    for (const name of ['docs', 'artifacts', 'node_modules', 'data.csv', 'report.html'])
      check(top.includes(name), `alpha tree lists ${name}`);
    for (const name of ['.env', '.git', 'escape', 'etc-link'])
      check(!top.includes(name), `alpha tree hides ${name}`);
    check(
      (await node('node_modules').getAttribute('class'))?.includes('opacity-50'),
      'a git-ignored folder is dimmed, not hidden',
    );
    await node('docs').click();
    await node('deep').click();
    await node('notes.md').click();
    const pane = page.locator('[aria-label="파일 미리보기"]');
    await pane.getByText('깊은 폴더의').waitFor();
    check(true, 'folders expand in place; markdown previews on the right');
    const paneBox = await pane.boundingBox();
    const treeBox = await tree.locator('> div').first().boundingBox();
    check(
      paneBox && treeBox && paneBox.x > treeBox.x + treeBox.width - 2,
      'tree left, preview right',
    );
    await shot(page, 'desktop-tree-markdown');

    await explorer.getByRole('searchbox', { name: '파일 이름 필터' }).fill('NOTES');
    const filtered = (await tree.locator(TREE_BUTTON).allInnerTexts()).filter((t) =>
      t.startsWith('▤'),
    );
    check(
      filtered.length === 1 && filtered[0].includes('notes.md'),
      `name filter keeps notes.md only (${filtered.join(',')})`,
    );
    await shot(page, 'desktop-filter');
    await explorer.getByRole('searchbox', { name: '파일 이름 필터' }).fill('');

    const recent = explorer.getByText('최근 산출물 · 24시간');
    check(await recent.isVisible(), '최근 산출물 is listed for a project root');

    const previews: [string, (p: Locator) => Promise<unknown>][] = [
      ['data.csv', (p) => p.locator('table td', { hasText: 'beta' }).waitFor()],
      ['data.json', (p) => p.getByText('"items"').first().waitFor()],
      ['report.html', (p) => p.locator('iframe[sandbox=""]').waitFor()],
      ['logo.svg', (p) => p.locator('img[src^="/api/cld/files/content/"]').waitFor()],
      ['doc.pdf', (p) => p.locator('iframe[src^="/api/cld/files/content/"]').waitFor()],
    ];
    for (const [name, ready] of previews) {
      await node(name).click();
      await ready(pane);
      await page.waitForTimeout(name === 'doc.pdf' || name === 'report.html' ? 1500 : 300);
      check(true, `preview ${name}`);
      await shot(page, `desktop-preview-${name.replace('.', '-')}`);
    }
    const reportFrame = page.frames().find((f) => f.url().includes('/api/cld/files/content/'));
    check(reportFrame !== undefined, 'the report loads in its frame');
    await node('artifacts').click();
    await node('chart.png').click();
    await pane.locator('img').waitFor();
    check(
      await pane
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 64),
      'chart.png renders (64 px wide)',
    );
    await shot(page, 'desktop-preview-chart-png');
    await node('src').click();
    await node('main.ts').click();
    await pane.getByText('export const answer').waitFor();
    check(true, 'preview main.ts as text');

    // Sensitive files: listed with hidden on, refused when opened.
    await explorer.getByLabel('숨김 파일').check();
    for (const name of [
      '.env',
      'vault.kdbx',
      'cert.p12',
      'id.PFX',
      'office.ovpn',
      'login.keychain-db',
    ]) {
      await node(name).click();
      await pane.getByRole('alert').waitFor();
      check(
        /민감한 파일/.test(await pane.getByRole('alert').innerText()),
        `${name} preview refused`,
      );
    }
    await shot(page, 'desktop-sensitive-refused');
    const hiddenTop = (await tree.locator(TREE_BUTTON).allInnerTexts()).map((t) =>
      t.replace(/^[▸▾▤]\s*/, '').trim(),
    );
    check(
      !hiddenTop.includes('.git') && !hiddenTop.includes('escape'),
      'hidden on: still no .git, no symlink to ~/.ssh',
    );
    await node('Inner').click();
    check(
      (await tree.getByRole('button', { name: /\.GIT/ }).count()) === 0,
      '.GIT at depth, odd case, not listed',
    );
    await explorer.getByLabel('숨김 파일').uncheck();

    // Download once; the same URL again is gone.
    await node('data.csv').click();
    await pane.locator('table').waitFor();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      pane.getByRole('button', { name: '다운로드' }).click(),
    ]);
    const saved = path.join(home, 'dl.csv');
    await download.saveAs(saved);
    check(fs.readFileSync(saved, 'utf-8').startsWith('name,count'), 'download delivers data.csv');
    const reuse = await page.evaluate(async () => {
      const r = await fetch('/api/cld/files/alpha/ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: 'data.csv', mode: 'download' }),
      });
      const { url } = (await r.json()) as { url: string };
      return [(await fetch(url)).status, (await fetch(url)).status];
    });
    check(reuse[0] === 200 && reuse[1] === 404, `a ticket works once (${reuse.join(', ')})`);

    // 다른 폴더 열기 → work/misc.
    await explorer.getByRole('button', { name: '다른 폴더 열기' }).click();
    const picker = page.getByRole('dialog').or(page.locator('[aria-label="폴더 고르기"]')).last();
    const sub = picker.locator('ul[aria-label="하위 폴더"]');
    await sub.getByRole('button', { name: '▸ work' }).click();
    await sub.getByRole('button', { name: '▸ misc' }).click();
    await picker.getByLabel('숨김 폴더').check();
    await page.waitForTimeout(300);
    const pickerNames = await sub.getByRole('button').allInnerTexts();
    check(
      !pickerNames.some((n) => /GCLOUD|\.AWS/i.test(n)),
      `picker hides .AWS (${pickerNames.join(',')})`,
    );
    await shot(page, 'desktop-picker');
    await picker.getByRole('button', { name: '이 폴더 선택' }).click();
    await node('todo.txt').waitFor();
    check(await explorer.getByText(misc, { exact: true }).isVisible(), 'chosen folder is the root');
    await node('todo.txt').click();
    await pane.getByText('buy milk').waitFor();
    check(true, 'chosen folder previews todo.txt');
    await explorer.getByLabel('숨김 파일').check();
    await node('.config').click();
    await page.waitForTimeout(500);
    const miscNames = (await tree.locator(TREE_BUTTON).allInnerTexts()).join('|');
    check(
      !/\.AWS|GCLOUD/i.test(miscNames),
      `chosen folder hides .AWS and .config/GCLOUD (${miscNames})`,
    );
    await explorer.getByLabel('숨김 파일').uncheck();
    await shot(page, 'desktop-other-folder');

    // Back to alpha: the cached tree shows before its (delayed) refresh lands.
    let held = 0;
    await page.route('**/api/cld/files/alpha/list**', async (route) => {
      held++;
      await new Promise((r) => setTimeout(r, 2000));
      await route.continue().catch(() => undefined); // unrouted meanwhile
    });
    const t0 = Date.now();
    await pick('alpha').click();
    await node('docs').waitFor({ timeout: 1500 });
    const shownMs = Date.now() - t0;
    check(
      held > 0 && shownMs < 1500,
      `cached alpha tree shown in ${shownMs} ms while the refresh is held`,
    );
    await page.unroute('**/api/cld/files/alpha/list**');

    // The root survives a reload; localStorage holds the root, never a file name.
    await pick('feature').click();
    await node('README.md').waitFor();
    check(true, 'the .claude worktree project browses');
    const featureNames = (await tree.locator(TREE_BUTTON).allInnerTexts()).join('|');
    await explorer.getByLabel('숨김 파일').check();
    await page.waitForTimeout(400);
    check(
      !(await tree.locator(TREE_BUTTON).allInnerTexts()).join('|').includes('.claude'),
      `.claude below the worktree root stays hidden (${featureNames})`,
    );
    await explorer.getByLabel('숨김 파일').uncheck();
    await page.reload();
    await drawer();
    await filesIcon.click();
    await node('README.md').waitFor();
    check(
      (await pick('feature').getAttribute('aria-pressed')) === 'true',
      'chosen root kept across a reload',
    );
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    check(
      stored.includes('cld.files.root.v1') &&
        !/notes\.md|todo\.txt|data\.csv|README\.md|chart\.png/.test(stored),
      'localStorage: the root only, no file names',
    );

    // A 현황판 row's 파일 opens the tab at that project.
    await page.locator('[data-hud-id="icon:office"] button').click(); // back to the board tabs
    const row = page.locator('article', {
      has: page.getByRole('button', { name: 'alpha', exact: true }),
    });
    await row.getByRole('button', { name: '파일', exact: true }).first().click();
    await explorer.waitFor();
    check(
      (await pick('alpha').getAttribute('aria-pressed')) === 'true',
      '현황판 row 파일 → 파일 tab at alpha',
    );
    await shot(page, 'desktop-from-status-row');

    // ── API refusals, from a second logged-in device (its own 120/min budget) ──
    const { ctx: actx, page: apage } = await open({ viewport: { width: 800, height: 600 } }, 'api');
    await apage.goto(await daemon.loginUrl());
    const api = apage.request;
    const status = async (u: string) => {
      const s = (await api.get(`http://127.0.0.1:${port}${u}`)).status();
      if (s === 429) throw new Error('rate limited: a refusal must not be a 429');
      return s;
    };
    const enc = encodeURIComponent;
    const F = '/api/cld/files/~folder';
    for (const root of [
      '/etc',
      '/tmp',
      '/',
      os.tmpdir(),
      h('.ssh'),
      h('.SSH'),
      h('.claude'),
      h('.ClAuDe/sessions'),
      configDirectory(home),
      configDirectory(home).toUpperCase(),
      h('.pixel-agents'),
      h('.aws'),
      h('.gnupg'),
      h('.kube'),
      h('.docker'),
      h('.azure'),
      h('.config/gcloud'),
      h('.config/google-chrome'),
      h('.mozilla'),
      h('.codex'),
      h('.config/gh'),
      h('work/../.ssh'),
      h('work/alpha/escape'),
      h('work/alpha/.git'),
      h('work/alpha/Inner/.GIT'),
      h('work/misc/.AWS'),
      path.join(bob, 'AppData/Local/Google/Chrome/User Data'),
      path.join(bob, 'appdata/local/microsoft/edge/user data/Default'),
      path.join(bob, 'AppData/Roaming/Mozilla'),
      path.join(bob, '.ssh'),
      path.join(bob, 'SSH~1'),
    ]) {
      check(
        (await status(`${F}/list?root=${enc(root)}`)) === 403,
        `root refused: ${root.replace(home, '~')}`,
      );
      check(
        (await status(`${F}/list?root=${enc(enc(root))}`)) === 403,
        `double-encoded root refused: ${root.replace(home, '~')}`,
      );
    }
    const homeList = await (
      await api.get(`http://127.0.0.1:${port}${F}/list?root=${enc(home)}&hidden=1&limit=1000`)
    ).json();
    const homeNames = (homeList.entries as { name: string }[]).map((e) => e.name);
    for (const n of [
      '.ssh',
      '.claude',
      '.pixel-agents',
      '.aws',
      '.gnupg',
      '.kube',
      '.docker',
      '.azure',
      '.mozilla',
      '.codex',
    ])
      check(!homeNames.includes(n), `home root lists no ${n}`);
    const cfg = await (
      await api.get(`http://127.0.0.1:${port}${F}/list?root=${enc(home)}&path=.config&hidden=1`)
    ).json();
    check(
      JSON.stringify((cfg.entries as { name: string }[]).map((e) => e.name)) === '["app"]',
      `~/.config shows app only (${JSON.stringify(cfg.entries.map((e: { name: string }) => e.name))})`,
    );
    const bobList = await (
      await api.get(`http://127.0.0.1:${port}${F}/list?root=${enc(bob)}&hidden=1`)
    ).json();
    check(
      JSON.stringify((bobList.entries as { name: string }[]).map((e) => e.name)) ===
        '["AppData","Documents"]',
      `Windows user root: AppData and Documents only (${JSON.stringify(bobList.entries.map((e: { name: string }) => e.name))})`,
    );
    for (const [root, rel] of [
      [home, '.ssh/config'],
      [home, '.SSH/config'],
      [home, '.claude/.credentials.json'],
      [configDirectory(home), 'secret.json'],
      [home, '.pixel-agents/standalone-token'],
      [home, 'work/alpha/escape/config'],
      [home, 'work/../.ssh/config'],
      [home, 'work/%2E%2E/.ssh/config'],
      [home, '..%2F..%2Fetc/hostname'],
      [home, 'work/alpha/Inner/.GIT/config'],
      [alpha, 'etc-link'],
      [feature, '.claude/settings.local.json'],
      [bob, 'AppData/Local/Google/Chrome/User Data/Default/Cookies'],
      [bob, 'SSH~1/id_ed25519'],
      [bob, 'appdata/roaming/mozilla/Firefox/key4.db'],
    ]) {
      const s = await status(
        `${F}/preview?root=${enc(root)}&path=${rel.includes('%') ? rel : enc(rel)}`,
      );
      check(s === 403 || s === 404, `preview refused (${s}): ${root.replace(home, '~')} :: ${rel}`);
    }
    const post = (
      body: unknown,
      headers: Record<string, string> = { origin: `http://127.0.0.1:${port}` },
    ) => api.post(`http://127.0.0.1:${port}${F}/ticket`, { data: body, headers });
    for (const [root, rel] of [
      [alpha, '.env'],
      [alpha, 'vault.kdbx'],
      [alpha, 'cert.p12'],
      [alpha, 'office.ovpn'],
      [alpha, 'escape/id_rsa'],
      [home, '.ssh/id_rsa'],
      [h('.ssh'), 'id_rsa'],
      [bob, 'SSH~1/id_ed25519'],
    ])
      check(
        (await post({ root, path: rel, mode: 'download' })).status() === 403,
        `ticket refused: ${rel}`,
      );
    check(
      (await post({ root: misc, path: 'todo.txt', mode: 'download' }, {})).status() === 403,
      'ticket without Origin refused',
    );
    const ok = await post({ root: misc, path: 'todo.txt', mode: 'download' });
    check(ok.status() === 200, 'a chosen-folder ticket with Origin works');
    const anon = await browser.newContext();
    check(
      (await anon.request.get(`http://127.0.0.1:${port}${F}/list?root=${enc(misc)}`)).status() ===
        401,
      'no session: 401',
    );
    await anon.close();
    const audit = serverLog
      .join('')
      .split('\n')
      .filter((l) => l.includes('[cld files]'));
    check(
      audit.some(
        (l) => l.includes(`project=${JSON.stringify(misc)}`) && l.includes('path="todo.txt"'),
      ),
      'audit names the chosen root and the file',
    );
    check(
      !serverLog.join('').includes('buy milk') && !serverLog.join('').includes(SECRET),
      'audit carries no contents',
    );
    check(
      (await appViolations(page)).length === 0,
      `desktop: no securitypolicyviolation (${(await appViolations(page)).join('; ')})`,
    );
    await dctx.close();
    // Control: the listener does see a violation when one happens.
    await apage.evaluate(() => {
      const el = document.createElement('script');
      el.textContent = 'window.__ran = 1';
      document.body.append(el);
    });
    await apage.waitForTimeout(200);
    check(
      (await appViolations(apage)).some((v) => v.startsWith('script-src')),
      'control: an inline script is caught as a violation',
    );
    csp.splice(0, csp.length, ...csp.filter((l) => !l.startsWith('api console')));
    await actx.close();

    // ── Phone ──
    const { ctx: pctx, page: phone } = await open(IPHONE13, 'phone');
    await phone.goto(await daemon.loginUrl()); // a login code works once
    // T-0077: no tab bar: the floating icons open the pages, whose menu holds HW and 파일.
    const icons = phone.locator('[data-hud-id^="icon:"] button');
    await icons.first().waitFor();
    await phone.addStyleTag({ content: SAFE_AREA });
    const picons = await icons.evaluateAll((els) => els.map((e) => e.getAttribute('title') ?? ''));
    check(
      JSON.stringify(picons.slice(0, 3)) === JSON.stringify(['현황판', '작업실', '메신저']),
      `phone icons (${picons.join(' | ')})`,
    );
    await icons.first().click(); // 현황판
    const bar = phone.getByRole('navigation', { name: '작업 메뉴' });
    const ptabs = (await bar.getByRole('button').allInnerTexts()).map((t) => t.trim());
    check(
      JSON.stringify(ptabs) === JSON.stringify(['현황판', 'HW']),
      `phone 현황판 page menu: 현황판 and HW (${ptabs.join(' | ')})`,
    );
    await phone.locator('[data-hud-id="icon:files"] button').click(); // UI-C1: 파일 is the folder's page
    const pexp = phone.locator('section[aria-label="파일 탐색"]');
    await pexp.waitFor();
    await pexp
      .locator('button[aria-pressed]')
      .filter({ hasText: /^alpha$/ })
      .click();
    const pnode = (name: string) =>
      pexp.locator(TREE_BUTTON).filter({ hasText: new RegExp(`^[▸▾▤]\\s*${esc(name)}$`) });
    await pnode('docs').click();
    await pnode('deep').click();
    await shot(phone, 'phone-tree');
    await pnode('notes.md').click();
    const overlay = phone.locator('[aria-label="파일 미리보기"]');
    await overlay.getByText('깊은 폴더의').waitFor();
    const vp = phone.viewportSize()!;
    const ob = await overlay.boundingBox();
    check(
      ob && ob.x === 0 && ob.y === 0 && ob.width === vp.width && ob.height === vp.height,
      'phone preview covers the screen',
    );
    const close = overlay.getByRole('button', { name: '닫기' });
    check(((await close.boundingBox())?.y ?? 0) >= 47, 'its 닫기 clears the top inset');
    await shot(phone, 'phone-preview-markdown');
    await close.click();
    check(await pnode('notes.md').isVisible(), 'closing returns to the tree');
    await pnode('chart.png').count(); // (folded)
    await pnode('artifacts').click();
    await pnode('chart.png').click();
    await overlay.locator('img').waitFor();
    await phone.waitForTimeout(300);
    await shot(phone, 'phone-preview-image');
    await overlay.getByRole('button', { name: '닫기' }).click();
    await pexp.getByRole('button', { name: '다른 폴더 열기' }).click();
    const ppicker = phone.locator('[aria-label="폴더 고르기"]').last();
    await ppicker
      .locator('ul[aria-label="하위 폴더"]')
      .getByRole('button', { name: '▸ work' })
      .click();
    await phone.waitForTimeout(300);
    const pickBox = await ppicker.boundingBox();
    check(
      pickBox && pickBox.x >= 0 && pickBox.x + pickBox.width <= vp.width + 1,
      'phone picker sits inside the screen',
    );
    await shot(phone, 'phone-picker');
    await ppicker
      .locator('ul[aria-label="하위 폴더"]')
      .getByRole('button', { name: '▸ misc' })
      .click();
    await ppicker.getByRole('button', { name: '이 폴더 선택' }).click();
    await pnode('todo.txt').waitFor();
    check(true, 'phone: 다른 폴더 열기 picks work/misc');
    const tb = await pnode('todo.txt').boundingBox();
    check(
      tb && tb.x >= 0 && tb.x < vp.width / 2,
      `the office page did not slide (todo.txt at x=${tb?.x})`,
    );
    await shot(phone, 'phone-other-folder');
    check(
      (await appViolations(phone)).length === 0,
      `phone: no securitypolicyviolation (${(await appViolations(phone)).join('; ')})`,
    );
    await pctx.close();

    check(
      csp.length === 0,
      `no CSP console errors on the app${csp.map((l) => `\n  ${l}`).join('')}`,
    );
    console.log(`info - report frame CSP messages (its own script refused): ${frameCsp.length}`);
    for (const l of frameCsp) console.log(`  ${l}`);
  } catch (err) {
    await current?.screenshot({ path: path.join(OUT, 'failure.png') }).catch(() => undefined);
    console.error(serverLog.join('').split('\n').slice(-15).join('\n'));
    throw err;
  } finally {
    clearTimeout(deadline);
    await browser?.close().catch(() => undefined);
    cleanup();
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  },
);
