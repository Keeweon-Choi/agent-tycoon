/**
 * T-0003 integration / real-use run: start dist/cli.js, open the office in
 * headless Chromium (`fake`: logged in with the fake HOME's own token; `real`: no
 * login, so just the login page), log the WebSocket message types, take
 * screenshots, stop the server.
 *
 *   npx tsx cld/test/run-office.ts fake <port> <claude:S-8|C-4> <outPrefix>
 *   npx tsx cld/test/run-office.ts real <port> - <outPrefix>
 *
 * `fake` builds an isolated HOME with the fake claude and animates two
 * running characters by appending tool records to their transcripts.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  assertPortFree,
  daemonLoginUrl,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  waitForDaemon,
} from '../../server/src/cld/testHome.js';

const [mode, , claudeScenario, outPrefix] = process.argv.slice(2);
const port = sparePort(3);
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0003');

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  let env: NodeJS.ProcessEnv = { ...process.env };
  let animate: string[] = [];
  let fakeHome = '';
  if (mode === 'fake') {
    const fake = makeFakeHome({ claude: claudeScenario, agentsJson: true });
    env = {
      ...process.env,
      ...fake.env,
      XDG_RUNTIME_DIR: fake.home,
      PATH: `${path.dirname(fake.claudePath)}${path.delimiter}${process.env.PATH}`,
    };
    const projects = path.join(fake.home, '.claude/projects');
    animate = ['-work-alpha', '-work-eta', '-work-beta']
      .map((d) => path.join(projects, d))
      .filter((d) => fs.existsSync(d))
      .map((d) => path.join(d, fs.readdirSync(d).sort()[0]));
    fakeHome = fake.home;
    console.log(`fake HOME ${fake.home}`);
  }

  const server = spawn(
    process.execPath,
    [path.join(REPO_ROOT, 'dist/cli.js'), '--port', String(port), '--no-terminal'],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const serverLog: string[] = [];
  server.stdout.on('data', (b: Buffer) => serverLog.push(b.toString()));
  server.stderr.on('data', (b: Buffer) => serverLog.push(b.toString()));
  // Ours, not another run's daemon that holds the port: /api/health names the pid.
  const ready = Promise.race([
    waitForDaemon(port, server.pid!, 30_000, fakeHome || undefined),
    new Promise<never>((_, reject) =>
      server.on('exit', (c) => reject(new Error(`server exited ${c}\n${serverLog.join('')}`))),
    ),
  ]);

  const types = new Map<string, number>();
  const browser = await launchBrowser();
  try {
    await ready;
    // A fake HOME has its own token: log in with a fresh code per page. The real mode has no
    // token to use here and opens the login page.
    const url = () =>
      fakeHome
        ? daemonLoginUrl(fakeHome, port, server.pid!)
        : Promise.resolve(`http://127.0.0.1:${port}/`);
    const shoot = async (
      name: string,
      viewport: { width: number; height: number },
      mobile: boolean,
    ) => {
      const ctx = await browser.newContext({
        viewport,
        isMobile: mobile,
        hasTouch: mobile,
        deviceScaleFactor: 1,
      });
      const page = await ctx.newPage();
      page.on('websocket', (ws) =>
        ws.on('framereceived', (f) => {
          try {
            const t = (JSON.parse(String(f.payload)) as { type?: string }).type ?? '?';
            types.set(t, (types.get(t) ?? 0) + 1);
          } catch {
            /* binary */
          }
        }),
      );
      await page.goto(await url());
      await page.waitForTimeout(2500);
      for (let i = 0; i < 3; i++) {
        animate.forEach((file, k) => {
          const id = `tu-${name}-${i}-${k}`;
          const tool =
            k % 2
              ? { name: 'Bash', input: { command: 'npm test' } }
              : { name: 'Edit', input: { file_path: '/work/src/app.ts' } };
          fs.appendFileSync(
            file,
            JSON.stringify({
              type: 'assistant',
              message: { content: [{ type: 'tool_use', id, ...tool }] },
            }) + '\n',
          );
        });
        await page.waitForTimeout(1200);
      }
      const file = path.join(OUT, `${outPrefix}-${name}.png`);
      await page.screenshot({ path: file });
      console.log(`screenshot ${file}`);
      await ctx.close();
    };
    await shoot('desktop', { width: 1400, height: 900 }, false);
    if (mode === 'fake') await shoot('phone', { width: 390, height: 844 }, true);
  } finally {
    await browser.close();
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
  }
  const lines = [...types.entries()].sort().map(([t, n]) => `${t}\t${n}`);
  fs.writeFileSync(path.join(OUT, `${outPrefix}-ws-types.txt`), lines.join('\n') + '\n');
  fs.writeFileSync(
    path.join(OUT, `${outPrefix}-server.log`),
    serverLog.join('').replace(/token=[0-9a-f-]+/gi, 'token=<redacted>'),
  );
  console.log('WebSocket message types received:\n' + lines.join('\n'));
  if (!types.has('layoutLoaded'))
    throw new Error('check failed: the office loaded (no layoutLoaded)');
  console.log('ok - the office loaded: layoutLoaded came over /ws');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
