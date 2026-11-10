/**
 * T-0064 + UI-C2 + UI-C2b, reduced after the 현황판 HW tab went (building-a-1104, owner 11-04
 * 20:28): fixture browser check for the lobby board's H/W screen, on the built daemon with a fake
 * LibreHardwareMonitor (agent-tycoon/test/hw/lhm-two-gpus.json, invented values, on a second spare port;
 * never real LHM, never nvidia-smi). The LHM reading has no disks: the daemon's own statfs rows
 * fill the drives (the WSL root and C: D: E:), and nothing may render "?". Two GPUs and four disks
 * reach the screen; the WSL <-> Windows toggle switches RAM and disks. The board draws the usage
 * donuts and temperature bars; a tap on the CPU (its graph or bar), RAM, a GPU or a disk opens that
 * one's detail, one at a time (the CPU's with a row per core, 14 cores in the fake tree); "show
 * all" goes back; the choice survives a reload. The full view must not clip sideways. The
 * 현황판 has no HW tab (run-building-a checks its tab strip).
 * ponytail: the phone's narrow view is not driven here (the HUD's CPU chip shows only while hot,
 * the billboard needs the isometric pan); add it when a phone path to the H/W screen exists.
 *
 *   npx tsx agent-tycoon/test/run-hw-panel.ts <port 18256-18259> <lhm port 18256-18259>
 */
import type { Locator, Page } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/agent-tycoon/testHome.js';

const port = sparePort();
const lhmPort = sparePort(3);
const OUT = path.join(REPO_ROOT, 'agent-tycoon/artifacts/ui-c2b');
const fake = makeFakeHome({ claude: 'S-8' });
let lhmJson = fs.readFileSync(path.join(REPO_ROOT, 'agent-tycoon/test/hw/lhm-two-gpus.json'));
const lhm = http.createServer((req, res) => {
  if (req.url === '/data.json') res.end(lhmJson);
  else res.writeHead(404).end();
});

const check = (ok: boolean, label: string) => {
  if (!ok) throw new Error(label);
  console.log(`ok - ${label}`);
};

async function main() {
  if (port === lhmPort) throw new Error('two different ports in 18256-18259');
  await assertPortFree(port, lhmPort);
  lhm.listen(lhmPort, '127.0.0.1');
  fs.mkdirSync(OUT, { recursive: true });
  const daemon = startDaemon(fake, port, ['--no-terminal', '--lhm-port', String(lhmPort)]);
  const browser = await launchBrowser();
  const deadline = setTimeout(() => {
    void daemon.stop();
    process.exit(1);
  }, 180_000);
  try {
    // The title scene would cover the office; the lobby board's wall is the 2D view's.
    const desk = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      locale: 'ko-KR',
    });
    await desk.addInitScript(() => localStorage.setItem('agty.title-scene', 'off'));
    const page = await desk.newPage();
    const sent: Array<{ type?: string; on?: boolean }> = [];
    page.on('websocket', (ws) => {
      ws.on('framesent', (frame) => {
        try {
          sent.push(JSON.parse(String(frame.payload)) as { type?: string; on?: boolean });
        } catch {
          /* binary */
        }
      });
    });
    await page.goto(await daemon.loginUrl());

    // The H/W screen of the board's full view: the HUD's CPU temperature opens it (the 2D lobby
    // has no wall board; the billboard of the isometric building is run-building-a's).
    const openBoardHw = async (pg: Page) => {
      await pg.getByTestId('hud-heat').first().click();
      await pg.getByTestId('board-full').waitFor({ timeout: 3_000 });
      check(
        (await pg
          .getByTestId('board-full')
          .getByTestId('board-tab-hw')
          .getAttribute('aria-selected')) === 'true',
        'the CPU temperature opens the board on its H/W screen',
      );
    };
    /** Nothing sticks out of the board body sideways (it scrolls down: the H/W screen carries the sources, warnings and the agent disk since building-a-1104). */
    const fitsBody = (loc: Locator) =>
      loc.evaluate((root) => {
        const body = root.querySelector('.led-body') as HTMLElement;
        const box = body.getBoundingClientRect();
        const out = [
          ...body.querySelectorAll(
            '.led-donut, .led-temp, .led-core, .led-detail, .led-figures, .led-hwpicked',
          ),
        ].filter((n) => {
          const r = n.getBoundingClientRect();
          return r.right > box.right + 1 || r.left < box.left - 1;
        }).length;
        return { scrolls: body.scrollHeight - body.clientHeight, out };
      });
    await page.reload();
    await openBoardHw(page);
    const full = page.getByTestId('board-full');
    const bToggle = full.getByTestId('board-hw-toggle');
    await bToggle.waitFor();
    check((await bToggle.getAttribute('data-view')) === 'wsl', 'board: starts on the WSL view');
    check(
      sent.some((m) => m.type === 'hwView' && m.on === true),
      'board: the H/W screen requests fast samples',
    );
    await bToggle.click();
    check(
      (await bToggle.getAttribute('data-view')) === 'windows',
      'board: the toggle switches to Windows',
    );
    const donuts = full.getByTestId('board-donut');
    const bars = full.getByTestId('board-hw-temp');
    // Windows: RAM, two VRAM, C: D: E:; bars: CPU, and temperature + hotspot of both GPUs.
    check((await donuts.count()) === 6, 'board, Windows view: six donuts (RAM, 2 VRAM, 3 drives)');
    check(
      (await bars.count()) === 5,
      'board: five temperature bars (CPU, 2 GPUs x temp + hotspot)',
    );
    check(
      (await full.locator('.led-hwline').count()) === 0,
      'board: the one-line-per-item list is gone',
    );
    check(
      (await donuts.first().innerText()).includes('21.5/48G'),
      'board, Windows view: the RAM donut is the host RAM',
    );
    const ringsDrawn = await full.locator('.led-donut canvas').evaluateAll(
      (cs) =>
        cs.filter((c) => {
          const cv = c as HTMLCanvasElement;
          const data = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data;
          return data.some((v, i) => i % 4 === 3 && v > 0);
        }).length,
    );
    check(ringsDrawn === 6, `board: every donut ring is painted (${ringsDrawn} of 6)`);
    await full.screenshot({ path: path.join(OUT, 'board-hw-windows.png') });
    let fit = await fitsBody(full);
    check(fit.out === 0, `board, overview fits the screen (${JSON.stringify(fit)})`);
    await bToggle.click();
    check((await bToggle.getAttribute('data-view')) === 'wsl', 'board: the toggle switches to WSL');
    check((await donuts.count()) === 4, 'board, WSL view: RAM, 2 VRAM and the root disk');
    check(
      !(await donuts.first().innerText()).includes('21.5/48G'),
      "board, WSL view: the distro RAM, not the host's",
    );
    await full.screenshot({ path: path.join(OUT, 'board-hw-wsl.png') });
    await bToggle.click();

    // CPU: from its graph, then from its temperature bar.
    const picked = full.getByTestId('board-hw-picked');
    await full.getByTestId('board-graph-cpu').click();
    await picked.waitFor();
    check((await picked.getAttribute('data-kind')) === 'cpu', 'board: the CPU graph opens the CPU');
    check(
      (await donuts.count()) === 0 && (await bars.count()) === 0,
      'board: the detail replaces the side',
    );
    check((await full.getByTestId('board-hw-core').count()) === 14, 'board: a row per core (14)');
    let cpuText = await picked.innerText();
    check(
      cpuText.includes('P-Core #1') && cpuText.includes('E-Core #8') && cpuText.includes('4200MHz'),
      'board: P- and E-cores by name with their clocks',
    );
    check(
      cpuText.includes('34W') && cpuText.includes('64°') && cpuText.includes('100MHz'),
      'board: cores power, core max and the bus speed',
    );
    check(
      (await full.locator('.led-core', { hasText: 'E-Core #1' }).innerText()).includes('21%'),
      'board: E-Core #1 reads the load of CPU Core #7',
    );
    fit = await fitsBody(full);
    check(fit.out === 0, `board, CPU detail fits the screen (${JSON.stringify(fit)})`);
    await full.screenshot({ path: path.join(OUT, 'board-hw-cpu-detail.png') });
    await picked.getByRole('button').click();
    check((await donuts.count()) === 6, 'board: "show all" goes back');
    await bars.first().click();
    check(
      (await picked.getAttribute('data-kind')) === 'cpu',
      'board: the CPU temperature bar opens the CPU too',
    );
    await picked.getByRole('button').click();

    // RAM, in both views.
    await donuts.first().click();
    check((await picked.getAttribute('data-kind')) === 'ram', 'board: the RAM donut opens the RAM');
    let ramText = await picked.innerText();
    check(
      ramText.includes('가상 메모리') && ramText.includes('31.5/56G') && ramText.includes('45%'),
      'board, Windows view: used, available, load, virtual memory',
    );
    fit = await fitsBody(full);
    check(fit.out === 0, `board, RAM detail fits (${JSON.stringify(fit)})`);
    await full.screenshot({ path: path.join(OUT, 'board-hw-ram-windows.png') });
    await bToggle.click();
    ramText = await picked.innerText();
    check(
      ramText.includes('사용 가능') && ramText.includes('스왑') && !ramText.includes('가상 메모리'),
      'board, WSL view: used, cache, available, swap (from /proc/meminfo)',
    );
    await full.screenshot({ path: path.join(OUT, 'board-hw-ram-wsl.png') });
    await bToggle.click();

    // A disk, then a GPU: one detail at a time; the larger view as UI-C2 had it.
    await picked.getByRole('button').click();
    const rowH = (await bars.first().boundingBox())!.height;
    await donuts.filter({ hasText: 'D:' }).click();
    check(
      (await picked.count()) === 1 &&
        (await picked.getAttribute('data-kind')) === 'disk' &&
        (await picked.innerText()).includes('D:'),
      'board: a disk donut opens that disk alone',
    );
    check((await picked.boundingBox())!.height > rowH * 2, 'board: the disk is larger than a bar');
    await full.screenshot({ path: path.join(OUT, 'board-hw-disk-picked.png') });
    // The same screen after a reload: the detail is remembered.
    await page.reload();
    await openBoardHw(page);
    check(
      (await picked.count()) === 1 &&
        (await picked.getAttribute('data-kind')) === 'disk' &&
        (await full.getByTestId('board-hw-toggle').getAttribute('data-view')) === 'windows',
      'board: the view and the open detail survive a reload',
    );
    await picked.getByRole('button').click();
    await donuts.filter({ hasText: 'VRAM 2' }).click();
    check(
      (await picked.count()) === 1 &&
        (await picked.getAttribute('data-kind')) === 'gpu' &&
        (await picked.innerText()).includes('Test GPU Beta'),
      'board: a VRAM donut opens that GPU',
    );
    await full.screenshot({ path: path.join(OUT, 'board-hw-gpu-picked.png') });
    // The disk is of the Windows side: switching to WSL while it is open falls back to all.
    await picked.getByRole('button').click();
    await donuts.filter({ hasText: 'E:' }).click();
    await bToggle.click();
    check(
      (await picked.count()) === 0 && (await donuts.count()) === 4,
      'board: the open disk gone after the toggle, everything is shown again',
    );
    await bToggle.click();
    check(
      (await picked.getAttribute('data-kind')) === 'disk',
      'board: back on Windows the remembered disk is open again',
    );
    await picked.getByRole('button').click();
    await bars.nth(1).click();
    check((await picked.getAttribute('data-kind')) === 'gpu', "board: a GPU's bar opens that GPU");
    await picked.getByRole('button').click();
  } finally {
    clearTimeout(deadline);
    lhm.close();
    await browser.close();
    await daemon.stop();
    fs.rmSync(fake.home, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
