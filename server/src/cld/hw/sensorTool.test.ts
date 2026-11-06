/**
 * The H/W screen's 센서 도구 설치 and nvidia-smi switch: the install runs only after this socket
 * got the consent text, with consent, from a privileged non-read-only connection, and from a
 * remote device only with a fresh step-up. The installer step itself is a double: nothing here
 * runs PowerShell, LibreHardwareMonitor or nvidia-smi.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { STEPUP_REQUIRED } from '../shell/gate.js';
import { CONSENT_TTL_MS, SensorTool, type SensorToolDeps, type ToolRun } from './sensorTool.js';

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const home = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-sensor-'));
  tmps.push(d);
  return d;
};

const PLAN = JSON.stringify({
  lines: ['… H/W 센서 도구를 설치합니다', '  곧 Windows 관리자 확인 창(UAC)'],
  install: true,
  lhmPort: null,
});

function tool(over: Partial<SensorToolDeps> = {}) {
  const run = vi.fn<ToolRun>(async (args) =>
    args[1] === 'plan'
      ? { code: 0, stdout: `${PLAN}\n` }
      : {
          code: 0,
          stdout: `✔ 센서 도구: LibreHardwareMonitor :8085\n${JSON.stringify({ ok: true, lhmPort: 8085 })}\n`,
        },
  );
  const installed = vi.fn();
  const setNvidiaSmi = vi.fn(() => true);
  const t = new SensorTool({
    platform: 'wsl',
    script: '/b/cld/install/hwSensors.mjs',
    port: () => 8085,
    home: home(),
    run,
    installed,
    setNvidiaSmi,
    ...over,
  });
  const sent: Array<Record<string, unknown>> = [];
  const send = (m: Record<string, unknown>) => {
    sent.push(m);
  };
  return { t, run, installed, setNvidiaSmi, sent, send };
}
const owner = { privileged: true, readOnly: false };
const remote = (fresh: boolean) => ({ ...owner, stepUp: { remote: true, fresh: () => fresh } });

describe('SensorTool: the install gate', () => {
  it('plan answers the consent text; install with consent runs the step once and re-detects', async () => {
    const { t, run, installed, sent, send } = tool();
    await t.handle({ action: 'plan' }, send, owner);
    expect(sent.at(-1)).toMatchObject({
      phase: 'plan',
      canInstall: true,
      lines: expect.arrayContaining([expect.stringContaining('UAC')]),
    });
    await t.handle({ action: 'install', consent: true }, send, owner);
    expect(run.mock.calls.map((c) => c[0])).toEqual([
      ['/b/cld/install/hwSensors.mjs', 'plan', '--port', '8085'],
      ['/b/cld/install/hwSensors.mjs', 'install', '--port', '8085'],
    ]);
    expect(sent.slice(1).map((m) => m.phase)).toEqual(['running', 'done']);
    expect(sent.at(-1)).toMatchObject({
      ok: true,
      lines: ['✔ 센서 도구: LibreHardwareMonitor :8085'],
    });
    expect(installed).toHaveBeenCalledWith(8085);
    // One consent, one run: again needs the plan again.
    await t.handle({ action: 'install', consent: true }, send, owner);
    expect(sent.at(-1)).toMatchObject({ phase: 'refused', error: 'consent' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('refused without consent, without the plan first, read-only, or off Windows/WSL', async () => {
    const a = tool();
    await a.t.handle({ action: 'install', consent: true }, a.send, owner); // no plan shown
    await a.t.handle({ action: 'plan' }, a.send, owner);
    await a.t.handle({ action: 'install' }, a.send, owner); // no consent
    await a.t.handle({ action: 'install', consent: 'yes' }, a.send, owner);
    await a.t.handle({ action: 'install', consent: true }, a.send, {
      privileged: true,
      readOnly: true,
    });
    await a.t.handle({ action: 'install', consent: true }, a.send, {
      privileged: false,
      readOnly: false,
    });
    expect(a.sent.filter((m) => m.phase === 'refused').map((m) => m.error)).toEqual([
      'consent',
      'consent',
      'consent',
      'read_only',
      'read_only',
    ]);
    expect(a.run.mock.calls.filter((c) => c[0][1] === 'install')).toEqual([]);
    for (const platform of ['linux', 'darwin'] as const) {
      const b = tool({ platform });
      await b.t.handle({ action: 'plan' }, b.send, owner);
      expect(b.sent).toEqual([
        { type: 'hwSensorToolState', phase: 'refused', error: 'unsupported' },
      ]);
      expect(b.run).not.toHaveBeenCalled();
    }
    const c = tool({ script: null });
    await c.t.handle({ action: 'plan' }, c.send, owner);
    expect(c.sent.at(-1)).toMatchObject({ error: 'unavailable' });
  });

  it('a remote session needs a fresh step-up for the install (not for the plan)', async () => {
    const { t, run, sent, send } = tool();
    await t.handle({ action: 'plan' }, send, remote(false));
    expect(sent.at(-1)).toMatchObject({ phase: 'plan' });
    await t.handle({ action: 'install', consent: true }, send, remote(false));
    expect(sent.at(-1)).toMatchObject({ phase: 'refused', error: STEPUP_REQUIRED });
    expect(run.mock.calls.filter((c) => c[0][1] === 'install')).toEqual([]);
    await t.handle({ action: 'install', consent: true }, send, remote(true));
    expect(sent.at(-1)).toMatchObject({ phase: 'done', ok: true });
  });

  it('one install at a time; a failed step says so and does not re-detect', async () => {
    let finish!: () => void;
    const { t, sent, send, installed } = tool({
      run: async (args) => {
        if (args[1] === 'plan') return { code: 0, stdout: PLAN };
        await new Promise<void>((r) => (finish = r));
        return {
          code: 0,
          stdout: `! 관리자 확인을 거절해 센서 없이 계속합니다\n${JSON.stringify({ ok: false, lhmPort: 8085 })}`,
        };
      },
    });
    const other = vi.fn();
    await t.handle({ action: 'plan' }, send, owner);
    await t.handle({ action: 'plan' }, other, owner);
    const first = t.handle({ action: 'install', consent: true }, send, owner);
    await new Promise((r) => setImmediate(r));
    await t.handle({ action: 'install', consent: true }, other, owner);
    expect(other).toHaveBeenLastCalledWith({
      type: 'hwSensorToolState',
      phase: 'refused',
      error: 'busy',
    });
    finish();
    await first;
    expect(sent.at(-1)).toMatchObject({
      phase: 'done',
      ok: false,
      lines: ['! 관리자 확인을 거절해 센서 없이 계속합니다'],
    });
    expect(installed).not.toHaveBeenCalled();
  });

  it('an LHM already answering on another port is read without installing', async () => {
    const { t, installed, sent, send } = tool({
      run: async () => ({
        code: 0,
        stdout: JSON.stringify({
          lines: ['✔ 이미 실행 중(:18085)'],
          install: false,
          lhmPort: 18085,
        }),
      }),
    });
    await t.handle({ action: 'plan' }, send, owner);
    expect(sent.at(-1)).toMatchObject({ phase: 'plan', canInstall: false });
    expect(installed).toHaveBeenCalledWith(18085);
  });
});

describe('SensorTool: the nvidia-smi switch', () => {
  it("stored as gpu.json's nvidiaSmi, other keys kept; refused when absent or the file is broken", async () => {
    const h = home();
    const file = path.join(h, '.config/agent-tycoon/gpu.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ exclusiveGib: 12 }));
    const a = tool({ home: h });
    await a.t.handle({ action: 'nvidiaOn' }, a.send, owner);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({
      exclusiveGib: 12,
      nvidiaSmi: true,
    });
    expect(a.setNvidiaSmi).toHaveBeenLastCalledWith(true);
    expect(a.sent).toEqual([]); // the next hwSample says it
    await a.t.handle({ action: 'nvidiaOff' }, a.send, owner);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).nvidiaSmi).toBe(false);

    await a.t.handle({ action: 'nvidiaOn' }, a.send, { privileged: true, readOnly: true });
    expect(a.sent.at(-1)).toMatchObject({ error: 'read_only' });
    const none = tool({ home: h, setNvidiaSmi: () => false });
    await none.t.handle({ action: 'nvidiaOn' }, none.send, owner);
    expect(none.sent.at(-1)).toMatchObject({ error: 'not_found' });
    fs.writeFileSync(file, '{ broken');
    await a.t.handle({ action: 'nvidiaOn' }, a.send, owner);
    expect(a.sent.at(-1)).toMatchObject({ error: 'write_failed' });
    expect(fs.readFileSync(file, 'utf-8')).toBe('{ broken');
  });
});

describe('SensorTool: after the security check', () => {
  it('turning nvidia-smi on from a remote device needs a fresh step-up; turning it off does not', async () => {
    const h = home();
    const { t, sent, send, setNvidiaSmi } = tool({ home: h });
    await t.handle({ action: 'nvidiaOn' }, send, remote(false));
    expect(sent.at(-1)).toMatchObject({ phase: 'refused', error: STEPUP_REQUIRED });
    expect(setNvidiaSmi).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(h, '.config/agent-tycoon/gpu.json'))).toBe(false);
    await t.handle({ action: 'nvidiaOff' }, send, remote(false));
    expect(setNvidiaSmi).toHaveBeenLastCalledWith(false);
    await t.handle({ action: 'nvidiaOn' }, send, remote(true));
    expect(setNvidiaSmi).toHaveBeenLastCalledWith(true);
  });

  it('a consent counts for its plan only: nothing to install, or older than the limit, is refused', async () => {
    let now = 1_000;
    const nothing = tool({
      now: () => now,
      run: async () => ({
        code: 0,
        stdout: JSON.stringify({ lines: ['! 웹 서버 꺼짐'], install: false, lhmPort: null }),
      }),
    });
    await nothing.t.handle({ action: 'plan' }, nothing.send, owner);
    await nothing.t.handle({ action: 'install', consent: true }, nothing.send, owner);
    expect(nothing.sent.at(-1)).toMatchObject({ phase: 'refused', error: 'consent' });

    const late = tool({ now: () => now });
    await late.t.handle({ action: 'plan' }, late.send, owner);
    now += CONSENT_TTL_MS + 1;
    await late.t.handle({ action: 'install', consent: true }, late.send, owner);
    expect(late.sent.at(-1)).toMatchObject({ phase: 'refused', error: 'consent' });
    expect(late.run.mock.calls.filter((c) => c[0][1] === 'install')).toEqual([]);
  });

  it('a plan waits for a running install (busy), and a timed-out install keeps the tool busy', async () => {
    let finish!: (r: { code: number; stdout: string; timedOut?: boolean }) => void;
    const { t, sent, send } = tool({
      run: (args) =>
        args[1] === 'plan'
          ? Promise.resolve({ code: 0, stdout: PLAN })
          : new Promise((r) => (finish = r)),
    });
    await t.handle({ action: 'plan' }, send, owner);
    const running = t.handle({ action: 'install', consent: true }, send, owner);
    await new Promise((r) => setImmediate(r));
    await t.handle({ action: 'plan' }, send, owner);
    expect(sent.at(-1)).toMatchObject({ phase: 'refused', error: 'busy' });
    finish({ code: -1, stdout: '', timedOut: true });
    await running;
    expect(sent.at(-1)).toMatchObject({ phase: 'done', ok: false });
    await t.handle({ action: 'plan' }, send, owner);
    expect(sent.at(-1)).toMatchObject({ phase: 'refused', error: 'busy' }); // the elevated step may still run
  });
});
