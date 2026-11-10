/**
 * dist/agty-worker.js (T-0021): what runs outside the daemon.
 *
 *   gpu-run                       the `job --gpu` wrapper (its job's env: AGTY_GPU_*)
 *   codex <id>                    a `agty codex` task's worker (AGTY_CODEX)
 *   gpu [--json]                  the reservation board        } `agty gpu …`
 *   gpu run [opts] -- <command>   foreground, with --wait      } (agty-cli.md §13)
 *   gpu cancel <id> | move <id> <n>                            }
 *   spec-map <folder>             SPT C1: the 지도's code scan, one JSON on stdout (spec/mapWorker.ts)
 *
 * Exit codes and JSON lines follow agty-cli.md §3 (AGTY_OUTPUT=json).
 */
import * as fs from 'fs';
import * as os from 'os';

import { CLI_NAME } from '../cliName.js';
import { findNvidiaSmi, readTotalMib } from '../hw/nvidiaSmi.js';
// dist/agty-worker.js is its own process entry: its `spec-map` command runs the map scan here (BRN K0 exception).
// eslint-disable-next-line no-restricted-imports
import { scanCode } from '../spec/mapWorker.js';
import { CODEX_TIMING, runCodex } from './codex.js';
import { appendEvent, eventsPath } from './events.js';
import type { GpuEvent, GpuPolicy } from './gpu.js';
import {
  boardJson,
  defaultLocks,
  gpuDir,
  gpuProcessesFromFile,
  GpuQueue,
  gpuRun,
  hasThresholds,
  noThresholdHolders,
  policyOf,
  readGpuConfig,
  readGpuTotalMib,
  ruleLine,
  unleasedFromProcesses,
  unleasedGpuUsers,
} from './gpu.js';
import { workerProjectAt } from './workerProjects.js';

const home = os.homedir();
const json = process.env.AGTY_OUTPUT === 'json';
const source = /^[A-Za-z0-9._:-]{1,64}$/.test(process.env.AGTY_SOURCE ?? '')
  ? process.env.AGTY_SOURCE!
  : 'cli';
const EXIT: Record<string, number> = { usage: 2 };

function finish(r: Record<string, unknown> & { ok: boolean }, sentence?: string): never {
  if (json) process.stdout.write(`${JSON.stringify({ v: 1, ...r })}\n`);
  else if (r.ok) {
    if (sentence) console.log(sentence);
  } else console.error(r.error);
  process.exit(r.ok ? 0 : (EXIT[r.code as string] ?? 1));
}
const usage = (error: string) => finish({ ok: false, code: 'usage', error });

const event: GpuEvent = (type, fields) => appendEvent(eventsPath(home), type, source, fields);

/** The policy is never "none": gpu.json, else the GPU's size, else one at a time (T-0094). */
async function queue(): Promise<{ q: GpuQueue; policy: GpuPolicy }> {
  const c = readGpuConfig(home);
  const dir = gpuDir(home, c);
  // nvidia-smi only on the user's say-so (gpu.json nvidiaSmi), as everywhere else.
  const total = hasThresholds(c)
    ? null
    : await readGpuTotalMib(dir, c.nvidiaSmi ? () => readTotalMib(findNvidiaSmi()) : null);
  return { q: new GpuQueue({ dir, locks: defaultLocks(), event }), policy: policyOf(c, total) };
}

/** `--name value` and `--flag` options before the rest. */
function options(args: string[], flags: string[], values: string[]) {
  const got: Record<string, string | true> = {};
  while (args.length) {
    const a = args[0];
    if (a === '--') {
      args.shift();
      break;
    }
    if (flags.includes(a)) got[a] = true;
    else if (values.includes(a)) {
      if (args.length < 2) usage(`${a} 에 값이 없습니다`);
      got[a] = args[1];
      args.shift();
    } else break;
    args.shift();
  }
  return got;
}

const num = (s: string | undefined | true): number | null => {
  if (s === undefined || s === '' || s === true) return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

async function gpu(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub === 'cancel' || sub === 'move') {
    const [, id, pos] = args;
    if (!id || (sub === 'move' && !/^\d+$/.test(pos ?? '')))
      usage(`사용법: ${CLI_NAME} gpu cancel <id> · ${CLI_NAME} gpu move <id> <순서>`);
    const { q } = await queue();
    if (sub === 'cancel') {
      const r = q.cancel(id);
      finish(r, `${id} 대기를 취소했습니다`);
    }
    const r = q.move(id, Number(pos));
    finish(r, r.ok ? `${id} 를 ${r.position}번째로 옮겼습니다` : undefined);
  }
  if (sub === 'run') {
    const rest = args.slice(1);
    const o = options(rest, ['--exclusive'], ['--vram', '--wait', '--label']);
    const vram = num(o['--vram']);
    const wait = o['--wait'] === undefined ? 5 : num(o['--wait']);
    if (Number.isNaN(vram) || Number.isNaN(wait) || !rest.length)
      usage(
        `사용법: ${CLI_NAME} gpu run [--vram GiB] [--exclusive] [--wait 분] [--label 설명] -- <명령>`,
      );
    const { q, policy } = await queue();
    process.exit(
      await gpuRun({
        queue: q,
        policy,
        cmd: rest.join(' '),
        vramGib: vram,
        exclusive: o['--exclusive'] === true,
        label: typeof o['--label'] === 'string' ? o['--label'] : null,
        project: workerProjectAt(home, process.cwd()),
        waitMin: wait,
        jobLog: null,
        gpuFile: null,
        event,
      }),
    );
  }
  if (sub !== undefined && sub !== '--json') usage(`모르는 gpu 명령입니다: ${sub}`);
  const { q, policy } = await queue();
  const s = q.withAdmit(() => {
    q.sweep();
    return q.state();
  });
  if (!s)
    finish({ ok: false, code: 'gpu_busy', error: 'GPU 대기 폴더의 입장 잠금을 잡지 못했다(10초)' });
  const holders = new Set(s.holders.map((h) => h.pid).filter((p): p is number => p !== null));
  // WSL: /dev/dxg openers, read here (no daemon needed); else the collector's
  // nvidia-smi list beside the queue, when there is a fresh one.
  const dxg = process.platform === 'linux' && fs.existsSync('/dev/dxg');
  const processes = dxg ? null : gpuProcessesFromFile(q.dir);
  const unleased: Array<{
    pid: number;
    cmd?: string;
    cwd?: string;
    project?: string | null;
    usedMib?: number | null;
  }> = dxg
    ? unleasedGpuUsers(holders, (cwd) => workerProjectAt(home, cwd))
    : processes
      ? unleasedFromProcesses(processes, holders)
      : [];
  const board = {
    ...boardJson(q.dir, policy, s, unleased),
    processes_unknown: !dxg && processes === null,
  };
  if (args.includes('--json') || json) {
    process.stdout.write(`${JSON.stringify(board)}\n`);
    process.exit(0);
  }
  const kind = (x: { exclusive: boolean; vram_gib: number | null }) =>
    x.exclusive ? '혼자' : `함께 ${x.vram_gib}GiB`;
  const late = noThresholdHolders(s.holders, policy);
  for (const h of board.holders)
    console.log(
      `예약  ${h.id}  ${h.project ?? '?'}  ${kind(h)}  pid ${h.pid}  ${h.label ?? ''}  (${h.started})${late.has(h.id) ? '  [문턱 없이 잡힌 예약]' : ''}`,
    );
  for (const x of board.queue)
    console.log(
      `대기${x.position}  ${x.id}  ${x.project ?? '?'}  ${kind(x)}  ${x.label ?? ''}  (${x.requested})`,
    );
  for (const u of unleased)
    console.log(
      u.cwd !== undefined
        ? `예약 없이 GPU 사용  ${u.project ?? '?'}  ${u.cmd}(${u.pid})  ${u.cwd}`
        : `예약 없이 GPU 사용  ${u.cmd ?? ''}(${u.pid})  ${u.usedMib ?? '?'} MiB`,
    );
  if (board.processes_unknown) console.log('GPU 사용 프로세스: 알 수 없음 (LHM만 사용 중)');
  if (!board.holders.length && !board.queue.length && !board.unleased.length)
    console.log('(GPU 예약·대기 없음)');
  console.log(ruleLine(policy));
  process.exit(0);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const e = process.env;
  if (cmd === 'gpu') return gpu(rest);
  if (cmd === 'gpu-run') {
    const { q, policy } = await queue();
    process.exit(
      await gpuRun({
        queue: q,
        policy,
        cmd: e.AGTY_GPU_CMD ?? '',
        vramGib: e.AGTY_GPU_VRAM ? Number(e.AGTY_GPU_VRAM) : null,
        exclusive: !!e.AGTY_GPU_EXCL,
        label: e.AGTY_GPU_LABEL || null,
        project: e.AGTY_GPU_PROJECT || null,
        waitMin: null,
        jobLog: e.AGTY_JOB_LOG || null,
        gpuFile: e.AGTY_GPU_FILE || null,
        event,
      }),
    );
  }
  if (cmd === 'codex' && rest[0] && e.AGTY_CODEX) {
    // Test knobs only (agent-tycoon/test): the waits are minutes otherwise.
    const ms = (v: string | undefined, d: number) => (v && /^\d+$/.test(v) ? Number(v) : d);
    const timing = {
      pollMs: ms(e.AGTY_CODEX_POLL_MS, CODEX_TIMING.pollMs),
      marginMs: ms(e.AGTY_CODEX_MARGIN_MS, CODEX_TIMING.marginMs),
      sidMs: CODEX_TIMING.sidMs,
    };
    process.exit(
      await runCodex(rest[0], { home, codex: e.AGTY_CODEX, agtyBin: e.AGTY_BIN ?? null, timing }),
    );
  }
  if (cmd === 'spec-map' && rest[0]) {
    const out = JSON.stringify(await scanCode(rest[0]));
    // A pipe may be asynchronous (Windows): exit once it took the whole answer.
    process.stdout.write(out, () => process.exit(0));
    return;
  }
  usage('사용법: agty-worker.js gpu … | gpu-run | codex <id> | spec-map <folder>');
}

void main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
