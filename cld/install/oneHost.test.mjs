// P7 (F-27, INSTALL-11): one local host per Windows user. Fakes only: no wsl.exe, cmd.exe or health for real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { install, main, newRecord, oneHostMessage, otherLocalHost, SECOND_HOST_ENV, sideOf, sideRecords, start, writeRecord } from './manager.mjs';

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `onehost-${name}-`));
const wslRecord = { schema: 1, current: '1.0.0', port: 18240, wslDistro: 'Ubuntu' };

function deps({ platform = 'win32', health = null, sides = [], env = {} } = {}) {
  const home = tmp('home');
  const lines = [];
  const runs = [];
  return {
    platform, home, uid: 1000, env: { AGENT_TYCOON_ROOT: path.join(home, 'install'), ...env }, lines, runs,
    print: (l) => lines.push(String(l)),
    run: async (cmd) => { runs.push(cmd); return { ok: true, stdout: '', stderr: '' }; },
    health: async () => health, sleep: async () => {},
    sideRecords: async () => sides,
  };
}

test('P7: from Windows, a WSL daemon answering on the port or a WSL install record is another host; a Windows one is not', async () => {
  const wslUp = deps({ health: { service: 'cld-gui', version: '1.0.0', os: 'wsl' } });
  assert.deepEqual(await otherLocalHost({ platform: 'win32', port: 18240, deps: wslUp }), { os: 'wsl', distro: null, port: 18240, answering: true, via: '/api/health on 127.0.0.1:18240 (wsl, 1.0.0)' });
  assert.equal(await otherLocalHost({ platform: 'win32', port: 18240, deps: deps({ health: { service: 'cld-gui', os: 'win32' } }) }), null);
  // An older daemon (no os in health; the owner's WSL source install today) is the WSL side.
  assert.match((await otherLocalHost({ platform: 'win32', port: 18240, deps: deps({ health: { service: 'cld-gui', version: '' } }) })).via, /\(wsl, an older daemon\)/);
  assert.equal(await otherLocalHost({ platform: 'wsl', port: 18240, deps: deps({ platform: 'wsl', health: { service: 'cld-gui' } }) }), null);
  const recorded = deps({ sides: [sideOf(wslRecord, 'wsl', 'Ubuntu')] });
  assert.match((await otherLocalHost({ platform: 'win32', port: 18240, deps: recorded })).via, /install record \(port 18240\)/);
  // From WSL the other side is Windows.
  assert.equal((await otherLocalHost({ platform: 'wsl', port: 18240, deps: deps({ platform: 'wsl', health: { service: 'cld-gui', os: 'win32' } }) })).os, 'win32');
  assert.equal(await otherLocalHost({ platform: 'wsl', port: 18240, deps: deps({ platform: 'wsl', health: { service: 'cld-gui', os: 'wsl' } }) }), null);
  // Plain Linux and macOS have no other side.
  assert.equal(await otherLocalHost({ platform: 'linux', port: 18240, deps: wslUp }), null);
  // A record with nothing installed is no host.
  assert.equal(sideOf({ schema: 1, current: null, port: 18240 }, 'wsl'), null);
});

test('P7: installing Windows native beside a WSL host stops before anything is unpacked, with the move offer', async () => {
  const d = deps({ sides: [sideOf(wslRecord, 'wsl', 'Ubuntu')] });
  await assert.rejects(install({ from: '/nowhere/bundle.tar.gz' }, d), (error) => {
    assert.equal(error.code, 'ONE_HOST');
    assert.match(error.message, /WSL\(Ubuntu\) 쪽 Agent Tycoon 호스트/);
    assert.match(error.message, /옮기려면: WSL\(Ubuntu\) 쪽에서 agty uninstall --program/);
    assert.match(error.message, /--allow-second-host --port <다른 포트>/);
    return true;
  });
  assert.equal(fs.existsSync(path.join(d.env.AGENT_TYCOON_ROOT, 'versions')), false);
  assert.equal(fs.existsSync(path.join(d.env.AGENT_TYCOON_ROOT, 'install.json')), false);
  assert.equal(await main(['install', '--from', '/nowhere/b.tar.gz'], d), 3);
});

test('P7 test mode: --allow-second-host needs another port than the live host, never reads the other side, and warns', async () => {
  let reads = 0;
  const sides = [sideOf(wslRecord, 'wsl', 'Ubuntu')];
  const d = (extra = {}) => { const x = deps({ sides, ...extra }); x.sideRecords = async () => { reads += 1; return sides; }; return x; };
  // Without the flag: the refusal stays (and the other side's record was read).
  await assert.rejects(install({ from: '/nowhere/b.tar.gz', port: 18250 }, d()), { code: 'ONE_HOST' });
  assert.equal(reads, 1);
  reads = 0;
  // The flag without --port, or with the live host's 18240: refused, nothing read.
  await assert.rejects(install({ from: '/nowhere/b.tar.gz', allowSecondHost: true }, d()), /--allow-second-host 는 시험용이고 다른 포트가/);
  await assert.rejects(install({ from: '/nowhere/b.tar.gz', allowSecondHost: true, port: 18240 }, d()), { code: 'ONE_HOST' });
  // The flag and 18250: past the check (it then fails on the missing bundle), warned, the other side never read.
  const ok = d();
  await assert.rejects(install({ from: '/nowhere/b.tar.gz', allowSecondHost: true, port: 18250 }, ok), (error) => error.code !== 'ONE_HOST');
  assert.match(ok.lines.join('\n'), /⚠ 시험 모드 \(--allow-second-host\): 이 Windows 호스트는 포트 18250 에서 기본 호스트\(포트 18240\) 옆에/);
  // install.ps1's flag arrives as the env variable: the same.
  const viaEnv = d({ env: { [SECOND_HOST_ENV]: '1' } });
  await assert.rejects(install({ from: '/nowhere/b.tar.gz', port: 18250 }, viaEnv), (error) => error.code !== 'ONE_HOST');
  assert.equal(reads, 0);
  // A WSL daemon answering on the asked port is refused even then.
  await assert.rejects(install({ from: '/nowhere/b.tar.gz', allowSecondHost: true, port: 18250 }, d({ health: { service: 'cld-gui', os: 'wsl' } })), { code: 'ONE_HOST' });
  assert.equal(await main(['install', '--from', '/nowhere/b.tar.gz', '--allow-second-host'], d()), 3);
  // A test host's later starts stay in test mode: no WSL reads.
  const t = d();
  fs.mkdirSync(t.env.AGENT_TYCOON_ROOT, { recursive: true });
  await writeRecord(t.env.AGENT_TYCOON_ROOT, { ...newRecord({ root: t.env.AGENT_TYCOON_ROOT, platform: 'win32', env: {} }), current: '1.0.0', port: 18250, besides: { mode: 'test', livePort: 18240 }, service: { name: 'agent-tycoon', kind: 'none' } });
  await assert.rejects(start({ port: 18250 }, t), /no service to start/); // past the P7 check
  assert.equal(reads, 0);
});

test('P7: from WSL, starting while a Windows host is installed is refused; one installed beside it on another port is accepted', async () => {
  const winRecord = { schema: 1, current: '1.0.0', port: 18240 };
  const d = deps({ platform: 'wsl', sides: [sideOf(winRecord, 'win32')] });
  fs.mkdirSync(d.env.AGENT_TYCOON_ROOT, { recursive: true });
  await writeRecord(d.env.AGENT_TYCOON_ROOT, { ...newRecord({ root: d.env.AGENT_TYCOON_ROOT, platform: 'wsl', env: {} }), current: '1.0.0', port: 18257, service: { name: 'agent-tycoon', kind: 'systemd' } });
  await assert.rejects(start({ port: 18257 }, d), { code: 'ONE_HOST' });
  assert.deepEqual(d.runs, []); // nothing started
  let up = false;
  const beside = deps({ platform: 'wsl', sides: [sideOf({ ...winRecord, port: 18250, besides: { os: 'wsl', port: 18240 } }, 'win32')] });
  beside.home = d.home; beside.env = d.env;
  beside.health = async () => (up ? { service: 'cld-gui', os: 'wsl' } : null);
  beside.run = async (cmd) => { beside.runs.push(cmd); up = true; return { ok: true, stdout: '', stderr: '' }; };
  await start({ port: 18257 }, beside);
  assert.deepEqual(beside.runs, [['systemctl', '--user', 'start', 'agent-tycoon']]);
});

test('P7: the record lookups (read only): each WSL distro through wsl.exe --exec, the Windows record through cmd.exe + wslpath', async () => {
  const calls = [];
  const fromWindows = await sideRecords.win32(async (cmd, o) => {
    calls.push({ cmd, o });
    if (cmd[1] === '-l') return { ok: true, stdout: 'Ubuntu\r\ndocker-desktop\r\nDebian\r\n', stderr: '' }; // WSL_UTF8=1
    if (cmd[2] === 'Ubuntu') return { ok: true, stdout: JSON.stringify(wslRecord), stderr: '' };
    return { ok: false, stdout: '', stderr: '' };
  });
  assert.deepEqual(fromWindows, [{ os: 'wsl', distro: 'Ubuntu', port: 18240, besides: null }]);
  assert.equal(calls[0].o.env.WSL_UTF8, '1');
  assert.deepEqual(calls[1].cmd.slice(0, 5), ['wsl.exe', '-d', 'Ubuntu', '--exec', 'sh']);
  assert.equal(calls.length, 3); // docker-desktop is skipped
  const local = tmp('localappdata');
  fs.mkdirSync(path.join(local, 'AgentTycoon'));
  fs.writeFileSync(path.join(local, 'AgentTycoon', 'install.json'), JSON.stringify({ schema: 1, current: '1.0.0', port: 18250 }));
  const fromWsl = await sideRecords.wsl(async (cmd) => ({ ok: true, stdout: cmd[0] === 'cmd.exe' ? 'C:\\Users\\u\\AppData\\Local\r\n' : `${local}\n`, stderr: '' }));
  assert.deepEqual(fromWsl, [{ os: 'win32', distro: null, port: 18250, besides: null }]);
  assert.deepEqual(await sideRecords.wsl(async () => ({ ok: true, stdout: '%LOCALAPPDATA%\r\n', stderr: '' })), []);
  assert.match(oneHostMessage({ os: 'win32', port: 18250, answering: false, via: 'install record (port 18250)' }, 'wsl'), /이미 Windows 쪽/);
});
