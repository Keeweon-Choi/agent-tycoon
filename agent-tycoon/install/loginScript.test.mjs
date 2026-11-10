// agent-tycoon/bin/agty-login as the desktop app runs it through wsl.exe: a non-interactive shell whose PATH has
// no node (10-27: the CONFIG-RENAME version asked node for the settings folder and every WSL login failed
// with "node: command not found"). It must still find the folders configPath.cjs picks.
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
const { configDirectory, officeDirectory } = require('../../core/src/agent-tycoon/configPath.cjs');
const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agty-login');
const NO_NODE_PATH = '/usr/bin:/bin';

function run(home, env = {}) {
  return new Promise((resolve) => {
    const child = spawn('bash', [SCRIPT, '--bare'], { env: { HOME: home, PATH: NO_NODE_PATH, ...env } });
    let out = '';
    let err = '';
    child.stdout.on('data', (b) => (out += b));
    child.stderr.on('data', (b) => (err += b));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

function home(settingsDir, port) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'login-script-'));
  // T-84: the host token is in the office folder; a stale upstream copy is never sent.
  fs.mkdirSync(officeDirectory(h), { recursive: true });
  fs.writeFileSync(path.join(officeDirectory(h), 'standalone-token'), 'test-token');
  fs.mkdirSync(path.join(h, '.pixel-agents'), { recursive: true });
  fs.writeFileSync(path.join(h, '.pixel-agents', 'standalone-token'), 'stale-token');
  const dir = settingsDir(h);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port }));
  return h;
}

test('agty-login gets a code without node on PATH, from the settings folder', { skip: process.platform === 'win32' }, async (t) => {
  const asked = [];
  const daemon = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url} ${req.headers.authorization}`);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ code: '12345678' }));
  });
  await new Promise((resolve) => daemon.listen(0, '127.0.0.1', resolve));
  t.after(() => daemon.close());
  const { port } = daemon.address();

  for (const settingsDir of [configDirectory]) {
    const h = home(settingsDir, port);
    t.after(() => fs.rmSync(h, { recursive: true, force: true }));
    assert.equal(settingsDir(h), configDirectory(h), 'the folder made is the one the resolver picks');
    const r = await run(h);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), '12345678');
    assert.doesNotMatch(r.err, /node/);
    // AGTY_TOKEN_FILE still overrides it.
    const other = path.join(h, 'other-token');
    fs.writeFileSync(other, 'override-token');
    assert.equal((await run(h, { AGTY_TOKEN_FILE: other })).code, 0);
  }
  assert.deepEqual(asked, ['POST /api/login-code Bearer test-token', 'POST /api/login-code Bearer override-token']);
});
