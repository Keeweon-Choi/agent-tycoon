import * as fs from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OfficeBackground } from '../../../core/src/messages.js';
import { ROSTER, startEngineOffice } from './officeTestKit.js';

afterEach(() => vi.restoreAllMocks());

const latest = (list: Array<Record<string, unknown>>) =>
  [...list].reverse().find((m) => m.type === 'officeBackground') as unknown as
    | OfficeBackground
    | undefined;

describe('office background (BACKGROUND)', () => {
  it('a change reaches everyone, survives a restart, and an untouched office sends nothing', async () => {
    const first = await startEngineOffice({ projects: ROSTER });
    const fresh: Array<Record<string, unknown>> = [];
    first.office.onClientReady((m: Record<string, unknown>) => fresh.push(m));
    expect(latest(fresh)).toBeUndefined();
    const ask = { type: 'setOfficeBackground', time: 'night', mix: 'towers', seed: 77 };
    first.office.onClientMessage(ask, vi.fn(), true, 'ua');
    expect(latest(first.messages)).toEqual({ type: 'officeBackground', time: 'night', mix: 'towers', seed: 77 });
    const file = `${first.home}/.config/agent-tycoon/background.json`;
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const home = first.home;
    first.stop();
    const again = await startEngineOffice({ projects: ROSTER, home });
    const got: Array<Record<string, unknown>> = [];
    again.office.onClientReady((m: Record<string, unknown>) => got.push(m));
    expect(latest(got)).toMatchObject({ time: 'night', mix: 'towers', seed: 77 });
    again.stop();
  });

  it('a read-only client or a bad value is refused and told the stored look', async () => {
    const o = await startEngineOffice({ projects: ROSTER });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent: Array<Record<string, unknown>> = [];
    const send = (m: Record<string, unknown>) => sent.push(m);
    const good = { type: 'setOfficeBackground', time: 'day', mix: 'houses', seed: 5 };
    o.office.onClientMessage(good, send, false, 'ua');
    o.office.onClientMessage({ ...good, time: 'dusk' }, send, true, 'ua');
    o.office.onClientMessage({ ...good, seed: -1 }, send, true, 'ua');
    o.office.onClientMessage({ ...good, seed: 1.5 }, send, true, 'ua');
    expect(sent).toHaveLength(4);
    for (const m of sent) expect(m).toMatchObject({ type: 'officeBackground', time: 'clock', seed: 1101 });
    expect(latest(o.messages)).toBeUndefined();
    o.stop();
  });
});
