/**
 * T-0026 canvas layers, called from the office renderer: a status ring under
 * each character, its activity prop beside it, a slightly dimmer sprite while
 * it idles, the 🤝 speech link to its sub-agents, and the tired look (sweat
 * drops, a yawn now and then, a slower walk). All in world space, so they move
 * with the camera and stay pixel-perfect at every zoom.
 */
import {
  ACTIVITY_IDLE_DIM,
  ACTIVITY_LINK_DOT_COLOR,
  ACTIVITY_LINK_DOT_SPACING,
  ACTIVITY_LINK_MARCH_SEC,
  ACTIVITY_LINK_SHADOW_COLOR,
  ACTIVITY_PROP_FRAME_SEC,
  ACTIVITY_RING_BLINK_DIM_ALPHA,
  ACTIVITY_RING_BLINK_SEC,
  ACTIVITY_RING_COLORS,
  BUBBLE_VERTICAL_OFFSET_PX,
  CHARACTER_SITTING_OFFSET_PX,
  FATIGUE_YAWN_EVERY_SEC,
  FATIGUE_YAWN_SEC,
  NOTICE_PULSE_COLOR,
  NOTICE_PULSE_PERIOD_MS,
  PIXEL_FONT_FAMILY,
  STATUS_ICON_BLINK_DIM_ALPHA,
  STATUS_ICON_BOX_BG,
  STATUS_ICON_BOX_BORDER,
  STATUS_ICON_BOX_PX,
  STATUS_ICON_EMOJI_PX,
  STATUS_ICON_FRAME_SEC,
  STATUS_ICON_OFFSET_X,
  STATUS_ICON_RISE_PX,
  THINKING_DOT_FRAME_SEC,
} from '../../constants.js';
import { adjustSprite } from '../../office/colorize.js';
import { copyFor, deriveSmooth } from '../../office/sprites/smoothSprite.js';
import { getCachedSprite } from '../../office/sprites/spriteCache.js';
import { BUBBLE_THINKING_SPRITES, characterLift } from '../../office/sprites/spriteData.js';
import type { Character, SpriteData } from '../../office/types.js';
import { CharacterState, Direction } from '../../office/types.js';
import { isE2E } from '../../runtime.js';
import { FRAME_H as CHAR_H, FRAME_W as CHAR_W } from '../characters/compose.js';
import { noticePulse } from '../notify/notices.js';
import { REST_SPRITES, restFrame, restWatch, sipAnchorOf } from '../rest.js';
import { sameFloor, tempLeaving } from '../staff.js';
import { THEME } from '../theme.js';
import propData from './props.json';
import {
  characterVisualOf,
  type PropId,
  type RingState,
  type StatusIcon,
  statusIcon,
} from './visuals.js';

const palette: Record<string, string> = propData.palette;
const toSprite = (rows: string[]): SpriteData =>
  rows.map((row) => [...row].map((key) => (key === '.' ? '' : palette[key])));

type Sprites = { at: [number, number]; frames: SpriteData[] };
const resolve = (sheet: Record<string, { at: number[]; frames: string[][] }>) =>
  Object.fromEntries(
    Object.entries(sheet).map(([id, s]) => [
      id,
      { at: s.at as [number, number], frames: s.frames.map(toSprite) },
    ]),
  );

/** Prop sprites: `at` is the top-left corner from the feet anchor, in world px. */
export const PROP_SPRITES = resolve(propData.props) as Record<PropId, Sprites>;
/** The tired look (and the rest bubble's zZ), placed the same way. */
export const EFFECT_SPRITES = resolve(propData.effects) as Record<'sweat' | 'yawn' | 'zz', Sprites>;
/** T-0036 head status icons (the working one is the activity emoji, drawn as text). */
export const ICON_SPRITES = Object.fromEntries(
  Object.entries(propData.icons).map(([id, s]) => [id, s.frames.map(toSprite)]),
) as Record<'zzz' | 'alert' | 'lock', SpriteData[]>;
/** The nameplate's lead icon, an orchestrator's (the rank icons are rankSprites.ts). */
export const LEAD_SPRITE = toSprite(propData.ranks.lead);

/** Seconds on the animation clock the canvas and the overlay (redrawn every
 *  frame on purpose) share, so a DOM icon steps with the canvas ones. */
export const animationClock = (): number => performance.now() / 1000;

/** Which thinking-bubble frame (its dot count) shows at time t: 0, 1, 2, 3, then round again. */
export const thinkingFrame = (t: number): number =>
  Math.floor(t / THINKING_DOT_FRAME_SEC) % BUBBLE_THINKING_SPRITES.length;

let motionQuery: MediaQueryList | null | undefined;
/** The user asked for less motion: the thinking bubble is not drawn, its text label says it (U-35). */
function reducedMotion(): boolean {
  if (motionQuery === undefined)
    motionQuery =
      typeof window === 'undefined'
        ? null
        : (window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null);
  return motionQuery?.matches === true;
}

/** A status icon's frame at time t: zzz grows, "!" bobs, the lock stays. */
export function statusIconFrame(icon: 'zzz' | 'alert' | 'lock', t: number): SpriteData {
  const frames = ICON_SPRITES[icon];
  return frames[Math.floor(t / STATUS_ICON_FRAME_SEC) % frames.length];
}

/** The lock blinks at the permission ring's pace; every other icon stays lit. */
export function statusIconAlpha(icon: StatusIcon, t: number): number {
  if (icon !== 'lock') return 1;
  const period = ACTIVITY_RING_BLINK_SEC.permission;
  return t % period < period / 2 ? 1 : STATUS_ICON_BLINK_DIM_ALPHA;
}

// A 16x8 ellipse centred under the feet: d = edge, o = rim, f = fill. Its back
// half goes behind the character, its front half in front of the seat.
const RING_MASK = [
  '....dddddddd....',
  '..ddoooooooodd..',
  '.dooffffffffood.',
  'doffffffffffffod',
  'doffffffffffffod',
  '.dooffffffffood.',
  '..ddoooooooodd..',
  '....dddddddd....',
];
/** World px from the ring's top row down to the feet anchor. */
const RING_RISE = 4;
/** Z-sort: the back arc just before the character (and its outline), the
 *  prop just after; the front arc after a back-facing seat too (its zY is one
 *  more than the row's), which upstream draws over a seated character. */
const RING_Z = 0.002;
const PROP_Z = 0.001;
const RING_FRONT_Z = 0.6;
/** Seconds of animation phase between characters, so props do not move in unison. */
export const PHASE_PER_ID = 0.37;
/** The link bubble's tail pixel, and how far above a sub-agent's feet the link ends. */
const LINK_TAIL = [4, 8] as const;
const SUB_HEAD_RISE = 22;

const ringSprites = new Map<
  RingState,
  { whole: SpriteData; back: SpriteData; front: SpriteData }
>();
function rings(state: RingState) {
  let sprites = ringSprites.get(state);
  if (!sprites) {
    const colour: Record<string, string> = { ...ACTIVITY_RING_COLORS[state], '.': '' };
    const key = { d: 'edge', o: 'rim', f: 'fill', '.': '.' } as const;
    const whole = RING_MASK.map((row) => [...row].map((k) => colour[key[k as keyof typeof key]]));
    const half = RING_MASK.length / 2;
    sprites = { whole, back: whole.slice(0, half), front: whole.slice(half) };
    ringSprites.set(state, sprites);
  }
  return sprites;
}
/** The whole ring of a state (the legend's swatch). */
export const ringSprite = (state: RingState): SpriteData => rings(state).whole;

/** Waiting blinks slowly, permission fast; the dim half never hides the ring. */
function ringAlpha(state: RingState, t: number): number {
  if (state !== 'waiting' && state !== 'permission') return 1;
  const period = ACTIVITY_RING_BLINK_SEC[state];
  return t % period < period / 2 ? 1 : ACTIVITY_RING_BLINK_DIM_ALPHA;
}

/** The prop's animation frame at time t (seconds). */
export function propFrame(prop: PropId, t: number): SpriteData {
  const { frames } = PROP_SPRITES[prop];
  return frames[Math.floor(t / ACTIVITY_PROP_FRAME_SEC) % frames.length];
}

/** The yawn's frame at time t, or null between yawns. */
export function yawnFrame(t: number): SpriteData | null {
  const into = t % FATIGUE_YAWN_EVERY_SEC;
  if (into >= FATIGUE_YAWN_SEC) return null;
  const { frames } = EFFECT_SPRITES.yawn;
  return frames[Math.min(frames.length - 1, Math.floor((into / FATIGUE_YAWN_SEC) * frames.length))];
}

const dimmed = new WeakMap<SpriteData, SpriteData>();
/** The character's sprite, slightly dimmer while it idles. */
export function cldCharacterSprite(id: number, sprite: SpriteData): SpriteData {
  return characterVisualOf(id)?.ring === 'idle' ? dimmedSprite(sprite) : sprite;
}

/** `sprite` as an idle character draws it (cached; the warm queue builds both). */
export function dimmedSprite(sprite: SpriteData): SpriteData {
  let dim = dimmed.get(sprite);
  if (!dim) {
    dim = copyFor(sprite) ?? adjustSprite(sprite, ACTIVITY_IDLE_DIM);
    deriveSmooth(sprite, dim, { adjust: ACTIVITY_IDLE_DIM });
    dimmed.set(sprite, dim);
  }
  return dim;
}

interface Drawable {
  zY: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

function drawAt(img: HTMLCanvasElement, x: number, y: number, alpha: number) {
  return (ctx: CanvasRenderingContext2D) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.drawImage(img, x, y);
    ctx.restore();
  };
}

/**
 * The ring and prop of one character, for the renderer's z-sorted pass.
 * `feetX`/`feetY` is the bottom centre of the character's own drawn sprite
 * (integer device px), so ring, body and prop move as one.
 */
export function cldCharacterDrawables(
  ch: Character,
  feetX: number,
  feetY: number,
  zoom: number,
  zY: number,
  alpha: number,
): Drawable[] {
  if (ch.matrixEffect) return [];
  const pulsed = pulseDrawable(ch.id, feetX, feetY, zoom, zY);
  // REST-ANIM: the theme's drink at the mouth while a live 휴식 plays (a Map lookup otherwise)
  const resting = restWatch.progress(ch.id, performance.now());
  if (resting !== null) {
    const sprite = restFrame(THEME.rest.prop, resting);
    const [sx, sy] = sipAnchorOf(ch.palette);
    const dx = REST_SPRITES[THEME.rest.prop].at[0];
    // facing left the sheet is mirrored: the drink goes on the other side of the mouth
    const left = ch.dir === Direction.LEFT ? CHAR_W - sx - dx - sprite[0].length : sx + dx;
    pulsed.push({
      zY: zY + PROP_Z,
      draw: drawAt(
        getCachedSprite(sprite, zoom),
        feetX + (left - CHAR_W / 2) * zoom,
        feetY + (sy - CHAR_H + REST_SPRITES[THEME.rest.prop].at[1]) * zoom,
        alpha,
      ),
    });
  }
  const visual = characterVisualOf(ch.id);
  if (!visual) return pulsed;
  const t = animationClock();
  const { back, front } = rings(visual.ring);
  const ringA = alpha * ringAlpha(visual.ring, t);
  const backImg = getCachedSprite(back, zoom);
  const ringX = feetX - backImg.width / 2;
  const ringY = feetY - RING_RISE * zoom;
  const out: Drawable[] = [
    ...pulsed,
    { zY: zY - RING_Z, draw: drawAt(backImg, ringX, ringY, ringA) },
    {
      zY: zY + RING_FRONT_Z,
      draw: drawAt(getCachedSprite(front, zoom), ringX, ringY + backImg.height, ringA),
    },
  ];
  // Each character's animations run on its own phase.
  const own = t + Math.abs(ch.id) * PHASE_PER_ID;
  const add = (sprite: SpriteData, at: [number, number]) =>
    out.push({
      zY: zY + PROP_Z,
      draw: drawAt(
        getCachedSprite(sprite, zoom),
        feetX + at[0] * zoom,
        feetY + at[1] * zoom,
        alpha,
      ),
    });
  if (visual.prop && resting === null)
    add(propFrame(visual.prop, own), PROP_SPRITES[visual.prop].at);
  // SHEET-IMPORT: over the head of a taller figure, higher by what it stands over a classic one
  const lift = characterLift(ch.palette, ch.hueShift);
  if (visual.thinkingDots && !reducedMotion()) {
    const frame = BUBBLE_THINKING_SPRITES[thinkingFrame(t)];
    add(frame, [-Math.floor(frame[0].length / 2), -BUBBLE_VERTICAL_OFFSET_PX - lift]);
  }
  const { sweat, yawn } = EFFECT_SPRITES;
  if (visual.fatigue?.sweat) {
    add(sweat.frames[Math.floor(own / ACTIVITY_PROP_FRAME_SEC) % sweat.frames.length], [
      sweat.at[0],
      sweat.at[1] - lift,
    ]);
  }
  const yawning = visual.fatigue?.yawn ? yawnFrame(own) : null;
  if (yawning) add(yawning, [yawn.at[0], yawn.at[1] - lift]);
  const icon = visual.headIcon ? statusIcon(visual.ring) : null;
  if (icon) {
    out.push({
      zY: zY + ICON_Z,
      draw: drawStatusIcon(
        icon,
        visual.icon,
        feetX + STATUS_ICON_OFFSET_X * zoom,
        feetY - (STATUS_ICON_RISE_PX + lift) * zoom,
        zoom,
        alpha * statusIconAlpha(icon, t),
        own,
      ),
    });
  }
  return out;
}

/** T-0039 pulse: an outline ellipse around the feet, `step` px wider each frame. */
const PULSE_STEPS = 4;
const pulseSprites: SpriteData[] = [];
function pulseSprite(step: number): SpriteData {
  let sprite = pulseSprites[step];
  if (!sprite) {
    const a = 9 + step * 2; // half width, world px
    const b = Math.ceil(a / 2);
    const rows: SpriteData = Array.from({ length: 2 * b + 1 }, () =>
      new Array<string>(2 * a + 1).fill(''),
    );
    // Walk both axes so the steep ends have no gaps.
    for (let x = -a; x <= a; x++) {
      const y = Math.round(b * Math.sqrt(1 - (x / a) ** 2));
      rows[b + y][a + x] = rows[b - y][a + x] = NOTICE_PULSE_COLOR;
    }
    for (let y = -b; y <= b; y++) {
      const x = Math.round(a * Math.sqrt(1 - (y / b) ** 2));
      rows[b + y][a + x] = rows[b + y][a - x] = NOTICE_PULSE_COLOR;
    }
    sprite = pulseSprites[step] = rows;
  }
  return sprite;
}

/** The pulse of a character a notice is about (none when it is not pulsing). */
function pulseDrawable(id: number, feetX: number, feetY: number, zoom: number, zY: number) {
  const ms = noticePulse(id);
  if (ms === null) return [];
  const phase = (ms % NOTICE_PULSE_PERIOD_MS) / NOTICE_PULSE_PERIOD_MS;
  const img = getCachedSprite(pulseSprite(Math.floor(phase * PULSE_STEPS)), zoom);
  // Centred on the ring (RING_RISE above the feet, half its height): grows outwards.
  const cy = feetY - (RING_RISE - RING_MASK.length / 2) * zoom;
  return [
    {
      zY: zY + ICON_Z,
      draw: drawAt(img, feetX - img.width / 2, cy - img.height / 2, 1 - phase / 2),
    },
  ];
}

/** Head icons draw over every room's furniture and characters, like a label. */
const ICON_Z = 1e6;

/** T-0036: one status icon, its bottom centre at (cx, bottom) in device px, on the sprite grid. */
function drawStatusIcon(
  icon: StatusIcon,
  emoji: string,
  cx: number,
  bottom: number,
  zoom: number,
  alpha: number,
  t: number,
) {
  return (ctx: CanvasRenderingContext2D) => {
    ctx.save();
    ctx.globalAlpha = alpha;
    if (icon === 'activity') {
      const side = STATUS_ICON_BOX_PX * zoom;
      const x = cx - Math.floor(STATUS_ICON_BOX_PX / 2) * zoom;
      const y = bottom - side;
      ctx.fillStyle = STATUS_ICON_BOX_BORDER;
      ctx.fillRect(x, y, side, side);
      ctx.fillStyle = STATUS_ICON_BOX_BG;
      ctx.fillRect(x + zoom, y + zoom, side - 2 * zoom, side - 2 * zoom);
      ctx.font = `${STATUS_ICON_EMOJI_PX * zoom}px ${PIXEL_FONT_FAMILY}, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(emoji, x + side / 2, y + side / 2 + zoom / 2);
    } else {
      const sprite = statusIconFrame(icon, t);
      const img = getCachedSprite(sprite, zoom);
      ctx.drawImage(img, cx - Math.floor(sprite[0].length / 2) * zoom, bottom - img.height);
    }
    ctx.restore();
  };
}

/** U-26: a character that went home (퇴근), is off, or is a temp walking out keeps no dotted line, at either end (a lingering temp still has it). */
const quiet = (ch: Character): boolean =>
  ch.cldAway === true || characterVisualOf(ch.id)?.ring === 'off' || tempLeaving(ch.id);

/** E2E only: when each lead>sub link was last drawn (performance.now()). */
const drawnLinks: Record<string, number> = {};
if (isE2E) Reflect.set(window, '__cldLinks', drawnLinks);

/** 🤝: marching dots from the link bubble's tail to each of the character's sub-agents. */
export function cldDrawSpeechLinks(
  ctx: CanvasRenderingContext2D,
  characters: Character[],
  offsetX: number,
  offsetY: number,
  zoom: number,
): void {
  const sit = (ch: Character) =>
    ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0;
  const march =
    Math.floor(performance.now() / 1000 / ACTIVITY_LINK_MARCH_SEC) % ACTIVITY_LINK_DOT_SPACING;
  for (const lead of characters) {
    if (lead.matrixEffect || quiet(lead) || characterVisualOf(lead.id)?.prop !== 'link') continue;
    const { at } = PROP_SPRITES.link;
    const x0 = Math.round(lead.x) + at[0] + LINK_TAIL[0];
    const y0 = Math.round(lead.y + sit(lead)) + at[1] + LINK_TAIL[1];
    for (const sub of characters) {
      // On another floor it is not where the line would end (its rows are another floor's).
      if (
        !sub.isSubagent ||
        sub.parentAgentId !== lead.id ||
        sub.matrixEffect ||
        quiet(sub) ||
        !sameFloor(lead, sub)
      )
        continue;
      if (isE2E) drawnLinks[`${lead.id}>${sub.id}`] = performance.now();
      const x1 = Math.round(sub.x);
      const y1 = Math.round(sub.y + sit(sub)) - SUB_HEAD_RISE;
      const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
      for (let i = march + 2; i < steps - 4; i += ACTIVITY_LINK_DOT_SPACING) {
        const x = offsetX + Math.round(x0 + ((x1 - x0) * i) / steps) * zoom;
        const y = offsetY + Math.round(y0 + ((y1 - y0) * i) / steps) * zoom;
        ctx.fillStyle = ACTIVITY_LINK_SHADOW_COLOR;
        ctx.fillRect(x, y + zoom, zoom, zoom);
        ctx.fillStyle = ACTIVITY_LINK_DOT_COLOR;
        ctx.fillRect(x, y, zoom, zoom);
      }
    }
  }
}
