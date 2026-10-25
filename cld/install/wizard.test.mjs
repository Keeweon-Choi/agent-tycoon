import assert from 'node:assert/strict';
import test from 'node:test';

import { allowedUrl, choice, desktopArtifact, desktopDefault, parseWizardArgs, parseWslList, sumsEntries, whereChoices, wslInstallArgv, wslOpenArgv, wslPathArgv } from './wizard.mjs';
import { lang, TEXT } from './wizardText.mjs';

test('language: Korean when LC_ALL, else LC_MESSAGES, else LANG starts with ko', () => {
  assert.equal(lang({ LANG: 'ko_KR.UTF-8' }), 'ko');
  assert.equal(lang({ LC_MESSAGES: 'ko_KR' , LANG: 'en_US.UTF-8' }), 'ko');
  assert.equal(lang({ LC_ALL: 'en_US.UTF-8', LANG: 'ko_KR.UTF-8' }), 'en');
  assert.equal(lang({ LC_ALL: '', LANG: 'ko' }), 'ko');
  assert.equal(lang({}), 'en');
  assert.equal(lang({ LANG: 'C.UTF-8' }), 'en');
  assert.deepEqual(Object.keys(TEXT.ko).sort(), Object.keys(TEXT.en).sort());
});

test('desktop app default: yes on a desktop with graphics, skip headless, over SSH, or without a terminal', () => {
  const d = (platform, env, tty = true) => desktopDefault({ platform, env, tty });
  assert.equal(d('linux', { DISPLAY: ':0' }), true);
  assert.equal(d('linux', { WAYLAND_DISPLAY: 'wayland-0' }), true);
  assert.equal(d('linux', {}), false);
  assert.equal(d('linux', { DISPLAY: ':0', SSH_CONNECTION: '10.0.0.2 5000 10.0.0.1 22' }), false);
  assert.equal(d('linux', { DISPLAY: ':0' }, false), false);
  assert.equal(d('darwin', {}), true);
  assert.equal(d('darwin', { SSH_TTY: '/dev/ttys001' }), false);
  assert.equal(d('win32', {}), true);
  assert.equal(d('win32', {}, false), false);
  assert.equal(d('wsl', {}), true); // the app goes on the Windows side, which has a screen
  assert.equal(d('wsl', { SSH_CONNECTION: 'x' }), false);
});

test('choice: a flag decides, --yes or no terminal take the default, else ask', () => {
  assert.deepEqual(choice('no', true, { tty: true }), { value: false });
  assert.deepEqual(choice('yes', false, { yes: false, tty: false }), { value: true });
  assert.deepEqual(choice(undefined, true, { yes: true, tty: true }), { value: true });
  assert.deepEqual(choice(undefined, false, { tty: false }), { value: false });
  assert.deepEqual(choice(undefined, true, { tty: true }), { ask: true, def: true });
});

test('where agents work: asked only on Windows with a WSL distro', () => {
  assert.deepEqual(whereChoices({ platform: 'win32', distros: ['Ubuntu', 'Debian'] }), [{ kind: 'wsl', distro: 'Ubuntu' }, { kind: 'native' }, { kind: 'remote' }]);
  assert.equal(whereChoices({ platform: 'win32', distros: [] }), null);
  for (const platform of ['linux', 'wsl', 'darwin']) assert.equal(whereChoices({ platform, distros: ['Ubuntu'] }), null);
});

test('wsl.exe -l -q output (UTF-16LE, BOM) gives the distros, default first, without Docker Desktop', () => {
  const out = Buffer.from('﻿Ubuntu-22.04\r\ndocker-desktop\r\nDebian\r\n\r\n', 'utf16le');
  assert.deepEqual(parseWslList(out), ['Ubuntu-22.04', 'Debian']);
  assert.deepEqual(parseWslList(Buffer.from('Ubuntu\n')), ['Ubuntu']);
  assert.deepEqual(parseWslList(Buffer.alloc(0)), []);
});

test('desktop artifact per OS: AppImage on Linux, dmg on macOS, NSIS on Windows and from WSL; none in a daemon-only release', () => {
  const names = [
    'agent-tycoon-daemon-1.0.0-linux-x64.tar.gz', 'agent-tycoon-daemon-1.0.0-win-x64.tar.gz',
    'pixel-office_1.0.0_amd64.AppImage', 'pixel-office_1.0.0_aarch64.AppImage', 'pixel-office_1.0.0_amd64.deb',
    'pixel-office_1.0.0_x64.dmg', 'pixel-office_1.0.0_aarch64.dmg', 'pixel-office_1.0.0_x64-setup.exe',
  ];
  assert.equal(desktopArtifact(names, { platform: 'linux', arch: 'x64' }), 'pixel-office_1.0.0_amd64.AppImage');
  assert.equal(desktopArtifact(names, { platform: 'linux', arch: 'arm64' }), 'pixel-office_1.0.0_aarch64.AppImage');
  assert.equal(desktopArtifact(names, { platform: 'darwin', arch: 'arm64' }), 'pixel-office_1.0.0_aarch64.dmg');
  assert.equal(desktopArtifact(names, { platform: 'darwin', arch: 'x64' }), 'pixel-office_1.0.0_x64.dmg');
  assert.equal(desktopArtifact(names, { platform: 'win32', arch: 'x64' }), 'pixel-office_1.0.0_x64-setup.exe');
  assert.equal(desktopArtifact(names, { platform: 'wsl', arch: 'arm64' }), 'pixel-office_1.0.0_x64-setup.exe'); // never a Linux GUI inside WSL
  assert.equal(desktopArtifact(names.slice(0, 2), { platform: 'linux', arch: 'x64' }), null);
  assert.equal(desktopArtifact(names, { platform: 'win32', arch: 'arm64' }), null);
});

test('SHA256SUMS entries', () => {
  const h = 'a'.repeat(64);
  assert.deepEqual(sumsEntries(`${h}  one.tar.gz\n${'b'.repeat(64)}  two.AppImage\nbad line\n`), { 'one.tar.gz': h, 'two.AppImage': 'b'.repeat(64) });
});

test('flags: wizard options, install options passed through, and the URL rule', () => {
  const o = parseWizardArgs(['--bundle', '/t/b.tar.gz', '--pub', '/t/k.pub', '--gui', 'no', '--launch', 'yes', '--yes', '--port', '18300', '--service', 'detached', '--add-path', '--base-url', 'https://example.com/r']);
  assert.deepEqual(o, { bundle: '/t/b.tar.gz', pub: '/t/k.pub', gui: 'no', launch: 'yes', yes: true, port: 18300, service: 'detached', addPath: true, baseUrl: 'https://example.com/r' });
  assert.deepEqual(parseWizardArgs(['--remote']), { remote: true });
  assert.throws(() => parseWizardArgs(['--bundle', 'b']), /--pub are required/);
  assert.throws(() => parseWizardArgs(['--remote', '--gui', 'maybe']), /--gui is yes or no/);
  assert.throws(() => parseWizardArgs(['--remote', '--port', '0']), /not a port/);
  assert.throws(() => parseWizardArgs(['--remote', '--frobnicate']), /unknown option/);
  assert.throws(() => parseWizardArgs(['--remote', '--port']), /needs a value/);
  assert.throws(() => parseWizardArgs(['--remote', '--base-url', 'http://127.0.0.1:9000']), /HTTPS only/);
  assert.equal(parseWizardArgs(['--remote', '--base-url', 'http://127.0.0.1:9000', '--insecure-localhost']).baseUrl, 'http://127.0.0.1:9000');
  assert.equal(allowedUrl('https://x.example/a'), true);
  assert.equal(allowedUrl('http://x.example/a', true), false);
  assert.equal(allowedUrl('http://localhost:1/a', true), true);
  assert.equal(allowedUrl('http://127.0.0.1:80@evil.example/', true), false);
  assert.equal(allowedUrl('ftp://127.0.0.1/', true), false);
  assert.equal(allowedUrl('not a url'), false);
});

test('wsl.exe argv: --exec (no shell re-parse in the distro), every value its own element, kept byte for byte', () => {
  const installer = 'C:\\Users\\John Smith\\AppData\\Local\\Temp\\agent-tycoon-install-1\\release\\install.sh';
  const odd = "https://rel.example/a b/$(id -un)/`x`/'q'";
  const net = wslInstallArgv('Ubuntu-22.04', installer, { yes: true, port: 18300, service: 'detached', addPath: true, baseUrl: odd, insecureLocalhost: true });
  assert.deepEqual(net, ['-d', 'Ubuntu-22.04', '--exec', 'sh', '-c', 'f=$(wslpath -u "$1") && shift && exec sh "$f" "$@"', 'sh', installer,
    '--gui', 'no', '--launch', 'no', '--yes', '--port', '18300', '--service', 'detached', '--add-path', '--base-url', odd, '--insecure-localhost']);
  assert.ok(!net.includes('--'), 'never `--`: the distro shell would re-parse the line');
  const local = wslInstallArgv('Debian', installer, {}, { dir: '/mnt/c/Users/John Smith/rel $(id)', pub: '/mnt/c/k.pub' });
  assert.deepEqual(local.slice(7), [installer, '--gui', 'no', '--launch', 'no', '--from', '/mnt/c/Users/John Smith/rel $(id)', '--pub', '/mnt/c/k.pub']);
  assert.deepEqual(wslPathArgv('Ubuntu', 'C:\\Users\\John Smith\\x.sh'), ['-d', 'Ubuntu', '--exec', 'wslpath', '-u', 'C:\\Users\\John Smith\\x.sh']);
  assert.deepEqual(wslOpenArgv('Ubuntu').slice(0, 5), ['-d', 'Ubuntu', '--exec', 'sh', '-c']);
});
