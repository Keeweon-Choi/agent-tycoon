import assert from 'node:assert/strict';
import test from 'node:test';

import { REMOTE_CHOICES, remoteSetupPlan } from './remoteSetupPlan.mjs';

const facts = { natKind: 'open', upnp: true, wslMode: null, relayReady: false, tailscaleInstalled: false, tailscaleLoggedIn: false, cloudflaredInstalled: false, port: 18240, platform: 'linux' };
const plan = (choice, change = {}) => remoteSetupPlan({ ...facts, ...change }, choice);
const kinds = (choice, change) => plan(choice, change).map((s) => s.kind);

test('all eight choices follow the visible card order', () => assert.deepEqual(REMOTE_CHOICES, ['local', 'direct', 'ssh', 'duckdns', 'tailscale', 'funnel', 'tunnel', 'lan']));
test('local and lan only switch', () => { assert.deepEqual(kinds('local'), ['switch']); assert.deepEqual(kinds('lan'), ['switch']); });
test('direct only runs direct when possible and keeps a working direct mode', () => {
  assert.deepEqual(kinds('direct'), ['direct']);
  assert.deepEqual(kinds('direct', { existingWorking: 'direct' }), ['keep']);
});
test('CGNAT refuses direct and suggests Tailscale', () => {
  assert.deepEqual(kinds('direct', { natKind: 'cgnat' }), ['unavailable']);
  assert.equal(plan('direct', { natKind: 'cgnat' })[0].suggest, 'tailscale');
});
test('WSL without relay copies PowerShell lines and stops', () => {
  const relay = { kind: 'relay', directPort: 18443, externalPort: 443 };
  const steps = plan('direct', { natKind: 'unknown', wslMode: 'nat', wslInstructions: 'netsh interface portproxy add v4tov4 ...\nNew-NetFirewallRule ...', relay });
  assert.deepEqual(steps.map((s) => s.kind), ['wsl-relay']);
  assert.match(steps[0].actions[0].text, /netsh interface portproxy/);
  assert.deepEqual(steps[0].admin, relay);
});
test('DuckDNS asks for account details, then shares the direct router step', () => {
  assert.equal(plan('duckdns')[0].actions[0].url, 'https://www.duckdns.org');
  assert.deepEqual(kinds('duckdns', { duckdnsConfigured: true }), ['direct']);
});
test('Tailscale installation, login and Serve stay in that choice', () => {
  const install = plan('tailscale')[0];
  assert.equal(install.actions[0].url, 'https://tailscale.com/download/linux');
  assert.equal(install.actions[1].text, 'curl -fsSL https://tailscale.com/install.sh | sh');
  const login = plan('tailscale', { tailscaleInstalled: true })[0];
  assert.equal(login.actions[0].url, 'https://login.tailscale.com/start');
  assert.equal(login.actions[1].text, 'sudo tailscale up --operator=$USER');
  assert.deepEqual(kinds('tailscale', { tailscaleInstalled: true, tailscaleLoggedIn: true }), ['tailscale-serve']);
});
test('Funnel shares the Tailscale install and login, then asks consent or turns Funnel on', () => {
  assert.deepEqual(kinds('funnel'), ['tailscale-install']);
  assert.deepEqual(kinds('funnel', { tailscaleInstalled: true }), ['tailscale-login']);
  const ready = { tailscaleInstalled: true, tailscaleLoggedIn: true };
  assert.deepEqual(kinds('funnel', ready), ['tailscale-funnel']);
  const consent = plan('funnel', { ...ready, tailscaleFunnelAllowed: false })[0];
  assert.equal(consent.kind, 'tailscale-funnel-consent');
  assert.equal(consent.actions[0].url, 'https://login.tailscale.com/admin/acls/file');
  assert.deepEqual(kinds('funnel', { ...ready, existingWorking: 'funnel' }), ['keep']);
  assert.deepEqual(kinds('tailscale', { ...ready, existingWorking: 'funnel' }), ['tailscale-serve']);
});
test('tunnel installs cloudflared or opens only the tunnel', () => {
  assert.match(plan('tunnel')[0].actions[0].url, /developers\.cloudflare\.com/);
  assert.deepEqual(kinds('tunnel', { cloudflaredInstalled: true }), ['tunnel']);
});
test('SSH copies the exact laptop line', () => {
  assert.equal(plan('ssh', { sshUser: 'choi', sshHost: 'home.example' })[0].actions[0].text,
    'ssh -N -L 18240:127.0.0.1:18240 choi@home.example');
  assert.match(plan('ssh', { platform: 'win32' })[0].actions[1].text, /Add-WindowsCapability.*OpenSSH.Server/);
  assert.equal(plan('ssh', { platform: 'darwin' })[0].actions[1].text, 'sudo systemsetup -setremotelogin on');
});
test('REMOTE-XPLAT SSH per platform: WSL uses Windows OpenSSH; an SSH already there gives only the laptop line', () => {
  const wsl = plan('ssh', { platform: 'wsl' })[0];
  assert.match(wsl.actions[1].text, /Add-WindowsCapability/);
  assert.match(wsl.guide, /관리자 PowerShell/);
  assert.match(plan('ssh', { platform: 'darwin' })[0].guide, /원격 로그인/);
  const found = plan('ssh', { sshFound: true, sshUser: 'choi', sshHost: '192.168.0.12', sshPort: 2233 })[0];
  assert.equal(found.actions.length, 1);
  assert.equal(found.actions[0].text, 'ssh -N -L 18240:127.0.0.1:18240 -p 2233 choi@192.168.0.12');
});
test('REMOTE-XPLAT WSL mirrored never gets the portproxy step; NAT does', () => {
  assert.deepEqual(kinds('direct', { wslMode: 'mirrored', relayReady: false }), ['direct']);
  assert.deepEqual(kinds('direct', { wslMode: 'nat', relayReady: false }), ['wsl-relay']);
});
test('REMOTE-XPLAT firewall step before any listener: Windows re-checks by itself, Linux/macOS confirm by hand', () => {
  const win = { kind: 'windows', add: ['A', 'B'], ready: false, confirm: false, admin: { kind: 'firewall', firewall: 'windows', ports: [18240, 18443] } };
  const direct = plan('direct', { firewall: win });
  assert.deepEqual(direct.map((s) => s.kind), ['firewall']);
  assert.equal(direct[0].actions[0].text, 'A\nB');
  assert.equal(direct[0].confirm, undefined);
  assert.match(direct[0].guide, /관리자 PowerShell/);
  assert.deepEqual(direct[0].admin, win.admin);
  const ufw = plan('lan', { firewall: { kind: 'ufw', add: ['sudo ufw allow 18240/tcp'], ready: false, confirm: true } });
  assert.deepEqual(ufw.map((s) => s.kind), ['firewall', 'switch']);
  assert.equal(ufw[0].confirm, true);
  assert.equal(ufw[0].actions[0].label, '터미널 명령 복사');
  assert.deepEqual(kinds('lan', { firewall: { ...win, ready: true } }), ['switch']);
  assert.deepEqual(kinds('duckdns', { duckdnsConfigured: true, firewall: { kind: 'macos', add: ['x'], ready: false, confirm: true } }), ['firewall']);
  // WSL NAT: the relay comes first; the firewall (none there) never shows.
  assert.deepEqual(kinds('direct', { wslMode: 'nat', relayReady: true }), ['direct']);
});
test('REMOTE-XPLAT Tailscale download names the PC platform; WSL on Windows tailscale.exe gets no Linux commands', () => {
  assert.equal(plan('tailscale', { platform: 'darwin' })[0].actions[0].url, 'https://tailscale.com/download/mac');
  assert.equal(plan('tailscale', { platform: 'win32' })[0].actions[0].url, 'https://tailscale.com/download/windows');
  const wslWin = plan('tailscale', { platform: 'wsl', tailscaleWindows: true, tailscaleInstalled: true })[0];
  assert.equal(wslWin.actions.length, 1);
});
test('unknown choice is refused', () => assert.throws(() => plan('wrong'), /알 수 없는/));

test('an account name with a space is quoted so the one-line SSH tunnel still pastes', async () => {
  const { sshTunnelCommand } = await import('./remoteSetupPlan.mjs');
  assert.equal(sshTunnelCommand({ port: 18240, sshPort: 22, user: 'Keeweon Choi', host: '192.168.0.12' }),
    'ssh -N -L 18240:127.0.0.1:18240 "Keeweon Choi@192.168.0.12"');
  assert.equal(sshTunnelCommand({ port: 18240, sshPort: 22, user: 'choi', host: 'h' }), 'ssh -N -L 18240:127.0.0.1:18240 choi@h');
});
