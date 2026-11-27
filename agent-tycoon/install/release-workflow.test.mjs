// release-bundles.yml's one-line install check runs on every bundle runner; a --service kind the manager refuses
// on that runner's OS only shows up when a tag is pushed (0.1.0-rc.9, 11-27: detached on macOS and Windows).
// This keeps that drift in the Installer Tests instead.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { SERVICE_KINDS, serviceRefusal } from './manager.mjs';

const workflow = fs.readFileSync(new URL('../../.github/workflows/release-bundles.yml', import.meta.url), 'utf8');
const PLATFORM = { linux: 'linux', darwin: 'darwin', win: 'win32' };

test('release-bundles.yml: the install steps pass matrix.service, and every target\'s kind is one the manager accepts on its OS', () => {
  const passed = [...workflow.matchAll(/^[^#\n]*--service (\$\{\{ matrix\.service \}\}|\S+)/gm)].map((m) => m[1]); // comments aside
  assert.ok(passed.length >= 2, 'the install.sh and install.ps1 steps');
  for (const kind of passed) assert.equal(kind, '${{ matrix.service }}', 'a literal --service skips the per-target check below');

  const rows = [...workflow.matchAll(/^\s*- \{ target: (\w+)-\w+,.*\}$/gm)];
  assert.ok(rows.length > 0);
  assert.equal(rows.length, workflow.match(/target: /g).length, 'every matrix target as one flow-style row');
  for (const [row, os] of rows) {
    const kind = /service: ([\w-]+)/.exec(row)?.[1];
    assert.ok(SERVICE_KINDS.includes(kind), `${row.trim()}: service ${kind}`);
    assert.equal(serviceRefusal(kind, PLATFORM[os]), null, row.trim());
  }
});
