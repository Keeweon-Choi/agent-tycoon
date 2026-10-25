import type { ServerMessage } from '../../../core/src/messages.js';
import { cldHandleMessage } from './officeStore.js';

const isoMinutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
const isoMinutesAhead = (n: number) => new Date(Date.now() + n * 60_000).toISOString();

/** Returns realistic demo data on every invocation so relative clocks stay fresh. */
export function cldMockMessages(): ServerMessage[] {
  const names = ['compass', 'beacon', 'ledger', 'harbor', 'atlas', 'garden', 'signal', 'forge'];
  const tabs = [
    { name: '\uc81c\ud488\ud300', kind: 'orch' as const, order: 0 },
    { name: '\ud50c\ub7ab\ud3fc\ud300', kind: 'orch' as const, order: 1 },
    { name: '\uc6b4\uc601\ud300', kind: 'orch' as const, order: 2 },
  ];
  const orchestrators = names.map((name, i) => ({
    name,
    dir: `/projects/${name}`,
    tab: tabs[Math.floor(i / 3)]?.name ?? '\uc6b4\uc601\ud300',
    order: i,
    state: (i >= 6 ? 'off' : 'running') as 'running' | 'off',
    busy: i % 3 !== 2,
    bg: i === 2 ? { id: 'bg-2', state: 'working' } : null,
    remoteControl: { on: i < 2, url: i < 2 ? `https://example.com/${name}` : null },
    compactions: i === 4 ? 2 : 0,
    alive: i < 7,
    agentId: 100 + i,
  }));
  const messages: ServerMessage[] = [
    {
      type: 'officeSnapshot',
      readOnly: true,
      tabs,
      orchestrators,
    },
    {
      type: 'codexTasks',
      tasks: [
        {
          id: 'beacon-42',
          project: 'beacon',
          model: 'model-a',
          state: 'running',
          progressDone: 7,
          progressTotal: 12,
          commits: 2,
          started: isoMinutesAgo(42),
          agentId: 109,
        },
        {
          id: 'compass-18',
          project: 'compass',
          model: 'model-a',
          state: 'limit',
          progressDone: 3,
          progressTotal: 8,
          commits: 1,
          resetAt: isoMinutesAhead(133),
          agentId: 110,
        },
      ],
    },
    {
      type: 'officeJobs',
      jobs: [
        {
          pid: 4451,
          project: 'compass',
          cmd: 'npm run build',
          started: isoMinutesAgo(6),
          progress: { label: '\ud504\ub7f0\ud2b8\uc5d4\ub4dc \ube4c\ub4dc', pct: 72, rate: '18 \ud30c\uc77c/\ucd08', eta: '2\ubd84' },
        },
        {
          pid: 4482,
          project: 'harbor',
          cmd: '\ub370\uc774\ud130 \ub3d9\uae30\ud654',
          started: isoMinutesAgo(10),
          progress: { label: '\uace0\uac1d \ub370\uc774\ud130 \ub3d9\uae30\ud654', pct: 42, rate: '4.2 MB/\ucd08', eta: '8\ubd84' },
        },
      ],
    },
    {
      type: 'hwSample',
      ts: isoMinutesAgo(1),
      stale: false,
      lhm: true,
      cpuTempC: 72,
      cpuPowerW: 138,
      cpuUtil: 0.64,
      gpuTempC: 83,
      gpuHotspotC: 91,
      gpuPowerW: 245,
      gpuUtil: 0.78,
      vramUsedMib: 17408,
      vramTotalMib: 24576,
      ramUsedGib: 37.2,
      ramTotalGib: 64,
      swapUsedGib: 1.2,
      disks: [
        { name: '\uc2dc\uc2a4\ud15c', freeGib: 82, warnGib: 20 },
        { name: '\uc791\uc5c5', freeGib: 14, warnGib: 20 },
      ],
      warnings: ['\uc791\uc5c5 \ub514\uc2a4\ud06c \uc5ec\uc720 \uacf5\uac04 \ubd80\uc871'],
      sources: Object.fromEntries(
        ['cpuTempC', 'cpuPowerW', 'gpuTempC', 'gpuHotspotC', 'gpuPowerW', 'gpuUtil', 'vramUsedMib']
          .map((k) => [k, 'lhm'])
          .concat(['cpuUtil', 'ramUsedGib', 'swapUsedGib', 'disks'].map((k) => [k, 'os'])),
      ),
    },
    {
      type: 'usageState',
      ts: isoMinutesAgo(1),
      claude: {
        fiveHourPct: 73,
        sevenDayPct: 48,
        fiveHourReset: isoMinutesAhead(133),
        sevenDayReset: isoMinutesAhead(4320),
        models: [{ family: 'fable', pct: 12, reset: isoMinutesAhead(5000) }],
      },
      codex: {
        fiveHourPct: 87,
        sevenDayPct: 61,
        fiveHourReset: isoMinutesAhead(84),
        sevenDayReset: isoMinutesAhead(5750),
      },
    },
  ];
  const summaries = [
    ['inbox', 'compass', '\uac80\ud1a0\ud560 \uba54\uc2dc\uc9c0 3\uac74\uc774 \ub3c4\ucc29\ud588\uc5b4\uc694'],
    ['task', 'beacon', 'Codex \uc791\uc5c5\uc774 \uc2dc\uc791\ub410\uc5b4\uc694'],
    ['job', 'harbor', '\ub370\uc774\ud130 \ub3d9\uae30\ud654\uac00 42% \uc9c4\ud589\ub410\uc5b4\uc694'],
    ['stop', 'atlas', '\uc791\uc5c5\uc744 \ub9c8\uce58\uace0 \uc26c\ub294 \uc911\uc774\uc5d0\uc694'],
    ['renew', 'garden', '\uad50\ub300\ub97c \uae30\ub2e4\ub9ac\uace0 \uc788\uc5b4\uc694'],
    ['hw', 'ops-agent', '\uc791\uc5c5 \ub514\uc2a4\ud06c \uacf5\uac04\uc744 \ud655\uc778\ud574 \uc8fc\uc138\uc694'],
    ['compaction', 'atlas', '\uc778\uc218\uc778\uacc4\uac00 \ud544\uc694\ud574\uc694'],
    ['task', 'compass', 'Codex \uc0ac\uc6a9 \ud55c\ub3c4 \ucd08\uae30\ud654\ub97c \uae30\ub2e4\ub824\uc694'],
    ['start', 'ledger', '\uc0c8 \uc791\uc5c5\uc744 \uc2dc\uc791\ud588\uc5b4\uc694'],
    ['status', 'signal', '\uc138\uc158\uc774 \uaebc\uc838 \uc788\uc5b4\uc694'],
  ];
  summaries.forEach(([kind, name, summary], i) =>
    messages.push({
      type: 'officeEvent',
      ts: isoMinutesAgo(i * 7 + 1),
      kind,
      name,
      source: 'engine',
      summary,
    }),
  );
  orchestrators.forEach(({ name }, i) =>
    messages.push({
      type: 'statusOutput',
      name,
      cmd: 'git status --short',
      isDefault: true,
      exit: 0,
      output: i % 2 ? '\uc791\uc5c5 \ud2b8\ub9ac\uac00 \uae68\ub057\ud569\ub2c8\ub2e4.' : ' M src/main.ts\n?? notes.md',
      truncated: false,
      git: {
        branch: i % 2 ? 'main' : `feature/${name}`,
        dirty: i % 2 ? 0 : 2,
        recent: [
          { hash: 'a12bc34', subject: '\ud654\uba74 \uc0c1\ud0dc \uac1c\uc120', time: isoMinutesAgo(40) },
          { hash: 'de45f67', subject: '\uc791\uc5c5 \ub85c\uadf8 \uc815\ub9ac', time: isoMinutesAgo(140) },
          { hash: '987abcd', subject: '\ucd08\uae30 \uc124\uc815', time: isoMinutesAgo(500) },
        ],
      },
    }),
  );
  return messages;
}

export const isCldMock = new URLSearchParams(window.location.search).get('cldMock') === '1';

let installed = false;
export function installCldMock(): void {
  if (installed) return;
  installed = true;
  const messages = cldMockMessages();
  for (const msg of messages) cldHandleMessage(msg);
  // BrowserMock has just loaded the office layout; create sample characters via
  // the same transport events as live agents, after the layout is ready.
  for (const orchestrator of messages[0].type === 'officeSnapshot' ? messages[0].orchestrators : []) {
    if (orchestrator.agentId != null)
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'agentCreated',
            id: orchestrator.agentId,
            directoryName: orchestrator.name,
            isExternal: false,
          },
        }),
      );
  }
  for (const [id, name] of [
    [109, 'codex·beacon'],
    [110, 'codex·compass'],
  ] as const) {
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'agentCreated', id, directoryName: name } }),
    );
  }
}
