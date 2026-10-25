#!/usr/bin/env node
/**
 * Turn a LibreHardwareMonitor data.json into the HW sampler's LHM fixture
 * (T-0030): the computer's name becomes DESKTOP-TEST and the network adapters
 * and memory modules (names, GUIDs, SPD timings: unused here) are dropped.
 * Capture the input read-only from LHM's web server first, e.g. from WSL:
 *
 *   /mnt/c/Windows/System32/curl.exe -s http://localhost:<port>/data.json > data.json
 *   node cld/test/record-lhm.mjs data.json cld/test/hw/lhm-<name>.json
 */
import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: record-lhm.mjs <data.json> <fixture.json>');
const root = JSON.parse(fs.readFileSync(input, 'utf-8'));
const DROP = /^\/(nic|memory\/dimm)\//;
const keep = (n) => !(typeof n.HardwareId === 'string' && DROP.test(`${n.HardwareId}/`));
for (const computer of root.Children ?? []) {
  computer.Text = 'DESKTOP-TEST';
  computer.Children = (computer.Children ?? []).filter(keep);
}
fs.writeFileSync(output, `${JSON.stringify(root)}\n`);
console.log(`${output}: ${fs.statSync(output).size} bytes`);
