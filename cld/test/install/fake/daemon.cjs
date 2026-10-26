'use strict';
// The daemon of a test bundle (it becomes dist/cli.js): answers what the manager asks of a real daemon and nothing
// else. GET /api/health, POST /api/login-code (host token), the engine socket's `status` and `stop-agents`,
// `--self-test`, and ~/.pixel-agents/server.json. Behaviour per version comes from files in $AT_TEST_CTL:
//   selftest-fail-<v>   self-test exits 1          selftest-sleep-<v>  self-test waits (an update to interrupt)
//   health-delay-<v>    ms before listening        crash-<v>           exits 1 at start (after migrate-<v>)
//   migrate-<v>         writes data-version.txt in the selected settings directory at start (a data migration)
//   projects.json       the engine's projects ([{ name, state }]), the same for every version
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
const version = manifest.version;
const ctl = process.env.AT_TEST_CTL || '';
const flag = (name) => ctl && fs.existsSync(path.join(ctl, `${name}-${version}`));
const flagNumber = (name) => Number(fs.readFileSync(path.join(ctl, `${name}-${version}`), 'utf8')) || 0;

if (process.argv.includes('--self-test')) {
  if (flag('selftest-fail')) { console.error(`self-test ${version}: fake failure`); process.exit(1); }
  if (flag('selftest-sleep')) setTimeout(() => { console.log(`self-test ${version} ok (slow)`); }, 60_000);
  else console.log(`self-test ${version} ok`);
  return;
}

const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
// This file is copied into a bundle, so it cannot require the repo; core/src/cld/configPath.cjs is the source of truth.
const legacy = path.join(os.homedir(), '.config', 'cld-gui');
const data = fs.existsSync(legacy) ? legacy : path.join(os.homedir(), '.config', 'agent-tycoon');
if (flag('migrate')) { fs.mkdirSync(data, { recursive: true }); fs.writeFileSync(path.join(data, 'data-version.txt'), `migrated by ${version}\n`); }
if (flag('crash')) { console.error(`fake daemon ${version}: crash at start`); process.exit(1); }

const TOKEN = 'test-host-token';
const projects = () => { try { return JSON.parse(fs.readFileSync(path.join(ctl, 'projects.json'), 'utf8')); } catch { return []; } };
const json = (res, body, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const server = http.createServer((req, res) => {
  if (req.url === '/api/health') return json(res, { service: 'cld-gui', version, protocol: manifest.protocol, pid: process.pid });
  if (req.url === '/api/login-code' && req.method === 'POST') return req.headers.authorization === `Bearer ${TOKEN}` ? json(res, { code: 'test-login-code' }) : json(res, { error: 'token' }, 401);
  return json(res, { error: 'not found' }, 404);
});

const sock = path.join(data, 'engine.sock');
const control = net.createServer((c) => {
  let buf = '';
  c.setEncoding('utf8');
  c.on('data', (d) => {
    buf += d;
    if (!buf.includes('\n')) return;
    let cmd = null;
    try { cmd = JSON.parse(buf.slice(0, buf.indexOf('\n'))).cmd; } catch { /* answered below */ }
    const reply = cmd === 'status' ? { ok: true, daemon: { port, entry: process.argv[1], pid: process.pid }, projects: projects(), jobs: [], tasks: [] }
      : cmd === 'stop-agents' ? { ok: true, stopped: [] } : { ok: false, error: `fake daemon: ${cmd}` };
    c.end(`${JSON.stringify(reply)}\n`);
  });
});

setTimeout(() => server.listen(port, '127.0.0.1', () => {
  fs.mkdirSync(data, { recursive: true });
  fs.rmSync(sock, { force: true });
  control.listen(sock);
  const pixel = path.join(os.homedir(), '.pixel-agents');
  fs.mkdirSync(pixel, { recursive: true });
  fs.writeFileSync(path.join(pixel, 'server.json'), JSON.stringify({ port, pid: process.pid, token: TOKEN }));
  console.log(`fake daemon ${version} on ${port}`);
}), flag('health-delay') ? flagNumber('health-delay') : 0);

const bye = () => { try { fs.rmSync(sock, { force: true }); } catch { /* gone */ } process.exit(0); };
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
