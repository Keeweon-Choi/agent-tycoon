import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HwSample, OfficeSnapshot } from '../../../../core/src/messages.js';
import { ISO_BILLBOARD_ROWS } from '../../constants.js';
import { setLanguage, t } from '../../i18n/index.js';
import { cldGetSnapshot, cldHandleMessage, cldResetForTests } from '../officeStore.js';
import {
  BILLBOARD_PAGES,
  billboardContent,
  type BillboardPage,
  nextPage,
} from './billboardFace.js';
import { moreText, projectRows } from './board.js';

const NOW = Date.parse('2026-11-04T11:00:00Z');
const office = (n: number): OfficeSnapshot => ({
  type: 'officeSnapshot',
  readOnly: true,
  tabs: [{ name: 'orch', kind: 'orch', order: 0 }],
  orchestrators: Array.from({ length: n }, (_, k) => ({
    name: `p${k}`,
    dir: `/w/p${k}`,
    tab: 'orch',
    order: k,
    state: 'running' as const,
    busy: false,
    remoteControl: { on: false, url: null },
    compactions: 0,
    alive: true,
    agentId: 100 + k,
  })),
});
const input = () => ({
  snap: cldGetSnapshot(),
  agentTools: {},
  waiting: 2,
  workers: new Set<string>(),
  reasons: {},
  view: 'wsl' as const,
  now: NOW,
});

describe('the billboard (building-a-1104)', () => {
  beforeEach(() => setLanguage('ko'));
  afterEach(() => cldResetForTests());

  it('turns summary, projects, H/W, GPU, then back', () => {
    expect(BILLBOARD_PAGES).toEqual(['summary', 'projects', 'hw', 'gpu']);
    let p: BillboardPage = BILLBOARD_PAGES[0];
    const seen: BillboardPage[] = [p];
    for (let i = 0; i < 4; i++) seen.push((p = nextPage(p)));
    expect(seen).toEqual(['summary', 'projects', 'hw', 'gpu', 'summary']);
  });

  it('shows the old board’s project rows and state words, a few, then +N', () => {
    cldHandleMessage(office(5));
    const f = billboardContent('projects', input());
    const rows = projectRows(cldGetSnapshot(), {}, NOW, ISO_BILLBOARD_ROWS);
    expect(f.lines!.slice(0, ISO_BILLBOARD_ROWS).map((l) => l.text)).toEqual(
      rows.shown.map((r) => r.name),
    );
    expect(f.lines!.at(-1)!.text).toBe(moreText(2));
    expect(f.lines![0].dot).toBeTruthy();
    expect(f.lines![0].value).toBeTruthy();
  });

  it('sums up who waits and the work running; H/W and GPU read the samples as they come', () => {
    const s = billboardContent('summary', input());
    expect(s.big!.map((b) => [b.label, b.value])).toEqual([
      [t('board.billboard.waiting'), '2'],
      [t('board.billboard.working'), '0'],
    ]);
    expect(billboardContent('hw', input()).lines![0].text).toBe(t('board.waitingHardware'));
    cldHandleMessage({
      type: 'hwSample',
      ts: new Date(NOW).toISOString(),
      stale: false,
      disks: [],
      warnings: [],
      cpuUtil: 0.23,
      gpuUtil: 0.5,
      ramUsedGib: 8,
      ramTotalGib: 32,
    } as HwSample);
    const hw = billboardContent('hw', input());
    expect(hw.lines![0]).toMatchObject({ text: 'CPU', value: '23%' });
    expect(hw.lines!.length).toBeLessThanOrEqual(ISO_BILLBOARD_ROWS);
    const gpu = billboardContent('gpu', input());
    expect(gpu.lines![0]).toMatchObject({ text: 'GPU', value: '50%' });
    expect(gpu.lines![1].text).toBe(t('board.gpuIdle'));
  });
});
