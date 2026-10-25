/**
 * GFX title scene (owner 10-25): the owner's lobby art with the menu as real buttons over it.
 *
 * Shows on the first open of a browser session (unless turned off in 설정 > 화면) and from the
 * 로비 button in the office's corner. Never in the way: 사무실 입장 has the focus, so Enter or
 * Esc or one click or tap is the office. The office keeps running underneath (the daemon and
 * the agents carry on; the canvas draws nothing while covered: the loop is paced to idle).
 *
 * The status line is honest and free: the socket's own state and the connector the remote
 * banner already reads (GET /api/cld/connector, a local call). No usage, no hardware numbers,
 * no model call.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { TransportState } from '../../../../core/src/transport.js';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { LAYOUT_UNITS_PER_PX, TITLE_BOX, TITLE_LOGO, TITLE_SCENE_Z } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { authFetch } from '../auth/authApi.js';
import type { ConnectorStatus } from '../auth/Remote.js';
import { openSettings } from '../settingsOpen.js';
import { safeArea } from '../useGameControls.js';
import logo from './art/logo-sign.png';
import { LobbyArt } from './LobbyLife.js';
import {
  closeTitleScene,
  exactDevicePx,
  lobbyCastLeft,
  snapExact,
  useTitleScene,
} from './titleSceneState.js';
import { useWarmUp } from './warmUp.js';

function useTransportState(): TransportState {
  const [s, setS] = useState<TransportState>(transport.state);
  useEffect(() => {
    setS(transport.state);
    return transport.onStateChange(setS);
  }, []);
  return s;
}

/** The connector, once per opening; null while unknown (a viewer without access gets none). */
function useConnector(): ConnectorStatus['connector'] | null {
  const [c, setC] = useState<ConnectorStatus['connector'] | null>(null);
  useEffect(() => {
    let live = true;
    authFetch<ConnectorStatus>('/api/cld/connector').then(
      (s) => live && setC(s.connector),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return c;
}

const MENU = ['remote', 'settings', 'help'] as const;

/** The menu stacked at the bottom (a phone held upright), else beside the picture's counter
 *  (a desktop, a phone held sideways: stacked, it would run off the top). */
const stacked = (phone: boolean) => phone && window.innerHeight >= window.innerWidth;

/** The margin around the logo (CSS px): the box's own, or the next whole CSS px that is a whole
 *  number of device px (dpr 1.25: 16), so the logo inside a box placed on an exact px is too. */
function logoMargin(dpr: number): number {
  const base = TITLE_BOX.padPx + TITLE_BOX.borderPx;
  for (let m = base; m < base + LAYOUT_UNITS_PER_PX; m++)
    if (Math.abs(m * dpr - Math.round(m * dpr)) < 1e-6) return m;
  return base;
}

type TitleBox = { css: number; box: number; margin: number };

/** The title box: the owner's logo sign at the largest whole number of device px per art px
 *  that fits (a share of the window's width and height, clear of the cast at the counter),
 *  never smoothed, and the box exactly the logo plus the same margin on both sides; the menu
 *  and the status line take that width. */
function useTitleBox(phone: boolean): TitleBox | null {
  const [size, setSize] = useState<TitleBox | null>(null);
  useLayoutEffect(() => {
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const left = safeArea().left + window.innerWidth * TITLE_BOX.leftShare;
      const room = stacked(phone)
        ? window.innerWidth - 2 * TITLE_BOX.phoneGutterPx
        : Math.min(
            TITLE_BOX.maxRem * rem,
            window.innerWidth * TITLE_BOX.maxWidthShare,
            lobbyCastLeft(window.innerWidth, window.innerHeight) - TITLE_BOX.castGapPx - left,
          );
      const margin = logoMargin(dpr);
      const avail = room - 2 * margin;
      const most = Math.max(
        1,
        Math.floor(
          Math.min(
            (avail * dpr) / TITLE_LOGO.w,
            (window.innerHeight * TITLE_LOGO.maxHeightShare * dpr) / TITLE_LOGO.h,
          ),
        ),
      );
      // The logo's canvas is padded to a whole number of layout units (Logo), the box with it.
      const css = most / dpr;
      setSize({ css, box: exactDevicePx(TITLE_LOGO.w * most, dpr) / dpr + 2 * margin, margin });
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [phone]);
  return size;
}

/** The logo sign drawn into a canvas of exactly its device px (an <img> of a size that is not
 *  a whole layout unit, 62 x 3.2 px at dpr 1.25, is resampled even on an exact px). */
function Logo({ css }: { css: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = window.devicePixelRatio || 1;
  const k = Math.round(css * dpr);
  // The canvas a whole number of layout units big (dpr 2.625: 810 device px is not; 819 is), the
  // logo centred in it to a device px.
  const w = exactDevicePx(TITLE_LOGO.w * k, dpr);
  const h = exactDevicePx(TITLE_LOGO.h * k, dpr);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    let live = true;
    const img = new Image();
    img.src = logo;
    void img
      .decode()
      .then(() => {
        if (!live) return;
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(
          img,
          Math.floor((w - TITLE_LOGO.w * k) / 2),
          Math.floor((h - TITLE_LOGO.h * k) / 2),
          TITLE_LOGO.w * k,
          TITLE_LOGO.h * k,
        );
      })
      .catch(() => undefined); // no logo: the box keeps its size, the name is its label
    return () => {
      live = false;
    };
  }, [k, w, h]);
  return (
    <canvas
      ref={ref}
      role="img"
      aria-label={t('gfx.title.name')}
      data-testid="title-logo"
      className="block"
      style={{ imageRendering: 'pixelated', width: w / dpr, height: h / dpr }}
    />
  );
}

export function TitleScene({ phone }: { phone: boolean }) {
  const { open } = useTitleScene();
  return open ? createPortal(<Title phone={phone} />, document.body) : null;
}

function Title({ phone }: { phone: boolean }) {
  const [help, setHelp] = useState(false);
  const box = useTitleBox(phone);
  const column = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = column.current;
    if (!el || !box) return;
    const place = () => {
      const dpr = window.devicePixelRatio || 1;
      const snap = (v: number) => snapExact(v, dpr);
      const safe = safeArea();
      const { width, height } = el.getBoundingClientRect();
      setPos(
        stacked(phone)
          ? {
              left: snap((window.innerWidth - width) / 2),
              top: snap(window.innerHeight - safe.bottom - TITLE_BOX.phoneGutterPx - height),
            }
          : {
              left: snap(safe.left + window.innerWidth * TITLE_BOX.leftShare),
              // Taller than the window (a phone held sideways): the logo stays on screen.
              top: snap(Math.max(safe.top, (window.innerHeight - height) / 2)),
            },
      );
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    window.addEventListener('resize', place);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [box, phone]);
  const socket = useTransportState();
  const connector = useConnector();
  const warm = useWarmUp();
  useEffect(() => {
    // 사무실 입장 takes the focus also when the lobby opens from the 로비 button (that click's
    // own focus lands after autoFocus), so Enter is always the office.
    const id = requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('[data-testid="title-enter"]')?.focus(),
    );
    return () => cancelAnimationFrame(id);
  }, []);
  useEffect(() => {
    // Enter or Esc with nothing focused (a click on the picture) is the office too; a dialog
    // the menu opened keeps its own keys.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === 'Enter' && document.activeElement && document.activeElement !== document.body)
        return; // a focused button does its own
      e.preventDefault();
      closeTitleScene();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const pick = (id: (typeof MENU)[number]) => {
    if (id === 'help') setHelp(true);
    else openSettings(id === 'remote' ? 'access' : undefined);
  };
  const daemon =
    socket === 'connected'
      ? 'connected'
      : socket === 'connecting' || socket === 'reconnecting'
        ? 'connecting'
        : 'down';
  const remote =
    connector === null ? null : connector === 'local' ? 'off' : connector === 'lan' ? 'lan' : 'on';
  return (
    <div
      // A phone held sideways may be shorter than the menu: the lobby scrolls, the picture does not.
      className="fixed inset-0 overflow-x-hidden overflow-y-auto bg-bg select-none"
      style={{ zIndex: TITLE_SCENE_Z }}
      role="region"
      aria-label={t('gfx.title.region')}
      data-testid="title-scene"
    >
      <LobbyArt />
      {/* Placed in whole device px (not translate(-50%) or a % padding): a fractional
          position would resample the logo. */}
      <div
        ref={column}
        className="absolute flex flex-col gap-8"
        style={{
          width: box?.box,
          left: pos?.left,
          top: pos?.top,
          visibility: box && pos ? undefined : 'hidden',
        }}
        data-testid="title-column"
      >
        <div
          className="pixel-panel"
          style={{
            padding: (box?.margin ?? TITLE_BOX.padPx + TITLE_BOX.borderPx) - TITLE_BOX.borderPx,
          }}
          data-testid="title-box"
        >
          <h1 className="m-0 leading-none">{box && <Logo css={box.css} />}</h1>
          <p className="m-0 mt-4 text-sm text-text-muted">{t('gfx.title.tagline')}</p>
        </div>
        <nav className="flex flex-col gap-4" aria-label={t('gfx.title.menu')}>
          <Button
            autoFocus
            size="md"
            variant="accent"
            className="justify-start! text-lg shadow-pixel"
            data-testid="title-enter"
            onClick={closeTitleScene}
          >
            {`▶ ${t('gfx.title.enter')}`}
          </Button>
          {MENU.map((id) => (
            <Button
              key={id}
              size="md"
              className="justify-start! shadow-pixel border-border!"
              data-testid={`title-${id}`}
              onClick={() => pick(id)}
            >
              {t(`gfx.title.${id}`)}
            </Button>
          ))}
        </nav>
        <p
          className="pixel-panel m-0 px-10 py-4 text-sm flex flex-wrap gap-x-12 gap-y-2"
          data-testid="title-status"
          aria-live="polite"
        >
          <span data-daemon={daemon}>{t(`gfx.title.daemon.${daemon}`)}</span>
          {remote && <span data-remote={remote}>{t(`gfx.title.remote.${remote}`)}</span>}
          {warm.total > 0 && (
            <span
              className="text-text-muted"
              data-testid="title-warm"
              data-done={warm.done >= warm.total ? '1' : '0'}
            >
              {warm.done >= warm.total
                ? t('sheetImport.warmDone')
                : t('sheetImport.warm', { done: warm.done, total: warm.total })}
            </span>
          )}
        </p>
      </div>
      {help && (
        <Modal isOpen onClose={() => setHelp(false)} title={t('gfx.title.help')}>
          <ul className="m-0 px-24 pb-10 text-sm flex flex-col gap-4" data-testid="title-help-text">
            {(['camera', 'floors', 'select', 'modes', 'legend'] as const).map((k) => (
              <li key={k}>{t(`gfx.help.${k}`)}</li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}
