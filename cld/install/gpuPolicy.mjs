/**
 * T-0094: GPU reservations never fail open. The runtime (server/src/cld/engine/gpu.ts, `policyOf`)
 * derives the thresholds from the GPU's total VRAM when ~/.config/cld-gui/gpu.json has none; the
 * installer writes that file once, from the same rule, so the numbers are visible and editable.
 * It never overwrites an existing gpu.json. The shares below must stay equal to gpu.ts's
 * DERIVED_SHARE (both sides are pinned by tests on 8, 12 and 24 GiB).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const DERIVED_SHARE = Object.freeze({ exclusive: 0.55, shared: 0.55, live: 0.75 });
const halfGib = (gib) => Math.round(gib * 2) / 2;
/** WSL ships nvidia-smi here, outside a service's PATH. */
const SMI_CANDIDATES = ['nvidia-smi', '/usr/lib/wsl/lib/nvidia-smi'];

export const gpuJsonPath = (home = os.homedir()) => path.join(home, '.config', 'cld-gui', 'gpu.json');

/** The default thresholds for a GPU of `totalMib`, or null when the size is not a positive number. */
export function derivedGpuPolicy(totalMib) {
  if (!(typeof totalMib === 'number' && totalMib > 0)) return null;
  const total = totalMib / 1024;
  return {
    exclusiveGib: halfGib(total * DERIVED_SHARE.exclusive),
    sharedBudgetGib: halfGib(total * DERIVED_SHARE.shared),
    liveLimitGib: halfGib(total * DERIVED_SHARE.live),
  };
}

/** The first GPU's total VRAM in MiB from nvidia-smi, or null (no NVIDIA GPU, no tool, no answer). */
export async function detectVramMib(candidates = SMI_CANDIDATES) {
  for (const bin of candidates) {
    try {
      const { stdout } = await run(bin, ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { timeout: 5000, windowsHide: true });
      const mib = Number(stdout.split('\n').find((line) => line.trim()));
      if (Number.isFinite(mib) && mib > 0) return mib;
    } catch { /* next */ }
  }
  return null;
}

/** The GPU's total from a hw.json the daemon already wrote (the size does not age), or null. */
export function hwJsonVramMib(home) {
  for (const file of [path.join(home, '.local/share/cld-gui/hw.json')]) {
    try {
      const mib = JSON.parse(fs.readFileSync(file, 'utf8'))?.gpu?.vram_total_mib;
      if (typeof mib === 'number' && mib > 0) return mib;
    } catch { /* next */ }
  }
  return null;
}

/** The size the installer goes by: a hw.json first (CON-005: no direct GPU query), nvidia-smi only on the user's opt-in. */
export async function gpuTotalMib(home, { nvidiaSmi = false, smi = detectVramMib } = {}) {
  return hwJsonVramMib(home) ?? (nvidiaSmi ? await smi() : null);
}

/** The user's nvidia-smi opt-in: the daemon's config (--nvidia-smi) or gpu.json's `nvidiaSmi`. */
export function nvidiaSmiOptIn(home, config) {
  if (config?.nvidiaSmi === true) return true;
  try { return JSON.parse(fs.readFileSync(gpuJsonPath(home), 'utf8'))?.nvidiaSmi === true; } catch { return false; }
}

const numbers = (j) => Object.fromEntries(['exclusiveGib', 'sharedBudgetGib', 'liveLimitGib'].filter((k) => typeof j?.[k] === 'number' && Number.isFinite(j[k]) && j[k] >= 0).map((k) => [k, j[k]]));

/** {file: 'missing'|'present', rule: 'file'|'derived'|'unknown', thresholds?, totalGib?} for --check and the step. */
export function gpuRule(home, totalMib) {
  let present = true; let json = {};
  try { json = JSON.parse(fs.readFileSync(gpuJsonPath(home), 'utf8')); } catch (error) { if (error.code === 'ENOENT') present = false; }
  const own = numbers(json);
  if (own.exclusiveGib !== undefined && own.sharedBudgetGib !== undefined) return { present, rule: 'file', thresholds: { liveLimitGib: null, ...own } };
  const derived = derivedGpuPolicy(totalMib);
  return derived ? { present, rule: 'derived', thresholds: { ...derived, ...own }, totalGib: totalMib / 1024 } : { present, rule: 'unknown' };
}

const gib = (n) => String(Math.round(n * 100) / 100);
export function gpuRuleLines(r) {
  if (r.rule === 'unknown') return ['GPU 예약 문턱: GPU 크기를 몰라 한 번에 하나만 돕니다 (gpu.json 에 exclusiveGib·sharedBudgetGib 를 적으면 그 값을 따릅니다)'];
  const t = r.thresholds;
  const nums = `혼자 ${gib(t.exclusiveGib)} · 함께 ${gib(t.sharedBudgetGib)} · 실제 ${t.liveLimitGib === null ? '없음' : gib(t.liveLimitGib)} GiB`;
  if (r.rule === 'file') return [`GPU 예약 문턱: gpu.json (${nums})`];
  return [`GPU 예약 문턱: GPU 크기에서 정한 기본값 (GPU ${gib(r.totalGib)} GiB의 ${['exclusive', 'shared', 'live'].map((k) => `${Math.round(DERIVED_SHARE[k] * 100)}%`).join(' · ')}: ${nums})${r.present ? '' : ' — gpu.json 이 없습니다'}`];
}

/**
 * The install step: write gpu.json once when it is missing and the GPU's size is known (0600,
 * exclusive create, so an existing file, even one made a moment ago, is never touched).
 * Returns the rule in force afterwards.
 */
export async function gpuStep(home, { dryRun = false, detect = () => gpuTotalMib(home), log = console.log } = {}) {
  const file = gpuJsonPath(home);
  const total = fs.existsSync(file) && gpuRule(home, null).rule === 'file' ? null : await detect();
  const before = gpuRule(home, total);
  if (!before.present) {
    if (before.rule === 'derived') {
      const body = `${JSON.stringify({ exclusiveGib: before.thresholds.exclusiveGib, sharedBudgetGib: before.thresholds.sharedBudgetGib, liveLimitGib: before.thresholds.liveLimitGib }, null, 2)}\n`;
      if (dryRun) log(`DRY-RUN file ${file} (0600):\n${body}`);
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        try { fs.writeFileSync(file, body, { flag: 'wx', mode: 0o600 }); log(`✔ GPU 예약 문턱을 ${file} 에 적었습니다`); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
    } else log('! GPU 크기를 알 수 없어 gpu.json 을 만들지 않았습니다. GPU 예약은 한 번에 하나씩만 돕니다');
  }
  const after = gpuRule(home, total);
  for (const line of gpuRuleLines(after)) log(line);
  return after;
}
