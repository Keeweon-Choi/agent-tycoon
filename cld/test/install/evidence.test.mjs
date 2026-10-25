// The owner's evidence script (evidence.sh) on a fresh test install: one report with the install record, service,
// health and versions, no secret in it, and nothing but read-only commands run (no start, stop, enable or install).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { release, scenario } from './harness.mjs';

test('evidence.sh: one report, no secrets, read-only', { timeout: 60_000 }, async (t) => {
  const s = await scenario('evidence'); t.after(() => s.cleanup());
  s.seedData();
  let r = await s.installSh(release('1.0.0'));
  assert.equal(r.code, 0, r.out + r.err);
  const record = fs.readFileSync(path.join(s.root, 'install.json'), 'utf8');
  const data = s.files();
  const callsBefore = s.calls().length;
  const report = path.join(s.base, 'report.txt');
  r = await s.run('sh', [path.join(import.meta.dirname, 'evidence.sh'), report], { env: { EVIDENCE_TEST: '1' } });
  assert.equal(r.code, 0, r.out + r.err);
  const text = fs.readFileSync(report, 'utf8');
  for (const want of ['"current": "1.0.0"', `"service":"cld-gui","version":"1.0.0"`, `ExecStart=${s.root}/current/node/bin/node`, '설치(관리자): 1.0.0', '시작 정책', 'claude   ', '"rc .bashrc"']) assert.ok(text.includes(want), `report has ${want}`);
  assert.equal(text.includes('test-host-token'), false, 'no token in the report');
  const ran = s.calls().slice(callsBefore);
  const readOnly = (c) => (c[0] === 'systemctl' && ['is-enabled', 'is-active', 'status'].includes(c[2])) || (c[0] === 'wsl.exe' && c[1] === '-l') || (c[0] === 'schtasks.exe' && c[1] === '/Query') || ['claude', 'codex'].includes(c[0]);
  assert.deepEqual(ran.filter((c) => !readOnly(c)), [], 'only reads');
  assert.equal(fs.readFileSync(path.join(s.root, 'install.json'), 'utf8'), record);
  assert.deepEqual(s.files(), data);
  assert.equal((await s.health())?.version, '1.0.0');
});
