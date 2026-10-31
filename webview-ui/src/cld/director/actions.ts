/**
 * C1: the moments the director plays (director.ts), each a small swappable class:
 *
 * - CoffeeBreak: walks to the nearest coffee machine on its floor, the machine plays, the drink
 *   (the lounge's seven steps, lounge.ts), a "휴식 +1" pop, back to its desk; with no machine on
 *   the floor, the drink at the mouth (rest.ts) under a cup bubble, then the pop.
 * - Rebirth A (light pillar), B (star orbit and nova), C (fireworks): 3-3.5 s bursts over the
 *   character with the big title, each with its own jingle (sounds.ts).
 * - Still: prefers-reduced-motion's badge (no motion, the office keeps its idle rate).
 *
 * Every picture is drawn in code with square world pixels (Pen), so it reads as pixel art at any
 * zoom, in the top-down and the isometric office alike. All shapes and words are our own.
 */
import {
  FX_COFFEE_MAX_SEC,
  FX_COLORS,
  FX_PLATE_CLEAR_PX,
  FX_PLUS_RISE_PX,
  FX_PLUS_SEC,
  FX_REBIRTH_SEC,
  FX_SPARK_COLORS,
  FX_STILL_SEC,
  FX_SUB_PX_PER_ZOOM,
  FX_TEXT_OUTLINE_PX,
  FX_TITLE_PX_PER_ZOOM,
  LOUNGE_FIGURE_PX,
  PIXEL_FONT_CRISP_STEP_PX,
  PIXEL_FONT_FAMILY,
  REST_ANIM_SEC,
  STATUS_DETAILS_RISE_PX,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import type { Character } from '../../office/types.js';
import { endBreak, type PantryKind, type Rest, startBreak } from '../lounge.js';
import { restWatch } from '../rest.js';
import { THEME } from '../theme.js';
import {
  director,
  type FxAction,
  type FxKind,
  type FxRequest,
  type FxSpot,
  type FxWorld,
} from './director.js';
import { playFxSound } from './sounds.js';

type Layer = 'back' | 'front';
type RebirthKind = Exclude<FxKind, 'coffee'>;

// ── Drawing in world pixels ──────────────────────────────────

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeOut = (v: number) => 1 - (1 - clamp01(v)) ** 3;
/** A stable pseudo-random 0..1 per particle index (the same picture on every frame). */
const rnd = (i: number) => {
  const s = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
};
/** Fades in over `fadeIn` s from `from`, out over `fadeOut` s before `to`. */
function window01(t: number, from: number, to: number, fadeIn = 0.15, fadeOut = 0.35): number {
  if (t < from || t > to) return 0;
  return Math.min(clamp01((t - from) / fadeIn), clamp01((to - t) / fadeOut));
}

/** Pixel rectangles relative to the feet, in world px snapped to the grid. */
class Pen {
  readonly ctx: CanvasRenderingContext2D;
  readonly at: FxSpot;
  /** World y just above the character's nameplate (a DOM box over the canvas, a fixed CSS
   *  size): words and bubbles go above it, never under it. */
  readonly top: number;
  constructor(ctx: CanvasRenderingContext2D, at: FxSpot) {
    this.ctx = ctx;
    this.at = at;
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1;
    // the plate's bottom: STATUS_DETAILS_RISE_PX over the feet (a figure taller than the classic
    // one lifts it as much), the higher of its two places (CharacterLabel.tsx)
    const plate = STATUS_DETAILS_RISE_PX + Math.max(0, at.h - LOUNGE_FIGURE_PX);
    this.top = -Math.max(at.h, plate) - (FX_PLATE_CLEAR_PX * dpr) / at.zoom;
  }

  rect(x: number, y: number, w: number, h: number, color: string, alpha = 1): void {
    if (alpha <= 0) return;
    const z = this.at.zoom;
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(
      this.at.x + Math.round(x) * z,
      this.at.y + Math.round(y) * z,
      Math.max(1, Math.round(w)) * z,
      Math.max(1, Math.round(h)) * z,
    );
  }

  /** A four-point twinkle of arm length `r` with a white heart. */
  star(x: number, y: number, r: number, color: string, alpha = 1): void {
    this.rect(x - r, y, 2 * r + 1, 1, color, alpha);
    this.rect(x, y - r, 1, 2 * r + 1, color, alpha);
    this.rect(x, y, 1, 1, FX_COLORS.white, alpha);
  }

  /** A flat ring on the floor (an ellipse of single pixels). */
  ring(rx: number, ry: number, color: string, alpha: number, cy = 0, dots = 28, spin = 0): void {
    for (let i = 0; i < dots; i++) {
      const a = spin + (i / dots) * Math.PI * 2;
      this.rect(Math.cos(a) * rx, cy + Math.sin(a) * ry, 1, 1, color, alpha);
    }
  }

  /** Text centred at (x, y) world px: `size` device px, an outline (or a hard drop) in `edge`. */
  text(
    str: string,
    x: number,
    y: number,
    size: number,
    fill: string,
    edge: string,
    alpha: number,
    drop = false,
  ): void {
    if (alpha <= 0) return;
    const { ctx, at } = this;
    const cx = Math.round(at.x + x * at.zoom);
    const cy = Math.round(at.y + y * at.zoom);
    const o = FX_TEXT_OUTLINE_PX;
    ctx.globalAlpha = alpha;
    ctx.font = `${size}px ${PIXEL_FONT_FAMILY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = edge;
    const offsets = drop
      ? [
          [o, o],
          [2 * o, 2 * o],
        ]
      : [
          [-o, 0],
          [o, 0],
          [0, -o],
          [0, o],
          [-o, -o],
          [o, -o],
          [-o, o],
          [o, o],
        ];
    for (const [dx, dy] of offsets) ctx.fillText(str, cx + dx, cy + dy);
    ctx.fillStyle = fill;
    ctx.fillText(str, cx, cy);
  }
}

/** A pixel-font size for this zoom: whole crisp steps, at least two (the title must read). */
const fontPx = (zoom: number, perZoom: number, min: number) =>
  Math.max(min, Math.round((zoom * perZoom) / PIXEL_FONT_CRISP_STEP_PX)) * PIXEL_FONT_CRISP_STEP_PX;

function withPen(ctx: CanvasRenderingContext2D, at: FxSpot, fn: (p: Pen) => void): void {
  ctx.save();
  try {
    fn(new Pen(ctx, at));
  } finally {
    ctx.restore();
  }
}

/** The title and its line under it, `alpha` and a vertical offset given by the variant. */
function drawTitle(
  p: Pen,
  count: number | undefined,
  y: number,
  alpha: number,
  fill: string,
  edge: string,
  subAlpha: number,
  drop = false,
): void {
  const z = p.at.zoom;
  const big = fontPx(z, FX_TITLE_PX_PER_ZOOM, 2);
  p.text(t('fx.rebirth.title'), 0, y, big, fill, edge, alpha, drop);
  if (count !== undefined && count > 0)
    p.text(
      t('fx.rebirth.sub', { count }),
      0,
      y + (big * 0.75) / z,
      fontPx(z, FX_SUB_PX_PER_ZOOM, 1),
      FX_COLORS.white,
      FX_COLORS.ink,
      Math.min(alpha, subAlpha),
    );
}

// ── Rebirth ──────────────────────────────────────────────────

abstract class Rebirth implements FxAction {
  readonly moving = true;
  protected t = 0;
  private started = false;

  protected readonly kind: RebirthKind;
  protected readonly count: number | undefined;
  constructor(kind: RebirthKind, count: number | undefined) {
    this.kind = kind;
    this.count = count;
  }

  step(dt: number): boolean {
    if (!this.started) {
      this.started = true;
      playFxSound(this.kind);
    }
    this.t += dt;
    return this.t < FX_REBIRTH_SEC[this.kind];
  }

  skip(): void {}

  draw(layer: Layer, ctx: CanvasRenderingContext2D, at: FxSpot): void {
    withPen(ctx, at, (p) => this.paint(layer, p, this.t, at.h));
  }

  protected abstract paint(layer: Layer, p: Pen, t: number, h: number): void;
}

/** A: a pillar of light from the floor to the top of the screen, a burst, rising twinkles, a gold title. */
class RebirthA extends Rebirth {
  protected paint(layer: Layer, p: Pen, t: number, h: number): void {
    const end = FX_REBIRTH_SEC.rebirthA;
    const top = -p.at.y / p.at.zoom - 2;
    const width = 18 * easeOut((t - 0.15) / 0.3) * (1 - easeOut((t - 2.2) / 0.6));
    if (layer === 'back') {
      // the floor glyph: two rings, the outer one spreading
      const ringA = window01(t, 0, end - 0.2, 0.1, 0.5);
      const r = 5 + 14 * easeOut(t / 0.5);
      p.ring(r, r * 0.4, FX_COLORS.gold, ringA, 0, 32, t * 0.6);
      p.ring(r * 0.6, r * 0.24, FX_COLORS.white, ringA * 0.8, 0, 20, -t * 1.2);
      if (width >= 1) {
        p.rect(-width / 2, top, width, -top, FX_COLORS.paleGold);
        p.rect(-width / 4, top, width / 2, -top, FX_COLORS.core, 0.8);
        // bright bands that climb the pillar
        for (let k = 0; k < 6; k++) {
          const y = -(((t * 70 + k * 22) % 130) + 2);
          p.rect(-width / 2, y, width, 1, FX_COLORS.white, 0.6);
        }
      }
      return;
    }
    // the character stands inside the light
    if (width >= 1) p.rect(-width / 4, -h - 2, width / 2, h + 2, FX_COLORS.core, 0.3);
    // the burst from the chest
    const burst = t - 0.45;
    if (burst > 0 && burst < 1)
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const d = 34 * easeOut(burst / 0.8);
        const c = i % 2 ? FX_COLORS.gold : FX_COLORS.white;
        p.rect(Math.cos(a) * d - 1, -h * 0.55 + Math.sin(a) * d * 0.7 - 1, 2, 2, c, 1 - burst);
      }
    // twinkles rising in the pillar
    for (let i = 0; i < 12; i++) {
      const born = 0.4 + rnd(i) * 1.6;
      const age = t - born;
      if (age < 0 || age > 1.2) continue;
      const x = (rnd(i + 50) - 0.5) * 22;
      const y = -age * (30 + rnd(i + 90) * 25);
      const r = Math.floor((t * 10 + i) % 2) + 1;
      p.star(x, y - 4, r, i % 3 ? FX_COLORS.gold : FX_COLORS.white, 1 - age / 1.2);
    }
    const drop = easeOut((t - 0.6) / 0.25);
    const bounce = Math.sin(clamp01((t - 0.85) / 0.2) * Math.PI) * 2;
    drawTitle(
      p,
      this.count,
      p.top - 38 + 16 * drop - bounce,
      window01(t, 0.6, end, 0.1, 0.4),
      FX_COLORS.gold,
      FX_COLORS.ink,
      window01(t, 0.9, end, 0.15, 0.4),
    );
  }
}

/** B: six stars orbit and rise to the head, a nova of rays, glitter falls, a cyan stamped title. */
class RebirthB extends Rebirth {
  protected paint(layer: Layer, p: Pen, t: number, h: number): void {
    const end = FX_REBIRTH_SEC.rebirthB;
    const nova = 1.4;
    if (t < nova) {
      const k = t / nova;
      const rx = 18 * (1 - 0.65 * k);
      const cy = -2 - (h - 4) * k;
      for (let i = 0; i < 6; i++) {
        for (let trail = 3; trail >= 0; trail--) {
          const a = (t - trail * 0.04) * Math.PI * 2 * 1.3 + (i / 6) * Math.PI * 2;
          if (Math.sin(a) < 0 !== (layer === 'back')) continue;
          const c = i % 2 ? FX_COLORS.cyan : FX_COLORS.magenta;
          const x = Math.cos(a) * rx;
          const y = cy + Math.sin(a) * rx * 0.35;
          if (trail === 0) p.star(x, y, 2, c);
          else p.rect(x, y, 1, 1, c, 0.7 - trail * 0.2);
        }
      }
      // a diamond on the floor that steps round
      if (layer === 'back') {
        const s = 8 + 4 * k;
        const step = Math.floor(t * 8) % 2;
        for (let i = -s; i <= s; i++) {
          const dy = (s - Math.abs(i)) * 0.4;
          p.rect(i, dy, 1, 1, step ? FX_COLORS.violet : FX_COLORS.magenta, 0.8);
          p.rect(i, -dy, 1, 1, step ? FX_COLORS.violet : FX_COLORS.magenta, 0.8);
        }
      }
      return;
    }
    if (layer === 'back') return;
    const n = t - nova;
    const head = -h + 4;
    // the nova: a white diamond flash and long rays
    if (n < 0.6) {
      const s = 4 + 36 * easeOut(n / 0.4);
      const a = 1 - n / 0.6;
      // row by row: one pixel wide at the tips, widest across the head
      for (let r = -s; r <= s; r += 1) {
        const half = s - Math.abs(r);
        p.rect(-half, head + r, 2 * half + 1, 1, FX_COLORS.flash, a * 0.3);
      }
      for (let i = 0; i < 12; i++) {
        const ang = (i / 12) * Math.PI * 2 + Math.PI / 12;
        const c = i % 2 ? FX_COLORS.cyan : FX_COLORS.magenta;
        for (let d = 6 + 50 * easeOut(n / 0.5) * 0.4; d < 6 + 50 * easeOut(n / 0.5); d += 2)
          p.rect(Math.cos(ang) * d, head + Math.sin(ang) * d, 2, 2, c, a);
      }
    }
    // glitter falling around the character
    for (let i = 0; i < 18; i++) {
      const age = n - rnd(i + 7) * 0.8;
      if (age < 0) continue;
      const x = (rnd(i + 30) - 0.5) * 44 + Math.sin(age * 6 + i) * 2;
      const y = head - 30 + age * (18 + rnd(i) * 14);
      if (y > 2) continue;
      const c = [FX_COLORS.cyan, FX_COLORS.violet, FX_COLORS.white][i % 3];
      p.rect(x, y, 1, 1 + (Math.floor(age * 8 + i) % 2), c, window01(t, nova, end, 0.05, 0.5));
    }
    const fall = easeOut((t - nova - 0.05) / 0.25);
    const settle = Math.sin(clamp01((t - nova - 0.3) / 0.15) * Math.PI) * 3;
    drawTitle(
      p,
      this.count,
      p.top - 68 + 46 * fall + settle,
      window01(t, nova + 0.05, end, 0.05, 0.4),
      FX_COLORS.cyan,
      FX_COLORS.magenta,
      window01(t, nova + 0.4, end, 0.15, 0.4),
      true,
    );
  }
}

/** C: pixel blocks gather into a cocoon, three rockets burst into colour, confetti, a rainbow title. */
class RebirthC extends Rebirth {
  private static readonly ROCKETS = [
    { at: 0, x: -24, up: 30, c: 0 },
    { at: 0.35, x: 24, up: 40, c: 1 },
    { at: 0.7, x: 0, up: 54, c: 2 },
  ] as const;

  protected paint(layer: Layer, p: Pen, t: number, h: number): void {
    const end = FX_REBIRTH_SEC.rebirthC;
    if (layer === 'back') {
      // a stepping square rune under the feet
      const a = window01(t, 0, end - 0.3, 0.2, 0.5);
      const s = 10;
      const turn = Math.floor(t * 6) % 2;
      for (let i = -s; i <= s; i += 2) {
        const c = turn ? FX_COLORS.violet : FX_COLORS.gold;
        p.rect(i, -s * 0.4, 1, 1, c, a);
        p.rect(i, s * 0.4, 1, 1, c, a);
        p.rect(-s, i * 0.4, 1, 1, c, a);
        p.rect(s, i * 0.4, 1, 1, c, a);
      }
      p.ring(s * 1.2, s * 0.5, turn ? FX_COLORS.gold : FX_COLORS.violet, a * 0.7, 0, 16, t);
      return;
    }
    // blocks spiral in
    if (t < 0.9)
      for (let i = 0; i < 18; i++) {
        const k = easeOut(t / 0.8);
        const ang = (i / 18) * Math.PI * 2 + k * 3;
        const r = 34 * (1 - k) + 2;
        const c = FX_SPARK_COLORS[i % FX_SPARK_COLORS.length];
        p.rect(Math.cos(ang) * r - 1, -h / 2 + Math.sin(ang) * r * 0.8 - 1, 2, 2, c, 1);
      }
    // the cocoon: a blinking frame, then a white fill that fades
    if (t >= 0.7 && t < 1.3) {
      const blink = Math.floor(t * 20) % 2 === 0;
      const w = 18;
      if (t < 1 && blink) {
        p.rect(-w / 2, -h - 3, w, 1, FX_COLORS.white);
        p.rect(-w / 2, 1, w, 1, FX_COLORS.white);
        p.rect(-w / 2, -h - 3, 1, h + 5, FX_COLORS.white);
        p.rect(w / 2 - 1, -h - 3, 1, h + 5, FX_COLORS.white);
      }
      if (t >= 0.95) p.rect(-w / 2, -h - 3, w, h + 5, FX_COLORS.flash, (1.3 - t) / 0.35);
    }
    // rockets and their bursts
    for (const r of RebirthC.ROCKETS) {
      const age = t - r.at;
      const color = FX_SPARK_COLORS[r.c];
      if (age < 0) continue;
      const peakY = -h - r.up;
      if (age < 0.5) {
        const y = peakY * easeOut(age / 0.5);
        p.rect(r.x, y, 1, 2, FX_COLORS.white);
        for (let k = 1; k < 4; k++) p.rect(r.x, y + k * 2, 1, 1, color, 1 - k * 0.3);
        continue;
      }
      const b = age - 0.5;
      if (b > 1.4) continue;
      // two rings: coloured and wide, white and tight, each spark with a short tail
      for (let i = 0; i < 28; i++) {
        const ang = (i / 28) * Math.PI * 2 + r.c;
        const inner = i % 2 === 0;
        const d = (inner ? 20 : 40) * easeOut(b / 0.7);
        const fall = 14 * b * b;
        const x = r.x + Math.cos(ang) * d;
        const y = peakY + Math.sin(ang) * d + fall;
        const c = inner ? FX_COLORS.white : color;
        const a = 1 - b / 1.4;
        const size = b < 0.7 ? 2 : 1;
        p.rect(x, y, size, size, c, a);
        p.rect(x - Math.cos(ang) * 3, y - Math.sin(ang) * 3, 1, 1, c, a * 0.5);
      }
      // the flash where it bursts
      if (b < 0.12) p.star(r.x, peakY, 4, FX_COLORS.white);
    }
    // confetti
    for (let i = 0; i < 34; i++) {
      const age = t - 1.4 - rnd(i + 11) * 0.6;
      if (age < 0) continue;
      const x = (rnd(i + 3) - 0.5) * 56 + Math.sin(age * 5 + i) * 3;
      const y = -h - 40 + age * (20 + rnd(i + 17) * 12);
      if (y > 2) continue;
      const flip = Math.floor(age * 10 + i) % 2;
      p.rect(
        x,
        y,
        flip ? 3 : 2,
        flip ? 2 : 3,
        FX_SPARK_COLORS[i % FX_SPARK_COLORS.length],
        window01(t, 1.4, end, 0.05, 0.4),
      );
    }
    const rise = easeOut((t - 1.5) / 0.35);
    const hue = FX_SPARK_COLORS[Math.floor(t / 0.08) % (FX_SPARK_COLORS.length - 1)];
    drawTitle(
      p,
      this.count,
      p.top - 6 - 16 * rise,
      window01(t, 1.5, end, 0.1, 0.4),
      hue,
      FX_COLORS.ink,
      window01(t, 1.8, end, 0.15, 0.4),
    );
  }
}

// ── Coffee break ─────────────────────────────────────────────

/** A cup in a speech bubble over the head (drawn, no sprite sheet). */
function cupBubble(p: Pen, alpha: number, steam: number, y = p.top - 12): void {
  p.rect(-6, y, 13, 10, FX_COLORS.ink, alpha);
  p.rect(-5, y + 1, 11, 8, FX_COLORS.bubble, alpha);
  p.rect(-1, y + 10, 3, 1, FX_COLORS.ink, alpha);
  p.rect(0, y + 11, 1, 1, FX_COLORS.ink, alpha);
  // the cup, its coffee and handle
  p.rect(-3, y + 3, 5, 5, FX_COLORS.ink, alpha);
  p.rect(-2, y + 4, 3, 3, FX_COLORS.cup, alpha);
  p.rect(-2, y + 4, 3, 1, FX_COLORS.coffee, alpha);
  p.rect(2, y + 4, 2, 1, FX_COLORS.ink, alpha);
  p.rect(3, y + 5, 1, 1, FX_COLORS.ink, alpha);
  p.rect(2, y + 6, 2, 1, FX_COLORS.ink, alpha);
  // steam that steps
  p.rect(-1 + steam, y + 1, 1, 1, FX_COLORS.steam, alpha);
  p.rect(-steam, y + 2, 1, 1, FX_COLORS.steam, alpha);
}

/** "휴식 +1", rising and fading `age` s after the drink. */
function plusPop(p: Pen, age: number): void {
  if (age < 0 || age > FX_PLUS_SEC) return;
  const k = age / FX_PLUS_SEC;
  p.text(
    t('fx.coffee.plus'),
    0,
    p.top - 4 - FX_PLUS_RISE_PX * easeOut(k),
    fontPx(p.at.zoom, FX_SUB_PX_PER_ZOOM, 1),
    FX_COLORS.green,
    FX_COLORS.ink,
    1 - clamp01((k - 0.6) / 0.4),
  );
}

/** The machine the theme's drink comes from. */
const MACHINE: Record<'coffee' | 'energy', PantryKind> = { coffee: 'coffee', energy: 'vending' };

class CoffeeBreak implements FxAction {
  readonly moving = true;
  private t = 0;
  private started = false;
  private rest: Rest | null = null;
  private lastPhase: Rest['phase'] | null = null;
  private plusAt: number | null = null;
  private ended = false;

  step(dt: number, world: FxWorld, ch: Character): boolean {
    const os = world as OfficeState;
    if (!this.started) {
      this.started = true;
      this.rest = startBreak(os, ch, MACHINE[THEME.rest.prop]);
      if (!this.rest) restWatch.sip(ch.id, performance.now());
    }
    this.t += dt;
    const r = this.rest;
    if (!r) {
      if (this.plusAt === null && this.t >= REST_ANIM_SEC) this.pop();
    } else if (!this.ended) {
      const phase = ch.cldRest === r ? r.phase : null;
      if (this.lastPhase === 'drink' && phase !== 'drink') this.pop();
      this.lastPhase = phase;
      // home again (or someone else's rest now, or too long): the FSM has it back
      if (phase === null || phase === 'rest' || this.t > FX_COFFEE_MAX_SEC) {
        endBreak(os, ch, r);
        this.ended = true;
      }
    }
    const popping = this.plusAt !== null && this.t - this.plusAt < FX_PLUS_SEC;
    return (r ? !this.ended : this.plusAt === null) || popping;
  }

  private pop(): void {
    this.plusAt = this.t;
    playFxSound('coffee');
  }

  skip(world: FxWorld, ch: Character): void {
    if (this.rest && !this.ended) endBreak(world as OfficeState, ch, this.rest);
    this.ended = true;
  }

  draw(layer: Layer, ctx: CanvasRenderingContext2D, at: FxSpot): void {
    if (layer === 'back') return;
    withPen(ctx, at, (p) => {
      const steam = Math.floor(this.t * 3) % 2;
      const inPlace = this.started && !this.rest && this.t < REST_ANIM_SEC;
      const fetching = this.rest && !this.ended && this.lastPhase === 'fetch';
      if (inPlace || fetching) cupBubble(p, 1, steam);
      if (this.plusAt !== null) plusPop(p, this.t - this.plusAt);
    });
  }
}

// ── Reduced motion ───────────────────────────────────────────

/** prefers-reduced-motion: the moment's meaning as one still picture, for FX_STILL_SEC. */
class Still implements FxAction {
  readonly moving = false;
  private t = 0;
  private started = false;

  private readonly req: FxRequest;
  constructor(req: FxRequest) {
    this.req = req;
  }

  step(dt: number): boolean {
    if (!this.started) {
      this.started = true;
      playFxSound(this.req.kind);
    }
    this.t += dt;
    return this.t < FX_STILL_SEC;
  }

  skip(): void {}

  draw(layer: Layer, ctx: CanvasRenderingContext2D, at: FxSpot): void {
    if (layer === 'back') return;
    withPen(ctx, at, (p) => {
      if (this.req.kind === 'coffee') {
        cupBubble(p, 1, 0);
        p.text(
          t('fx.coffee.plus'),
          0,
          p.top - 20,
          fontPx(at.zoom, FX_SUB_PX_PER_ZOOM, 1),
          FX_COLORS.green,
          FX_COLORS.ink,
          1,
        );
        return;
      }
      p.star(-32, p.top - 22, 2, FX_COLORS.gold);
      p.star(32, p.top - 22, 2, FX_COLORS.gold);
      drawTitle(p, this.req.count, p.top - 22, 1, FX_COLORS.gold, FX_COLORS.ink, 1);
    });
  }
}

// ── The factory ──────────────────────────────────────────────

const REBIRTHS = { rebirthA: RebirthA, rebirthB: RebirthB, rebirthC: RebirthC } as const;

export function makeAction(req: FxRequest, reduced: boolean): FxAction {
  if (reduced) return new Still(req);
  if (req.kind === 'coffee') return new CoffeeBreak();
  return new REBIRTHS[req.kind](req.kind, req.count);
}

director.use(makeAction);
export { director };
