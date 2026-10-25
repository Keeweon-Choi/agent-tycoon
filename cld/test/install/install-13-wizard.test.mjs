// INSTALL-13 (CLI parts; this machine is WSL): the install wizard's defaults and choices.
//   a terminal on a desktop: the desktop app defaults to yes, and from WSL it is the Windows installer (run on the
//     Windows side through cmd.exe/wslpath), never a Linux GUI inside WSL;
//   headless (SSH_CONNECTION) under --yes: the app is skipped, nothing is opened;
//   --gui yes --launch yes: the Windows installer, then the office opens in the Windows browser (explorer.exe) with
//     a one-time login link; headless --launch yes prints the address, QR and link, opens nothing.
// The real NSIS install and the app itself are manual (install-owner-checklist.md).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { INSTALL_SH, PUB, release, scenario } from './harness.mjs';

const recorder = (name) => [`#!/bin/sh\nprintf '${name}\\t%s\\n' "$*" >>"$AT_TEST_CTL/calls.log"\n`, 0o755];
const SETUP = 'Pixel.Office_1.0.0_x64-setup.exe';
const APPIMAGE = 'pixel-office_1.0.0_amd64.AppImage';
const r1 = release('1.0.0', { extra: { [SETUP]: recorder('setup.exe'), [APPIMAGE]: recorder('appimage') } });
const ran = (s, name) => s.calls().filter((c) => c[0] === name);
const noLinuxGui = (s) => assert.equal(fs.existsSync(path.join(s.home, '.local/bin/pixel-office')), false, 'no Linux GUI inside WSL');

test('INSTALL-13: on a terminal the wizard asks, the desktop app defaults to yes, and from WSL it is the Windows installer', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i13-tty'); t.after(() => s.cleanup());
  const answers = [[/Choose 1-3 \[1\]:/, '\n'], [/Install Agent Tycoon Desktop\? \[Y\/n\]/, '\n'], [/Run it now\? \[Y\/n\]/, '\n'], [/Launch Agent Tycoon now\? \[Y\/n\]/, 'n\n']];
  const cmd = `sh ${INSTALL_SH} --from ${r1.dir} --pub ${PUB} --port ${s.port}`; // no --yes: a person at a terminal
  const r = await s.run('script', ['-qec', cmd, '/dev/null'], { answers });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /When should Agent Tycoon run\?/);
  assert.equal(ran(s, 'setup.exe').length, 1, 'the Windows installer ran once');
  assert.ok(s.calls().some((c) => c[0] === 'cmd.exe' && c.includes('echo %TEMP%')) && ran(s, 'wslpath').length, 'copied to the Windows temp folder first');
  assert.deepEqual(fs.readdirSync(path.join(s.ctl, 'wintemp')), [], 'and removed from there afterwards');
  assert.equal(ran(s, 'appimage').length, 0); noLinuxGui(s);
  assert.equal(ran(s, 'explorer.exe').length, 0, 'launch answered no');
  assert.equal(s.record().startPolicy, 'on-demand');
  assert.equal((await s.health())?.version, '1.0.0');
});

test('INSTALL-13: headless (SSH) under --yes skips the app and opens nothing', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i13-headless'); t.after(() => s.cleanup());
  const r = await s.installSh(r1, ['--yes', '--port', String(s.port)], { defaults: false, env: { SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /desktop app skipped/);
  assert.equal(ran(s, 'setup.exe').length + ran(s, 'appimage').length, 0); noLinuxGui(s);
  assert.equal(ran(s, 'explorer.exe').length + ran(s, 'xdg-open').length, 0);
  assert.equal((await s.health())?.version, '1.0.0');
});

test('INSTALL-13: --gui yes --launch yes from WSL: the Windows installer, then the Windows browser with a one-time link', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i13-yes'); t.after(() => s.cleanup());
  const r = await s.installSh(r1, ['--yes', '--gui', 'yes', '--launch', 'yes', '--port', String(s.port)], { defaults: false });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(ran(s, 'setup.exe').length, 1); assert.equal(ran(s, 'appimage').length, 0); noLinuxGui(s);
  assert.deepEqual(ran(s, 'explorer.exe').map((c) => c[1]), [`http://localhost:${s.port}/login?code=test-login-code`]);
  assert.equal(ran(s, 'xdg-open').length, 0);
});

test('INSTALL-13: headless --launch yes prints the address and the one-time link and opens nothing; agty open draws the QR too', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i13-headless-launch'); t.after(() => s.cleanup());
  const r = await s.installSh(r1, ['--yes', '--launch', 'yes', '--port', String(s.port)], { defaults: false, env: { SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, new RegExp(`주소: http://localhost:${s.port}`));
  assert.match(r.out, new RegExp(`/login\\?code=test-login-code`));
  assert.equal(ran(s, 'explorer.exe').length + ran(s, 'xdg-open').length + ran(s, 'setup.exe').length, 0);
  const again = await s.agty(['open'], { env: { SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' } });
  assert.equal(again.code, 0, again.out + again.err);
  assert.match(again.out, /[█▀▄]{5}/, 'the installed agty open draws the QR');
});

// install.sh unpacks only node, cld, core and package.json into its temp folder (no uqr there): the wizard's last
// step draws the QR with the installed version's cld-gui-qr.mjs, as agty open does.
test('INSTALL-13: headless --launch yes from install.sh also draws the QR', { timeout: 60_000 }, async (t) => {
  const s = await scenario('i13-headless-qr'); t.after(() => s.cleanup());
  const r = await s.installSh(r1, ['--yes', '--launch', 'yes', '--port', String(s.port)], { defaults: false, env: { SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /[█▀▄]{5}/, 'a QR code');
});
