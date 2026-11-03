/**
 * C1: the moments the director plays (director.ts), each a small swappable class:
 *
 * - CoffeeBreak: walks to the nearest coffee machine on its floor, the machine plays, the drink
 *   (the lounge's seven steps, lounge.ts), a "휴식 +1" pop, back to its desk; with no machine on
 *   the floor, the drink at the mouth (rest.ts) under a cup bubble, then the pop.
 * - Level-up A (light pillar), B (star orbit and nova), C (fireworks): 3-3.5 s bursts over the
 *   character with "레벨 업!" and "Lv N", each with its own jingle (sounds.ts).
 * - Rebirth R1 (ascension), R2 (phoenix), R3 (constellation), C1-FX2: 6-6.5 s in phases (a
 *   gathering charge, the burst with a flash, a lingering aura, a title with its own entrance)
 *   over a dimmed screen, each with a longer jingle; a live 환생 picks one at random.
 * - Inherit (계승): the old self's pale ghost beside the heir hands it a spirit flame, ~5 s over a
 *   dimmed screen, its own jingle (INHERIT; it plays when an heir first shows up in the office).
 * - Still: prefers-reduced-motion's badge (no motion, the office keeps its idle rate).
 *
 * Every picture is drawn in code with square world pixels (Pen), so it reads as pixel art at any
 * zoom, in the top-down and the isometric office alike. All shapes and words are our own.
 */
import {
  FX_COFFEE_HOLD_MAX_SEC,
  FX_COFFEE_MAX_SEC,
  FX_COLORS,
  FX_DIM_ALPHA,
  FX_DIM_EDGE,
  FX_DIM_RX,
  FX_DIM_RY,
  FX_FLASH_ALPHA,
  FX_FLASH_SEC,
  FX_GRAND_SUB_PX_PER_ZOOM,
  FX_GRAND_TITLE_PX_PER_ZOOM,
  FX_INHERIT_BEATS,
  FX_INHERIT_DIM_WIDEN,
  FX_INHERIT_GHOST_ALPHA,
  FX_INHERIT_GHOST_DX,
  FX_INHERIT_GHOST_FILTER,
  FX_INHERIT_SEC,
  FX_LEVELUP_SEC,
  FX_PLATE_CLEAR_PX,
  FX_PLUS_RISE_PX,
  FX_PLUS_SEC,
  FX_REBIRTH_BURST_SEC,
  FX_REBIRTH_SEC,
  FX_SPARK_COLORS,
  FX_STILL_SEC,
  FX_SUB_PX_PER_ZOOM,
  FX_TEXT_OUTLINE_PX,
  FX_TITLE_PX_PER_ZOOM,
  LOUNGE_FIGURE_PX,
  OWNER_CHARACTER_ID,
  PIXEL_FONT_CRISP_STEP_PX,
  REST_ANIM_SEC,
  STATUS_DETAILS_RISE_PX,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import type { Character } from '../../office/types.js';
import { endBreak, type PantryKind, pantryNear, type Rest, startBreak } from '../lounge.js';
import { compactHolds, restWatch } from '../rest.js';
import { THEME } from '../theme.js';
import { pixelFontFamily } from '../uiFont.js';
import {
  director,
  type FxAction,
  type FxRequest,
  type FxSpot,
  type FxWorld,
  type InheritKind,
  type LevelUpKind,
  type RebirthKind,
} from './director.js';
import { playFxSound } from './sounds.js';

type Layer = 'back' | 'front';
type Title = 'fx.levelUp' | 'fx.rebirth' | 'inherit.fx';
/** Whose words a moment shows (their i18n keys): a level-up burst says 레벨 업, a rebirth 환생,
 *  an inherit 계승. */
const titleOf = (req: FxRequest): Title =>
  req.kind === 'inherit' ? 'inherit.fx' : req.kind.startsWith('rebirth') ? 'fx.rebirth' : 'fx.levelUp';

// ── Drawing in world pixels ──────────────────────────────────

/** The dimmed screen's clear disc is drawn in stairs this tall (world px). */
const DIM_STAIR = 2;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const easeIn = (v: number) => clamp01(v) ** 2;
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

  /** A dotted line, the first `k` (0..1) of it, leaving out the pixels `skip` names. */
  line(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    color: string,
    alpha: number,
    k = 1,
    skip?: (x: number, y: number) => boolean,
  ): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n * clamp01(k); i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const y = y0 + ((y1 - y0) * i) / n;
      if (!skip?.(x, y)) this.rect(x, y, 1, 1, color, alpha);
    }
  }

  /** The whole canvas in one colour (the burst's flash). */
  screen(color: string, alpha: number): void {
    if (alpha <= 0) return;
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = color;
    this.ctx.fillRect(0, 0, this.ctx.canvas.width, this.ctx.canvas.height);
  }

  /** Darkens the whole canvas but a stepped pixel disc (rx, ry world px) round (0, cy). */
  dim(alpha: number, rx: number, ry: number, cy: number): void {
    if (alpha <= 0) return;
    const { ctx, at } = this;
    const z = at.zoom;
    const X = (x: number) => at.x + x * z;
    const Y = (y: number) => at.y + Math.round(cy + y) * z;
    const rows: Array<[number, number]> = [];
    for (let y = -ry; y < ry; y += DIM_STAIR) {
      const m = (y + DIM_STAIR / 2) / ry;
      rows.push([y, Math.round(rx * Math.sqrt(Math.max(0, 1 - m * m)))]);
    }
    ctx.globalAlpha = alpha;
    ctx.fillStyle = FX_COLORS.dim;
    ctx.beginPath();
    ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.moveTo(X(rows[0][1]), Y(rows[0][0]));
    for (const [y, w] of rows) {
      ctx.lineTo(X(w), Y(y));
      ctx.lineTo(X(w), Y(y + DIM_STAIR));
    }
    for (let i = rows.length - 1; i >= 0; i--) {
      const [y, w] = rows[i];
      ctx.lineTo(X(-w), Y(y + DIM_STAIR));
      ctx.lineTo(X(-w), Y(y));
    }
    ctx.closePath();
    ctx.fill('evenodd');
  }

  /** A white band across `str` (as text() draws it), `k` 0..1 of the way from left to right. */
  shine(str: string, x: number, y: number, size: number, k: number, alpha: number): void {
    if (alpha <= 0 || k <= 0 || k >= 1) return;
    const { ctx, at } = this;
    const cx = Math.round(at.x + x * at.zoom);
    const cy = Math.round(at.y + y * at.zoom);
    ctx.font = `${size}px ${pixelFontFamily()}`;
    const w = ctx.measureText(str).width;
    const band = Math.round(size * 0.35);
    const bx = Math.round(cx - w / 2 - band + (w + band) * k);
    ctx.save();
    ctx.beginPath();
    ctx.rect(bx, cy - size, band, 2 * size);
    ctx.rect(bx + band + Math.round(band / 2), cy - size, Math.round(band / 3), 2 * size);
    ctx.clip();
    ctx.globalAlpha = alpha * 0.85;
    ctx.fillStyle = FX_COLORS.white;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(str, cx, cy);
    ctx.restore();
  }

  /** Text centred at (x, y) world px: `size` device px, an outline (or a hard drop) in `edge`;
   *  only its first `chars` letters, where the whole word would put them (a typed-in title). */
  text(
    str: string,
    x: number,
    y: number,
    size: number,
    fill: string,
    edge: string,
    alpha: number,
    drop = false,
    chars = Infinity,
  ): void {
    if (alpha <= 0 || chars <= 0) return;
    const { ctx, at } = this;
    let cx = Math.round(at.x + x * at.zoom);
    const cy = Math.round(at.y + y * at.zoom);
    const o = FX_TEXT_OUTLINE_PX;
    ctx.globalAlpha = alpha;
    ctx.font = `${size}px ${pixelFontFamily()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const letters = Array.from(str);
    if (chars < letters.length) {
      cx -= Math.round(ctx.measureText(str).width / 2);
      ctx.textAlign = 'left';
      str = letters.slice(0, chars).join('');
    }
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
  title: Title,
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
  p.text(t(`${title}.title`), 0, y, big, fill, edge, alpha, drop);
  if (count !== undefined && count > 0)
    p.text(
      t(`${title}.sub`, { count }),
      0,
      y + (big * 0.75) / z,
      fontPx(z, FX_SUB_PX_PER_ZOOM, 1),
      FX_COLORS.white,
      FX_COLORS.ink,
      Math.min(alpha, subAlpha),
    );
}

// ── Level-up ─────────────────────────────────────────────────

/** A timed burst over the character: its jingle on the first frame, `paint` every frame. */
abstract class Burst<K extends LevelUpKind | RebirthKind | InheritKind> implements FxAction {
  readonly moving = true;
  protected t = 0;
  private started = false;

  protected readonly kind: K;
  protected readonly count: number | undefined;
  protected readonly title: Title;
  constructor(req: FxRequest & { kind: K }) {
    this.kind = req.kind;
    this.count = req.count;
    this.title = titleOf(req);
  }

  protected abstract get sec(): number;

  step(dt: number): boolean {
    if (!this.started) {
      this.started = true;
      playFxSound(this.kind);
    }
    this.t += dt;
    return this.t < this.sec;
  }

  skip(): void {}

  draw(layer: Layer, ctx: CanvasRenderingContext2D, at: FxSpot): void {
    withPen(ctx, at, (p) => this.paint(layer, p, this.t, at.h));
  }

  protected abstract paint(layer: Layer, p: Pen, t: number, h: number): void;
}

abstract class LevelUp extends Burst<LevelUpKind> {
  protected get sec(): number {
    return FX_LEVELUP_SEC[this.kind];
  }
}

/** A: a pillar of light from the floor to the top of the screen, a burst, rising twinkles, a gold title. */
class LevelUpA extends LevelUp {
  protected paint(layer: Layer, p: Pen, t: number, h: number): void {
    const end = this.sec;
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
      this.title,
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
class LevelUpB extends LevelUp {
  protected paint(layer: Layer, p: Pen, t: number, h: number): void {
    const end = this.sec;
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
      this.title,
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
class LevelUpC extends LevelUp {
  private static readonly ROCKETS = [
    { at: 0, x: -24, up: 30, c: 0 },
    { at: 0.35, x: 24, up: 40, c: 1 },
    { at: 0.7, x: 0, up: 54, c: 2 },
  ] as const;

  protected paint(layer: Layer, p: Pen, t: number, h: number): void {
    const end = this.sec;
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
    for (const r of LevelUpC.ROCKETS) {
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
      this.title,
      this.count,
      p.top - 6 - 16 * rise,
      window01(t, 1.5, end, 0.1, 0.4),
      hue,
      FX_COLORS.ink,
      window01(t, 1.8, end, 0.15, 0.4),
    );
  }
}

// ── Rebirth (C1-FX2 candidates) ──────────────────────────────

/**
 * A grand rebirth: a gathering charge until `burst`, the burst with a short white flash, an
 * aura that lingers, a title with its own entrance. The screen round the character dims all the
 * while (two half steps, a stepped disc left clear round the figure) and clears at the end.
 */
abstract class GrandRebirth extends Burst<RebirthKind> {
  protected get sec(): number {
    return FX_REBIRTH_SEC[this.kind];
  }
  protected get burst(): number {
    return FX_REBIRTH_BURST_SEC[this.kind];
  }

  draw(layer: Layer, ctx: CanvasRenderingContext2D, at: FxSpot): void {
    withPen(ctx, at, (p) => {
      if (layer === 'front') this.backdrop(p, at.h);
      this.paint(layer, p, this.t, at.h);
    });
  }

  private backdrop(p: Pen, h: number): void {
    const t = this.t;
    const a = FX_DIM_ALPHA * Math.min(easeOut(t / this.burst), clamp01((this.sec - t) / 0.8));
    p.dim(a / 2, FX_DIM_RX * FX_DIM_EDGE, FX_DIM_RY * FX_DIM_EDGE, -h / 2);
    p.dim(a / 2, FX_DIM_RX, FX_DIM_RY, -h / 2);
    const f = t - this.burst;
    if (f >= 0 && f < FX_FLASH_SEC)
      p.screen(FX_COLORS.white, FX_FLASH_ALPHA * (1 - f / FX_FLASH_SEC));
  }

  /** The big 환생 title (`size` times the grand one), its first `chars` letters, a shine at
   *  `shine` (0..1 across), and the count line under it. */
  protected grandTitle(
    p: Pen,
    y: number,
    alpha: number,
    subAlpha: number,
    fill: string,
    edge: string,
    look: { size?: number; chars?: number; shine?: number; sub?: string } = {},
  ): void {
    const z = p.at.zoom;
    const big = fontPx(z, FX_GRAND_TITLE_PX_PER_ZOOM * (look.size ?? 1), 2);
    const str = t(`${this.title}.title`);
    p.text(str, 0, y, big, fill, edge, alpha, false, look.chars);
    if (look.shine !== undefined) p.shine(str, 0, y, big, look.shine, alpha);
    if (this.count)
      p.text(
        t(`${this.title}.sub`, { count: this.count }),
        0,
        y + (fontPx(z, FX_GRAND_TITLE_PX_PER_ZOOM, 2) * 0.72) / z,
        fontPx(z, FX_GRAND_SUB_PX_PER_ZOOM, 1),
        look.sub ?? FX_COLORS.white,
        FX_COLORS.ink,
        Math.min(alpha, subAlpha),
      );
  }
}

/** R1 ascension: motes gather to the chest over a closing floor sigil; a pillar of light, a
 *  halo and two fans of light wings open; a gold title rises with a shine sweeping it. */
class Ascension extends GrandRebirth {
  protected paint(layer: Layer, p: Pen, t: number, h: number): void {
    const end = this.sec;
    const B = this.burst;
    const b = t - B;
    const chest = -h * 0.55;
    const top = -p.at.y / p.at.zoom - 2;
    const aura = window01(t, B, end, 0.1, 0.8);
    if (layer === 'back') {
      // the floor sigil: two rings close in through the charge, then turn slowly
      const k = easeOut(t / B);
      const r = b < 0 ? 44 - 22 * k : 22;
      const ringA = Math.max(window01(t, 0, B, 0.2, 0.01) * 0.9, aura);
      p.ring(r, r * 0.4, FX_COLORS.gold, ringA, 0, 36, t * 0.8);
      p.ring(r * 0.6, r * 0.24, FX_COLORS.white, ringA, 0, 22, -t * 1.4);
      for (let i = 0; i < 8; i++) {
        const a = t * 0.8 + (i / 8) * Math.PI * 2;
        p.star(Math.cos(a) * r, Math.sin(a) * r * 0.4, 1, FX_COLORS.gold, ringA);
      }
      // the shock ring on the floor
      if (b >= 0 && b < 0.8) {
        const s = 10 + 84 * easeOut(b / 0.6);
        p.ring(s, s * 0.4, FX_COLORS.white, 1 - b / 0.8, 0, 64);
        p.ring(s * 0.85, s * 0.34, FX_COLORS.gold, 1 - b / 0.8, 0, 52);
      }
      // the wings: a fan of six feathers each side, opening, breathing
      const open = easeOut((b - 0.15) / 0.6);
      if (b > 0.15)
        for (const side of [-1, 1])
          for (let f = 0; f < 6; f++) {
            const ang = ((10 + f * 15 + Math.sin(t * 3.5) * 5) * Math.PI) / 180;
            const len = (28 - f * 2.5) * open;
            for (let d = 0; d < len; d++) {
              const c =
                d < len * 0.35
                  ? FX_COLORS.white
                  : d < len * 0.8
                    ? FX_COLORS.gold
                    : FX_COLORS.goldDeep;
              const x = side * (3 + Math.cos(ang) * d);
              const y = chest - 2 - Math.sin(ang) * d;
              p.rect(side < 0 ? x - 1 : x, y, 2, 1, c, aura * (1 - (d / len) * 0.4));
            }
          }
      return;
    }
    // the charge: a thin thread of light, motes drawn into the chest
    if (b < 0) {
      const k = t / B;
      p.rect(-1, top, 2, -top, FX_COLORS.paleGold, k);
      p.rect(-6, -h - 2, 12, h + 2, FX_COLORS.core, 0.12 * k * (Math.floor(t * 12) % 2 ? 1 : 0.5));
      for (let i = 0; i < 26; i++) {
        const born = rnd(i) * B * 0.6;
        const m = easeIn((t - born) / (B * 0.4));
        if (t < born || m >= 1) continue;
        const a = rnd(i + 40) * Math.PI * 2;
        const r0 = 34 + rnd(i + 80) * 22;
        const x = Math.cos(a) * r0 * (1 - m);
        const y = chest + Math.sin(a) * r0 * 0.8 * (1 - m);
        p.rect(
          x,
          y,
          i % 3 ? 1 : 2,
          i % 3 ? 1 : 2,
          i % 2 ? FX_COLORS.gold : FX_COLORS.white,
          0.4 + m * 0.6,
        );
      }
    } else {
      // the pillar: wide at the burst, settling, bright bands climbing it
      const width = 30 * easeOut(b / 0.2) - 14 * easeOut((b - 0.4) / 1.2);
      const fade = window01(t, B, end, 0.01, 1.2);
      p.rect(-width / 2, top, width, -top, FX_COLORS.paleGold, fade);
      p.rect(-width / 4, top, width / 2, -top, FX_COLORS.core, 0.55 * fade);
      for (let k = 0; k < 8; k++) {
        const y = -(((t * 80 + k * 24) % 190) + 2);
        p.rect(-width / 2, y, width, 1, FX_COLORS.white, 0.5 * fade);
      }
      // rays from the chest
      if (b < 0.7)
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * Math.PI * 2;
          const len = 70 * easeOut(b / 0.5);
          p.line(
            Math.cos(a) * len * 0.4,
            chest + Math.sin(a) * len * 0.4,
            Math.cos(a) * len,
            chest + Math.sin(a) * len,
            i % 2 ? FX_COLORS.gold : FX_COLORS.white,
            1 - b / 0.7,
          );
        }
      // the halo over the head
      const halo = easeOut((b - 0.4) / 0.4);
      if (halo > 0) {
        const hy = -h - 5 + Math.sin(t * 3) * 1;
        p.ring(8 * halo, 2.2 * halo, FX_COLORS.gold, aura, hy, 22, t);
        p.ring(6 * halo, 1.4 * halo, FX_COLORS.white, aura * 0.8, hy, 16, -t);
      }
      // twinkles rising in the light
      for (let i = 0; i < 26; i++) {
        const born = B + rnd(i + 5) * (end - B - 1.4);
        const age = t - born;
        if (age < 0 || age > 1.4) continue;
        const x = (rnd(i + 60) - 0.5) * 30;
        const y = -4 - age * (34 + rnd(i + 99) * 30);
        p.star(
          x,
          y,
          Math.floor((t * 10 + i) % 2) + 1,
          i % 3 ? FX_COLORS.gold : FX_COLORS.white,
          1 - age / 1.4,
        );
      }
    }
    // the title rises into place; a shine sweeps it every 1.6 s
    const rise = easeOut((b - 0.5) / 0.6);
    const sweep = ((b - 1) % 1.6) / 0.8;
    this.grandTitle(
      p,
      p.top - 6 - 30 * rise,
      window01(t, B + 0.5, end, 0.3, 0.5),
      window01(t, B + 1.1, end, 0.2, 0.5),
      FX_COLORS.gold,
      FX_COLORS.ink,
      { shine: b > 1 ? sweep : undefined },
    );
  }
}

/** R2's bird, our own: a left half (the right is its mirror) per wing beat. a flame, b orange,
 *  c gold, d white. Two frames: wings raised, wings spread. */
const BIRD_HALVES = [
  [
    'a............',
    'ab...........',
    'abb..........',
    '.abb.......cd',
    '.abcb.....cdd',
    '..abcb....bcd',
    '..abccb..bccc',
    '...abccbbcccd',
    '....abcccccdd',
    '.....abbcccdd',
    '.......abbccd',
    '.........abcc',
    '........ab.bc',
    '.......ab..ab',
    '......a....a.',
  ],
  [
    '.............',
    '.............',
    '.............',
    '...........cd',
    '..........cdd',
    'aabb......bcd',
    '.abbcbb..bccc',
    '..aabcccbcccd',
    '....aabcccddd',
    '.....abbcccdd',
    '.......abbccd',
    '.........abcc',
    '........ab.bc',
    '.......ab..ab',
    '......a....a.',
  ],
] as const;
const BIRD = BIRD_HALVES.map((half) =>
  half.map((row) => row + [...row.slice(0, -1)].reverse().join('')),
);
const BIRD_INK: Record<string, string> = {
  a: FX_COLORS.flame,
  b: FX_COLORS.orange,
  c: FX_COLORS.gold,
  d: FX_COLORS.white,
};
const FLAMES = [FX_COLORS.flame, FX_COLORS.orange, FX_COLORS.gold] as const;

/** R2 phoenix: flame squares spiral in round a burning floor ring; a bird of squares bursts up
 *  out of the character and beats its wings, embers rain down, the title pops in like a spark. */
class Phoenix extends GrandRebirth {
  protected paint(layer: Layer, p: Pen, t: number, h: number): void {
    const end = this.sec;
    const B = this.burst;
    const b = t - B;
    const chest = -h * 0.55;
    const aura = window01(t, B, end, 0.1, 0.8);
    if (layer === 'back') {
      // the burning ring on the floor: tongues that flicker, higher after the burst
      const ringA = Math.max(window01(t, 0, B, 0.3, 0.01), aura);
      const tall = b < 0 ? 2 + 3 * (t / B) : 6;
      for (let i = 0; i < 26; i++) {
        const a = (i / 26) * Math.PI * 2 + t * 0.5;
        const x = Math.cos(a) * 26;
        const y = Math.sin(a) * 10;
        const hgt = Math.round(tall * (0.5 + rnd(i + Math.floor(t * 14)) * 0.8));
        p.rect(x, y - hgt, 1, hgt, FX_COLORS.flame, ringA);
        p.rect(x, y - Math.ceil(hgt / 2), 1, Math.ceil(hgt / 2), FX_COLORS.orange, ringA);
        p.rect(x, y, 1, 1, FX_COLORS.gold, ringA);
      }
      // flames climbing round the figure through the aura
      if (b > 0)
        for (let i = 0; i < 22; i++) {
          const age = (t * 0.9 + rnd(i + 3)) % 1;
          const x = (rnd(i + 21) - 0.5) * 22;
          p.rect(x, -age * (h + 10), 1, 2, FLAMES[Math.floor(age * 3)], aura * (1 - age));
        }
      return;
    }
    if (b < 0) {
      // the spiral: squares wind in faster and faster, each with a short tail
      const k = t / B;
      for (let i = 0; i < 28; i++) {
        for (let tail = 3; tail >= 0; tail--) {
          const kk = Math.max(0, k - tail * 0.012);
          const r = 60 * (1 - easeIn(kk)) + 4;
          const a = (i / 28) * Math.PI * 2 + kk * kk * 11;
          const x = Math.cos(a) * r;
          const y = chest + Math.sin(a) * r * 0.75;
          const c = FLAMES[i % 3];
          if (tail === 0) p.rect(x - 1, y - 1, 2, 2, c, 0.4 + 0.6 * k);
          else p.rect(x, y, 1, 1, c, (0.6 - tail * 0.15) * k);
        }
      }
      p.rect(-6, -h - 2, 12, h + 2, FX_COLORS.orange, 0.1 * k * (Math.floor(t * 14) % 2 ? 1 : 0.4));
    } else {
      // the shock ring
      if (b < 0.6) {
        const r = 6 + 76 * easeOut(b / 0.5);
        for (let i = 0; i < 40; i++) {
          const a = (i / 40) * Math.PI * 2;
          p.rect(
            Math.cos(a) * r - 1,
            chest + Math.sin(a) * r * 0.8 - 1,
            2,
            2,
            FLAMES[i % 3],
            1 - b / 0.6,
          );
        }
      }
      // the bird: rises out of the chest, grows to two-pixel squares, beats its wings, then fades
      const birdA = window01(t, B, end - 1.3, 0.05, 0.7);
      if (birdA > 0) {
        const cell = b < 0.12 ? 1 : 2;
        const frame = BIRD[Math.floor(b / 0.17) % 2];
        const cy = chest - 8 - 30 * easeOut(b / 0.6) + Math.sin(b * 3) * 2;
        const w = frame[0].length;
        const rows = frame.length;
        for (let r = 0; r < rows; r++)
          for (let c = 0; c < w; c++) {
            const ink = frame[r][c];
            if (ink === '.') continue;
            p.rect(
              (c - (w - 1) / 2) * cell,
              cy + (r - rows / 2) * cell,
              cell,
              cell,
              BIRD_INK[ink],
              birdA,
            );
          }
      }
      // embers rain from it
      for (let i = 0; i < 54; i++) {
        const age = b - 0.3 - rnd(i + 13) * 2.6;
        if (age < 0) continue;
        const x = (rnd(i + 31) - 0.5) * 70 + Math.sin(age * 4 + i) * 3;
        const y = chest - 40 + age * (16 + rnd(i + 57) * 18);
        if (y > 2) continue;
        const c = FLAMES[Math.floor(age * 6 + i) % 3];
        p.rect(x, y, 1, 1 + (i % 4 === 0 ? 1 : 0), c, aura);
      }
    }
    // the title: in big, a step down, home (crisp steps); its edge flickers like a flame
    const pop = b < 0.5 ? 0 : b < 0.58 ? 1.5 : b < 0.66 ? 0.85 : 1;
    this.grandTitle(
      p,
      p.top - 34,
      pop ? window01(t, B + 0.5, end, 0.01, 0.5) : 0,
      window01(t, B + 1, end, 0.2, 0.5),
      FX_COLORS.gold,
      Math.floor(t * 10) % 2 ? FX_COLORS.flame : FX_COLORS.ink,
      { size: pop, sub: FX_COLORS.gold },
    );
  }
}

/** R3's emblem: eight outer stars (an eight-pointed star drawn through every third) round eight
 *  inner ones (an octagon), and a ring round it all, about the chest (world px from its centre). */
const EMBLEM_R = 44;
const EMBLEM_IN = 20;
const EMBLEM_RING = 52;
const EMBLEM = (() => {
  const pt = (r: number, i: number, off: number) => {
    const a = -Math.PI / 2 + ((i + off) / 8) * Math.PI * 2;
    return [Math.round(Math.cos(a) * r), Math.round(Math.sin(a) * r)] as const;
  };
  const outer = Array.from({ length: 8 }, (_, i) => pt(EMBLEM_R, i, 0));
  const inner = Array.from({ length: 8 }, (_, i) => pt(EMBLEM_IN, i, 0.5));
  const lines = [
    ...outer.map((a, i) => ({ a, b: outer[(i + 3) % 8], at: 0.45 + i * 0.2 })),
    ...inner.map((a, i) => ({ a, b: inner[(i + 1) % 8], at: 0.6 + i * 0.2 })),
  ];
  // the stars light in turn with the jingle's pings (one every 0.14 s from 0.25 s)
  const stars = outer.flatMap((o, i) => [
    { p: o, at: 0.25 + i * 0.28 },
    { p: inner[i], at: 0.39 + i * 0.28 },
  ]);
  // the pieces the emblem shatters into: every third pixel of every line and of the ring
  const shards: Array<{ x: number; y: number; i: number }> = [];
  for (const l of lines) {
    const n = Math.max(Math.abs(l.b[0] - l.a[0]), Math.abs(l.b[1] - l.a[1]));
    for (let s = 0; s <= n; s += 3)
      shards.push({
        x: l.a[0] + ((l.b[0] - l.a[0]) * s) / n,
        y: l.a[1] + ((l.b[1] - l.a[1]) * s) / n,
        i: shards.length,
      });
  }
  for (let s = 0; s < 96; s++) {
    const a = (s / 96) * Math.PI * 2;
    shards.push({ x: Math.cos(a) * EMBLEM_RING, y: Math.sin(a) * EMBLEM_RING, i: shards.length });
  }
  return { lines, stars, shards };
})();
const STARRY = [FX_COLORS.white, FX_COLORS.starLine, FX_COLORS.cyan, FX_COLORS.gold] as const;

/** R3 constellation: in the dark, stars light one by one and lines join them into a large
 *  emblem round the character; it flares white and shatters into sparkles, small stars keep
 *  circling, and the title is spelled out a letter at a time. */
class Constellation extends GrandRebirth {
  protected paint(layer: Layer, p: Pen, t: number, h: number): void {
    const end = this.sec;
    const B = this.burst;
    const b = t - B;
    const cy = -h * 0.55 - 6;
    const aura = window01(t, B, end, 0.1, 0.8);
    if (layer === 'back') {
      // small stars circling the figure, behind it on the far half of the orbit
      this.orbit(p, t, cy, aura, true);
      return;
    }
    // the figure stays clear of lines
    const body = (x: number, y: number) => Math.abs(x) < 8 && y + cy > -h - 3 && y + cy < 2;
    if (b < 0.35) {
      const flare = b >= 0;
      const lineC = flare ? FX_COLORS.white : FX_COLORS.starLine;
      for (const l of EMBLEM.lines) {
        const k = flare ? 1 : (t - l.at) / 0.3;
        if (k <= 0) continue;
        const skip = (x: number, y: number) => body(x, y - cy);
        p.line(l.a[0], cy + l.a[1], l.b[0], cy + l.b[1], lineC, flare ? 1 : 0.85, k, skip);
        if (flare) p.line(l.a[0] + 1, cy + l.a[1], l.b[0] + 1, cy + l.b[1], lineC, 0.6, 1, skip);
      }
      const ringK = flare ? 1 : (t - 1.9) / 0.6;
      const dots = Math.floor(96 * clamp01(ringK));
      for (let s = 0; s < dots; s++) {
        const a = -Math.PI / 2 + (s / 96) * Math.PI * 2;
        const x = Math.cos(a) * EMBLEM_RING;
        const y = Math.sin(a) * EMBLEM_RING;
        p.rect(x, cy + y, 1, 1, s % 8 ? lineC : FX_COLORS.gold, flare ? 1 : 0.8);
      }
      for (const s of EMBLEM.stars) {
        const age = t - s.at;
        if (age < 0) continue;
        const r = flare ? 3 : age < 0.12 ? 3 : 1 + (Math.floor(t * 6 + s.at * 10) % 2);
        p.star(s.p[0], cy + s.p[1], r, flare ? FX_COLORS.white : FX_COLORS.cyan);
      }
      if (flare) {
        const r = EMBLEM_RING + 34 * easeOut(b / 0.35);
        p.ring(r, r, FX_COLORS.white, 1 - b / 0.35, cy, 72);
      }
    }
    // the shatter: every shard flies out from the centre, falls a little, twinkles out
    if (b >= 0.25) {
      const s = b - 0.25;
      for (const d of EMBLEM.shards) {
        const len = Math.hypot(d.x, d.y) || 1;
        const v = 8 + rnd(d.i) * 22;
        const life = 1.2 + rnd(d.i + 300) * 0.8;
        if (s > life) continue;
        const x = d.x + (d.x / len) * v * s;
        const y = d.y + (d.y / len) * v * s + 10 * s * s;
        const size = Math.floor(s * 8 + d.i) % 3 === 0 ? 2 : 1;
        p.rect(x, cy + y, size, size, STARRY[d.i % STARRY.length], 1 - s / life);
      }
    }
    this.orbit(p, t, cy, aura, false);
    // the title, spelled out
    const chars = Math.floor((b - 0.4) / 0.15) + 1;
    this.grandTitle(
      p,
      p.top - 40,
      window01(t, B + 0.4, end, 0.01, 0.5),
      window01(t, B + 1.4, end, 0.2, 0.5),
      FX_COLORS.white,
      FX_COLORS.night,
      { chars, sub: FX_COLORS.starLine },
    );
  }

  private orbit(p: Pen, t: number, cy: number, alpha: number, back: boolean): void {
    if (alpha <= 0) return;
    for (let i = 0; i < 10; i++) {
      const a = t * 1.6 + (i / 10) * Math.PI * 2;
      if (Math.sin(a) < 0 !== back) continue;
      const y = cy + 4 + Math.sin(a) * 6 + Math.sin(t * 2 + i) * 2;
      p.star(Math.cos(a) * 18, y, i % 3 ? 1 : 2, STARRY[i % STARRY.length], alpha);
    }
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
  private readonly drink: 'coffee' | 'energy';
  private readonly machine: string | undefined;
  constructor(drink: 'coffee' | 'energy', machine?: string) {
    this.drink = drink;
    this.machine = machine;
  }
  private t = 0;
  private started = false;
  private rest: Rest | null = null;
  private lastPhase: Rest['phase'] | null = null;
  private plusAt: number | null = null;
  private ended = false;
  /** COMPACT-COFFEE: seconds held while its agent compacts (they do not count to the timeout). */
  private heldSec = 0;

  step(dt: number, world: FxWorld, ch: Character): boolean {
    const os = world as OfficeState;
    if (!this.started) {
      this.started = true;
      this.rest = startBreak(os, ch, MACHINE[this.drink], this.machine);
      if (!this.rest) restWatch.sip(ch.id, performance.now());
    }
    this.t += dt;
    const held = compactHolds.has(ch.id) && this.heldSec < FX_COFFEE_HOLD_MAX_SEC;
    if (held) this.heldSec += dt;
    const r = this.rest;
    if (!r) {
      // in place, held: the drink at the mouth again (rest.ts), the pop when it is over
      if (held && this.t >= REST_ANIM_SEC) {
        this.t = 0;
        restWatch.sip(ch.id, performance.now());
      } else if (this.plusAt === null && this.t >= REST_ANIM_SEC) this.pop();
    } else if (!this.ended) {
      r.hold = held;
      const phase = ch.cldRest === r ? r.phase : null;
      if (this.lastPhase === 'drink' && phase !== 'drink') this.pop();
      this.lastPhase = phase;
      // home again (or someone else's rest now, or too long): the FSM has it back
      if (phase === null || phase === 'rest' || this.t - this.heldSec > FX_COFFEE_MAX_SEC) {
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

// ── Inherit (계승) ───────────────────────────────────────────

/** A spirit flame `s` world px tall at (x, y) (its base), flickering with `t`: a white heart,
 *  a mint body, a deep edge, a tongue that sways. */
function spiritFlame(p: Pen, x: number, y: number, s: number, t: number, alpha: number): void {
  const sway = Math.round(Math.sin(t * 14) * s * 0.12);
  const w = Math.max(2, Math.round(s * 0.6));
  p.rect(x - w / 2 - 1, y - s * 0.7, w + 2, s * 0.7, FX_COLORS.spiritDeep, alpha);
  p.rect(x - w / 2, y - s * 0.85, w, s * 0.8, FX_COLORS.spirit, alpha);
  p.rect(x - w / 4 + sway, y - s * 1.15, Math.max(1, w / 2), s * 0.4, FX_COLORS.spirit, alpha);
  p.rect(x - 1, y - s * 0.55, 2, s * 0.35, FX_COLORS.white, alpha);
  p.ring(s * 0.9, s * 0.9, FX_COLORS.spiritPale, alpha, y - s * 0.5, 16, t * 2);
}

/**
 * INHERIT: the removed agent's records came over to this one. Its old self steps in beside it as
 * a pale ghost (the character's own frame, paled) over a ring of its own, raises a spirit flame,
 * and hands it along an arc while a chain of light links the two rings on the floor; the flame
 * sinks into the heir's chest in ripples, the ghost dissolves upward, and "계승!" stamps in
 * between two growing bars with "N대째". Mint and white (환생 is gold and fire, a level-up
 * sparkles), over a dimmed screen with a wide clear disc for the two of them.
 */
class Inheritance extends Burst<InheritKind> {
  protected get sec(): number {
    return FX_INHERIT_SEC;
  }

  draw(layer: Layer, ctx: CanvasRenderingContext2D, at: FxSpot): void {
    withPen(ctx, at, (p) => {
      if (layer === 'front') {
        const a = FX_DIM_ALPHA * Math.min(easeOut(this.t / FX_INHERIT_BEATS.ghost), clamp01((this.sec - this.t) / 0.8));
        const rx = FX_DIM_RX * FX_INHERIT_DIM_WIDEN;
        p.dim(a / 2, rx * FX_DIM_EDGE, FX_DIM_RY * FX_DIM_EDGE, -at.h / 2);
        p.dim(a / 2, rx, FX_DIM_RY, -at.h / 2);
        this.ghost(ctx, p, at);
      }
      this.paint(layer, p, this.t, at.h);
    });
  }

  /** The old self: the character's frame again, paled and floating, beside the heir. */
  private ghost(ctx: CanvasRenderingContext2D, p: Pen, at: FxSpot): void {
    const t = this.t;
    const B = FX_INHERIT_BEATS;
    const a = Math.min(easeOut(t / B.ghost), 1 - easeIn((t - B.pass) / 0.9));
    if (a <= 0) return;
    const gx = -FX_INHERIT_GHOST_DX;
    const lift = Math.round(-2 - 2 * Math.sin(t * 2.2) - 6 * (1 - easeOut(t / B.ghost)));
    if (at.figure) {
      ctx.save();
      ctx.globalAlpha = a * FX_INHERIT_GHOST_ALPHA;
      ctx.filter = FX_INHERIT_GHOST_FILTER;
      at.figure(ctx, Math.round(gx * at.zoom), lift * at.zoom);
      ctx.restore();
    } else p.rect(gx - 4, lift - at.h, 8, at.h, FX_COLORS.spiritPale, a);
    // its scan lines drift up through it, a spirit's shimmer
    for (let y = -at.h; y < 0; y += 3) {
      const yy = y + lift - ((t * 9) % 3);
      p.rect(gx - 7, yy, 14, 1, FX_COLORS.spirit, 0.12 * a);
    }
  }

  protected paint(layer: Layer, p: Pen, t: number, h: number): void {
    const B = FX_INHERIT_BEATS;
    const end = this.sec;
    const gx = -FX_INHERIT_GHOST_DX;
    const chest = -h * 0.55;
    const held = { x: gx, y: -h - 6 };
    if (layer === 'back') {
      // a ring under each of them, then a chain of light that flows from the old one to the new
      const ringA = window01(t, 0.2, end, 0.4, 0.8);
      p.ring(10, 4, FX_COLORS.spirit, ringA * (1 - easeIn((t - B.pass) / 1.2)), 0, 24, t);
      p.ring(10, 4, FX_COLORS.spirit, ringA, 0, 24, -t);
      p.ring(7, 2.6, FX_COLORS.white, ringA * window01(t, B.pass, end, 0.2, 0.8), 0, 18, t * 2);
      const n = 9;
      for (let i = 0; i < n; i++) {
        const k = ((i / n + t * 0.6) % 1);
        const x = gx + 9 + (FX_INHERIT_GHOST_DX - 18) * k;
        const linkA = window01(t, B.ghost * 0.6, end - 0.6, 0.4, 0.6);
        p.rect(x - 1, -1 + Math.round(Math.sin(k * Math.PI) * -2), 3, 1, i % 3 ? FX_COLORS.spirit : FX_COLORS.white, linkA);
      }
      return;
    }
    // the flame: rises from the ghost's chest to over its head, then flies on an arc to the heir
    if (t > B.ghost * 0.5 && t < B.pass + 0.15) {
      const born = easeOut((t - B.ghost * 0.5) / (B.raise - B.ghost * 0.5));
      let x = gx;
      let y = -h * 0.5 + (held.y + h * 0.5) * born;
      let s = 3 + 5 * born;
      if (t > B.raise) {
        const k = easeIn((t - B.raise) / (B.pass - B.raise));
        x = gx + (0 - gx) * k;
        y = held.y + (chest - held.y) * k - Math.sin(k * Math.PI) * 16;
        s = 8 - 3 * k;
        // its trail of motes
        for (let i = 1; i <= 8; i++) {
          const kk = Math.max(0, k - i * 0.045);
          const tx = gx + (0 - gx) * kk;
          const ty = held.y + (chest - held.y) * kk - Math.sin(kk * Math.PI) * 16 - s * 0.5;
          p.rect(tx, ty, i < 4 ? 2 : 1, i < 4 ? 2 : 1, i % 2 ? FX_COLORS.spirit : FX_COLORS.white, 1 - i / 9);
        }
      }
      spiritFlame(p, x, y, s, t, Math.min(1, born * 1.5));
      // the light it casts on the raised hands while it is held
      if (t < B.raise) p.star(gx, held.y + 3, 2, FX_COLORS.white, 0.6 * born);
    }
    // the arrival: ripples from the chest, a mint glow round the heir, motes from the ghost
    const b = t - B.pass;
    if (b >= 0) {
      if (b < 0.25) p.screen(FX_COLORS.spirit, 0.22 * (1 - b / 0.25));
      for (let r = 0; r < 3; r++) {
        const k = (b - r * 0.18) / 0.7;
        if (k > 0 && k < 1) p.ring(6 + 30 * easeOut(k), 6 + 30 * easeOut(k), r ? FX_COLORS.spirit : FX_COLORS.white, 1 - k, chest, 40);
      }
      const glow = window01(t, B.pass, end, 0.1, 0.8);
      for (let i = 0; i < 14; i++) {
        const y = -((t * 26 + i * 7) % (h + 8));
        const x = (rnd(i + 7) - 0.5) * 16;
        p.rect(x, y, 1, 2, i % 2 ? FX_COLORS.spirit : FX_COLORS.white, glow * (1 + y / (h + 8)));
      }
      p.star(-6, chest - 4, 1, FX_COLORS.white, glow * (Math.floor(t * 6) % 2));
      p.star(6, chest + 2, 1, FX_COLORS.spirit, glow * (Math.floor(t * 6 + 1) % 2));
      for (let i = 0; i < 18; i++) {
        const age = b - rnd(i + 31) * 0.6;
        if (age < 0 || age > 1.2) continue;
        p.rect(gx + (rnd(i + 3) - 0.5) * 12, -h * rnd(i + 50) - age * 24, 1, 1, FX_COLORS.spirit, 1 - age / 1.2);
      }
    }
    // the title: two bars grow from the middle, then "계승!" stamps in between them
    if (t >= B.title) stampTitle(p, this.title, this.count, t - B.title, window01(t, B.title, end, 0.08, 0.5));
  }
}

/** The 계승 title `T` s in: two bars with gold ends grow from the middle, the word stamps in
 *  (big to its size, a hard drop) with a shine sweeping it, the count line under it. */
function stampTitle(p: Pen, title: Title, count: number | undefined, T: number, alpha: number): void {
  const z = p.at.zoom;
  const y = p.top - 14;
  const bar = 40 * easeOut(T / 0.35);
  const big = fontPx(z, FX_GRAND_TITLE_PX_PER_ZOOM, 2);
  const gap = (big * 0.62) / z;
  for (const dy of [-gap, gap]) {
    p.rect(-bar, y + dy, 2 * bar, 1, FX_COLORS.spirit, alpha);
    p.rect(-bar - 2, y + dy - 1, 2, 3, FX_COLORS.gold, alpha);
    p.rect(bar, y + dy - 1, 2, 3, FX_COLORS.gold, alpha);
  }
  const stamp = easeOut((T - 0.15) / 0.25);
  const size = fontPx(z, FX_GRAND_TITLE_PX_PER_ZOOM * (1.7 - 0.7 * stamp), 2);
  if (T > 0.15) {
    const str = t(`${title}.title`);
    p.text(str, 0, y, size, FX_COLORS.spirit, FX_COLORS.ink, alpha * Math.min(1, stamp * 1.4), true);
    if (T > 0.6) p.shine(str, 0, y, size, ((T - 0.6) % 1.4) / 0.7, alpha);
  }
  const sub = fontPx(z, FX_GRAND_SUB_PX_PER_ZOOM, 1);
  if (count && T > 0.5)
    p.text(t(`${title}.sub`, { count }), 0, y + gap + (sub * 0.9) / z, sub, FX_COLORS.white, FX_COLORS.ink, alpha * easeOut((T - 0.5) / 0.3));
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
      drawTitle(
        p,
        titleOf(this.req),
        this.req.count,
        p.top - 22,
        1,
        FX_COLORS.gold,
        FX_COLORS.ink,
        1,
      );
    });
  }
}

// ── The factory ──────────────────────────────────────────────

const BURSTS = {
  levelUpA: LevelUpA,
  levelUpB: LevelUpB,
  levelUpC: LevelUpC,
  rebirthR1: Ascension,
  rebirthR2: Phoenix,
  rebirthR3: Constellation,
  inherit: Inheritance,
} as const;

export function makeAction(req: FxRequest, reduced: boolean): FxAction {
  if (reduced) return new Still(req);
  if (req.kind === 'coffee') return new CoffeeBreak(req.drink ?? THEME.rest.prop, req.machine);
  const Make = BURSTS[req.kind] as new (r: FxRequest) => FxAction;
  return new Make(req);
}

director.use(makeAction);
export { director };

/**
 * FX-ALL: the owner's character drinks at the coffee or vending machine it stands next to (its
 * key), or at the one tapped (`tile`, a tile of its footprint): that machine's drink, the coffee
 * break's frames and steam. False: no such machine by it, or a moment of its own plays already.
 */
export function ownerDrink(os: OfficeState, tile?: { col: number; row: number }): boolean {
  const ch = os.characters.get(OWNER_CHARACTER_ID);
  if (!ch || ch.cldAway || director.playing(ch.id)) return false;
  const m = pantryNear(os, ch, tile);
  if (!m) return false;
  return director.play(ch.id, {
    kind: 'coffee',
    drink: m.kind === 'vending' ? 'energy' : 'coffee',
    machine: m.uid,
  });
}
