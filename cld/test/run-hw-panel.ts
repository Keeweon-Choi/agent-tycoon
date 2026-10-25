/**
 * T-0064 + UI-C2 + UI-C2b: fixture browser check for the 현황판 HW tab and the lobby board's HW page, on
 * the built daemon with a fake LibreHardwareMonitor (cld/test/hw/lhm-two-gpus.json, invented
 * values, on a second spare port; never real LHM, never nvidia-smi). The LHM reading has no
 * disks: the daemon's own statfs rows fill the drives (the WSL root and C: D: E:), and nothing
 * may render "?". Two GPUs and four disks reach both views; the WSL <-> Windows toggle switches
 * RAM and disks. The board draws the usage donuts and temperature bars; a tap on the CPU (its
 * graph or bar), RAM, a GPU or a disk opens that one's detail, one at a time (the CPU's with a
 * row per core, 14 cores in the fake tree); "show all" goes back; the choice survives a reload.
 * The wall's mini board, the full view and a phone must not clip.
 *
 *   npx tsx cld/test/run-hw-panel.ts <port 18256-18259> <lhm port 18256-18259>
 */
import type { Locator, Page } from '@playwright/test';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  openOfficeWindow,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const lhmPort = sparePort(3);
const OUT = path.join(REPO_ROOT, 'cld/artifacts/ui-c2b');
const fake = makeFakeHome({ claude: 'S-8' });
let lhmJson = fs.readFileSync(path.join(REPO_ROOT, 'cld/test/hw/lhm-two-gpus.json'));
const lhm = http.createServer((req, res) => {
  if (req.url === '/data.json') res.end(lhmJson);
  else res.writeHead(404).end();
});

/** One finger dragging across the page (the office pans). */
async function touchDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const cdp = await page.context().newCDPSession(page);
  const at = (k: number) => [
    { x: from.x + ((to.x - from.x) * k) / 12, y: from.y + ((to.y - from.y) * k) / 12 },
  ];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) });
  for (let k = 1; k <= 12; k++)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(k) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

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
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const sent: Array<{ type?: string; on?: boolean }> = [];
    const samplesAt: number[] = [];
    page.on('websocket', (ws) => {
      ws.on('framesent', (frame) => {
        try {
          sent.push(JSON.parse(String(frame.payload)) as { type?: string; on?: boolean });
        } catch {
          /* binary */
        }
      });
      ws.on('framereceived', (frame) => {
        if (String(frame.payload).startsWith('{"type":"hwSample"')) samplesAt.push(Date.now());
      });
    });
    const samplesIn = async (ms: number) => {
      const from = Date.now();
      await page.waitForTimeout(ms);
      return samplesAt.filter((t) => t >= from).length;
    };
    await page.goto(await daemon.loginUrl());
    await openOfficeWindow(page); // T-0108: a desktop starts with icons only
    const drawer = page.getByRole('complementary', { name: '사무실 정보' });
    await drawer
      .getByRole('navigation', { name: '사무실 메뉴' })
      .getByRole('button', { name: 'HW', exact: true })
      .click();
    const panel = page.getByTestId('hw-panel');
    const toggle = panel.getByTestId('hw-view-toggle');
    await toggle.waitFor();
    check((await toggle.getAttribute('data-view')) === 'wsl', 'tab: starts on the WSL view');
    // The row labels (the toggle's own "WSL" is not one).
    const driveRows = panel
      .locator('div.justify-between > span.text-text-muted')
      .filter({ hasText: /^(WSL|C:|D:|E:)$/ });
    let text = await panel.innerText();
    check(
      (await driveRows.count()) === 1 && !text.includes('Windows RAM'),
      'tab, WSL view: the root disk and the distro RAM only',
    );
    check(
      (await panel.getByText(/^GPU · Test GPU (Alpha|Beta)$/).count()) === 2,
      'tab: both GPUs are listed',
    );
    check(
      text.includes('5120 / 8192 MiB') && text.includes('1536 / 12288 MiB'),
      'tab: each GPU has its own VRAM',
    );
    await page.screenshot({ path: path.join(OUT, 'hw-panel-desktop-wsl.png') });
    await toggle.click();
    await panel.getByText('Windows RAM', { exact: true }).waitFor();
    check(
      (await toggle.getAttribute('data-view')) === 'windows',
      'tab: the toggle switches to Windows',
    );
    check((await driveRows.count()) === 3, 'tab, Windows view: C: D: E: (1 + 3 = four drives)');
    text = await panel.innerText();
    check(text.includes('21.5 / 48 GiB'), 'tab: Windows RAM (the fake LHM reading)');
    check(
      /C:\s+\d+ \/ \d+ GiB \(\d+%\)/.test(text) && !/\?/.test(text),
      'drives show used / total GiB (%) from statfs, and nothing renders "?"',
    );
    await page.screenshot({ path: path.join(OUT, 'hw-panel-desktop.png') });
    await panel.getByText('E:', { exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, 'hw-panel-desktop-drives.png') });
    const clock = panel.getByTestId('hw-clock');
    const first = await clock.innerText();
    await page.waitForFunction(
      (old) => document.querySelector('[data-testid="hw-clock"]')?.textContent !== old,
      first,
    );
    const second = await clock.innerText();
    const seconds = (s: string) =>
      Number(s.slice(-8, -6)) * 3600 + Number(s.slice(-5, -3)) * 60 + Number(s.slice(-2));
    check((seconds(second) - seconds(first) + 86400) % 86400 === 1, 'clock advances one second');
    check(
      sent.some((m) => m.type === 'hwView' && m.on === true),
      'panel requests fast samples',
    );
    const open = await samplesIn(4_000);
    check(
      open >= 3 && open <= 5,
      `open: ${open} samples in 4 s (1 s cadence; 3 when the machine is loaded)`,
    );
    await drawer
      .getByRole('navigation', { name: '사무실 메뉴' })
      .getByRole('button', { name: '현황판', exact: true })
      .click();
    await page.waitForFunction(() => !document.querySelector('[data-testid="hw-panel"]'));
    const requests = sent.filter((m) => m.type === 'hwView');
    check(requests.at(-1)?.on === false, 'panel stops fast sample requests when closed');
    const closed = await samplesIn(4_000);
    check(closed <= 2, `closed: ${closed} samples in 4 s (back to the 2 s cadence)`);

    // The tab's folds: per core (the fake tree has 14) and memory detail.
    await drawer
      .getByRole('navigation', { name: '사무실 메뉴' })
      .getByRole('button', { name: 'HW', exact: true })
      .click();
    await panel.getByTestId('hw-view-toggle').waitFor();
    const coresFold = panel.getByTestId('hw-fold-cores');
    await coresFold.locator('summary').click();
    check((await panel.getByTestId('hw-core').count()) === 14, 'tab: a row per core in the fold');
    check(
      (await coresFold.innerText()).includes('P-Core #1') &&
        (await coresFold.innerText()).includes('MHz'),
      'tab: the cores read name, clock, temperature and load',
    );
    await panel.getByTestId('hw-fold-ram').locator('summary').click();
    check(
      (await panel.getByTestId('hw-fold-ram').innerText()).includes('가상 메모리'),
      'tab, Windows view: the memory fold has the virtual memory',
    );
    await coresFold.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, 'hw-panel-cores-fold.png') });

    // The lobby board's HW page, in its full view (the wall's copy takes no taps).
    const openBoardHw = async (pg: Page) => {
      const wall = pg.getByTestId('lobby-board');
      await wall.waitFor();
      const b = (await wall.boundingBox())!;
      await pg.mouse.click(b.x + b.width / 2, b.y + b.height * 0.7);
      await pg.getByTestId('board-full').waitFor({ timeout: 3_000 });
      await pg.getByTestId('board-full').getByTestId('board-tab-hw').click();
    };
    /** Nothing scrolls or sticks out of the board body. */
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
          return r.bottom > box.bottom + 1 || r.right > box.right + 1 || r.left < box.left - 1;
        }).length;
        return { scrolls: body.scrollHeight - body.clientHeight, out };
      });
    await page.reload();
    await openBoardHw(page);
    const full = page.getByTestId('board-full');
    const bToggle = full.getByTestId('board-hw-toggle');
    await bToggle.waitFor();
    // The tab's choice is the board's: remembered per device, so it opens on Windows.
    check(
      (await bToggle.getAttribute('data-view')) === 'windows',
      "board: shares the tab's choice (Windows)",
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
    check(
      fit.scrolls <= 0 && fit.out === 0,
      `board, overview fits the screen (${JSON.stringify(fit)})`,
    );
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
    check(
      fit.scrolls <= 0 && fit.out === 0,
      `board, CPU detail fits the screen (${JSON.stringify(fit)})`,
    );
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
    check(fit.scrolls <= 0 && fit.out === 0, `board, RAM detail fits (${JSON.stringify(fit)})`);
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

    // The wall's mini board: what fits, "+n" for the rest, nothing clipped.
    await page.keyboard.press('Escape');
    await full.waitFor({ state: 'detached' });
    // The info drawer would cover the wall's right half.
    const closeDrawer = drawer.getByRole('button', { name: '닫기' });
    if (await closeDrawer.count()) await closeDrawer.first().click();
    const wall = page.getByTestId('lobby-board');
    await wall.getByTestId('board-tab-hw').click();
    await wall.getByTestId('board-donut').first().waitFor();
    const miniFit = (loc: Locator) =>
      loc.evaluate((root) => {
        const box = root.getBoundingClientRect();
        const body = root.querySelector('.led-body') as HTMLElement;
        const out = [
          ...root.querySelectorAll('.led-donut, .led-temp, .led-core, .led-detail, .led-figures'),
        ].filter((n) => {
          const r = n.getBoundingClientRect();
          const head = root.querySelector('.led-ticker')?.getBoundingClientRect().top ?? box.bottom;
          return r.bottom > Math.min(box.bottom, head) + 1 || r.right > box.right + 1;
        }).length;
        return { scrolls: body.scrollHeight - body.clientHeight, out };
      });
    check(
      (await wall.getByTestId('board-donut').count()) === 6 &&
        (await wall.getByTestId('board-donut-more').count()) === 0,
      'mini: all six donuts fit one row, no "+n"',
    );
    let mini = await miniFit(wall);
    check(
      mini.scrolls <= 0 && mini.out === 0,
      `mini, overview: nothing clipped (${JSON.stringify(mini)})`,
    );
    await wall.screenshot({ path: path.join(OUT, 'mini-hw-overview.png') });
    // Two more GPUs appear: what does not fit the wall becomes "+n".
    const many = JSON.parse(lhmJson.toString()) as {
      Children: Array<{ Children: Array<{ HardwareId?: string; Text?: string }> }>;
    };
    const hardware = many.Children[0].Children;
    const alpha = JSON.stringify(hardware.find((h) => h.HardwareId === '/gpu-nvidia/0'));
    for (const n of [7, 8])
      hardware.push(
        JSON.parse(
          alpha.replaceAll('/gpu-nvidia/0', `/gpu-nvidia/${n}`).replaceAll('Alpha', `Extra ${n}`),
        ),
      );
    lhmJson = Buffer.from(JSON.stringify(many));
    await wall.getByTestId('board-donut-more').waitFor({ timeout: 8_000 });
    check(
      (await wall.getByTestId('board-donut').count()) === 5 &&
        (await wall.getByTestId('board-donut-more').innerText()) === '+3',
      'mini: eight donuts, five shown and "+3" in the last slot',
    );
    check(
      (await wall.getByTestId('board-temp-more').count()) === 1,
      'mini: more bars than fit also end in "+n"',
    );
    mini = await miniFit(wall);
    check(
      mini.scrolls <= 0 && mini.out === 0,
      `mini, many GPUs: nothing clipped (${JSON.stringify(mini)})`,
    );
    await wall.screenshot({ path: path.join(OUT, 'mini-hw-many.png') });
    lhmJson = Buffer.from(
      JSON.stringify(
        JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'cld/test/hw/lhm-two-gpus.json'), 'utf-8')),
      ),
    );
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('cld.board.hw') ?? '{}');
      localStorage.setItem('cld.board.hw', JSON.stringify({ ...raw, detail: 'cpu' }));
    });
    await page.reload();
    await wall.waitFor();
    await wall.getByTestId('board-tab-hw').click();
    await wall.getByTestId('board-hw-core').first().waitFor();
    mini = await miniFit(wall);
    check(
      mini.scrolls <= 0 && mini.out === 0,
      `mini, CPU detail: nothing clipped (${JSON.stringify(mini)})`,
    );
    await wall.screenshot({ path: path.join(OUT, 'mini-hw-cpu.png') });
    await page.evaluate(() => {
      const raw = JSON.parse(localStorage.getItem('cld.board.hw') ?? '{}');
      localStorage.setItem('cld.board.hw', JSON.stringify({ ...raw, detail: null }));
    });

    // Phone: the same panel inside the safe-area layout.
    const phone = await browser.newPage({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    await phone.goto(await daemon.loginUrl());
    // T-0077: the 현황판 icon opens the page; HW is a tab of its menu.
    await phone
      .locator('[data-hud-id^="icon:"]')
      .getByRole('button', { name: '현황판', exact: true })
      .click();
    await phone
      .getByRole('navigation', { name: '작업 메뉴' })
      .getByRole('button', { name: 'HW', exact: true })
      .click();
    const phonePanel = phone.getByTestId('hw-panel');
    // The desktop page's choice (Windows) is not shared with this fresh context: toggle to it.
    await phonePanel.getByTestId('hw-view-toggle').click();
    await phonePanel.getByText('Windows RAM', { exact: true }).waitFor();
    const overflow = await phone.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    await phone.screenshot({ path: path.join(OUT, 'hw-panel-phone.png') });
    await phonePanel.getByText('E:', { exact: true }).scrollIntoViewIfNeeded();
    await phone.screenshot({ path: path.join(OUT, 'hw-panel-phone-drives.png') });
    check(overflow <= 0, `phone: no horizontal scroll (${overflow} px)`);

    // Phone: the board's full view (the choice is this context's own: Windows was toggled above).
    await phone.goto(await daemon.loginUrl());
    const pwall = phone.getByTestId('lobby-board');
    await pwall.waitFor();
    await phone.waitForTimeout(1_500);
    const boxOf = async () => ((await pwall.count()) ? pwall.boundingBox() : null);
    const whole = async () => {
      const b = await boxOf();
      return !!b && Math.abs(b.x - 8) <= 24 && Math.abs(b.y - 260) <= 60;
    };
    for (let k = 0; k < 10 && !(await whole()); k++) {
      const b = await boxOf();
      const clamp = (d: number) => Math.max(-250, Math.min(250, d));
      const to = b ? { x: 196 + clamp(8 - b.x), y: 380 + clamp(260 - b.y) } : { x: 120, y: 200 };
      await touchDrag(phone, { x: 196, y: 380 }, to);
      await phone.waitForTimeout(400);
    }
    check(await whole(), 'phone: pans to the lobby board');
    const pb = (await pwall.boundingBox())!;
    await phone.touchscreen.tap(
      (Math.max(0, pb.x) + Math.min(393, pb.x + pb.width)) / 2,
      (Math.max(80, pb.y + pb.height * 0.3) + Math.min(700, pb.y + pb.height)) / 2,
    );
    const pfull = phone.getByTestId('board-full');
    await pfull.waitFor({ timeout: 3_000 });
    await pfull.getByTestId('board-tab-hw').tap();
    const pToggle = pfull.getByTestId('board-hw-toggle');
    await pToggle.waitFor();
    const pDonuts = pfull.getByTestId('board-donut');
    check(
      (await pDonuts.count()) === 6 && (await pfull.getByTestId('board-hw-temp').count()) === 5,
      'phone board: opens on Windows (the tab toggled it): six donuts and five bars',
    );
    const phoneFits = (loc: Locator) =>
      loc.evaluate((el) => {
        const b = el.querySelector('.led-full')!.getBoundingClientRect();
        const wide = [
          ...el.querySelectorAll('.led-donut, .led-temp, .led-core, .led-detail, .led-hwpicked'),
        ].filter((n) => n.scrollWidth > n.clientWidth + 1).length;
        return (
          b.left >= 0 &&
          b.right <= window.innerWidth &&
          document.body.scrollWidth <= 393 &&
          wide === 0
        );
      });
    await phone.screenshot({ path: path.join(OUT, 'board-hw-phone-windows.png') });
    check(await phoneFits(pfull), 'phone board: overview fits the screen, no clipped item');
    await pToggle.tap();
    check((await pDonuts.count()) === 4, 'phone board: the toggle shows the root disk only');
    await phone.screenshot({ path: path.join(OUT, 'board-hw-phone-wsl.png') });
    await pToggle.tap();
    await pfull.getByTestId('board-graph-cpu').tap();
    await pfull.getByTestId('board-hw-picked').waitFor();
    check(
      (await pfull.getByTestId('board-hw-core').count()) === 14,
      'phone board: all 14 cores in one list',
    );
    await pfull.getByTestId('board-hw-picked').scrollIntoViewIfNeeded();
    await phone.screenshot({ path: path.join(OUT, 'board-hw-phone-cpu.png') });
    check(await phoneFits(pfull), 'phone board: the CPU detail fits the width');
    await pfull.getByTestId('board-hw-picked').getByRole('button').tap();
    await pDonuts.filter({ hasText: 'RAM' }).first().tap();
    await pfull.getByTestId('board-hw-picked').waitFor();
    await phone.screenshot({ path: path.join(OUT, 'board-hw-phone-ram.png') });
    check(await phoneFits(pfull), 'phone board: the RAM detail fits the width');
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
