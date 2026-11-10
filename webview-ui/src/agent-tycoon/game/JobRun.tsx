/**
 * GAME-UI-1 G3, 06 (specs/ui-mock-1103/ideas/agents/06-job-run): a job's progress as cells with the owner of
 * its project's room running along them to a flag. The fill is honest (gameState.runFill): a tqdm bar in the
 * log or the median of the last five successful runs, else nothing fills and the runner jogs in place. It
 * walks (8 fps) only while game motion is on, it is the list's top running job and its card is on screen.
 * The end: CLEAR · exit 0 and three coins once (0.8 s), or GAME OVER · exit N with 로그: the bar filled to where
 * it stopped, that cell red (gameState.stopCells), and the log line that says why (the server's stopLine).
 */
import { type CSSProperties, type RefObject, useEffect, useRef, useState } from 'react';

import type { OfficeJob } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { GAME_RUN_FIGURE_ZOOM, GAME_RUN_SEGMENTS, GAME_RUN_WALK_MS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { Direction } from '../../office/types.js';
import { useAgtyStore, virtualAgentId } from '../officeStore.js';
import type { JobKind } from '../panels/jobs.js';
import { GameFigure } from './GameFigure.js';
import { useChangeKey, useGameLooks } from './gameLooks.js';
import { useGameMotion } from './gameMotion.js';
import { litCells, runFill, stopCells } from './gameState.js';
import { PixelIcon, SegBar } from './parts.js';

/** True while `ref` is on screen and the page is visible (no timer runs otherwise). */
function useOnScreen(ref: RefObject<HTMLElement | null>, enabled: boolean): boolean {
  const [seen, setSeen] = useState(false);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(([e]) => setSeen(e.isIntersecting));
    io.observe(el);
    const onVis = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [ref, enabled]);
  return enabled && seen && visible;
}

const COINS = [0, 1, 2];

export function JobRun({ job, kind, walk, onLog }: { job: OfficeJob; kind: JobKind; walk: boolean; onLog?: () => void }) {
  const store = useAgtyStore();
  const looks = useGameLooks();
  const motion = useGameMotion();
  const track = useRef<HTMLDivElement>(null);
  const running = kind === 'running';
  const moving = useOnScreen(track, running && walk && motion);
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!moving) return;
    const timer = window.setInterval(() => setStep((n) => n + 1), GAME_RUN_WALK_MS);
    return () => window.clearInterval(timer);
  }, [moving]);
  const ended = useChangeKey(kind, (a, b) => a === 'running' && b !== 'running');

  const fill = runFill(job);
  const failed = kind === 'failed' || kind === 'timeout';
  let lit = fill ? litCells(fill.pct, GAME_RUN_SEGMENTS) : 0;
  let mark: number | undefined;
  if (kind === 'done') lit = GAME_RUN_SEGMENTS;
  else if (failed) ({ lit, mark } = stopCells(job, GAME_RUN_SEGMENTS));
  else if (!running) lit = 0;

  // The runner: the owner of the job's project room (the orchestrator of that name).
  const owner = job.project ? store.officeSnapshot?.orchestrators.find((o) => o.name === job.project) : undefined;
  const ownerId = owner ? (owner.agentId ?? virtualAgentId(`orch:${owner.name}`)) : null;
  const look = ownerId !== null ? looks?.getAppearance(ownerId) : undefined;
  const source = running ? (fill?.source ?? 'none') : null;
  return (
    <div className="game-run" data-testid="job-run" data-kind={kind} data-lit={lit} data-source={source ?? undefined} data-walking={moving || undefined}>
      <div ref={track} className="game-run-track" style={{ '--lit': lit / GAME_RUN_SEGMENTS } as CSSProperties}>
        <span className="game-run-goal">
          <PixelIcon name="flag" />
        </span>
        {look && (
          <span className="game-run-runner" data-testid="job-runner">
            <GameFigure
              look={look}
              zoom={GAME_RUN_FIGURE_ZOOM}
              dir={running ? Direction.RIGHT : Direction.DOWN}
              step={moving ? step : undefined}
            />
          </span>
        )}
        {kind === 'done' && ended > 0 && motion && (
          <span key={ended} className="game-run-coins" aria-hidden="true">
            {COINS.map((i) => (
              <span key={i} className="game-coin" data-coin={i}>
                <PixelIcon name="coin" />
              </span>
            ))}
          </span>
        )}
        <SegBar
          value={lit}
          max={GAME_RUN_SEGMENTS}
          segments={GAME_RUN_SEGMENTS}
          tone={kind === 'done' ? 'ok' : undefined}
          mark={mark}
          className="game-seg-fill game-run-lane"
          label={t('game.run.track', { name: job.label ?? job.project ?? '' })}
        />
      </div>
      {source && <p className="game-run-src">{t(`game.run.${source}`)}</p>}
      {kind === 'done' && (
        <div key={ended} className="game-run-plate" data-ok="" data-pop={ended ? '' : undefined} data-testid="job-plate">
          <PixelIcon name="trophy" />
          <span className="game-run-big">{t('game.run.clear')}</span>
        </div>
      )}
      {failed && (
        <div key={ended} className="game-run-plate" data-bad="" data-pop={ended ? '' : undefined} data-testid="job-plate">
          <span className="game-run-big">{job.exit == null ? t('game.run.overNoCode') : t('game.run.over', { code: job.exit })}</span>
          {onLog && (
            <Button size="sm" className="ml-auto" onClick={onLog}>
              <PixelIcon name="log" />
              {t('game.run.log')}
            </Button>
          )}
        </div>
      )}
      {failed && job.stopLine && (
        <p className="game-run-why" data-testid="job-stop-line">
          {t('game.run.stopAt', { line: job.stopLine })}
        </p>
      )}
    </div>
  );
}
