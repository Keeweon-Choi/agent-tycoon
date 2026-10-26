#!/usr/bin/env node
// The desktop app's first-run pages (cld/desktop/ui) in headless Chromium with a fake
// window.__TAURI__ that plays Rust's part per scenario (T2+P5). Screenshots: cld/artifacts/t2p5/.
//
//   node cld/desktop/scripts/ui-flow.mjs
//
// The fake keeps its state in sessionStorage, so a reload (Rust navigating back to ui/) keeps it.
// It mirrors lib.rs only as far as the pages see it (ui_state and the commands); the decisions
// themselves are tested in src-tauri/src/local.rs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const page_url = pathToFileURL(path.join(here, '..', 'ui', 'index.html')).href;
const KO_FONT = pathToFileURL(
  path.join(here, '..', '..', '..', 'webview-ui', 'public', 'fonts', 'galmuri', 'Galmuri11.woff2'),
).href;
const shots = path.join(here, '..', '..', 'artifacts', 't2p5');
fs.mkdirSync(shots, { recursive: true });

/** Runs in the page before app.js. */
function fakeTauri(scenario) {
  const KEY = 'fake-tauri';
  const STEPS = ['설치 파일 확인', '프로그램 설치', '사무실 시작', '로그인'];
  const LINES = [
    '✔ agent-tycoon-daemon-0.1.0-rc.1-linux-x64.tar.gz: signature, SHA-256 and linux-x64 match',
    '… 풀기 124/5208 (2%)',
    '… 확인 2500/5208 (48%)',
    '✔ self-test 0.1.0-rc.1',
    '✔ 시작 정책: 필요할 때만 (on-demand) · 실행 중인 데몬과 에이전트는 그대로예요',
    '✔ Agent Tycoon 0.1.0-rc.1 is running on port 18240',
  ];
  const blank = () => ({
    status: '',
    detail: '',
    ask: '',
    adopt: false,
    askPolicy: false,
    step: null,
    failed: false,
    lines: [],
    installProgress: null,
    leftover: [],
  });
  const fresh = {
    platform: scenario.platform,
    config: scenario.saved ?? null,
    settings: false,
    choosing: false,
    view: blank(),
    calls: [],
    opened: null,
    installing: 0,
  };
  let s = JSON.parse(sessionStorage.getItem(KEY) || 'null') ?? fresh;
  const save = () => sessionStorage.setItem(KEY, JSON.stringify(s));
  const navigate = () => {
    save();
    setTimeout(() => location.reload(), 0);
  };
  const open = () => {
    s.view = { ...s.view, status: '연결됨', detail: '' };
    if (s.view.step !== null) s.view.step = 3;
    s.opened = 'http://127.0.0.1:18240/login?code=<one-time>';
  };
  // Rust's local_flow after a choice (Action::Look).
  const look = () => {
    s.view = blank();
    if (scenario.existing) return open();
    s.view.status = '이 컴퓨터에 Agent Tycoon을 설치할까요?';
    s.view.ask = 'install';
    s.view.askPolicy = s.config.localEnv === 'wsl' || s.platform === 'linux';
  };
  // setup() -> connect(): a saved choice runs the flow right away.
  if (s === fresh && s.config) look();
  const screen = () =>
    s.settings ? 'settings' : s.choosing ? 'where' : s.config ? 'status' : 'welcome';
  const commands = {
    ui_state() {
      if (s.installing) {
        // One manager line per poll, as stream_lines shows them.
        const n = s.installing++ - 1;
        if (scenario.failAt !== undefined && n >= scenario.failAt) {
          s.installing = 0;
          s.view.failed = true;
          s.view.status = '이 컴퓨터에서 사무실을 열지 못했습니다';
          s.view.detail = '설치하지 못했습니다: self-test of 0.1.0-rc.1 failed:';
          s.view.lines.push('✖ self-test of 0.1.0-rc.1 failed:');
          s.view.leftover = [
            '풀어 둔 버전: 0.1.0-rc.1',
            '만든 파일 1개 (설치 기록에 적혀 있음)',
            '다시 시도하면 이어서 설치합니다. 지우려면 자세히의 명령을 쓰세요.',
          ];
        } else if (n < LINES.length) {
          const line = LINES[n];
          s.view.lines.push(line);
          if (line.startsWith('… ')) {
            const [, phase, percent] = /^… (풀기|확인) \d+\/\d+ \((\d+)%\)$/.exec(line);
            s.view.installProgress = { phase, percent: Number(percent) };
          }
          s.view.step = [1, 1, 1, 2, 2, 3][n];
        } else {
          s.installing = 0;
          open();
        }
      }
      save();
      const local = s.config?.mode === 'local' && s.platform === 'windows';
      return {
        screen: screen(),
        platform: s.platform,
        // local::where_line
        whereLine: !local
          ? ''
          : s.config.localEnv === 'wsl'
            ? `WSL ${s.config.distro} 에서 사무실을 엽니다`
            : 'Windows 에서 바로 사무실을 엽니다',
        ...s.view,
        steps: STEPS,
        fingerprint: '',
        tailscaleHelp: false,
        settings: screen() === 'settings',
        saved: !!s.config,
        config: s.config ?? {
          mode: 'tailscale',
          url: '',
          sshTarget: '',
          sshPort: 2233,
          localPort: 18240,
          remotePort: 18240,
          loginCommand: '~/.local/bin/cld-gui-login',
          localEnv: '',
          distro: '',
        },
      };
    },
    // Windows decides by itself (local::auto_choice): an office in a distro, then a dev setup, else Windows.
    start_here() {
      if (s.platform !== 'windows') return commands.choose_local({ env: 'native', distro: '' });
      const order = [...(scenario.distros ?? [])].sort((a, b) => b.default - a.default);
      const pick = order.find((d) => d.office) ?? order.find((d) => d.dev);
      return commands.choose_local(
        pick ? { env: 'wsl', distro: pick.name } : { env: 'native', distro: '' },
      );
    },
    local_choose() {
      s.choosing = true;
      s.settings = false;
      navigate();
    },
    local_options() {
      const distros = scenario.distros ?? [];
      const def = distros.find((d) => d.default) ?? distros[0];
      return { distros, nativeInstalled: false, recommended: def ? `wsl:${def.name}` : 'native' };
    },
    choose_local({ env, distro }) {
      s.config = { mode: 'local', localEnv: env, distro: env === 'wsl' ? distro : '' };
      s.choosing = false;
      s.settings = false;
      look();
      navigate();
    },
    local_install({ policy }) {
      if (s.view.ask !== 'install') throw new Error('지금은 그 답을 받지 않습니다.');
      s.policy = policy;
      s.view = { ...blank(), status: '설치하는 중…', step: 0 };
      s.installing = 1;
      s.view.lines = [];
      save();
    },
    open_settings() {
      s.settings = true;
      s.choosing = false;
      navigate();
    },
    reconnect() {
      s.settings = false;
      s.choosing = false;
      if (s.config) look();
      navigate();
    },
    device_key: () => null,
  };
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args = {}) => {
        s.calls.push(
          args.policy !== undefined
            ? `${cmd}:${args.policy}`
            : args.env
              ? `${cmd}:${args.env}:${args.distro}`
              : cmd,
        );
        save();
        if (!commands[cmd]) throw new Error(`fake: no ${cmd}`);
        return commands[cmd](args);
      },
    },
  };
}

const SCENARIOS = {
  // A dev setup in the default distro: WSL there, install after 설치.
  'windows-wsl-fresh': {
    platform: 'windows',
    expect: 'WSL Ubuntu 에서 사무실을 엽니다',
    distros: [
      { name: 'Ubuntu', running: true, default: true, dev: true },
      { name: 'Debian', running: false, default: false, dev: true },
    ],
  },
  // No WSL2 distro (or none that is a dev setup): Windows itself.
  'windows-no-wsl': {
    platform: 'windows',
    expect: 'Windows 에서 바로 사무실을 엽니다',
    distros: [],
  },
  // An office in a distro that is not the default: that one, reused.
  'windows-wsl-existing': {
    platform: 'windows',
    existing: true,
    expect: 'WSL Debian 에서 사무실을 엽니다',
    distros: [
      { name: 'Ubuntu', running: true, default: true, dev: true },
      { name: 'Debian', running: false, default: false, office: true },
    ],
  },
  'install-failure': {
    platform: 'windows',
    failAt: 3,
    expect: 'WSL Ubuntu 에서 사무실을 엽니다',
    distros: [{ name: 'Ubuntu', running: true, default: true, dev: true }],
  },
  // 자세히 → 다른 방식으로 실행: today's choice screen, then Windows.
  'windows-other-way': {
    platform: 'windows',
    other: 'native',
    expect: 'WSL Ubuntu 에서 사무실을 엽니다',
    distros: [{ name: 'Ubuntu', running: true, default: true, dev: true }],
  },
  'second-start': {
    platform: 'windows',
    existing: true,
    saved: { mode: 'local', localEnv: 'wsl', distro: 'Ubuntu' },
  },
  'linux-fresh': { platform: 'linux' },
};

// The Chrome the repo's runners use (cld/test/run-notices.ts); PLAYWRIGHT_CHROME overrides it.
const chrome =
  process.env.PLAYWRIGHT_CHROME ??
  path.join(os.homedir(), '.cache/ms-playwright/chromium-1248/chrome-linux64/chrome');
const browser = await chromium.launch({
  headless: true,
  args: ['--disable-gpu'],
  executablePath: fs.existsSync(chrome) ? chrome : undefined,
});
const results = [];
try {
  for (const [name, scenario] of Object.entries(SCENARIOS)) {
    const context = await browser.newContext({ viewport: { width: 640, height: 820 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript(fakeTauri, scenario);
    // This PC has no Korean system font (Windows has Malgun Gothic): the office's Galmuri, for the screenshots only.
    await page.addInitScript((font) => {
      addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = `@font-face { font-family: RunnerKo; src: url(${font}); } body { font-family: RunnerKo, sans-serif; }`;
        document.head.append(style);
      });
    }, KO_FONT);
    await page.goto(page_url);
    const fake = () => page.evaluate(() => JSON.parse(sessionStorage.getItem('fake-tauri')));
    const shot = (step) =>
      page.screenshot({ path: path.join(shots, `${name}-${step}.png`), fullPage: true });
    const visible = (sel) => page.locator(sel).first().waitFor({ state: 'visible', timeout: 5000 });

    if (name === 'second-start') {
      // A saved choice: no welcome, no question, straight to the office.
      await visible('#status');
      await page.waitForFunction(
        () => document.getElementById('status-line').textContent === '연결됨',
      );
      assert.equal(await page.locator('#welcome').isHidden(), true);
      await shot('1-office');
      assert.ok((await fake()).opened);
      assert.deepEqual(
        (await fake()).calls.filter((c) => c !== 'ui_state'),
        [],
      );
    } else {
      await visible('#welcome');
      await shot('1-welcome');
      await page.click('#here');
      if (scenario.platform === 'windows') {
        // No choice screen: the decision in one line, the choice only under 자세히.
        await visible('#where-line');
        assert.equal(await page.locator('#where-line').innerText(), scenario.expect);
        assert.equal(await page.locator('#where').isHidden(), true);
        assert.equal(await page.locator('#other').isVisible(), false);
        await shot('2-decided');
        if (scenario.other) {
          await page.click('#other-box summary');
          await shot('2b-other');
          await page.click('#other');
          await visible('#where label');
          const labels = await page.locator('#where-list label').allInnerTexts();
          assert.match(labels[0], /WSL 배포판 Ubuntu에서 실행 \(추천\)/);
          assert.match(labels.at(-1), /다른 컴퓨터에 연결/);
          // No technical words on the main screen; WSL details only under 자세히.
          assert.doesNotMatch(
            await page.locator('#where-list').innerText(),
            /Node|npm|systemd|wsl\.exe/,
          );
          await shot('2c-where');
          await page.check(`input[value="${scenario.other}"]`);
          await page.click('#where button[type=submit]');
          await visible('#where-line');
          assert.equal(
            await page.locator('#where-line').innerText(),
            'Windows 에서 바로 사무실을 엽니다',
          );
        }
      }
      await visible('#status');
      if (scenario.existing) {
        await page.waitForFunction(
          () => document.getElementById('status-line').textContent === '연결됨',
        );
        await shot('3-office');
        assert.ok((await fake()).opened);
      } else {
        await visible('#install');
        const policy = scenario.platform === 'linux' || (await fake()).config.localEnv === 'wsl';
        assert.equal(await page.locator('#policy').isVisible(), policy);
        if (policy) assert.equal(await page.locator('input[value="on-demand"]').isChecked(), true);
        assert.doesNotMatch(await page.locator('#status-line').innerText(), /Node|npm|systemd/);
        await shot('3-install-question');
        await page.click('#install-go');
        await visible('#steps');
        await visible('#install-progress');
        assert.equal(await page.locator('#install-progress').getAttribute('value'), '2');
        assert.equal(await page.locator('#install-progress-label').innerText(), '풀기 2%');
        await page.click('#lines-box summary');
        assert.match(await page.locator('#lines').innerText(), /… 풀기 124\/5208 \(2%\)/);
        await shot('4-installing');
        if (scenario.failAt !== undefined) {
          await visible('#leftover');
          await page.click('#lines-box summary');
          assert.match(await page.locator('#steps li.failed').innerText(), /프로그램 설치/);
          assert.match(await page.locator('#leftover-list').innerText(), /0\.1\.0-rc\.1/);
          await shot('5-failed');
          assert.equal((await fake()).opened, null);
        } else {
          await page.waitForFunction(
            () => document.getElementById('status-line').textContent === '연결됨',
          );
          await shot('5-office');
          assert.equal(await page.locator('#steps li.done').count(), 3);
          assert.ok((await fake()).opened);
        }
        assert.ok(
          (await fake()).calls.includes(policy ? 'local_install:on-demand' : 'local_install:null'),
        );
      }
    }
    assert.deepEqual(errors, []);
    results.push(
      `ok ${name}: ${(await fake()).calls.filter((c) => c !== 'ui_state').join(', ') || '(no command)'}`,
    );
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(results.join('\n'));
console.log(`screenshots: ${shots}`);
