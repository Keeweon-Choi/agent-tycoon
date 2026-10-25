#!/usr/bin/env node
/**
 * Record this machine's hwmon sensors as a fixture for the HW sampler's sysfs
 * reader (T-0030). Reads /sys only; writes cld/test/hw/sysfs.json, where each
 * fixture is { note, files: { "class/hwmon/hwmonN/<file>": "<content>" } }.
 * Only the files the reader uses are copied, and the device/ files of a GPU.
 *
 *   node cld/test/record-sysfs.mjs <fixture-name>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const name = process.argv[2];
if (!name) throw new Error('usage: record-sysfs.mjs <fixture-name>');
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hw/sysfs.json');
const SENSOR = /^(name|temp\d+_(input|label)|power\d+_(average|input))$/;
const DEVICE = ['gpu_busy_percent', 'mem_info_vram_used', 'mem_info_vram_total'];
const read = (f) => {
  try {
    return fs.readFileSync(f, 'utf-8');
  } catch {
    return null;
  }
};
const list = (d) => {
  try {
    return fs.readdirSync(d).sort();
  } catch {
    return [];
  }
};

const files = {};
for (const chip of list('/sys/class/hwmon')) {
  const dir = path.join('/sys/class/hwmon', chip);
  for (const f of list(dir).filter((f) => SENSOR.test(f))) {
    const v = read(path.join(dir, f));
    if (v !== null) files[`class/hwmon/${chip}/${f}`] = v;
  }
  for (const f of DEVICE) {
    const v = read(path.join(dir, 'device', f));
    if (v !== null) files[`class/hwmon/${chip}/device/${f}`] = v;
  }
}
const zones = list('/sys/class/thermal');
const kinds = [...new Set(zones.map((z) => read(`/sys/class/thermal/${z}/type`)?.trim()))];
const drm = list('/sys/class/drm').filter((c) => /^card\d+$/.test(c));
const note =
  `recorded ${new Date().toISOString().slice(0, 10)} on ${os.release()}: ` +
  `${list('/sys/class/hwmon').length} hwmon chips; /sys/class/thermal: ${zones.length} entries (${kinds.join(', ') || 'none'}); ` +
  `/sys/class/drm: ${drm.map((c) => `${c} -> ${path.basename(fs.realpathSync(`/sys/class/drm/${c}/device`))}`).join(', ') || 'none'}`;
const all = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf-8')) : {};
all[name] = { note, files };
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(all, null, 2)}\n`);
console.log(`${name}: ${Object.keys(files).length} files. ${note}`);
