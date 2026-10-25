/**
 * T-0030 HW sampler: the sysfs reader on recorded and synthesized hwmon trees,
 * the LHM data.json parser on a recorded tree, the nvidia-smi gate and stall
 * rules with a fake binary, and how HwSource puts them together per OS.
 * Nothing here runs a real nvidia-smi or touches Windows: the LHM readers and
 * nvidia-smi are fixtures, doubles or the fake in cld/test/hw.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REPO_ROOT } from '../testHome.js';
import {
  hasHwReadings,
  HwSource,
  readRamDetail,
  readTopProcesses,
  withoutDetail,
} from './hwSource.js';
import { LHM_RETRY_MS, LhmReader, parseLhm } from './lhm.js';
import { findNvidiaSmi, NvidiaSmi, nvidiaSmiStuck, parseNvidiaCsv } from './nvidiaSmi.js';
import { readSysfs } from './sysfs.js';

const FIXTURES = path.join(REPO_ROOT, 'cld/test/hw');
const FAKE_NVIDIA = path.join(FIXTURES, 'fake-nvidia-smi');
/** Every test runs with the fake as the first nvidia-smi on PATH: whatever looks one
 *  up by name finds the fake, never this machine's real one (/usr/bin, WSL's lib). */
const FAKE_BIN = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-fakebin-'));
fs.copyFileSync(FAKE_NVIDIA, path.join(FAKE_BIN, 'nvidia-smi'));
fs.chmodSync(path.join(FAKE_BIN, 'nvidia-smi'), 0o755);
const tmps: string[] = [];
const savedEnv = { ...process.env };
beforeEach(() => {
  process.env.PATH = [FAKE_BIN, '/usr/bin', '/bin'].join(path.delimiter);
});
afterEach(() => {
  process.env = { ...savedEnv };
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
afterAll(() => fs.rmSync(FAKE_BIN, { recursive: true, force: true }));
const tmp = (prefix: string) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmps.push(d);
  return d;
};

/** One fixture of cld/test/hw/sysfs.json as a /sys tree in a temp dir. */
function sysTree(name: string): string {
  const all = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'sysfs.json'), 'utf-8')) as Record<
    string,
    { files: Record<string, string> }
  >;
  const root = tmp('cld-sys-');
  fs.mkdirSync(path.join(root, 'class/hwmon'), { recursive: true });
  for (const [f, text] of Object.entries(all[name].files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
}

/** A /proc with only meminfo: 16 GiB, 10 available, 3 cache + 0.5 buffers, 2 GiB swap of which 0.5 used. */
function meminfoRoot(): string {
  const root = tmp('cld-proc-');
  const kib = (gib: number) => Math.round(gib * 1024 * 1024);
  fs.writeFileSync(
    path.join(root, 'meminfo'),
    [
      `MemTotal:       ${kib(16)} kB`,
      `MemFree:        ${kib(8)} kB`,
      `MemAvailable:   ${kib(10)} kB`,
      `Buffers:        ${kib(0.5)} kB`,
      `Cached:         ${kib(3)} kB`,
      `SwapTotal:      ${kib(2)} kB`,
      `SwapFree:       ${kib(1.5)} kB`,
    ].join('\n'),
  );
  return root;
}

const lhmFixture = () =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, 'lhm-intel-nvidia.json'), 'utf-8')) as unknown;

/** Two GPUs, a CPU and the host's RAM, all values invented (cld/test/hw/lhm-two-gpus.json). */
const lhmTwoGpus = () =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, 'lhm-two-gpus.json'), 'utf-8')) as unknown;

/** A Zen CPU (invented values): per-core clock and load, two core temperatures, SMU powers that are not the package. */
const lhmAmd = () =>
  JSON.parse(fs.readFileSync(path.join(FIXTURES, 'lhm-amd-cores.json'), 'utf-8')) as unknown;

/** A bare Intel CPU tree of (type, name, value) sensors, ids numbered per type; invented values. */
function intelTree(sensors: Array<[type: string, text: string, value: string]>) {
  const next: Record<string, number> = {};
  return {
    Children: [
      {
        HardwareId: '/intelcpu/0',
        Text: 'CPU',
        Children: sensors.map(([Type, Text, Value]) => ({
          SensorId: `/intelcpu/0/${Type.toLowerCase()}/${(next[Type] = (next[Type] ?? -1) + 1)}`,
          Type,
          Text,
          Value,
        })),
      },
    ],
  };
}

/** A small LHM tree: a Zen CPU and a Radeon card, numbers written the German way. */
const zenRadeon = {
  Text: 'Sensor',
  Children: [
    {
      Text: 'PC',
      Children: [
        {
          Text: 'AMD Ryzen 7 7700',
          HardwareId: '/amdcpu/0',
          Children: [
            {
              SensorId: '/amdcpu/0/temperature/2',
              Type: 'Temperature',
              Text: 'Core (Tctl/Tdie)',
              Value: '61,5 °C',
            },
            {
              SensorId: '/amdcpu/0/temperature/3',
              Type: 'Temperature',
              Text: 'CCD1 (Tdie)',
              Value: '58,0 °C',
            },
            { SensorId: '/amdcpu/0/power/0', Type: 'Power', Text: 'Package', Value: '45,2 W' },
          ],
        },
        {
          Text: 'AMD Radeon RX 7800 XT',
          HardwareId: '/gpu-amd/0',
          Children: [
            {
              SensorId: '/gpu-amd/0/temperature/0',
              Type: 'Temperature',
              Text: 'GPU Core',
              Value: '44,0 °C',
            },
            {
              SensorId: '/gpu-amd/0/temperature/2',
              Type: 'Temperature',
              Text: 'GPU Hot Spot',
              Value: '51,0 °C',
            },
            { SensorId: '/gpu-amd/0/power/3', Type: 'Power', Text: 'GPU Package', Value: '38,0 W' },
            { SensorId: '/gpu-amd/0/load/0', Type: 'Load', Text: 'GPU Core', Value: '12,0 %' },
            {
              SensorId: '/gpu-amd/0/smalldata/1',
              Type: 'SmallData',
              Text: 'GPU Memory Used',
              Value: '2048,0 MB',
            },
            {
              SensorId: '/gpu-amd/0/smalldata/2',
              Type: 'SmallData',
              Text: 'GPU Memory Total',
              Value: '16368,0 MB',
            },
          ],
        },
      ],
    },
  ],
};

describe('sysfs (Linux hwmon)', () => {
  it("this PC's recorded tree (WSL2: no hwmon chip) gives nothing, without an error", () => {
    expect(readSysfs(sysTree('wsl2-this-pc'))).toEqual({});
    expect(readSysfs(path.join(tmp('cld-nosys-'), 'missing'))).toEqual({});
  });

  it('Intel package temperature, and a Radeon edge, junction, power, load and VRAM', () => {
    expect(readSysfs(sysTree('intel-coretemp-amdgpu'))).toEqual({
      cpuTempC: 54,
      gpuTempC: 45,
      gpuHotspotC: 52,
      gpuPowerW: 34,
      gpuUtil: 0.17,
      vramUsedMib: 1024,
      vramTotalMib: 16368,
    });
  });

  it('Zen Tctl; with an APU and a card, the card (more VRAM) is the GPU shown', () => {
    expect(readSysfs(sysTree('zen-apu-and-radeon'))).toEqual({
      cpuTempC: 61.3,
      gpuTempC: 41,
      gpuHotspotC: 44,
      gpuPowerW: 12,
      gpuUtil: 0,
      vramUsedMib: 384,
      vramTotalMib: 8176,
    });
  });

  it('Tdie over an offset Tctl; no GPU chip under the NVIDIA driver; a Pi SoC', () => {
    expect(readSysfs(sysTree('zen-tdie-offset'))).toEqual({ cpuTempC: 40.1 });
    expect(readSysfs(sysTree('intel-nvidia-proprietary'))).toEqual({ cpuTempC: 47 });
    expect(readSysfs(sysTree('raspberry-pi'))).toEqual({ cpuTempC: 48.3 });
  });
});

describe('LHM data.json', () => {
  it("reads a recorded tree (Intel CPU, NVIDIA card): package temperature and power, the GPU's five", () => {
    // The recorded tree also has per-core sensors: asserted below on invented values only.
    expect(parseLhm(lhmFixture())).toMatchObject({
      cpuTempC: 60,
      cpuPowerW: 62.9,
      hostRamUsedGib: 37.2,
      hostRamTotalGib: 47.8,
      gpuTempC: 40,
      gpuHotspotC: 53.1,
      gpuPowerW: 27.7,
      gpuUtil: 0.01,
      vramUsedMib: 1749,
      vramTotalMib: 8192,
      gpus: [
        {
          name: expect.any(String),
          tempC: 40,
          hotspotC: 53.1,
          powerW: 27.7,
          util: 0.01,
          vramUsedMib: 1749,
          vramTotalMib: 8192,
        },
      ],
    });
  });

  it('lists every GPU with its own readings; the first also fills the single-GPU fields', () => {
    const r = parseLhm(lhmTwoGpus());
    expect(r).toMatchObject({
      cpuTempC: 58,
      cpuPowerW: 41.5,
      hostRamUsedGib: 21.5,
      hostRamTotalGib: 48,
      gpuTempC: 62,
      gpuHotspotC: 71,
      gpuPowerW: 138.5,
      gpuUtil: 0.64,
      vramUsedMib: 5120,
      vramTotalMib: 8192,
    });
    expect(r?.gpus).toEqual([
      {
        name: 'Test GPU Alpha',
        tempC: 62,
        hotspotC: 71,
        powerW: 138.5,
        util: 0.64,
        vramUsedMib: 5120,
        vramTotalMib: 8192,
      },
      {
        name: 'Test GPU Beta',
        tempC: 47,
        hotspotC: 52,
        powerW: 36.2,
        util: 0.09,
        vramUsedMib: 1536,
        vramTotalMib: 12288,
      },
    ]);
  });

  it('Intel hybrid: each core carries its clock, temperature and load; package and cores power, max, average, bus', () => {
    const r = parseLhm(lhmTwoGpus());
    expect(r).toMatchObject({
      cpuPowerW: 41.5,
      cpuCoresW: 33.8,
      cpuCoreMaxC: 64,
      cpuCoreAvgC: 55.5,
      cpuBusMhz: 100,
    });
    expect(r?.cpuCores).toHaveLength(14);
    // P-Core #2: two threads (22 % and mean of 20/24), the n-th core in clock order is `CPU Core #n`.
    expect(r?.cpuCores?.[1]).toEqual({ name: 'P-Core #2', clockMhz: 4237, tempC: 50, util: 0.22 });
    // E-Core #1 is the 7th core: its load is `CPU Core #7` (21 %), not a thread of a P-core.
    expect(r?.cpuCores?.[6]).toEqual({ name: 'E-Core #1', clockMhz: 3166, tempC: 60, util: 0.21 });
    // `... Distance to TjMax` is not a temperature of the core.
    expect(r?.cpuCores?.every((c) => c.tempC! >= 48)).toBe(true);
    expect(r?.cpuCores?.map((c) => c.name).slice(5, 8)).toEqual([
      'P-Core #6',
      'E-Core #1',
      'E-Core #2',
    ]);
  });

  it('non-hybrid Intel names its cores `CPU Core #n` for clock and temperature too', () => {
    const r = parseLhm(
      intelTree([
        ['Clock', 'CPU Core #1', '3600 MHz'],
        ['Clock', 'CPU Core #2', '3500 MHz'],
        ['Temperature', 'CPU Core #1', '51 °C'],
        ['Temperature', 'CPU Core #2', '53 °C'],
        ['Load', 'CPU Core #1 Thread #1', '10 %'],
        ['Load', 'CPU Core #1 Thread #2', '20 %'],
        ['Load', 'CPU Core #2 Thread #1', '40 %'],
        ['Load', 'CPU Core #2 Thread #2', '60 %'],
      ]),
    );
    expect(r?.cpuCores).toEqual([
      { name: 'CPU Core #1', clockMhz: 3600, tempC: 51, util: 0.15 },
      { name: 'CPU Core #2', clockMhz: 3500, tempC: 53, util: 0.5 },
    ]);
  });

  it('a core is paired with its load by the number in its name, not by position', () => {
    // Core #1 has no clock or temperature at all: Core #2 must still read the load of CPU Core #2.
    const r = parseLhm(
      intelTree([
        ['Clock', 'Core #2', '3000 MHz'],
        ['Clock', 'Core #3', '3100 MHz'],
        ['Load', 'CPU Core #1', '11 %'],
        ['Load', 'CPU Core #2', '22 %'],
        ['Load', 'CPU Core #3', '33 %'],
      ]),
    );
    expect(r?.cpuCores).toEqual([
      { name: 'Core #2', clockMhz: 3000, util: 0.22 },
      { name: 'Core #3', clockMhz: 3100, util: 0.33 },
    ]);
  });

  it('hybrid cores take loads by position only when the counts agree; else no load is guessed', () => {
    const hybrid = (loads: string[]) =>
      parseLhm(
        intelTree([
          ['Clock', 'P-Core #1', '4000 MHz'],
          ['Clock', 'E-Core #1', '3000 MHz'],
          ...loads.map((v, i): [string, string, string] => ['Load', `CPU Core #${i + 1}`, v]),
        ]),
      )?.cpuCores;
    expect(hybrid(['10 %', '20 %'])).toEqual([
      { name: 'P-Core #1', clockMhz: 4000, util: 0.1 },
      { name: 'E-Core #1', clockMhz: 3000, util: 0.2 },
    ]);
    // One core's clock unreadable (dropped) while loads still count three: nobody gets a neighbour's.
    expect(hybrid(['10 %', '20 %', '30 %'])).toEqual([
      { name: 'P-Core #1', clockMhz: 4000 },
      { name: 'E-Core #1', clockMhz: 3000 },
    ]);
  });

  it('Windows memory: used, available, load, and the virtual memory (not a GPU)', () => {
    expect(parseLhm(lhmTwoGpus())?.hostRamDetail).toEqual({
      usedGib: 21.5,
      availableGib: 26.5,
      util: 0.45,
      virtualUsedGib: 31.5,
      virtualTotalGib: 56,
    });
    expect(parseLhm(zenRadeon)?.hostRamDetail).toBeUndefined();
  });

  it('Zen: cores by name (CCD suffix dropped), the SMU powers are not the package, CCD max/average', () => {
    const r = parseLhm(lhmAmd());
    expect(r).toMatchObject({
      cpuTempC: 66,
      cpuPowerW: 52.5,
      cpuCoresW: 31,
      cpuCoreMaxC: 61,
      cpuCoreAvgC: 58,
      cpuBusMhz: 100,
    });
    expect(r?.cpuCores).toEqual([
      { name: 'Core #1', clockMhz: 4500, tempC: 60, util: 0.2 },
      { name: 'Core #2', clockMhz: 4380, tempC: 57, util: 0.5 },
      { name: 'Core #3', clockMhz: 3900, util: 0.05 },
    ]);
  });

  it('no per-core clock or temperature: the load sensors name the cores; no core sensors, no list', () => {
    const load = (n: number, v: string) => ({
      SensorId: `/intelcpu/0/load/${n}`,
      Type: 'Load',
      Text: `CPU Core #${n}`,
      Value: v,
    });
    const tree = {
      Children: [
        {
          HardwareId: '/intelcpu/0',
          Text: 'CPU',
          Children: [
            {
              SensorId: '/intelcpu/0/temperature/0',
              Type: 'Temperature',
              Text: 'CPU Package',
              Value: '50 °C',
            },
            load(1, '10 %'),
            load(2, '30 %'),
          ],
        },
      ],
    };
    expect(parseLhm(tree)?.cpuCores).toEqual([
      { name: 'Core #1', util: 0.1 },
      { name: 'Core #2', util: 0.3 },
    ]);
    expect(parseLhm(zenRadeon)?.cpuCores).toBeUndefined();
  });

  it('a discrete card is listed before an integrated one, whatever the tree order', () => {
    const tree = lhmTwoGpus() as { Children: Array<{ Children: Array<{ HardwareId?: string }> }> };
    const hardware = tree.Children[0].Children;
    hardware.find((h) => h.HardwareId === '/gpu-nvidia/0')!.HardwareId = '/gpu-intel-integrated/0';
    const sensorsOf = (h: unknown) =>
      JSON.stringify(h).replaceAll('/gpu-nvidia/0', '/gpu-intel-integrated/0');
    tree.Children[0].Children = hardware.map((h) =>
      h.HardwareId === '/gpu-intel-integrated/0' ? JSON.parse(sensorsOf(h)) : h,
    );
    expect(parseLhm(tree)?.gpus?.map((g) => g.name)).toEqual(['Test GPU Beta', 'Test GPU Alpha']);
  });

  it('Zen and Radeon names, with a comma for the decimal point', () => {
    expect(parseLhm(zenRadeon)).toEqual({
      cpuTempC: 61.5,
      cpuPowerW: 45.2,
      gpuTempC: 44,
      gpuHotspotC: 51,
      gpuPowerW: 38,
      gpuUtil: 0.12,
      vramUsedMib: 2048,
      vramTotalMib: 16368,
      gpus: [
        {
          name: expect.any(String),
          tempC: 44,
          hotspotC: 51,
          powerW: 38,
          util: 0.12,
          vramUsedMib: 2048,
          vramTotalMib: 16368,
        },
      ],
    });
  });

  it('anything that is not an LHM sensor tree is null', () => {
    for (const x of [null, 'x', {}, { Children: [{ Text: 'a' }] }, [1, 2]])
      expect(parseLhm(x)).toBeNull();
  });

  it('reads 127.0.0.1; from WSL falls back to curl.exe; a failure waits LHM_RETRY_MS', async () => {
    const tree = lhmFixture();
    const refuse = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const curl = vi.fn(async () => tree);
    const direct = new LhmReader(8085, true, { http: vi.fn(async () => tree), curl });
    expect((await direct.read(0))?.cpuTempC).toBe(60);
    expect(curl).not.toHaveBeenCalled(); // mirrored networking or Windows itself

    const nat = new LhmReader(18085, true, { http: refuse, curl });
    expect((await nat.read(0))?.gpuTempC).toBe(40);
    expect(curl).toHaveBeenCalledWith('http://localhost:18085/data.json');

    const curlFails = vi.fn(async () => {
      throw new Error('exit 7');
    });
    const win = new LhmReader(8085, false, { http: refuse, curl: curlFails });
    expect(await win.read(0)).toBeNull();
    expect(curlFails).not.toHaveBeenCalled(); // Windows itself: no curl.exe
    expect(refuse).toHaveBeenCalledTimes(2);
    expect(await win.read(LHM_RETRY_MS - 1)).toBeNull();
    expect(refuse).toHaveBeenCalledTimes(2); // backing off
    await win.read(LHM_RETRY_MS);
    expect(refuse).toHaveBeenCalledTimes(3);
  });
});

describe('collector additions', () => {
  it('uses comm without reading cmdline for a D-state process', () => {
    const proc = procTree('stuck-python', 10, 'D');
    fs.writeFileSync(path.join(proc, '4242/status'), 'VmRSS:\t20480 kB\n');
    expect(readTopProcesses(proc)).toMatchObject([
      { pid: 4242, rssMib: 20, command: 'stuck-python' },
    ]);
  });

  it('masks a secret-looking command in the top process list', () => {
    const proc = procTree('python', 10);
    fs.writeFileSync(path.join(proc, '4242/status'), 'VmRSS:\t20480 kB\n');
    fs.writeFileSync(path.join(proc, '4242/cmdline'), 'python\0--api-key=very-secret\0');
    expect(readTopProcesses(proc)).toMatchObject([
      { pid: 4242, rssMib: 20, command: 'python --api-key=***' },
    ]);
  });

  it('does not return home paths in a top process command', () => {
    const proc = procTree('claude', 10);
    fs.writeFileSync(path.join(proc, '4242/status'), 'VmRSS:\t20480 kB\n');
    fs.writeFileSync(
      path.join(proc, '4242/cmdline'),
      '/home/u/.local/share/claude/versions/2.1.309\0--append-system-prompt-file\0/home/u/.config/team/rules-engine.md\0',
    );

    const command = readTopProcesses(proc)[0]?.command ?? '';
    expect(command).toBe('2.1.309 --append-system-prompt-file rules-engine.md');
    expect(command).not.toContain('/home/');
  });

  it('WSL: GPU users are the /dev/dxg openers (comm only), no nvidia-smi needed', async () => {
    const proc = procTree('python', 10);
    fs.mkdirSync(path.join(proc, '4242/fd'));
    fs.symlinkSync('/dev/dxg', path.join(proc, '4242/fd/7'));
    fs.writeFileSync(path.join(proc, '4242/comm'), 'python\n');
    fs.symlinkSync(os.tmpdir(), path.join(proc, '4242/cwd'));
    const s = await new HwSource({
      platform: 'wsl',
      home: proc,
      procRoot: proc,
      lhm: null,
      nvidia: null,
      diskPaths: [],
    }).sample();
    expect(s.gpuProcesses).toEqual([{ pid: 4242, usedMib: null, cmd: 'python' }]);
    expect(s.topProcesses).toBeUndefined(); // on demand only (cld-gui hw)
  });

  it('reads configured disk thresholds and marks a drive low', async () => {
    const home = tmp('cld-hw-home-');
    fs.mkdirSync(path.join(home, '.config/cld-gui'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.config/cld-gui/hw.json'),
      JSON.stringify({ diskFreeWarnGib: 1e9 }),
    );
    const s = await new HwSource({
      platform: 'other',
      home,
      diskPaths: [{ name: 'WSL', path: home }],
    }).sample();
    expect(s.disks).toMatchObject([{ name: 'WSL', warning: true }]);
    expect(s.warnings).toContain('디스크 WSL 공간 부족');
  });
});

/** A /proc with one process of the given name, started `age` seconds ago. */
function procTree(comm: string, age: number, state = 'R'): string {
  const proc = tmp('cld-proc-');
  const uptime = 1000;
  fs.writeFileSync(path.join(proc, 'uptime'), `${uptime.toFixed(2)} 0.00\n`);
  fs.mkdirSync(path.join(proc, '4242'));
  const start = Math.round((uptime - age) * 100);
  fs.writeFileSync(
    path.join(proc, '4242/stat'),
    `4242 (${comm}) ${state} 1 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${start} 0 0\n`,
  );
  fs.mkdirSync(path.join(proc, 'self'));
  return proc;
}

const calls = (log: string) =>
  fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean).length : 0;

describe('nvidia-smi: gate and stall rules (fake binary)', () => {
  it('parses the CSV answer; [N/A] fields are left out', () => {
    expect(parseNvidiaCsv('37, 1596, 8192, 48, 60.26\n')).toEqual({
      gpuUtil: 0.37,
      vramUsedMib: 1596,
      vramTotalMib: 8192,
      gpuTempC: 48,
      gpuPowerW: 60.26,
    });
    expect(parseNvidiaCsv('0, 512, 4096, 41, [N/A]')).toEqual({
      gpuUtil: 0,
      vramUsedMib: 512,
      vramTotalMib: 4096,
      gpuTempC: 41,
    });
    expect(parseNvidiaCsv('NVIDIA-SMI has failed')).toBeNull();
  });

  it("someone's nvidia-smi running 2 s or more means stuck; a younger one or a shell naming it does not", () => {
    expect(nvidiaSmiStuck(2, procTree('nvidia-smi', 3.5))).toBe(true);
    expect(nvidiaSmiStuck(2, procTree('nvidia-smi', 1))).toBe(false);
    expect(nvidiaSmiStuck(2, procTree('bash', 60))).toBe(false);
    expect(nvidiaSmiStuck(2, path.join(tmp('cld-noproc-'), 'none'))).toBe(false);
  });

  it('a stuck one elsewhere: no new run', async () => {
    const log = path.join(tmp('cld-nv-'), 'calls');
    process.env.FAKE_NVIDIA_LOG = log;
    const nv = new NvidiaSmi(FAKE_NVIDIA, { proc: procTree('nvidia-smi', 5) });
    expect(await nv.read()).toBe('stale');
    expect(calls(log)).toBe(0);
  });

  it('ours past its timeout is left running and never doubled; once it exits, the next run answers', async () => {
    const log = path.join(tmp('cld-nv-'), 'calls');
    Object.assign(process.env, { FAKE_NVIDIA_LOG: log, FAKE_NVIDIA_SLEEP: '3' });
    const nv = new NvidiaSmi(FAKE_NVIDIA, { proc: procTree('bash', 1), timeoutMs: 200 });
    const t0 = Date.now();
    expect(await nv.read()).toBe('stale');
    expect(Date.now() - t0).toBeLessThan(2500); // did not wait for the 3 s hang
    expect(await nv.read()).toBe('stale'); // ours still runs: no second one
    expect(calls(log)).toBe(1);
    delete process.env.FAKE_NVIDIA_SLEEP;
    // Wait for the hung one to exit instead of sleeping a fixed time: under load its exit (and a
    // fresh query's 200 ms limit) can be late, so a stale answer is retried (more than one new run).
    await vi.waitFor(async () => expect(await nv.read()).toMatchObject({ gpuTempC: 48, vramTotalMib: 8192 }), {
      timeout: 20_000,
      interval: 100,
    });
    expect(calls(log)).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(log, 'utf-8')).toContain('--query-gpu=');
  });

  it('only this module queries the GPU (security T16)', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
          if (fs.readFileSync(p, 'utf-8').includes('--query-gpu'))
            offenders.push(path.relative(REPO_ROOT, p));
        }
      }
    };
    walk(path.join(REPO_ROOT, 'server/src'));
    expect(offenders).toEqual(['server/src/cld/hw/nvidiaSmi.ts']);
  });
});

describe('HwSource: one sensor source per OS', () => {
  const linux = (fixture: string, extra = {}) =>
    new HwSource({ platform: 'linux', sysRoot: sysTree(fixture), home: os.tmpdir(), ...extra });

  it('macOS: the OS readings only, no sensor hint', async () => {
    const dir = tmp('cld-hw-');
    const own = await new HwSource({ home: dir, platform: 'darwin' }).sample();
    expect(own).toMatchObject({ stale: false, warnings: [] });
    expect(own.ramTotalGib).toBeGreaterThan(0);
    expect(own.gpuTempC).toBeUndefined();
    expect(own.sources).toMatchObject({ ramUsedGib: 'os', ramTotalGib: 'os', disks: 'os' });
    expect(own.sensorsHint).toBeUndefined(); // macOS: nothing the installer could add
    expect(own.disks[0]).toMatchObject({ name: '~', totalGib: expect.any(Number) });
  });

  it('Linux: sysfs readings named sysfs, the rest os; the hint only without a CPU temperature', async () => {
    const s = await linux('intel-coretemp-amdgpu').sample();
    expect(s).toMatchObject({
      cpuTempC: 54,
      gpuTempC: 45,
      vramTotalMib: 16368,
      sensorsHint: false,
    });
    expect(s.sources).toMatchObject({ cpuTempC: 'sysfs', gpuUtil: 'sysfs', ramUsedGib: 'os' });
    expect(s.lhm).toBeUndefined();
    const bare = await linux('wsl2-this-pc').sample();
    expect(bare.sensorsHint).toBe(true);
    expect(Object.values(bare.sources ?? {})).not.toContain('sysfs');
  });

  it('Windows/WSL: LHM when the installer set it up, else the hint', async () => {
    const tree = lhmFixture();
    const read = vi.fn(async () => parseLhm(tree));
    const withLhm = await new HwSource({ platform: 'wsl', lhm: { read } }).sample();
    expect(withLhm).toMatchObject({ lhm: true, sensorsHint: false, cpuTempC: 60, gpuTempC: 40 });
    expect(withLhm.sources).toMatchObject({
      cpuTempC: 'lhm',
      vramUsedMib: 'lhm',
      ramTotalGib: 'os',
    });

    const down = await new HwSource({
      platform: 'win32',
      lhm: { read: async () => null },
    }).sample();
    expect(down).toMatchObject({ lhm: false, sensorsHint: true });
    expect(down.cpuTempC).toBeUndefined();
    // No --lhm-port: nothing to read and nothing probed.
    const none = await new HwSource({ platform: 'wsl', lhmPort: null }).sample();
    expect(none).toMatchObject({ lhm: false, sensorsHint: true });
  });

  it('WSL with LHM: both RAM views and the GPU list; the disks say which side they are on', async () => {
    const root = tmp('cld-disks-');
    const withLhm = await new HwSource({
      platform: 'wsl',
      diskPaths: [
        { name: 'WSL', path: root },
        ...['C:', 'D:', 'E:'].map((name) => ({ name, path: root })),
      ],
      lhm: { read: async () => parseLhm(lhmTwoGpus()) },
    }).sample();
    expect(withLhm.disks.map((d) => [d.name, d.view])).toEqual([
      ['WSL', 'wsl'],
      ['C:', 'windows'],
      ['D:', 'windows'],
      ['E:', 'windows'],
    ]);
    expect(
      withLhm.disks.every((d) => typeof d.totalGib === 'number' && typeof d.freeGib === 'number'),
    ).toBe(true);
    expect(withLhm).toMatchObject({ hostRamUsedGib: 21.5, hostRamTotalGib: 48, gpuTempC: 62 });
    expect(withLhm.ramTotalGib).toBeGreaterThan(0); // the distro's own memory
    expect(withLhm.gpus).toHaveLength(2);
    expect(withLhm.sources).toMatchObject({ gpus: 'lhm', hostRamUsedGib: 'lhm', ramUsedGib: 'os' });
  });

  it('WSL with LHM down: the OS view only (no host RAM, no GPU list), the old fields stay empty', async () => {
    const root = tmp('cld-disks-');
    const down = await new HwSource({
      platform: 'wsl',
      diskPaths: [{ name: 'WSL', path: root }],
      lhm: { read: async () => null },
    }).sample();
    expect(down.hostRamTotalGib).toBeUndefined();
    expect(down.gpus).toBeUndefined();
    expect(down.gpuTempC).toBeUndefined();
    expect(down.ramTotalGib).toBeGreaterThan(0);
    expect(down.lhm).toBe(false);
  });

  it('per-core and memory detail: LHM wins; without it the OS gives clock and load from the second sample on', async () => {
    const withLhm = new HwSource({
      platform: 'wsl',
      lhm: { read: async () => parseLhm(lhmTwoGpus()) },
      procRoot: meminfoRoot(),
    });
    const a = await withLhm.sample();
    expect(a.cpuCores).toHaveLength(14);
    expect(a.sources).toMatchObject({ cpuCores: 'lhm', hostRamDetail: 'lhm', ramDetail: 'os' });
    expect(a.cpuCoresW).toBe(33.8);

    const down = new HwSource({
      platform: 'wsl',
      lhm: { read: async () => null },
      procRoot: meminfoRoot(),
    });
    const first = await down.sample();
    expect(first.cpuCores?.length).toBe(os.cpus().length);
    expect(first.cpuCores?.[0].name).toBe('CPU #1');
    expect(first.sources?.cpuCores).toBe('os');
    expect(first.cpuCores?.some((c) => 'util' in c)).toBe(false); // nothing to subtract yet
    expect(first.hostRamDetail).toBeUndefined();
    expect(first.cpuCoresW).toBeUndefined();
    await new Promise((r) => setTimeout(r, 30));
    const second = await down.sample();
    expect(
      second.cpuCores?.every(
        (c) => c.util === undefined || c.util === null || (c.util >= 0 && c.util <= 1),
      ),
    ).toBe(true);
    // The old fields are still what they were.
    expect(second.ramTotalGib).toBeGreaterThan(0);
    expect(second.lhm).toBe(false);
  });

  it('/proc/meminfo: used (= total - available), cache, swap; absent on macOS and with no file', async () => {
    expect(readRamDetail(meminfoRoot())).toEqual({
      usedGib: 6,
      availableGib: 10,
      cachedGib: 3.5,
      swapUsedGib: 0.5,
      swapTotalGib: 2,
    });
    expect(readRamDetail(tmp('cld-nomem-'))).toBeNull();
    const s = await new HwSource({ platform: 'wsl', lhm: null, procRoot: meminfoRoot() }).sample();
    expect(s.ramDetail).toMatchObject({ usedGib: 6, swapTotalGib: 2 });
    expect(s.sources?.ramDetail).toBe('os');
    const mac = await new HwSource({ platform: 'darwin', procRoot: meminfoRoot() }).sample();
    expect(mac.ramDetail).toBeUndefined();
  });

  it('`cld-gui hw` prints the sample without the detail fields, and their sources', () => {
    const sample = {
      ts: 't',
      stale: false,
      disks: [],
      warnings: [],
      cpuTempC: 50,
      cpuCoresW: 3,
      cpuCores: [{ name: 'a' }],
      ramDetail: { usedGib: 1, availableGib: 1 },
      sources: { cpuTempC: 'lhm', cpuCores: 'lhm' },
    } as const;
    const out = withoutDetail(sample as never);
    expect(out).toEqual({
      ts: 't',
      stale: false,
      disks: [],
      warnings: [],
      cpuTempC: 50,
      sources: { cpuTempC: 'lhm' },
    });
  });

  it('Linux and macOS carry no view on their disks', async () => {
    const root = tmp('cld-disks-');
    const s = await new HwSource({
      platform: 'darwin',
      diskPaths: [{ name: '~', path: root }],
    }).sample();
    expect(s.disks[0].view).toBeUndefined();
  });

  it('nvidia-smi only with the config flag, and only when the GPU is still empty', async () => {
    const log = path.join(tmp('cld-nv-'), 'calls');
    process.env.FAKE_NVIDIA_LOG = log;
    expect(findNvidiaSmi()).toBe(path.join(FAKE_BIN, 'nvidia-smi'));

    // As the daemon builds it without --nvidia-smi: the GPU stays empty and nothing runs.
    const off = await linux('intel-nvidia-proprietary', { nvidiaSmi: null }).sample();
    expect(off.gpuTempC).toBeUndefined();
    expect(calls(log)).toBe(0);

    // With the flag it runs (on a loaded machine the fake may answer after the 1.5 s production
    // timeout, so its readings are checked below with a reader that waits longer).
    await linux('intel-nvidia-proprietary', { nvidiaSmi: findNvidiaSmi() }).sample();
    await vi.waitFor(() => expect(calls(log)).toBeGreaterThan(0));
    const flagged = calls(log);
    const patient = new NvidiaSmi(findNvidiaSmi()!, { timeoutMs: 15_000 });
    const on = await linux('intel-nvidia-proprietary', { nvidia: patient }).sample();
    expect(on).toMatchObject({ cpuTempC: 47, gpuTempC: 48, gpuUtil: 0.37, vramUsedMib: 1596 });
    expect(on.sources).toMatchObject({ cpuTempC: 'sysfs', gpuTempC: 'nvidia-smi' });
    expect(on.gpuProcesses).toEqual([{ pid: 4242, usedMib: 1536 }]);
    expect(calls(log) - flagged).toBe(2);

    // The OS source already has the GPU (a Radeon): nvidia-smi is not asked.
    const nvidia = { read: vi.fn(async () => null) };
    await linux('intel-coretemp-amdgpu', { nvidia }).sample();
    expect(nvidia.read).not.toHaveBeenCalled();
    // Stuck: a warning instead of GPU readings.
    const stuck = await linux('intel-nvidia-proprietary', {
      nvidia: { read: async () => 'stale' as const },
    }).sample();
    expect(stuck.warnings).toEqual([expect.stringMatching(/nvidia-smi/)]);
  });
});

describe('hasHwReadings (cld-gui hw)', () => {
  it('a sample of nothing is no sample; any number or disk is one', () => {
    const empty = { ts: '2026-10-22T10:00:00+09:00', stale: false, disks: [], warnings: ['x'] };
    expect(hasHwReadings(empty)).toBe(false);
    expect(hasHwReadings({ ...empty, cpuUtil: null, sensorsHint: true })).toBe(false);
    expect(hasHwReadings({ ...empty, ramUsedGib: 1 })).toBe(true);
    expect(hasHwReadings({ ...empty, disks: [{ name: '~', freeGib: 1 }] })).toBe(true);
  });
});
