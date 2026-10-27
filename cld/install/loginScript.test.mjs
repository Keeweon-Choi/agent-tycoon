// cld/bin/cld-gui-login as the desktop app runs it through wsl.exe: a non-interactive shell whose PATH has
// no node (10-27: the CONFIG-RENAME version asked node for the settings folder and every WSL login failed
// with "node: command not found"). It must still find the folder configPath.cjs picks, new or legacy.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { configDirectory, legacyConfigDirectory } = require('../../core/src/cld/configPath.cjs');
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'cld-gui-login');
const NO_NODE_PATH = '/usr/bin:/bin';

function run(home) {
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, '--bare'], { env: { HOME: home, PATH: NO_NODE_PATH } });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err += b));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function home(settingsDir, port) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'login-script-'));
  fs.mkdirSync(path.join(h, '.pixel-agents'), { recursive: true });
  fs.writeFileSync(path.join(h, '.pixel-agents', 'standalone-token'), 'test-token');
  const dir = settingsDir(h);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port }));
  return h;
}

test('cld-gui-login gets a code without node on PATH, from the new and from the legacy settings folder', { skip: process.platform === 'win32' }, async (t) => {
  const asked = [];
  const daemon = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: '12345678' }));
  });
  await new Promise((resolve) => daemon.listen(0, '127.0.0.1', resolve));
  t.after(() => daemon.close());
  const { port } = daemon.address();

  for (const settingsDir of [configDirectory, legacyConfigDirectory]) {
    const h = home(settingsDir, port);
    t.after(() => fs.rmSync(h, { recursive: true, force: true }));
    assert.equal(settingsDir(h), configDirectory(h), 'the folder made is the one the resolver picks');
    const r = await run(h);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), '12345678');
    assert.doesNotMatch(r.err, /node/);
  }
  assert.deepEqual(asked, Array(2).fill('POST /api/login-code Bearer test-token'));
});
