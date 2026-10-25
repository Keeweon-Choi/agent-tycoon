/**
 * T-0030 end to end: the built daemon (dist/cli.js) on a spare port in an isolated
 * HOME with only a fake `claude`, run once without and once with
 * `--lhm-port`. A logged-in WebSocket viewer waits for hwSample. On a WSL host in
 * NAT mode the second run reads an already running LibreHardwareMonitor through
 * Windows' curl.exe (GET /data.json, read only). nvidia-smi, tmux and office are traps
 * on PATH that log any run. A hard deadline kills the server.
 *
 *   npx tsx cld/test/run-hw.ts <port 18256-18259> <lhm-port>
 */
import * as fs from 'fs';
import * as path from 'path';
import WebSocket from 'ws';

import {
  assertPortFree,
  makeFakeHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const lhmPort = Number(process.argv[3]);
const OUT = path.join(REPO_ROOT, 'cld/artifacts/t0030');
const DEADLINE_MS = 90_000;

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

/** Start the daemon, log a viewer in, and return the last hwSample seen within `ms`. */
async function sample(
  extra: string[],
  ms = 7_000,
): Promise<{ hw: Record<string, unknown>; traps: string }> {
  const fake = makeFakeHome({ claude: 'V-3' });
  const traps = path.join(fake.home, 'trap-bin');
  const trapLog = path.join(fake.home, 'traps.log');
  fs.mkdirSync(traps);
  for (const name of ['nvidia-smi', 'tmux', 'office']) {
    fs.writeFileSync(
      path.join(traps, name),
      `#!/bin/sh\necho "${name} $*" >> "${trapLog}"\nexit 1\n`,
    );
    fs.chmodSync(path.join(traps, name), 0o755);
  }
  const daemon = startDaemon(fake, port, ['--no-terminal', ...extra], {
    PATH: traps,
  });
  const log = daemon.log;
  try {
    const login = await fetch(await daemon.loginUrl(), { redirect: 'manual' });
    const cookie = (login.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
    const samples: Array<Record<string, unknown>> = [];
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
        headers: { cookie, origin: `http://127.0.0.1:${port}` },
      });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'webviewReady' })));
      ws.on('message', (data) => {
        const m = JSON.parse(String(data)) as Record<string, unknown>;
        if (m.type === 'hwSample') samples.push(m);
      });
      ws.on('error', reject);
      setTimeout(() => {
        ws.close();
        resolve();
      }, ms);
    });
    if (!samples.length) throw new Error(`no hwSample\n${log.join('')}`);
    return {
      hw: samples.at(-1)!,
      traps: fs.existsSync(trapLog) ? fs.readFileSync(trapLog, 'utf-8') : '',
    };
  } finally {
    await daemon.stop();
    fs.rmSync(fake.home, { recursive: true, force: true });
  }
}

async function main() {
  await assertPortFree(port);
  if (!(lhmPort > 0)) throw new Error('give the LibreHardwareMonitor port');
  const deadline = setTimeout(() => {
    console.error(`aborted: deadline ${DEADLINE_MS / 1000} s`);
    process.exit(1);
  }, DEADLINE_MS);
  fs.mkdirSync(OUT, { recursive: true });

  const bare = await sample([]);
  fs.writeFileSync(
    path.join(OUT, 'hw-sample-no-lhm.json'),
    `${JSON.stringify(bare.hw, null, 2)}\n`,
  );
  check(
    bare.hw.lhm === false && bare.hw.sensorsHint === true && bare.hw.cpuTempC === undefined,
    'without --lhm-port: no LHM read, no temperature, and the --hw-sensors hint',
  );
  const sources = bare.hw.sources as Record<string, string>;
  check(
    sources.ramUsedGib === 'os' && sources.disks === 'os',
    'CPU, RAM and disk come from the OS, and say so',
  );

  const lhm = await sample(['--lhm-port', String(lhmPort)]);
  fs.writeFileSync(path.join(OUT, 'hw-sample-lhm.json'), `${JSON.stringify(lhm.hw, null, 2)}\n`);
  const s = lhm.hw.sources as Record<string, string>;
  check(
    lhm.hw.lhm === true &&
      lhm.hw.sensorsHint === false &&
      typeof lhm.hw.cpuTempC === 'number' &&
      s.cpuTempC === 'lhm',
    `with --lhm-port ${lhmPort}: CPU ${String(lhm.hw.cpuTempC)} °C from LHM`,
  );
  check(
    typeof lhm.hw.gpuTempC === 'number' && s.gpuTempC === 'lhm' && s.cpuUtil === 'os',
    `GPU ${String(lhm.hw.gpuTempC)} °C from LHM; CPU load still from the OS`,
  );
  check(bare.traps === '' && lhm.traps === '', 'nvidia-smi, tmux and office were never run');
  clearTimeout(deadline);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
