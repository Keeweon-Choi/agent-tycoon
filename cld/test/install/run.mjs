#!/usr/bin/env node
/**
 * The INSTALL bundle (P8): the invariant checker's snapshot of this machine, every scenario file one after another
 * (they share the test ports 18256-18259), the snapshot again. Fails when a scenario fails or anything watched changed.
 *
 *   node cld/test/install/run.mjs [name filter ...]      e.g. run.mjs 07 14
 *
 * TAP of each file goes to stdout as it runs; the table and the invariant result come last.
 * Nothing here needs the network, Windows, WSL or a service manager: everything outside HOME is a fake (harness.mjs).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const here = import.meta.dirname;
const filters = process.argv.slice(2);
const files = fs.readdirSync(here).filter((f) => f.endsWith('.test.mjs') && (!filters.length || filters.some((x) => f.includes(x)))).sort();
const before = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'at-install-run-')), 'invariants-before.json');
const checker = (...args) => spawnSync(process.execPath, [path.join(here, 'invariants.mjs'), ...args], { stdio: 'inherit' }).status;

if (checker('snapshot', before) !== 0) process.exit(2);
const rows = [];
for (const f of files) {
  const started = Date.now();
  const r = spawnSync(process.execPath, ['--test', path.join(here, f)], { stdio: 'inherit', env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')) });
  rows.push({ file: f, ok: r.status === 0, seconds: Math.round((Date.now() - started) / 1000) });
}
const unchanged = checker('compare', before) === 0;
console.log('\nINSTALL bundle');
for (const row of rows) console.log(`  ${row.ok ? 'pass' : 'FAIL'}  ${String(row.seconds).padStart(3)} s  ${row.file}`);
console.log(`  invariants: ${unchanged ? 'unchanged' : 'CHANGED (see above)'}  (${before})`);
process.exit(rows.every((r) => r.ok) && unchanged ? 0 : 1);
