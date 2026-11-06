/**
 * GAME-UI-1 G3, 07 (specs/ui-mock-1103/ideas/agents/07-hud): the top bar as a game HUD. Usage gauges
 * (what is LEFT: the 5-hour window as cells, its reset as h:mm, the week as a number), the job counter
 * and the CPU heat gauge. Only what the stores already hold: the usage state, the job and Codex
 * records, the hwSample the daemon broadcasts while someone watches (no polling of its own).
 * One-shot motion only (refill, roll, nudge), keyed on a change, never on mount.
 */
import { GAME_HEAT_SEGMENTS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { openBoard } from '../board/boardOpen.js';
import { useCldStore } from '../officeStore.js';
import { workCounts } from '../panels/jobs.js';
import { useChangeKey } from './gameLooks.js';
import { heatLook } from './gameState.js';
import { openJobs } from './openJobs.js';
import { PixelIcon, SegBar, type SegTone } from './parts.js';

/** Jobs running now and waiting (the records alone, jobs.workCounts); 0 dimmed; a click opens the jobs. */
export function JobCounter({ chip = false }: { chip?: boolean }) {
  const { officeJobs, codexTasks } = useCldStore();
  const n = workCounts(officeJobs?.jobs ?? [], codexTasks?.tasks ?? []);
  const waiting = n.queued + n.gpuWait + n.limit;
  const roll = useChangeKey(n.running);
  const title = t('game.hud.jobsTitle', { running: n.running, waiting });
  return (
    <button
      type="button"
      className={chip ? 'game-pin' : 'game-gx game-cnt'}
      title={title}
      aria-label={title}
      data-testid="hud-jobs"
      data-count={n.running}
      onClick={openJobs}
    >
      <PixelIcon name="case" />
      <span className="game-cnt-box">
        <span key={roll} className="game-cnt-v" data-zero={n.running === 0 || undefined} data-roll={roll ? '' : undefined}>
          {n.running}
        </span>
      </span>
      {!chip && <span className="game-gx-r">{t('game.hud.jobs')}</span>}
      {!chip && waiting > 0 && <span className="game-gx-r">· {t('game.hud.queued', { count: waiting })}</span>}
    </button>
  );
}

const rank = (tone: SegTone | undefined): number => (tone === 'bad' ? 2 : tone === 'warn' ? 1 : 0);

/**
 * The CPU's heat (hwSample.cpuTempC, the daemon's sample while someone watches): cells from 30 °C,
 * amber and 뜨거움 from 85, red and 위험 from 95; crossing up nudges the box once. `chip` (the phone)
 * shows only a hot one. Nothing measured, nothing shown.
 */
export function HeatGauge({ chip = false }: { chip?: boolean }) {
  const c = useCldStore().hwSample?.cpuTempC;
  const look = typeof c === 'number' && Number.isFinite(c) ? heatLook(c) : null;
  const nudge = useChangeKey(look?.tone, (a, b) => rank(b) > rank(a));
  if (!look || (chip && !look.tone)) return null;
  const deg = `${Math.round(c!)}°`;
  const title = t('game.hud.heatTitle', { temp: deg });
  return (
    <button
      key={nudge}
      type="button"
      className={chip ? 'game-pin' : 'game-gx game-heat'}
      data-tone={look.tone}
      data-nudge={nudge ? '' : undefined}
      title={title}
      aria-label={title}
      data-testid="hud-heat"
      onClick={() => openBoard('hw')}
    >
      <PixelIcon name={look.tone ? 'flame' : 'thermo'} className="game-tone" />
      {!chip && <span className="game-gx-nm">{t('game.hud.cpu')}</span>}
      {!chip && (
        <SegBar value={look.lit} max={GAME_HEAT_SEGMENTS} segments={GAME_HEAT_SEGMENTS} tone={look.tone} className="game-seg-thin game-heat-cells" />
      )}
      <span className="game-gx-v game-tone">{deg}</span>
      {!chip && look.word && <span className="game-gx-r game-tone">{t(`game.hud.${look.word}`)}</span>}
    </button>
  );
}
