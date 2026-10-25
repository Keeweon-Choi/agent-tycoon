// Negative controls of the INSTALL bundle: each check must be able to fail.
//   1. install-14 run against an install.sh whose SHA-256 check is removed must fail (the substituted bundle runs).
//   2. the invariant checker must report a write to a watched path (on a temp HOME, never the real one).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { INSTALL_SH } from './harness.mjs';
import { diff, snapshot } from './invariants.mjs';

const here = import.meta.dirname;

test('negative control: INSTALL-14 fails when install.sh no longer checks the bundle\'s SHA-256', { timeout: 120_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'at-negative-'));
  try {
    const sh = fs.readFileSync(INSTALL_SH, 'utf8');
    const check = /^ {2}\[ "\$got" = "\$want" \] \|\| die "refused \$name: SHA-256 .*$/m;
    assert.match(sh, check, 'the check this control removes is where it was');
    fs.writeFileSync(path.join(dir, 'install.sh'), sh.replace(check, '  : # SHA-256 check removed (negative control)'));
    const r = spawnSync(process.execPath, ['--test', '--test-name-pattern', 'install.sh --from refuses', path.join(here, 'install-14-integrity.test.mjs')], { encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')), AT_INSTALL_SH: path.join(dir, 'install.sh') }, timeout: 110_000 });
    assert.notEqual(r.status, 0, 'INSTALL-14 passed without the check: it does not test it');
    assert.match(r.stdout, /not ok 1 - INSTALL-14: install\.sh --from refuses/);
    assert.match(r.stdout, /substituted bundle: nothing from the refused bundle ran/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('negative control: the invariant checker reports a write to a watched path', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'at-invariants-'));
  try {
    for (const f of ['.bashrc', '.claude/settings.json', '.config/systemd/user/x.service']) { fs.mkdirSync(path.dirname(path.join(home, f)), { recursive: true }); fs.writeFileSync(path.join(home, f), 'same\n'); }
    const before = snapshot({ home, system: false });
    assert.deepEqual(diff(before, snapshot({ home, system: false })), [], 'unchanged reads as unchanged');
    fs.appendFileSync(path.join(home, '.bashrc'), 'export PATH="$HOME/.local/share/agent-tycoon/bin:$PATH"\n');
    fs.writeFileSync(path.join(home, '.config/systemd/user/agent-tycoon.service'), '[Service]\n');
    assert.deepEqual(diff(before, snapshot({ home, system: false })).map((c) => c.key).sort(), ['rc .bashrc', 'systemd user units']);
    const out = path.join(home, 'before.json');
    fs.writeFileSync(out, JSON.stringify({ at: 'now', home, system: false, values: before }));
    const r = spawnSync(process.execPath, [path.join(here, 'invariants.mjs'), 'compare', out], { encoding: 'utf8' });
    assert.equal(r.status, 1); assert.match(r.stderr, /CHANGED \(2\)[\s\S]*rc \.bashrc/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
