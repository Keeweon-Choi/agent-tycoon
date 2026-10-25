/**
 * T-0024 --remote decision tree: direct > SSH > Tailscale > Claude Remote
 * Control, with fakes for every command and recorded tailscale outputs. No
 * real router, Tailscale change, install, `tailscale up` or sudo.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeConfig, parseArgs } from './install.mjs';
import {
  CONSENT_WAIT_MS,
  defaultConnector,
  funnelServing,
  installSteps,
  parseConsentUrl,
  remoteSetup,
  setupLines,
  tailscaleFacts,
} from './remote.mjs';

const PORT = 18240;
const HOST = 'office.tail0000.ts.net';

test('the installer prints the same live setup steps and saved check as the button', () => {
  const result = {
    ok: true, url: `https://${HOST}/`, test: { checkedAt: 0 },
    steps: [
      { ok: false, text: '공유기가 응답하지 않아요' },
      { ok: true, text: '로그인 화면을 확인했어요' },
    ],
  };
  assert.equal(setupLines(result)[0], '✖ 공유기가 응답하지 않아요');
  assert.equal(setupLines(result)[1], '✔ 로그인 화면을 확인했어요');
  assert.match(setupLines(result).at(-1), /✔ 바깥 접속 확인됨 .*office\.tail0000\.ts\.net/);
});

test('a check that could not reach the address from this PC is not printed as confirmed', () => {
  const unknown = { ok: true, unknown: true, text: '이 PC 안에서는 바깥 주소에 닿지 못해 확인하지 못했어요' };
  const result = { ok: true, url: `https://${HOST}/`, test: { checkedAt: 0, steps: [unknown] }, steps: [unknown] };
  assert.equal(setupLines(result)[0], `? ${unknown.text}`);
  assert.ok(!setupLines(result).some((line) => line.includes('바깥 접속 확인됨')));
});

/** `tailscale status --json` on this PC (1.104.2), trimmed and renamed. */
const STATUS_FUNNEL = {
  Version: '1.104.2-tc3430f0d2-g598b63867',
  BackendState: 'Running',
  AuthURL: '',
  Self: {
    DNSName: `${HOST}.`,
    UserID: 1,
    CapMap: {
      'default-auto-update': null,
      funnel: null,
      https: null,
      'https://tailscale.com/cap/funnel-ports?ports=443,8443,10000': null,
    },
  },
  User: { 1: { LoginName: 'owner@localhost' } },
};
/** The same tailnet before its owner allowed Funnel (no funnel/https node attributes). */
const STATUS_NO_FUNNEL = {
  ...STATUS_FUNNEL,
  Self: { ...STATUS_FUNNEL.Self, CapMap: { 'default-auto-update': null } },
};
/** Logged out (tailscale status --json while NeedsLogin). */
const STATUS_LOGGED_OUT = {
  BackendState: 'NeedsLogin',
  AuthURL: '',
  Self: { DNSName: '', CapMap: {} },
};
/** `tailscale funnel status --json` on this PC: the HTTP proxy to the daemon, published. */
const FUNNEL_ON = {
  TCP: { 443: { HTTPS: true } },
  Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${PORT}` } } } },
  AllowFunnel: { [`${HOST}:443`]: true },
};
const SERVE_ONLY = { TCP: FUNNEL_ON.TCP, Web: FUNNEL_ON.Web };
/**
 * What `tailscale funnel --bg …` prints on a tailnet without Funnel: the
 * control server's text, then the link indented by 9 spaces
 * (cmd/tailscale/cli/serve_legacy.go enableFeatureInteractive, v1.104.2).
 */
const CONSENT_OUTPUT = `\nFunnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=nXk3Lm9CNTRL\n\n`;

function fakeDeps({
  tailscale = 'running',
  statuses = [],
  funnelStatus = FUNNEL_ON,
  direct,
  sshd = null,
  confirm = null,
  consentAfterPolls = Infinity,
  funnelFails = false,
} = {}) {
  const calls = {
    run: [],
    daemon: [],
    interactive: [],
    start: [],
    qr: [],
    printed: [],
    confirms: [],
  };
  let clock = 0;
  let polls = 0;
  let installed = tailscale !== 'missing';
  let loggedIn = tailscale === 'running';
  let allowed = !statuses.includes('no-funnel');
  let serving = funnelStatus;
  const deps = {
    print: (line) => calls.printed.push(line),
    qr: async (url) => void calls.qr.push(url),
    which: async (name) => (name === 'tailscale' ? installed : false),
    run: async (command) => {
      calls.run.push(command.join(' '));
      if (command[1] === 'status') {
        if (!allowed && ++polls >= consentAfterPolls) allowed = true;
        return {
          code: 0,
          stdout: JSON.stringify(
            !loggedIn ? STATUS_LOGGED_OUT : allowed ? STATUS_FUNNEL : STATUS_NO_FUNNEL,
          ),
          stderr: '',
        };
      }
      if (command[1] === 'funnel' && command[2] === 'status')
        return { code: 0, stdout: JSON.stringify(serving ?? {}), stderr: '' };
      if (command[1] === 'funnel') {
        if (funnelFails)
          return { code: 1, stdout: '', stderr: 'Access denied: serve config denied' };
        serving = FUNNEL_ON;
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    start: (command, onLine) => {
      calls.start.push(command.join(' '));
      for (const line of CONSENT_OUTPUT.split('\n')) onLine(line);
      return { stop: () => undefined };
    },
    interactive: async (command) => {
      calls.interactive.push(command.join(' '));
      if (command.includes('install.sh') || command.join(' ').includes('install.sh'))
        installed = true;
      if (command.includes('up')) loggedIn = true;
      return 0;
    },
    confirm: async (question) => {
      calls.confirms.push(question);
      return confirm;
    },
    daemon: async (path, body) => {
      calls.daemon.push({ path, body });
      return (
        direct ?? {
          ok: false,
          steps: [
            {
              ok: false,
              text: '공유기 바깥 주소 100.72.1.2가 통신사 공유 대역이에요 (CGNAT): 바깥에서 들어올 수 없어요',
            },
          ],
        }
      );
    },
    sshd: async () => sshd,
    outside: async (host) => ({ ok: true, text: `바깥 경로 확인 (${host}, fake)` }),
    sleep: async (ms) => void (clock += ms),
    now: () => clock,
  };
  return { deps, calls };
}

const out = (calls) => calls.printed.join('\n');

test('the connector a config gets: this PC keeps tailscale and new installs stay local', () => {
  assert.equal(
    defaultConnector({ port: 18240, funnel: true, allowedHosts: ['cld-gui.tailnet-example.ts.net'] }),
    'tailscale',
  );
  assert.equal(defaultConnector({ allowedHosts: ['cld-gui.tailnet-example.ts.net'] }), 'tailscale');
  assert.equal(defaultConnector({ port: 18240 }), 'local');
  assert.equal(defaultConnector({}), 'local');
  assert.equal(defaultConnector({ connector: 'direct', funnel: true }), 'direct');
  assert.equal(mergeConfig({}).connector, 'local');
  // A config written by an earlier install is never made less or more exposed by an update.
  assert.equal(mergeConfig({ connector: 'direct' }).connector, 'direct');
  assert.equal(mergeConfig({ connector: 'nope' }).connector, 'local');
  assert.equal(mergeConfig({ connector: 'lan' }, { connector: 'direct' }).connector, 'direct');
  assert.equal(parseArgs(['--connector', 'direct', '--manual-forward']).manualForward, true);
  assert.throws(() => parseArgs(['--connector', 'cloudflare']), /--connector/);
  assert.throws(() => parseArgs(['--ddns', 'office.duckdns.org']), /--ddns-token-file/);
  assert.equal(
    parseArgs(['--ddns', 'office.duckdns.org', '--ddns-token-file', '/t']).ddns,
    'office.duckdns.org',
  );
});

test('setup lines print the same guide, page and command as the panel', () => {
  const lines = setupLines({ steps: [{ ok: false, text: '설치 필요', guide: '직접 설치하세요', actions: [
    { kind: 'open', label: '설치 페이지', url: 'https://tailscale.com/download' },
    { kind: 'copy', label: '설치 명령', text: 'curl -fsSL https://tailscale.com/install.sh | sh' },
  ] }] });
  assert.match(lines.join('\n'), /직접 설치하세요/);
  assert.match(lines.join('\n'), /https:\/\/tailscale.com\/download/);
  assert.match(lines.join('\n'), /curl -fsSL https:\/\/tailscale.com\/install.sh \| sh/);
});

test('recorded tailscale outputs: consent link, Funnel allowed, what is published', () => {
  assert.equal(
    parseConsentUrl(CONSENT_OUTPUT),
    'https://login.tailscale.com/f/funnel?node=nXk3Lm9CNTRL',
  );
  assert.equal(parseConsentUrl('Funnel is already on'), null);
  // the older fallback (ipn.CheckFunnelAccess) only names its help page
  assert.equal(
    parseConsentUrl(
      'Funnel not available; "funnel" node attribute not set. See https://tailscale.com/s/no-funnel.',
    ),
    'https://tailscale.com/s/no-funnel',
  );
  assert.deepEqual(tailscaleFacts(STATUS_FUNNEL), {
    loggedIn: true,
    host: HOST,
    user: 'owner@localhost',
    funnelAllowed: true,
  });
  assert.equal(tailscaleFacts(STATUS_NO_FUNNEL).funnelAllowed, false);
  assert.equal(tailscaleFacts(STATUS_LOGGED_OUT).loggedIn, false);
  assert.equal(tailscaleFacts(null).loggedIn, false);
  assert.deepEqual(funnelServing(FUNNEL_ON, PORT), { host: HOST, funnel: true, tcp: false });
  assert.deepEqual(funnelServing(SERVE_ONLY, PORT), { host: HOST, funnel: false, tcp: false });
  assert.equal(funnelServing(FUNNEL_ON, 18256), null); // another daemon's port
  assert.deepEqual(funnelServing({ TCP: { 443: { TCPForward: `127.0.0.1:${PORT}` } } }, PORT), {
    host: '',
    funnel: false,
    tcp: true,
  });
});

test('Tailscale install steps per platform: admin steps exactly as typed', () => {
  assert.deepEqual(installSteps('wsl', { user: 'choi' }).install, [
    ['sh', '-c', 'curl -fsSL https://tailscale.com/install.sh | sh'],
  ]);
  assert.deepEqual(installSteps('linux', { user: 'choi' }).up, [
    'sudo',
    'tailscale',
    'up',
    '--qr',
    '--operator=choi',
  ]);
  assert.deepEqual(installSteps('win32').install, [
    ['winget', 'install', '--id', 'Tailscale.Tailscale', '-e'],
  ]);
  assert.deepEqual(installSteps('win32').up, ['tailscale', 'up', '--qr']);
  assert.deepEqual(installSteps('darwin', { brew: true }).install, [
    ['brew', 'install', '--cask', 'tailscale'],
  ]);
  assert.equal(
    installSteps('darwin', { brew: false }).link,
    'https://pkgs.tailscale.com/stable/#macos',
  );
});

test('this PC: Tailscale+Funnel already serve the daemon → nothing to do, nothing touched', async () => {
  const { deps, calls } = fakeDeps();
  const result = await remoteSetup({ platform: 'wsl', port: PORT, deps });
  assert.deepEqual(result, {
    connector: 'tailscale',
    host: HOST,
    user: 'owner@localhost',
    kept: true,
    funnel: true,
  });
  assert.match(out(calls), /✔ Tailscale\+Funnel active → nothing to do/);
  assert.deepEqual(calls.run, ['tailscale status --json', 'tailscale funnel status --json']); // read only
  assert.deepEqual(calls.daemon, []);
  assert.deepEqual(calls.interactive, []);
  // the same in a dry run
  const dry = fakeDeps();
  assert.equal(
    (await remoteSetup({ platform: 'wsl', port: PORT, dryRun: true, deps: dry.deps })).kept,
    true,
  );
});

test('a fresh PC behind a router that allows it: direct, no signup, no Tailscale', async () => {
  const { deps, calls } = fakeDeps({
    tailscale: 'missing',
    direct: {
      ok: true,
      url: 'https://203.0.113.7/AbCdEfGhIjKlMnOpQrStUv/',
      steps: [
        { ok: true, text: '공유기에 길을 열었어요: 외부 443 → 192.168.0.100:18443' },
        { ok: true, text: '인증서 발급: 203.0.113.7' },
      ],
    },
  });
  const result = await remoteSetup({ platform: 'linux', port: PORT, deps });
  assert.deepEqual(result, {
    connector: 'direct',
    url: 'https://203.0.113.7/AbCdEfGhIjKlMnOpQrStUv/',
  });
  assert.deepEqual(calls.daemon, [
    {
      path: '/api/cld/connector/enable',
      body: { connector: 'direct', options: { manualForward: false } },
    },
  ]);
  assert.match(out(calls), /✔ 공유기에 길을 열었어요/);
  assert.deepEqual(calls.run, []); // Tailscale never asked
});

test('CGNAT: direct skipped with its reason, SSH offered for the laptop, Tailscale Serve (never Funnel) as the last resort', async () => {
  const { deps, calls } = fakeDeps({ statuses: [], funnelStatus: null, sshd: 22 });
  const run = deps.run;
  const served = { serving: null };
  deps.run = async (command) => {
    const result = await run(command);
    if (command[1] === 'serve' && command[2] === '--bg') served.serving = SERVE_ONLY;
    if (command[1] === 'funnel' && command[2] === 'status' && served.serving)
      return { code: 0, stdout: JSON.stringify(served.serving), stderr: '' };
    return result;
  };
  const result = await remoteSetup({ platform: 'linux', port: PORT, deps });
  assert.deepEqual(result, {
    connector: 'tailscale',
    host: HOST,
    user: 'owner@localhost',
    kept: false,
    funnel: false,
  });
  const text = out(calls);
  assert.match(
    text,
    /건너뜀: 직접 열기 — 공유기 바깥 주소 100\.72\.1\.2가 통신사 공유 대역이에요 \(CGNAT\)/,
  );
  assert.match(text, /노트북 앱만: 이 PC의 SSH\(22번\)/);
  // S-22: the open internet needs `--connector funnel`; no choice means the tailnet only
  assert.ok(calls.run.includes(`tailscale serve --bg --https=443 http://127.0.0.1:${PORT}`));
  assert.ok(!calls.run.some((c) => c.startsWith('tailscale funnel --bg')));
  // the order the user asked for
  const order = ['… 1) 직접 열기', '노트북 앱만', '… 3) Tailscale'].map((s) => text.indexOf(s));
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
});

test('Funnel not allowed yet: the consent link as a QR, polls the CapMap, then turns Funnel on', async () => {
  const { deps, calls } = fakeDeps({
    statuses: ['no-funnel'],
    funnelStatus: null,
    consentAfterPolls: 4,
  });
  const result = await remoteSetup({ requested: 'funnel', platform: 'linux', port: PORT, deps });
  assert.equal(result.connector, 'tailscale');
  assert.deepEqual(calls.qr, ['https://login.tailscale.com/f/funnel?node=nXk3Lm9CNTRL']);
  assert.match(out(calls), /✔ Funnel이 허용됐어요/);
});

test('consent never comes: ✖ after 10 minutes, then the chat-only last resort is described', async () => {
  const { deps, calls } = fakeDeps({ statuses: ['no-funnel'], funnelStatus: null });
  const result = await remoteSetup({ requested: 'funnel', platform: 'linux', port: PORT, deps });
  assert.deepEqual(result, { connector: null });
  assert.equal(deps.now(), CONSENT_WAIT_MS);
  const text = out(calls);
  assert.match(text, /✖ 10분 안에 Funnel 허용을 확인하지 못했어요/);
  assert.match(text, /Claude 앱으로 대화만/);
  assert.match(
    text,
    /Anthropic이 대화를 중계·저장하고, 요청마다 토큰이 들고, 픽셀 오피스는 없어요/,
  );
  assert.ok(!calls.run.some((c) => c.startsWith('tailscale funnel --bg'))); // never turned on without consent
});

test('Tailscale missing, no terminal to ask: admin steps shown, nothing run, nothing installed', async () => {
  const { deps, calls } = fakeDeps({ tailscale: 'missing', confirm: null });
  const result = await remoteSetup({ platform: 'wsl', port: PORT, deps });
  assert.deepEqual(result, { connector: null });
  const text = out(calls);
  assert.match(
    text,
    /호스트에서 한 번: sh -c 'curl -fsSL https:\/\/tailscale\.com\/install\.sh \| sh'/,
  );
  assert.match(text, /호스트에서 한 번: sudo tailscale up --qr --operator=/);
  assert.match(text, /터미널에서 위 명령을 실행한 뒤 --remote를 다시 하세요/);
  assert.deepEqual(calls.interactive, []);
  assert.ok(text.indexOf('호스트에서 한 번') < text.indexOf('터미널에서')); // shown before anything else
});

test('Tailscale missing, the person says yes: install, `tailscale up --qr`, then Funnel', async () => {
  const { deps, calls } = fakeDeps({ tailscale: 'missing', confirm: true, funnelStatus: null });
  const result = await remoteSetup({ requested: 'funnel', platform: 'linux', port: PORT, deps });
  assert.equal(result.connector, 'tailscale');
  assert.equal(calls.interactive.length, 2);
  assert.equal(calls.interactive[0], 'sh -c curl -fsSL https://tailscale.com/install.sh | sh');
  assert.match(calls.interactive[1], /^sudo tailscale up --qr --operator=\S+$/);
  assert.equal(calls.confirms.length, 2); // each admin step asked for separately
});

test('Funnel refused for lack of operator: the one host command that fixes it', async () => {
  const { deps, calls } = fakeDeps({ funnelStatus: null, funnelFails: true });
  const result = await remoteSetup({ requested: 'funnel', platform: 'linux', port: PORT, deps });
  assert.deepEqual(result, { connector: null });
  assert.match(out(calls), /호스트에서 한 번: sudo tailscale set --operator=/);
});

test('dry run of --connector funnel on a PC without Funnel: the plan only; no daemon call, no Tailscale change, no install', async () => {
  const { deps, calls } = fakeDeps({ statuses: ['no-funnel'], funnelStatus: null });
  const result = await remoteSetup({ requested: 'funnel', platform: 'linux', port: PORT, dryRun: true, deps });
  assert.deepEqual(result, { connector: null });
  const text = out(calls);
  assert.match(
    text,
    /DRY-RUN: Funnel 허용 링크를 QR로 보여 주고 최대 10분 기다린 뒤 tailscale funnel --bg --https=443 http:\/\/127\.0\.0\.1:18240/,
  );
  assert.deepEqual(calls.daemon, []);
  assert.deepEqual(calls.interactive, []);
  assert.deepEqual(calls.start, []);
  assert.ok(calls.run.every((c) => c.endsWith('--json')));
});

test('--connector direct alone: no Tailscale fallback; --connector lan/local: no outside path at all', async () => {
  const direct = fakeDeps();
  assert.deepEqual(
    await remoteSetup({
      platform: 'linux',
      port: PORT,
      requested: 'direct',
      deps: { ...direct.deps, run: async () => ({ code: 0, stdout: '{}', stderr: '' }) },
    }),
    { connector: null },
  );
  for (const requested of ['lan', 'local']) {
    const { deps, calls } = fakeDeps();
    assert.deepEqual(await remoteSetup({ platform: 'linux', port: PORT, requested, deps }), {
      connector: requested,
    });
    assert.deepEqual(calls.run, []);
    assert.deepEqual(calls.daemon, []);
  }
});

test('a TCP-mode forward of our port is called out (it would pass client identity headers through)', async () => {
  const { deps, calls } = fakeDeps({
    funnelStatus: { TCP: { 443: { TCPForward: `127.0.0.1:${PORT}` } } },
  });
  await remoteSetup({ platform: 'linux', port: PORT, deps });
  assert.match(out(calls), /✖ Tailscale이 18240번을 TCP로 넘기고 있어요/);
});

test('S6: --connector tailscale turns on Serve (no Funnel, no consent); --connector funnel keeps the Funnel path', async () => {
  const serveOnly = fakeDeps({ funnelStatus: null });
  serveOnly.deps.run = ((inner) => async (command) => {
    const result = await inner(command);
    if (command[1] === 'serve' && command[2] === '--bg') serveOnly.serving = SERVE_ONLY;
    if (command[1] === 'funnel' && command[2] === 'status' && serveOnly.serving)
      return { code: 0, stdout: JSON.stringify(serveOnly.serving), stderr: '' };
    return result;
  })(serveOnly.deps.run);
  const serve = await remoteSetup({ platform: 'linux', port: PORT, requested: 'tailscale', deps: serveOnly.deps });
  assert.deepEqual(serve, { connector: 'tailscale', host: HOST, user: 'owner@localhost', kept: false, funnel: false });
  assert.ok(serveOnly.calls.run.includes(`tailscale serve --bg --https=443 http://127.0.0.1:${PORT}`));
  assert.ok(!serveOnly.calls.run.some((c) => c.startsWith('tailscale funnel --bg')));
  assert.deepEqual(serveOnly.calls.daemon, []);
  // Serve already on: kept; Funnel on is not what --connector tailscale asks for, so it is not kept
  const kept = fakeDeps({ funnelStatus: SERVE_ONLY });
  assert.equal((await remoteSetup({ platform: 'linux', port: PORT, requested: 'tailscale', deps: kept.deps })).kept, true);
  const funnelOn = fakeDeps();
  assert.equal((await remoteSetup({ platform: 'linux', port: PORT, requested: 'funnel', deps: funnelOn.deps })).funnel, true);
  const funnelNew = fakeDeps({ funnelStatus: null });
  const result = await remoteSetup({ platform: 'linux', port: PORT, requested: 'funnel', deps: funnelNew.deps });
  assert.equal(result.funnel, true);
  assert.ok(funnelNew.calls.run.includes(`tailscale funnel --bg --https=443 http://127.0.0.1:${PORT}`));
});

test('S6: --connector tailscale on a funneled port ends serve-only, whichever way `serve --bg` behaves; a foreign 443 is never touched', async () => {
  for (const serveClearsFunnel of [true, false]) {
    const { deps, calls } = fakeDeps();
    // One 443 handler; `funnel --https=443 off` removes it whole (seen on 1.104.2).
    let handler = { funnel: true };
    deps.run = async (command) => {
      calls.run.push(command.join(' '));
      const args = command.slice(1).join(' ');
      if (args === 'status --json') return { code: 0, stdout: JSON.stringify(STATUS_FUNNEL), stderr: '' };
      if (args === 'funnel status --json')
        return { code: 0, stdout: JSON.stringify(!handler ? {} : handler.funnel ? FUNNEL_ON : SERVE_ONLY), stderr: '' };
      if (args === 'funnel --https=443 off') handler = null;
      else if (args.startsWith('serve --bg')) handler = { funnel: !serveClearsFunnel && handler?.funnel === true };
      return { code: 0, stdout: '', stderr: '' };
    };
    const result = await remoteSetup({ platform: 'linux', port: PORT, requested: 'tailscale', deps });
    assert.deepEqual(result, { connector: 'tailscale', host: HOST, user: 'owner@localhost', kept: false, funnel: false }, String(serveClearsFunnel));
    assert.deepEqual(handler, { funnel: false });
  }
  const foreign = fakeDeps({ funnelStatus: { Web: { [`${HOST}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:9' } } } } } });
  assert.deepEqual(await remoteSetup({ platform: 'linux', port: PORT, requested: 'tailscale', deps: foreign.deps }), { connector: null });
  assert.ok(!foreign.calls.run.some((c) => c.includes('--bg') || c.endsWith('off')));
  assert.match(out(foreign.calls), /https 443이 다른 곳을 열고 있어요/);
});

test('S6: `serve|funnel --bg` succeeds but the re-read fails: the exposure is already in the ledger', async () => {
  for (const requested of ['tailscale', 'funnel']) {
    const { deps, calls } = fakeDeps({ funnelStatus: null });
    const recorded = [];
    deps.record = async (entry) => void recorded.push(entry);
    let bg = false;
    deps.run = ((inner) => async (command) => {
      if (command.includes('--bg')) bg = true;
      if (bg && command[1] === 'funnel' && command[2] === 'status') {
        calls.run.push(command.join(' '));
        return { code: 1, stdout: '', stderr: 'tailscaled not responding' };
      }
      return inner(command);
    })(deps.run);
    const result = await remoteSetup({ platform: 'linux', port: PORT, requested, deps });
    assert.deepEqual(result, { connector: null }, requested);
    assert.ok(calls.run.some((c) => c.includes('--bg')), requested);
    assert.deepEqual(recorded.map(({ at, ...e }) => e), [
      { kind: 'tailscale', host: HOST, port: PORT, funnel: requested === 'funnel', by: 'installer' },
    ], requested);
  }
});
