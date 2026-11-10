/**
 * App icon check (11-04): the page's tab icons, apple-touch icon, the login page's links and the PWA
 * manifest icons are the files of webview-ui/public (the acorn bubble), byte for byte, as the daemon serves
 * them. Screenshot goes to agent-tycoon/artifacts/app-icon-1104/.
 *
 *   npx tsx agent-tycoon/test/run-app-icon.ts <port>   (18410-18419)
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
if (!(port >= 18410 && port <= 18419)) throw new Error('usage: run-app-icon.ts <port 18410-18419>');
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/app-icon-1104');
const PUBLIC = path.join(REPO_ROOT, 'webview-ui/public');
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex').slice(0, 12);

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'S-8', accessChosen: false, agentsJson: true });
  const daemon = startDaemon(fake, port, ['--no-terminal']);
  const browser = await launchBrowser();
  let failed = 0;
  const check = (name: string, ok: boolean, note = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name} ${note}`);
    if (!ok) failed++;
  };
  try {
    const loginUrl = await daemon.loginUrl(); // also waits until the daemon answers
    const ctx = await browser.newContext({ viewport: { width: 900, height: 700 } });
    // an unauthenticated visitor sees the login page: its icon links are public
    const login = await ctx.newPage();
    await login.goto(`http://127.0.0.1:${port}/login`);
    await login.waitForSelector('main.login');
    const loginLinks = await login.$$eval('link[rel~="icon"], link[rel="apple-touch-icon"]', (ls) =>
      ls.map((l) => ({
        rel: l.getAttribute('rel'),
        sizes: l.getAttribute('sizes'),
        href: (l as HTMLLinkElement).href,
      })),
    );
    const page = await ctx.newPage();
    await page.goto(loginUrl);
    await page.waitForSelector('canvas', { timeout: 30_000 });
    const pageLinks = await page.$$eval('link[rel~="icon"], link[rel="apple-touch-icon"]', (ls) =>
      ls.map((l) => ({
        rel: l.getAttribute('rel'),
        sizes: l.getAttribute('sizes'),
        href: (l as HTMLLinkElement).href,
      })),
    );
    const manifestUrl = await page.$eval(
      'link[rel="manifest"]',
      (l) => (l as HTMLLinkElement).href,
    );
    const manifest = (await (await ctx.request.get(manifestUrl)).json()) as {
      icons: Array<{ src: string; sizes: string; purpose?: string }>;
    };

    const shown: Array<{ label: string; data: Buffer }> = [];
    const verify = async (label: string, url: string, file: string) => {
      const res = await ctx.request.get(url);
      const body = await res.body();
      const want = fs.readFileSync(path.join(PUBLIC, file));
      check(label, res.status() === 200 && body.equals(want), `${sha(body)} ${file} ${sha(want)}`);
      shown.push({ label, data: body });
    };
    const fileOf = (href: string) => decodeURIComponent(new URL(href).pathname).replace(/^\//, '');
    check(
      'page has 16 + 32 tab icons',
      ['16x16', '32x32'].every((s) => pageLinks.some((l) => l.sizes === s)),
    );
    check(
      'login has 16 + 32 tab icons',
      ['16x16', '32x32'].every((s) => loginLinks.some((l) => l.sizes === s)),
    );
    for (const [where, links] of [
      ['page', pageLinks],
      ['login', loginLinks],
    ] as const)
      for (const l of links)
        await verify(`${where} ${l.rel} ${l.sizes ?? ''}`, l.href, fileOf(l.href));
    for (const i of manifest.icons)
      await verify(
        `manifest ${i.sizes}${i.purpose ? ' ' + i.purpose : ''}`,
        new URL(i.src, manifestUrl).href,
        fileOf(new URL(i.src, manifestUrl).href),
      );
    await verify('favicon.ico', `http://127.0.0.1:${port}/favicon.ico`, 'favicon.ico');

    // contact sheet: every served icon, nearest-neighbour at 1x
    const sheet = await ctx.newPage();
    const imgs = shown
      .filter((s) => !s.label.endsWith('.ico'))
      .map(
        (s) =>
          `<figure><img src="data:image/png;base64,${s.data.toString('base64')}"><figcaption>${s.label}</figcaption></figure>`,
      )
      .join('');
    await sheet.setContent(
      `<body style="background:Canvas;color:CanvasText;font:11px monospace;display:flex;flex-wrap:wrap;gap:14px;padding:14px;align-items:flex-end"><style>img{image-rendering:pixelated}figure{margin:0}</style>${imgs}</body>`,
    );
    await sheet.screenshot({ path: path.join(OUT, 'served-icons.png') });
  } finally {
    await browser.close();
    await daemon.stop();
    fs.rmSync(fake.home, { recursive: true, force: true });
  }
  if (failed) throw new Error(`${failed} checks failed`);
  console.log('app icon: all served icons are the new files');
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
