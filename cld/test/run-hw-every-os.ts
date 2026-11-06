/**
 * hw-every-os: the missing-sensor guide and its fixes on the built daemon (this PC is WSL). No
 * LibreHardwareMonitor answers at first (its port is a spare one nobody listens on), a fake
 * nvidia-smi (cld/test/hw/fake-nvidia-smi) is first on PATH, and the installer step is a fake
 * (CLD_GUI_TEST_HW_SENSORS) that prints the real step's consent text and says it installed.
 * Never the real installer, LHM or nvidia-smi; never a measurement source on screen.
 * - the 현황판's system summary and the board's H/W screen show one line per missing thing;
 * - "GPU 정보 켜기" stores gpu.json's nvidiaSmi and the GPU shows (from the fake);
 * - "센서 도구 설치" shows the consent text, installs on confirm, and the temperatures come.
 *
 *   taskset -c 16,17 nice -n 10 npx tsx cld/test/run-hw-every-os.ts <port 19020-19028> <lhm port 19029>
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import {
  assertPortFree,
  launchBrowser,
  makeFakeHome,
  openOfficeWindow,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
const lhmPort = Number(process.argv[3]);
const inRange = (p: number) => p >= 19020 && p <= 19029;
const OUT = path.join(REPO_ROOT, 'cld/artifacts/hw-every-os');
const DEADLINE_MS = 180_000;
const check = (ok: boolean, label: string) => {
  if (!ok) throw new Error(label);
  console.log(`ok - ${label}`);
};

async function main() {
  if (!inRange(port) || !inRange(lhmPort) || port === lhmPort)
    throw new Error('two different ports in 19020-19029');
  await assertPortFree(port, lhmPort);
  fs.mkdirSync(OUT, { recursive: true });
  const fake = makeFakeHome({ claude: 'S-8' });
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-hwbin-'));
  fs.copyFileSync(path.join(REPO_ROOT, 'cld/test/hw/fake-nvidia-smi'), path.join(bin, 'nvidia-smi'));
  fs.chmodSync(path.join(bin, 'nvidia-smi'), 0o755);
  const nvLog = path.join(bin, 'nvidia.log');
  const toolLog = path.join(bin, 'tool.log');
  const tool = path.join(bin, 'fake-hw-sensors.mjs');
  // The real step's consent text (a pure function), never its detection or install.
  fs.writeFileSync(
    tool,
    `import fs from 'node:fs';
import { hwSensorsPlan } from ${JSON.stringify(path.join(REPO_ROOT, 'cld/install/hwSensors.mjs'))};
const [cmd, , p] = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(toolLog)}, cmd + ' ' + p + '\\n');
if (cmd === 'plan') {
  const plan = hwSensorsPlan({ platform: 'wsl', detection: { state: 'missing' }, port: Number(p) });
  console.log(JSON.stringify({ lines: plan.lines.filter((l) => !l.includes('--no-hw-sensors')), install: true, lhmPort: null }));
} else {
  console.log('✔ 센서 도구: LibreHardwareMonitor :' + p);
  console.log(JSON.stringify({ ok: true, lhmPort: Number(p) }));
}
`,
  );
  const lhmJson = fs.readFileSync(path.join(REPO_ROOT, 'cld/test/hw/lhm-intel-nvidia.json'));
  const lhm = http.createServer((req, res) => {
    if (req.url === '/data.json') res.end(lhmJson);
    else res.writeHead(404).end();
  });
  const daemon = startDaemon(fake, port, ['--no-terminal', '--allow-actions', '--lhm-port', String(lhmPort)], {
    PATH: bin,
    FAKE_NVIDIA_LOG: nvLog,
    CLD_GUI_TEST_HW_SENSORS: tool,
  });
  const browser = await launchBrowser();
  const deadline = setTimeout(() => {
    console.error(`aborted: deadline ${DEADLINE_MS / 1000} s`);
    void daemon.stop();
    process.exit(1);
  }, DEADLINE_MS);
  try {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
    await ctx.addInitScript(() => localStorage.setItem('cld.title-scene', 'off'));
    const page = await ctx.newPage();
    await page.goto(await daemon.loginUrl());
    await openOfficeWindow(page);
    const win = page.locator('[data-hud-window="office"]');
    await win.getByTestId('hw-fix-lhm').waitFor({ timeout: 15_000 });
    check(await win.getByTestId('hw-fix-nvidiaOff').isVisible(), 'summary: the GPU-info line shows (nvidia-smi found, off)');
    const summaryText = await win.innerText();
    check(
      summaryText.includes('LibreHardwareMonitor를 설치하세요') && !summaryText.includes('측정 출처'),
      'summary: what to install, and no measurement source',
    );
    check(!fs.existsSync(nvLog), 'nvidia-smi never ran while off');
    const summary = win.locator('section.sb-panel', { has: page.getByTestId('hw-fix') });
    await summary.scrollIntoViewIfNeeded();
    await summary.screenshot({ path: path.join(OUT, 'summary-missing.png') });

    // The board's H/W screen from the summary's H/W link.
    await win.locator('.sb-head-action .sb-link').click();
    const full = page.getByTestId('board-full');
    await full.waitFor();
    await full.getByTestId('board-tab-hw').click();
    await full.getByTestId('hw-fix-lhm').waitFor();
    const boardText = await full.innerText();
    check(
      (await full.getByTestId('board-hw-sources').count()) === 0 &&
        !/측정 출처|· LHM|· OS|sysfs/.test(boardText),
      'board: no measurement source anywhere',
    );
    await full.screenshot({ path: path.join(OUT, 'board-missing.png') });

    // GPU 정보 켜기: gpu.json, then the fake's GPU.
    await full.getByTestId('hw-fix-nvidiaOff-action').click();
    await full.getByTestId('hw-fix-nvidia-off').waitFor({ timeout: 10_000 });
    check((await full.getByTestId('hw-fix-nvidiaOff').count()) === 0, 'board: the GPU line goes once it is on');
    const gpuJson = JSON.parse(fs.readFileSync(path.join(configDirectory(fake.home), 'gpu.json'), 'utf-8'));
    check(gpuJson.nvidiaSmi === true, "gpu.json's nvidiaSmi is true");
    check(fs.existsSync(nvLog), 'the (fake) nvidia-smi answered');
    await full.screenshot({ path: path.join(OUT, 'board-nvidia-on.png') });

    // 센서 도구 설치: the consent text first, then the install on confirm.
    await full.getByTestId('hw-fix-lhm-action').click();
    const plan = full.getByTestId('hw-fix-plan');
    await plan.waitFor({ timeout: 10_000 });
    const planText = await plan.innerText();
    check(planText.includes('LibreHardwareMonitor') && planText.includes('UAC'), 'board: the installer\'s consent text, with the UAC line');
    check(fs.readFileSync(toolLog, 'utf-8').trim() === `plan ${lhmPort}`, 'nothing installed before confirm');
    await full.screenshot({ path: path.join(OUT, 'board-install-plan.png') });
    await new Promise<void>((r) => lhm.listen(lhmPort, '127.0.0.1', () => r()));
    await full.getByTestId('hw-fix-confirm').click();
    await full.getByTestId('hw-fix-done').waitFor({ timeout: 10_000 });
    check(fs.readFileSync(toolLog, 'utf-8').includes(`install ${lhmPort}`), 'the install step ran once, on confirm');
    await full.getByTestId('hw-fix-lhm').waitFor({ state: 'detached', timeout: 15_000 });
    check(true, 'board: the LHM line goes once LHM answers (re-detected at once)');
    await page.waitForTimeout(1_500);
    await full.screenshot({ path: path.join(OUT, 'board-installed.png') });

    await full.getByTestId('hw-fix-nvidia-off').click();
    await full.getByTestId('hw-fix-nvidia-off').waitFor({ state: 'detached', timeout: 10_000 });
    const off = JSON.parse(fs.readFileSync(path.join(configDirectory(fake.home), 'gpu.json'), 'utf-8'));
    check(off.nvidiaSmi === false, 'GPU 정보 끄기 stores false');
    await ctx.close();
  } finally {
    clearTimeout(deadline);
    await browser.close();
    await daemon.stop();
    lhm.close();
    fs.rmSync(bin, { recursive: true, force: true });
    fs.rmSync(fake.home, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
