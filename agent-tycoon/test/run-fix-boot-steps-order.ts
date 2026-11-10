/**
 * One runner pass (owner 11-06 21:14): the loading screen's list, recorded as it loads, in both screen
 * styles; no row is ever done under a row still running. Temp HOME, own port, headless, no GPU.
 * `taskset -c 12-19 nice -n 10 npx tsx agent-tycoon/test/run-fix-boot-steps-order.ts <port 19370-19379>`
 * Screenshots and log: agent-tycoon/artifacts/fix-boot-steps-order/.
 */
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeEngineHome,
  removeTestHome,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = Number(process.argv[2]);
const OUT = path.resolve(import.meta.dirname, '../artifacts/fix-boot-steps-order');
const LOADS = 3;
// Every change of the list: its rows top to bottom with their state.
const OBS = `
window.__rows = [];
const rec = () => {
  const s = document.querySelector('[data-testid="boot-screen"]');
  if (!s) return;
  const rows = [...document.querySelectorAll('[data-boot-step]')].map((li) => li.getAttribute('data-boot-step') + ':' + li.getAttribute('data-state')).join(' ');
  const last = window.__rows[window.__rows.length - 1];
  if (!last || last.rows !== rows) window.__rows.push({ t: Math.round(performance.now()), rows });
  window.__seen = true;
};
new MutationObserver(rec).observe(document, { subtree: true, attributes: true, childList: true });
`;
const bad = (rows: string): boolean => {
  const st = rows.split(' ').map((r) => r.split(':')[1]);
  const firstOpen = st.findIndex((s) => s !== 'done' && s !== 'skip');
  return firstOpen >= 0 && st.slice(firstOpen).some((s) => s === 'done');
};

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const d = startDaemon({ home, claudePath }, port, ['--no-terminal']);
  const log: string[] = [];
  let violations = 0;
  try {
    const browser = await launchBrowser({ webkit: false });
    for (const theme of ['modern', 'pixel']) {
      for (let i = 0; i < LOADS; i++) {
        const ctx = await browser.newContext({ viewport: { width: 420, height: 800 } });
        await ctx.addInitScript(
          `globalThis.__name = (fn) => fn; try{localStorage.setItem('agty.title-scene','on');localStorage.setItem('agty.ui-theme','${theme}')}catch{}; ${OBS}`,
        );
        const login = await ctx.newPage();
        await login.goto(await d.loginUrl());
        await login.waitForURL(`http://127.0.0.1:${port}/`);
        await login.close();
        const page = await ctx.newPage();
        const cdp = await ctx.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false,
          latency: 120,
          downloadThroughput: (1_500_000 / 8) * 2,
          uploadThroughput: 750_000 / 8,
        });
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'commit' });
        // Screenshots while it loads (the first ones with a row ended), up to 3 per load.
        let shots = 0;
        const t0 = Date.now();
        while (Date.now() - t0 < 60_000) {
          const seen = await page
            .evaluate(() => (window as any).__seen === true)
            .catch(() => false);
          const gone = await page
            .evaluate(() => !document.querySelector('[data-testid="boot-screen"]'))
            .catch(() => false);
          if (seen && gone) break;
          if (
            seen &&
            shots < 3 &&
            (await page
              .locator('[data-boot-step][data-state="done"]')
              .count()
              .catch(() => 0)) >=
              shots + 2
          ) {
            await page
              .screenshot({ path: path.join(OUT, `${theme}-load${i}-${shots}.png`) })
              .catch(() => undefined);
            shots++;
          }
          await page.waitForTimeout(40);
        }
        const rows = (await page.evaluate(() => (window as any).__rows)) as {
          t: number;
          rows: string;
        }[];
        const n = rows.filter((r) => bad(r.rows)).length;
        violations += n;
        log.push(
          `# ${theme} load ${i}: ${rows.length} list changes, ${n} with a done row under an open one, ${shots} shots`,
        );
        for (const r of rows)
          log.push(
            `${String(r.t).padStart(6)} ms  ${r.rows.replace(/([a-z]+):(done|now|wait|skip)/g, (_m, a, b) => `${a}${{ done: '#', now: '>', wait: '.', skip: '-' }[b as 'done']}`)}`,
          );
        await ctx.close();
      }
    }
    await browser.close();
  } finally {
    await d.stop();
    removeTestHome(home);
  }
  log.push(`# violations: ${violations}`);
  fs.writeFileSync(path.join(OUT, 'boot-list.log'), log.join('\n') + '\n');
  console.log(log.filter((l) => l.startsWith('#')).join('\n'));
  if (violations) process.exit(1);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
