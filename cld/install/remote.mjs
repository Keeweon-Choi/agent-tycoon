/**
 * T-0024's explicit --connector paths. Automatic --remote now calls the daemon's
 * T-0090 setup planner and self-test, sharing them with the settings button.
 * This older path picks the outside path by itself, in the
 * user's order, and says plainly why each one it passes over was skipped:
 *   0. Tailscale + Funnel already serve this daemon: keep it, nothing to do.
 *   1. direct, no signup: the daemon maps 443 on the router (UPnP), gets a
 *      Let's Encrypt IP certificate and tests the outside path
 *      (POST /api/cld/connector/enable, the same code the app's wizard runs).
 *   2. SSH, the laptop app only, when an sshd answers here.
 *   3. Tailscale, the last resort (CGNAT, double NAT, blocked routers):
 *      logged in -> Funnel, its consent link as a QR, waiting up to 10
 *      minutes; missing -> the admin steps shown first and confirmed, then
 *      `tailscale up --qr`. `--connector tailscale` is Serve (the tailnet
 *      only, S6), `--connector funnel` this Funnel path.
 *   4. Claude Remote Control: chat only, described.
 * Nothing changes the router or Tailscale silently; sudo and admin steps run
 * only after a yes on a terminal, otherwise they are printed for the person.
 * Detection only reads (tailscale status/funnel status --json, a TCP probe).
 */
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';

import { isOurTunnel, portproxyRemoveCommands, tailscaleOffArgs } from '../../core/src/exposureLedger.mjs';
import { REMOTE_CHOICES } from '../../core/src/remoteSetupPlan.mjs';

export const SETUP_CHOICES = REMOTE_CHOICES;

export const CONNECTORS = Object.freeze(['local', 'lan', 'tailscale', 'direct']);
/** The terminal prints the step lines the settings button receives. */
export function setupLines(result) {
  const lines = [];
  for (const step of result.steps ?? []) {
    lines.push(`${step.unknown ? '?' : step.ok ? '✔' : '✖'} ${step.text}`);
    if (step.fix) lines.push(`  → ${step.fix}`);
    if (step.admin) lines.push(`  관리자 PowerShell에서 한 번:\n${step.admin}`);
    if (step.guide) lines.push(`  → ${step.guide}`);
    for (const action of step.actions ?? [])
      lines.push(action.kind === 'open' ? `  ${action.label}: ${action.url}` : `  ${action.label}: ${action.text}`);
    if (step.suggest) lines.push(`  다른 방식: ${step.suggest}`);
    // Nothing here can read that rule back: the person confirms it in the access panel.
    if (step.confirm) lines.push('  실행한 뒤 설정 → 접속 방식에서 "실행했어요"를 누르세요');
  }
  // A step that could not be checked from this PC is not a confirmation.
  if (result.ok && result.test && !result.test.steps?.some((step) => step.unknown))
    lines.push(`✔ 바깥 접속 확인됨 (${new Date(result.test.checkedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })}) ${result.url}`);
  return lines;
}
const TS_NAME = /\.ts\.net\.?$/i;
/**
 * The link `tailscale funnel` prints when the tailnet has not allowed Funnel
 * (cli/serve_legacy.go enableFeatureInteractive), or its older fallback's help
 * page (ipn.CheckFunnelAccess: https://tailscale.com/s/no-funnel).
 */
export const CONSENT_URL = /https:\/\/(?:login\.)?tailscale\.com\/[^\s"'<>]+/;
export const CONSENT_WAIT_MS = 10 * 60_000;

/**
 * The connector of a config with none yet: this PC's Tailscale set-up keeps
 * tailscale, an existing install stays loopback-only (no new port on upgrade),
 * and a new install is loopback-only too. Opening a LAN listener is always an
 * explicit choice.
 */
export function defaultConnector(existing = {}) {
  if (CONNECTORS.includes(existing.connector)) return existing.connector;
  if (existing.funnel === true || (existing.allowedHosts ?? []).some((h) => TS_NAME.test(String(h)))) return 'tailscale';
  return 'local';
}

export function parseConsentUrl(output) {
  return CONSENT_URL.exec(String(output ?? ''))?.[0].replace(/[.,;)]+$/, '') ?? null;
}

/** From `tailscale status --json`: logged in, the node's name, the login, Funnel allowed (CapMap). */
export function tailscaleFacts(status) {
  const self = status?.Self;
  const host = typeof self?.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : '';
  const caps = new Set([...Object.keys(self?.CapMap ?? {}), ...(Array.isArray(self?.Capabilities) ? self.Capabilities : [])]);
  return {
    loggedIn: status?.BackendState === 'Running' && host !== '',
    host,
    user: self?.UserProfile?.LoginName || status?.User?.[self?.UserID]?.LoginName || '',
    funnelAllowed: caps.has('funnel') && caps.has('https'),
  };
}

/**
 * From `tailscale funnel status --json`: is this daemon published, and how?
 * Only the HTTP proxy form strips client-sent identity headers; a TCP
 * forward of our port is reported so the caller replaces it.
 */
export function funnelServing(status, port) {
  const targets = [`http://127.0.0.1:${port}`, `http://127.0.0.1:${port}/`, `http://localhost:${port}`];
  for (const [hostPort, web] of Object.entries(status?.Web ?? {})) {
    if (!hostPort.endsWith(':443') || !targets.includes(web?.Handlers?.['/']?.Proxy)) continue;
    return { host: hostPort.slice(0, -4), funnel: status?.AllowFunnel?.[hostPort] === true, tcp: false };
  }
  for (const tcp of Object.values(status?.TCP ?? {}))
    if (String(tcp?.TCPForward ?? '').endsWith(`:${port}`)) return { host: '', funnel: false, tcp: true };
  return null;
}

/** Tailscale's install and first login per platform, exactly as a person would type them. */
export function installSteps(platform, { brew = false, user = os.userInfo().username } = {}) {
  const up = platform === 'linux' || platform === 'wsl' ? ['sudo', 'tailscale', 'up', '--qr', `--operator=${user}`] : ['tailscale', 'up', '--qr'];
  if (platform === 'win32') return { install: [['winget', 'install', '--id', 'Tailscale.Tailscale', '-e']], why: 'Windows 관리자 확인 창(UAC)이 한 번 떠요', up };
  if (platform === 'darwin')
    return brew
      ? { install: [['brew', 'install', '--cask', 'tailscale']], why: 'Homebrew로 설치해요', up }
      : { install: [], link: 'https://pkgs.tailscale.com/stable/#macos', why: 'Tailscale 앱(pkg)을 받아 설치하세요', up };
  return { install: [['sh', '-c', 'curl -fsSL https://tailscale.com/install.sh | sh']], why: 'Tailscale 공식 설치 스크립트가 sudo 비밀번호를 물어요 (저장하지 않아요)', up };
}

const shown = (command) => (typeof command === 'string' ? command : command.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replaceAll("'", "'\\''")}'`)).join(' '));

async function tailscaleState(deps) {
  if (!(await deps.which('tailscale'))) return { installed: false, loggedIn: false, funnelAllowed: false, user: '', serveStatus: null };
  const json = async (command) => {
    try {
      return JSON.parse((await deps.run(command)).stdout || '{}');
    } catch {
      return null;
    }
  };
  const facts = tailscaleFacts(await json(['tailscale', 'status', '--json']));
  return { installed: true, ...facts, serveStatus: facts.loggedIn ? await json(['tailscale', 'funnel', 'status', '--json']) : null };
}

/**
 * The whole --remote. `requested` is --connector (undefined: choose by the
 * order above; 'tailscale': Serve; 'funnel': Funnel). Returns the connector
 * set up or kept (null: none), and the Tailscale name, login and whether
 * Funnel is on when that path won.
 */
export async function remoteSetup({ platform, port, requested, dryRun = false, manualForward = false, funnel, sshPorts = [22], deps }) {
  const out = makeOutput(deps);
  const auto = requested === undefined;
  if (requested === 'lan' || requested === 'local') {
    out.say(true, requested === 'lan' ? '같은 와이파이(LAN)에서만 열어요' : '이 PC 안에서만 열어요');
    return { connector: requested };
  }

  // 0. Funnel (or, for --connector tailscale, Serve) already serves this daemon: keep it.
  const ts = await tailscaleState(deps);
  const serving = ts.loggedIn ? funnelServing(ts.serveStatus, port) : null;
  if (serving?.tcp) out.say(false, `Tailscale이 ${port}번을 TCP로 넘기고 있어요: 신원 헤더를 지우지 않는 형태라 HTTP 프록시로 바꿔야 해요`);
  if ((auto || requested === 'funnel') && serving?.funnel && funnel !== false) {
    out.say(true, `Tailscale+Funnel active → nothing to do (https://${serving.host}/ 가 이미 이 PC를 열고 있어요)`);
    return { connector: 'tailscale', host: serving.host, user: ts.user, kept: true, funnel: true };
  }
  if (requested === 'tailscale' && serving && !serving.tcp && !serving.funnel) {
    out.say(true, `Tailscale Serve active → nothing to do (https://${serving.host}/ 가 이미 내 기기에 이 PC를 열고 있어요)`);
    return { connector: 'tailscale', host: serving.host, user: ts.user, kept: true, funnel: false };
  }

  // 1. direct: the router, no account.
  if (auto || requested === 'direct') {
    deps.print('… 1) 직접 열기 (공유기, 가입 없음)');
    if (dryRun) {
      deps.print("DRY-RUN: POST /api/cld/connector/enable {\"connector\":\"direct\"} → 공유기 UPnP, 바깥 주소(STUN)와 NAT 비교, 외부 443 연결, Let's Encrypt IP 인증서(TLS-ALPN-01), 바깥 확인");
    } else {
      let result;
      try {
        result = await deps.daemon('/api/cld/connector/enable', { connector: 'direct', options: { manualForward } });
      } catch (error) {
        result = { ok: false, steps: [{ ok: false, text: `데몬에 묻지 못했어요: ${error.message}` }] };
      }
      out.steps(result.steps ?? []);
      if (result.ok) return { connector: 'direct', url: result.url };
      if (!auto) return { connector: null };
      out.skipped('직접 열기', (result.steps ?? []).find((s) => !s.ok)?.text ?? '실패');
    }
  }

  // 2. SSH: the laptop app only.
  if (auto) {
    const open = dryRun ? null : await deps.sshd(sshPorts);
    if (open) deps.print(`  노트북 앱만: 이 PC의 SSH(${open}번)가 열려 있어요. Pixel Office 앱의 "SSH 터널"로 중계 없이 붙어요 (밖에서는 공유기에서 그 포트를 포워드해야 해요; 아이폰은 못 써요)`);
    else out.skipped('SSH (노트북 앱)', dryRun ? 'DRY-RUN: 127.0.0.1의 sshd 포트를 확인만 해요' : '이 PC에서 sshd가 응답하지 않아요 (아이폰은 어차피 못 써요)');
  }

  // 3. Tailscale, the last resort.
  if (auto || requested === 'tailscale' || requested === 'funnel') {
    deps.print('… 3) Tailscale (무료 계정; CGNAT·이중 NAT에서도 돼요)');
    const result = await tailscalePath({ platform, port, dryRun, deps, out, ts, funnel: requested === 'funnel' });
    if (result) return result;
  }

  // 4. Claude Remote Control: chat only.
  deps.print('… 4) 마지막 방법: "Claude 앱으로 대화만"');
  deps.print('  엔진 프로젝트 설정에서 remote-control을 켜면 claude.ai/code와 Claude 앱에서 그 세션과 대화할 수 있어요.');
  deps.print('  Anthropic이 대화를 중계·저장하고, 요청마다 토큰이 들고, 픽셀 오피스는 없어요.');
  return { connector: null };
}

function makeOutput(deps) {
  const say = (ok, text) => deps.print(`${ok ? '✔' : '✖'} ${text}`);
  return {
    say,
    skipped: (path, why) => deps.print(`  건너뜀: ${path} — ${why}`),
    hostStep: (command) => deps.print(`  호스트에서 한 번: ${shown(command)}`),
    steps(list) {
      for (const step of list) {
        say(step.ok, step.text);
        if (step.fix) deps.print(`  → ${step.fix.split('\n').join('\n    ')}`);
        if (step.admin) this.hostStep(step.admin);
      }
    },
  };
}

/** Admin steps: shown first; run only after a yes on a terminal. False: not run (printed for the person). */
async function confirmAndRun(commands, deps) {
  const yes = await deps.confirm('위 관리자 단계를 지금 실행할까요?');
  if (!yes) {
    deps.print(yes === null ? '  터미널에서 위 명령을 실행한 뒤 --remote를 다시 하세요' : '  실행하지 않았어요');
    return false;
  }
  for (const command of commands) if ((await deps.interactive(command)) !== 0) return false;
  return true;
}

async function tailscalePath({ platform, port, dryRun, deps, out, ts, funnel = true }) {
  let state = ts;
  if (!state.installed) {
    const plan = installSteps(platform, { brew: platform === 'darwin' && (await deps.which('brew')) });
    deps.print(`  Tailscale이 없어요. 관리자 단계부터 보여 드려요: ${plan.why}`);
    for (const command of plan.install) out.hostStep(command);
    if (plan.link) deps.print(`  다운로드: ${plan.link}`);
    out.hostStep(plan.up);
    deps.print(`  (그다음 휴대폰으로 로그인 QR을 찍으면 ${funnel ? 'Funnel' : 'Serve'}을 켜요)`);
    if (dryRun || plan.install.length === 0 || !(await confirmAndRun(plan.install, deps))) return null;
    state = await tailscaleState(deps);
    if (!state.installed) return void out.say(false, 'Tailscale 설치를 확인하지 못했어요');
  }
  if (!state.loggedIn) {
    const { up } = installSteps(platform);
    deps.print('  Tailscale에 로그인해야 해요 (휴대폰으로 QR을 찍어요):');
    out.hostStep(up);
    if (dryRun || !(await confirmAndRun([up], deps))) return null;
    state = await tailscaleState(deps);
    if (!state.loggedIn) return void out.say(false, 'Tailscale 로그인을 확인하지 못했어요');
  }
  if (foreignHandler(state.serveStatus, port))
    return void out.say(false, 'Tailscale의 https 443이 다른 곳을 열고 있어요. 그 설정은 건드리지 않아요');
  // Only the HTTP proxy form, never a TCP mode: tailscaled strips identity headers only there.
  if (!funnel) return tailscaleServe({ port, dryRun, deps, out, host: state.host, wasFunnel: funnelServing(state.serveStatus, port)?.funnel === true });
  const command = ['tailscale', 'funnel', '--bg', '--https=443', `http://127.0.0.1:${port}`];
  if (dryRun) {
    deps.print(`DRY-RUN: ${state.funnelAllowed ? '' : 'Funnel 허용 링크를 QR로 보여 주고 최대 10분 기다린 뒤 '}${shown(command)}`);
    return null;
  }
  if (!state.funnelAllowed) {
    deps.print('  이 tailnet은 아직 Funnel을 허용하지 않았어요. 아래 링크(QR)에서 한 번 허용하세요. 최대 10분 기다려요');
    let link = null;
    const child = deps.start(command, (line) => {
      const url = parseConsentUrl(line);
      if (url && !link) {
        link = url;
        void deps.qr(url).then(() => deps.print(`  ${url}`));
      }
    });
    const until = deps.now() + CONSENT_WAIT_MS;
    while (deps.now() < until && !state.funnelAllowed) {
      await deps.sleep(5000);
      state = await tailscaleState(deps);
    }
    child.stop();
    if (!state.funnelAllowed) return void out.say(false, `10분 안에 Funnel 허용을 확인하지 못했어요${link ? '' : ' (허용 링크도 받지 못했어요)'}`);
    out.say(true, 'Funnel이 허용됐어요');
  }
  const result = await deps.run(command, { timeout: 30_000 });
  if (result.code !== 0) {
    const why = `${result.stderr}\n${result.stdout}`.split('\n').find((l) => l.trim()) ?? '';
    out.say(false, `Funnel을 켜지 못했어요: ${why}`);
    if (/access denied|permission|operator/i.test(why)) out.hostStep(['sudo', 'tailscale', 'set', `--operator=${os.userInfo().username}`]);
    return null;
  }
  // On before any check: a failed re-read must not leave a Funnel nobody recorded.
  await recordOn(deps, { host: state.host, port, funnel: true });
  const after = await tailscaleState(deps);
  const now = funnelServing(after.serveStatus, port);
  if (!now?.funnel) return void out.say(false, 'Funnel 설정을 다시 읽었는데 켜져 있지 않아요 (노출 장부에 적어 뒀어요: 제거나 다른 연결로 바꿀 때 되돌려요)');
  out.say(true, `Tailscale Funnel: https://${now.host}/`);
  const check = await deps.outside(now.host);
  out.say(check.ok, check.text);
  return { connector: 'tailscale', host: now.host, user: after.user, kept: false, funnel: true };
}

/** Into the exposure ledger (install.mjs passes deps.record) as soon as a `--bg` command succeeded. */
async function recordOn(deps, { host, port, funnel }) {
  await deps.record?.({ kind: 'tailscale', host, port, funnel, by: 'installer', at: deps.now() });
}

/** A https:443 handler that proxies somewhere other than this daemon: someone else's, never replaced. */
export function foreignHandler(status, port) {
  return !funnelServing(status, port) && Object.keys(status?.Web ?? {}).some((hostPort) => hostPort.endsWith(':443'));
}

/**
 * Serve: the tailnet only. No Funnel consent, no outside check (the internet
 * cannot reach it, by design). Serve and Funnel are one 443 handler, so a
 * funneled one is converged in place, re-reading after each command: on
 * tailscale 1.104.2 `funnel --https=443 off` was seen to drop the WHOLE
 * handler, and whether `serve --bg` clears Funnel is not known. UNVERIFIED
 * against the real binary (the tests use a fake modelled on what was seen).
 */
async function tailscaleServe({ port, dryRun, deps, out, host, wasFunnel = false }) {
  const command = ['tailscale', 'serve', '--bg', '--https=443', `http://127.0.0.1:${port}`];
  if (dryRun) return void deps.print(`DRY-RUN: ${shown(command)}`);
  const result = await deps.run(command, { timeout: 30_000 });
  if (result.code !== 0) {
    const why = `${result.stderr}\n${result.stdout}`.split('\n').find((l) => l.trim()) ?? '';
    out.say(false, `Serve를 켜지 못했어요: ${why}`);
    if (/access denied|permission|operator/i.test(why)) out.hostStep(['sudo', 'tailscale', 'set', `--operator=${os.userInfo().username}`]);
    return null;
  }
  // On before any check (as Funnel if it was: `serve --bg` may leave Funnel on).
  await recordOn(deps, { host, port, funnel: wasFunnel });
  let after = await tailscaleState(deps);
  let now = funnelServing(after.serveStatus, port);
  if (now?.funnel) {
    if ((await deps.run(['tailscale', 'funnel', '--https=443', 'off'])).code !== 0) return void out.say(false, 'Funnel을 끄지 못했어요');
    after = await tailscaleState(deps);
    now = funnelServing(after.serveStatus, port);
    if (!now) {
      if ((await deps.run(command, { timeout: 30_000 })).code !== 0) return void out.say(false, 'Serve를 다시 켜지 못했어요');
      after = await tailscaleState(deps);
      now = funnelServing(after.serveStatus, port);
    }
  }
  if (!now || now.tcp || now.funnel) return void out.say(false, 'Serve 설정을 다시 읽었는데 내 기기 전용으로 켜져 있지 않아요 (노출 장부에 적어 뒀어요: 제거나 다른 연결로 바꿀 때 되돌려요)');
  out.say(true, `Tailscale Serve (내 tailnet 기기만): https://${now.host}/`);
  return { connector: 'tailscale', host: now.host, user: after.user, kept: false, funnel: false };
}

/**
 * Uninstall (S6, T10): undo what the exposure ledger recorded. Serve/Funnel
 * goes off only while it still proxies to the recorded port (another config is
 * someone else's); a recorded tunnel pid is killed only while it is still our
 * process (start time and argv, isOurTunnel; a reused pid is left alone); a
 * portproxy needs an administrator, so its commands are printed.
 */
export async function revertExposures(entries, deps) {
  for (const entry of entries) {
    if (entry.kind === 'tailscale') {
      let status = null;
      try { status = JSON.parse((await deps.run(['tailscale', 'serve', 'status', '--json'])).stdout || 'null'); } catch { /* not asked */ }
      const live = funnelServing(status, entry.port);
      if (!live || live.tcp) { deps.print(`  Tailscale ${entry.funnel ? 'Funnel' : 'Serve'}: 이제 이 PC(${entry.port}번)를 가리키지 않아 그대로 둬요`); continue; }
      // By what is live, not what was recorded. UNVERIFIED against the real binary
      // (on 1.104.2 `funnel --https=443 off` was seen to drop the whole handler).
      const off = tailscaleOffArgs({ ...entry, funnel: live.funnel });
      const what = live.funnel ? 'Funnel' : 'Serve';
      const result = await deps.run(['tailscale', ...off]);
      deps.print(result.code === 0 ? `✔ Tailscale ${what}을 껐어요 (https://${entry.host}/)` : `! Tailscale ${what}을 끄지 못했어요: tailscale ${off.join(' ')}`);
    } else if (entry.kind === 'tunnel') {
      const proc = entry.pid ? { stat: await deps.procFile(entry.pid, 'stat'), cmdline: await deps.procFile(entry.pid, 'cmdline') } : null;
      if (proc && isOurTunnel(entry, proc)) {
        deps.kill(entry.pid);
        deps.print(`✔ 임시 주소 터널(cloudflared ${entry.pid})을 닫았어요`);
      } else if (entry.pid) deps.print(`  임시 주소 터널: ${entry.pid}번 프로세스는 이제 우리 cloudflared가 아니라 그대로 둬요`);
    } else {
      deps.print(`! Windows 포트 전달은 직접 지워야 해요. Windows 관리자 PowerShell 에서 실행:\n${portproxyRemoveCommands(entry.externalPort).join('\n')}`);
    }
  }
}

/**
 * The outside path through Funnel, from this PC: resolve the name with public
 * DNS (1.1.1.1 over HTTPS, not MagicDNS) to Tailscale's ingress, then fetch
 * through that address. The login page must answer, and the API must refuse
 * a visitor without a session.
 */
export async function funnelOutsideCheck(host, { fetchFn = fetch } = {}) {
  try {
    const answer = await (await fetchFn(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(8000) })).json();
    const ip = (answer.Answer ?? []).find((a) => a.type === 1)?.data;
    if (!ip) return { ok: false, text: `공개 DNS가 ${host}를 아직 몰라요 (새 Funnel은 10분까지 걸려요)` };
    const get = (path) =>
      new Promise((resolve, reject) => {
        const req = https.get({ host: ip, servername: host, headers: { host }, path, agent: false, timeout: 10_000 }, (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode ?? 0));
        });
        req.on('timeout', () => req.destroy(new Error('timeout'))).on('error', reject);
      });
    const page = await get('/');
    const api = await get('/api/cld/connector');
    if ((page === 200 || page === 401) && api === 401) return { ok: true, text: `바깥 경로 확인: ${ip}(Tailscale 입구)를 거쳐 로그인 화면이 열리고, 로그인 없이는 API가 막혀요` };
    return { ok: false, text: `바깥에서 받은 응답이 이상해요 (페이지 ${page}, API ${api})` };
  } catch (error) {
    return { ok: false, text: `바깥 경로를 확인하지 못했어요: ${error.message}` };
  }
}

/** Real I/O (tests pass fakes for all of it). */
export function realDeps({ port, token, print = console.log, qr = async () => {} }) {
  return {
    print,
    qr,
    run: (command, { timeout = 20_000 } = {}) =>
      new Promise((resolve) =>
        execFile(command[0], command.slice(1), { encoding: 'utf8', timeout }, (error, stdout, stderr) =>
          resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: stdout ?? '', stderr: stderr ?? '' }),
        ),
      ),
    /** A command whose output arrives over time (the Funnel consent link). */
    start: (command, onLine) => {
      const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', (chunk) => chunk.split('\n').forEach(onLine));
      return { stop: () => child.kill() };
    },
    /** An admin command on the person's own terminal: they type the sudo password, never us. */
    interactive: (command) => new Promise((resolve) => spawn(command[0], command.slice(1), { stdio: 'inherit' }).on('close', (code) => resolve(code ?? 1))),
    confirm: async (question) => {
      if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
      const { createInterface } = await import('node:readline/promises');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return /^(y|yes|예|네)$/i.test((await rl.question(`${question} [y/N] `)).trim());
      } finally {
        rl.close();
      }
    },
    daemon: async (path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(240_000),
      });
      if (!response.ok) throw new Error(`데몬이 ${response.status}로 답했어요`);
      return response.json();
    },
    sshd: async (ports) => {
      for (const p of ports) {
        const open = await new Promise((resolve) => {
          const socket = net.connect({ host: '127.0.0.1', port: p, timeout: 1000 }, () => {
            socket.destroy();
            resolve(true);
          });
          socket.on('error', () => resolve(false));
          socket.on('timeout', () => {
            socket.destroy();
            resolve(false);
          });
        });
        if (open) return p;
      }
      return null;
    },
    outside: (host) => funnelOutsideCheck(host),
    procFile: (pid, file) => fs.promises.readFile(`/proc/${pid}/${file}`, 'utf8').catch(() => null),
    kill: (pid) => { try { process.kill(pid); } catch { /* gone already */ } },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    which: (name) => new Promise((resolve) => execFile(process.platform === 'win32' ? 'where' : 'which', [name], (error) => resolve(!error))),
  };
}
