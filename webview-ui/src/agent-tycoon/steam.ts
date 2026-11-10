/**
 * C1 (owner 11-01 "커피는 김 모락모락"): hot coffee's steam, drawn in code: a few soft wisps that
 * rise slowly, sway, grow and fade, looping. Over a coffee machine's full cup (iso/render.ts, the
 * piece's `steam`) and a cup in hand (a drink cell's steam origin). Never for cans or water.
 */
import {
  STEAM_ALPHA,
  STEAM_CLEAR,
  STEAM_COLOR,
  STEAM_GROW,
  STEAM_PERIOD_SEC,
  STEAM_PUFFS,
  STEAM_RADIUS_PX,
  STEAM_RISE_PX,
  STEAM_SPREAD_PX,
  STEAM_SWAY_PX,
  STEAM_SWAY_WAVES,
  STEAM_WISP_PHASE,
  STEAM_WISPS,
} from '../constants.js';

/** Steam rising from (x, y) (device px), at `s` device px per world px, `t` s on the clock.
 *  `lean` (world px, signed): it drifts that far sideways over its rise and its wisps start on
 *  that side of (x, y) only (a held cup, away from the face); 0: straight up, centred. */
export function drawSteam(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  t: number,
  lean = 0,
): void {
  ctx.save();
  const side = Math.sign(lean);
  for (let w = 0; w < STEAM_WISPS; w++) {
    const at = side ? (side * w) / 2 : w - (STEAM_WISPS - 1) / 2;
    const x0 = x + at * STEAM_SPREAD_PX * s;
    for (let i = 0; i < STEAM_PUFFS; i++) {
      // 0 just over the cup, 1 risen and gone; the wisps are out of step
      const p = (t / STEAM_PERIOD_SEC + w / STEAM_WISPS + i / STEAM_PUFFS) % 1;
      const px =
        x0 +
        Math.sin((p * STEAM_SWAY_WAVES + w * STEAM_WISP_PHASE) * Math.PI) * STEAM_SWAY_PX * s * p +
        lean * s * p;
      const py = y - p * STEAM_RISE_PX * s;
      const r = STEAM_RADIUS_PX * s * (1 + p * STEAM_GROW);
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, STEAM_COLOR);
      g.addColorStop(1, STEAM_CLEAR);
      ctx.globalAlpha = STEAM_ALPHA * Math.sin(Math.PI * p);
      ctx.fillStyle = g;
      ctx.fillRect(px - r, py - r, 2 * r, 2 * r);
    }
  }
  ctx.restore();
}
