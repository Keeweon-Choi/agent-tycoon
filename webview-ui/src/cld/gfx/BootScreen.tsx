/**
 * BOOT-LOAD (owner 11-04 21:08): the loading screen in front of the lobby at launch. It gets what
 * the lobby and the first office view draw ready while the person waits, and its bar follows the
 * real steps (bootSteps.ts), never a timer: the daemon and the first office snapshot, the fonts,
 * the lobby picture, the worn character sheets (and the lobby cast's), the isometric pictures, the
 * queued sprite builds drained (warmUp.ts's batch and the ones the office queued as it drew), and
 * one office frame drawn after that (the floor, facade and background caches, the depth order).
 *
 * It fills the caches the office already keeps and makes none of its own: the office draws under
 * this screen as it always drew under the lobby, and this screen only gives the build queue a
 * bigger slice of each frame. Nothing it decodes is held past the moment the lobby takes over.
 * The 로비 button never shows it (titleSceneState: `booting` is set only at launch).
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { Button } from '../../components/ui/Button.js';
import {
  BOOT_ALERT_MS,
  BOOT_BAR_SEGMENTS,
  BOOT_GIVE_UP_MS,
  BOOT_STEPS,
  BOOT_WARM_SLICE_MS,
  TITLE_SCENE_Z,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import { officeOnScreen, onOfficeDrawn } from '../../office/engine/gameLoop.js';
import { pumpWarm, warmPending, warmRan } from '../../office/sprites/smoothSprite.js';
import { transport } from '../../transport/index.js';
import { sheetLoads } from '../characters/looks.js';
import { SegBar } from '../game/parts.js';
import { isoImages } from '../iso/art.js';
import { isoOn } from '../iso/isoView.js';
import { cldGetSnapshot } from '../officeStore.js';
import logo from './art/logo-sign.png';
import {
  type BootStepId,
  type BootView,
  bootView,
  skippable,
  type StepReport,
} from './bootSteps.js';
import { LOBBY_SRC, lobbyLooks } from './lobbyCast.js';
import { finishBoot, lobbyCover, useTitleScene } from './titleSceneState.js';

export function BootScreen({ layoutReady }: { layoutReady: boolean }) {
  const { booting } = useTitleScene();
  return booting ? createPortal(<Boot layoutReady={layoutReady} />, document.body) : null;
}

type Shown = BootView & { alert: boolean; daemon: 'connecting' | 'down' };

function Boot({ layoutReady }: { layoutReady: boolean }) {
  const layout = useRef(layoutReady);
  layout.current = layoutReady;
  const [view, setView] = useState<Shown | null>(null);
  useEffect(() => {
    const t0 = performance.now();
    // The lobby's picture for this window's shape and the logo, decoded now (held until the
    // lobby shows them: then they are its own <img> and canvas).
    const pictures = [LOBBY_SRC[lobbyCover(window.innerWidth, window.innerHeight).art], logo];
    let decoded = 0;
    const held = pictures.map((src) => {
      const img = new Image();
      img.src = src;
      img.decode().then(
        () => decoded++,
        () => decoded++, // a picture that fails shows as it always did: not a reason to wait
      );
      return img;
    });
    // Office frames drawn so far, and the count when each later step could start.
    let drawn = 0;
    const offDrawn = onOfficeDrawn(() => drawn++);
    const marks: Partial<Record<'office' | 'assets' | 'warm', number>> = {};
    const since = (k: keyof typeof marks) =>
      marks[k] !== undefined && (!officeOnScreen() || drawn > marks[k]);
    // What was queued when every picture was in (the office's frames keep queueing new turns as
    // characters walk: those build in the office's own slices afterwards, as always).
    let queued: { pending: number; ran: number } | null = null;
    let fonts = false;
    let rendered = false;
    let asked: unknown = null;
    let raf = 0;
    let last = '';
    let ended: BootStepId[] = [];
    const tick = () => {
      // Nothing else moves while this shows: the queue gets more of the frame than the office's slice.
      pumpWarm(BOOT_WARM_SLICE_MS);
      const elapsed = performance.now() - t0;
      const snap = cldGetSnapshot();
      // The layout arrives over the socket (a development mock delivers it without one).
      const connected = transport.state === 'connected' || layout.current;
      // ponytail: a page without the agty office (no snapshot ever) passes after BOOT_GIVE_UP_MS
      const office = layout.current && (snap.officeSnapshot !== null || elapsed > BOOT_GIVE_UP_MS);
      if (office) marks.office ??= drawn;
      const presets = snap.characterPresets;
      if (presets && office && presets !== asked) {
        asked = presets;
        lobbyLooks(presets); // the lobby cast's sheets, asked as the lobby asks
      }
      const [sheetsDone, sheets] = sheetLoads();
      // since(office): the looks were applied (an office frame comes after the effects that ask)
      const looks = !!presets && since('office') && sheetsDone === sheets;
      const iso = isoOn() ? isoImages() !== null : null;
      if (looks && iso !== false) marks.assets ??= drawn;
      // since(assets): the office drew with every picture in, so it queued what it draws
      if (since('assets')) queued ??= { pending: warmPending(), ran: warmRan() };
      const built = queued ? Math.min(queued.pending, warmRan() - queued.ran) : 0;
      const warm = !!queued && (built >= queued.pending || warmPending() === 0);
      if (warm) marks.warm ??= drawn;
      const reports: Record<BootStepId, StepReport> = {
        connect: { done: connected },
        office: { done: office },
        fonts: { done: fonts },
        lobby: { done: decoded === pictures.length, part: [decoded, pictures.length] },
        looks: { done: looks, part: [sheetsDone, sheets] },
        iso: iso === null ? null : { done: iso },
        warm: { done: warm, part: [built, queued?.pending ?? 0] },
        frame: { done: since('warm') },
      };
      const giveUp = new Set(
        elapsed > BOOT_GIVE_UP_MS ? BOOT_STEPS.map((s) => s.id).filter(skippable) : [],
      );
      const v = bootView(reports, giveUp, ended);
      ended = v.ended;
      const shown: Shown = {
        ...v,
        alert: !office && elapsed > BOOT_ALERT_MS,
        daemon:
          transport.state === 'connecting' || transport.state === 'reconnecting'
            ? 'connecting'
            : 'down',
      };
      const key = JSON.stringify(shown);
      if (key !== last) {
        last = key;
        setView(shown);
      }
      if (!rendered) {
        rendered = true;
        // The faces this screen's text asked for are loading now; ready settles when they are in
        // (a later Hangul range the office draws loads on its own).
        void document.fonts.ready.then(() => (fonts = true));
      }
      if (v.done) {
        if (v.skipped.length)
          console.warn(`[Webview] loading screen skipped ${v.skipped.join(', ')}`);
        return; // the lobby follows once 100 % is on screen (below)
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      offDrawn();
      held.length = 0;
    };
  }, []);
  const done = !!view?.done;
  useEffect(() => {
    if (!done) return;
    const id = requestAnimationFrame(() => finishBoot());
    return () => cancelAnimationFrame(id);
  }, [done]);
  const v = view;
  return (
    <div
      className="fixed inset-0 bg-bg flex items-center justify-center p-16 select-none"
      style={{ zIndex: TITLE_SCENE_Z }}
      role="region"
      aria-label={t('boot.region')}
      data-testid="boot-screen"
      data-pct={v?.pct ?? 0}
      data-step={v?.current ?? ''}
    >
      <div className="pixel-panel w-full max-w-[420px] p-16 flex flex-col gap-12">
        <div className="flex items-baseline justify-between gap-12">
          <h1 className="m-0 text-lg leading-none">{t('boot.title')}</h1>
          <span className="text-lg leading-none text-accent-text" data-testid="boot-pct">
            {`${v?.pct ?? 0}%`}
          </span>
        </div>
        <SegBar
          value={v?.pct ?? 0}
          max={100}
          segments={BOOT_BAR_SEGMENTS}
          label={t('boot.region')}
          className="self-start"
        />
        <ol className="m-0 p-0 list-none flex flex-col gap-2 text-sm" aria-live="polite">
          {(v?.order ?? BOOT_STEPS.map((s) => s.id)).map((id) => {
            const state = v ? v.states[id] : 'wait';
            if (!state) return null; // not needed here
            return (
              <li
                key={id}
                className={`flex gap-8 ${state === 'now' ? 'text-text' : 'text-text-muted'}`}
                data-boot-step={id}
                data-state={state}
              >
                <span
                  aria-hidden="true"
                  className={state === 'done' ? 'text-accent-text' : undefined}
                >
                  {MARK[state]}
                </span>
                <span>{t(`boot.step.${id}`)}</span>
                {state === 'now' && v?.part && v.part[1] > 0 && (
                  <span className="ml-auto">
                    {t('boot.part', { done: v.part[0], total: v.part[1] })}
                  </span>
                )}
                {state === 'skip' && <span className="ml-auto">{t('boot.skipped')}</span>}
              </li>
            );
          })}
        </ol>
        {v?.alert && (
          <div className="flex flex-col gap-8" data-testid="boot-alert" role="alert">
            <p className="m-0 text-sm">
              {`${t(`gfx.title.daemon.${v.daemon}`)} · ${t('boot.alert')}`}
            </p>
            <Button
              size="md"
              variant="accent"
              className="self-start"
              onClick={() => location.reload()}
            >
              {t('boot.retry')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

const MARK = { done: '■', now: '▶', wait: '□', skip: '–' } as const;
