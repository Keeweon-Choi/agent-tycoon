/**
 * GFX2 (owner 10-25 22:27): the lobby picture comes alive. The picture is placed by hand as a
 * centred cover (the same numbers place the effects), its lamps glow and flicker, the neon sign
 * blinks, fairy lights twinkle, a few city windows go off and on (lobby.css: opacity only, none
 * under reduced motion), and Tori and the owner's character sit at the reception counter (or
 * stand at it, in the wide picture, whose own receptionist is drawn behind it), each drawn at a
 * whole number of device px per sprite px, with the idle frames of the office.
 *
 * The spots are lobbySpots.json (cld/scripts/gen-lobby-spots.ts: found in the pictures by colour).
 */
import './lobby.css';

import { type CSSProperties, useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { CharacterChoice, CharacterPresets } from '../../../../core/src/messages.js';
import { LOBBY_ART } from '../../constants.js';
import { getCachedSprite } from '../../office/sprites/spriteCache.js';
import { getCharacterSprites } from '../../office/sprites/spriteData.js';
import { Direction } from '../../office/types.js';
import { lookByName, useLooksUi } from '../characters/looks.js';
import { reducedMotion } from '../floors.js';
import { useCldStore } from '../officeStore.js';
import tall from './art/title-tall.webp';
import wide from './art/title-wide.webp';
import SPOTS from './lobbySpots.json';
import { exactDevicePx, type LobbyArtKind, lobbyCover, snapExact } from './titleSceneState.js';

type Art = LobbyArtKind;
const SRC: Record<Art, string> = { wide, tall };
/** The look the owner keeps for themself (assignments.owner), else the HD sample preset. */
const OWNER_LOOK_KEY = 'owner';
const OWNER_FALLBACK_PRESET = 'bunny-hd-sample';
const TORI: CharacterChoice = { v: 2, kind: 'mascot', species: 'tori' };

function useCover() {
  const get = () => lobbyCover(window.innerWidth, window.innerHeight);
  const [cover, setCover] = useState(get);
  useEffect(() => {
    const on = () => setCover(get());
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return cover;
}

/** Deterministic variety (no Math.random: the same lobby each time). */
const vary = (i: number, lo: number, hi: number) => lo + (((i * 7919) % 97) / 97) * (hi - lo);
/** An effect's own period and phase (lobby.css reads --d and --t). */
const timing = (i: number, lo: number, hi: number) =>
  ({ '--d': `${vary(i, lo, hi)}s`, '--t': `-${vary(i + 3, 0, hi)}s` }) as CSSProperties;

export function LobbyArt() {
  const { art, s, left, top } = useCover();
  const dpr = window.devicePixelRatio || 1;
  const snap = (v: number) => snapExact(v, dpr); // the figures are placed from here
  const spot = SPOTS[art];
  const pct = (x: number, n: number) => `${(x / n) * 100}%`;
  const box = (x: number, y: number, w: number, h: number) => ({
    left: pct(x - w / 2, spot.w),
    top: pct(y - h / 2, spot.h),
    width: pct(w, spot.w),
    height: pct(h, spot.h),
  });
  return (
    <div
      className="absolute"
      style={{ left: snap(left), top: snap(top), width: spot.w * s, height: spot.h * s }}
      data-testid="title-art"
      data-art={art}
    >
      <img
        src={SRC[art]}
        alt=""
        draggable={false}
        className="absolute inset-0 w-full h-full"
        style={{ imageRendering: 'pixelated' }}
      />
      <div className="cld-lobby-fx absolute inset-0" data-testid="title-fx">
        {spot.lamps.map(([x, y, r], i) => (
          <i
            key={`l${i}`}
            className="cld-lobby-glow"
            style={{ ...box(x, y, r * 3, r * 3), ...timing(i, 3.5, 7) }}
          />
        ))}
        <i
          className="cld-lobby-neon"
          style={box(
            spot.neon.x + spot.neon.w / 2,
            spot.neon.y + spot.neon.h / 2,
            spot.neon.w * 1.4,
            spot.neon.h * 1.6,
          )}
        />
        <i
          className="cld-lobby-neon-off"
          style={box(
            spot.neon.x + spot.neon.w / 2,
            spot.neon.y + spot.neon.h / 2,
            spot.neon.w,
            spot.neon.h,
          )}
        />
        {spot.twinkles.map(([x, y], i) => (
          <i
            key={`f${i}`}
            className="cld-lobby-twinkle"
            style={{ ...box(x, y, 4, 4), ...timing(i, 1.2, 3.2) }}
          />
        ))}
        {spot.windows.map(([x, y, w, h], i) => (
          <i
            key={`w${i}`}
            className="cld-lobby-window"
            style={{ ...box(x, y, w, h), ...timing(i, 11, 23) }}
          />
        ))}
      </div>
      <LobbyCast art={art} s={s} />
    </div>
  );
}

/** Tori and the owner at the counter. */
function LobbyCast({ art, s }: { art: Art; s: number }) {
  const { characterPresets } = useCldStore();
  useLooksUi(); // a preset sheet that finishes loading draws
  const presets: CharacterPresets = characterPresets ?? {
    type: 'characterPresets',
    presets: [],
    assignments: {},
  };
  const owner =
    presets.assignments[OWNER_LOOK_KEY] ??
    (presets.presets.some((p) => p.id === OWNER_FALLBACK_PRESET)
      ? { preset: OWNER_FALLBACK_PRESET }
      : null);
  const looks = [TORI, owner].map((choice, i) =>
    choice
      ? lookByName(`lobby:${i}`, { ...presets, assignments: { [`lobby:${i}`]: choice } })
      : null,
  );
  const desk = SPOTS[art].desk;
  // One world scale for both (device px per world px), a multiple of every density on show,
  // so each sprite is drawn at a whole number of device px per sprite px and both stand the
  // same size.
  const densities = looks.map((l) => (l ? getCharacterSprites(l.palette, l.hueShift).density : 1));
  const most = Math.max(1, ...densities);
  const dpr = window.devicePixelRatio || 1;
  const k = most * Math.max(1, Math.round((LOBBY_ART.castArtPxPerWorld * s * dpr) / most));
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (reducedMotion()) return;
    const id = setInterval(
      () => setFrame((f) => f + 1),
      desk.seated ? LOBBY_ART.typeFrameMs : LOBBY_ART.idleFrameMs,
    );
    return () => clearInterval(id);
  }, [desk.seated]);
  return (
    <>
      {looks.map(
        (look, i) =>
          look && (
            <Figure
              key={i}
              look={look}
              x={desk.xs[i]}
              feetY={desk.feetY}
              seated={desk.seated}
              s={s}
              k={k}
              frame={frame}
              testId={i === 0 ? 'lobby-tori' : 'lobby-owner'}
            />
          ),
      )}
    </>
  );
}

/** One figure: the sprite at k / density device px per sprite px (a whole number), its feet at
 *  picture px (x, feetY); seated, only the rows above the counter. Placed in whole device px. */
function Figure(p: {
  look: { palette: number; hueShift: number };
  x: number;
  feetY: number;
  seated: boolean;
  s: number;
  /** Device px per world px (a multiple of the density). */
  k: number;
  frame: number;
  testId: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const sprites = getCharacterSprites(p.look.palette, p.look.hueShift);
  const d = sprites.density;
  const frames = p.seated ? sprites.typing[Direction.DOWN] : sprites.reading[Direction.DOWN];
  const sprite = frames[p.frame % frames.length];
  const dpr = window.devicePixelRatio || 1;
  const n = Math.max(1, Math.round(p.k / d));
  const rows = p.seated ? LOBBY_ART.seatedRows * d : sprite.length;
  const wDev = sprite[0].length * n;
  const hDev = rows * n;
  // The canvas a whole number of layout units big (the figure in its bottom-left corner), or
  // the browser resamples it by a hair (dpr 3: 128 px is 42.67 CSS px).
  const wBox = exactDevicePx(wDev, dpr);
  const hBox = exactDevicePx(hDev, dpr);
  const snap = (v: number) => snapExact(v, dpr);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = wBox;
    c.height = hBox;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, wBox, hBox);
    ctx.drawImage(getCachedSprite(sprite, n), 0, hBox - hDev);
  }, [sprite, n, wBox, hBox, hDev]);
  return (
    <canvas
      ref={ref}
      className="cld-lobby-cast"
      data-testid={p.testId}
      data-scale={n}
      style={{
        left: snap(p.x * p.s - wDev / dpr / 2),
        top: snap(p.feetY * p.s - hBox / dpr),
        width: wBox / dpr,
        height: hBox / dpr,
      }}
    />
  );
}
