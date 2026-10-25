import { useEffect, useState } from 'react';

import { PERF_REFRESH_MS } from '../constants.js';
import { t } from '../i18n/index.js';
import { perfSnapshot, usePerfOn } from './perf.js';

const MB = 1024 * 1024;

/** HD64-SAMPLE: the readout, top left, while Settings has it on. */
export function PerfReadout() {
  const on = usePerfOn();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!on) return;
    const id = window.setInterval(() => tick((n) => n + 1), PERF_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [on]);
  if (!on) return null;
  const s = perfSnapshot();
  return (
    <div
      className="fixed left-8 top-8 z-[86] pointer-events-none border-2 border-border bg-bg px-8 py-4 text-xs text-text"
      data-testid="perf-readout"
    >
      {t('perf.readout', {
        ms: s.avgMs.toFixed(2),
        max: s.maxMs.toFixed(1),
        n: s.characters,
        hd: s.hd64,
        zoom: s.zoom,
        mb: (s.cacheBytes / MB).toFixed(1),
      })}
    </div>
  );
}
