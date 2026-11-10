/** sRGB <-> OKLab/OKLCh for the photo converter (pure, DOM-free). */

export type Rgb = readonly [number, number, number];
export interface Lab {
  L: number;
  a: number;
  b: number;
}

const toLinear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (c: number) =>
  255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

export function rgbToLab([r, g, b]: Rgb): Lab {
  const lr = toLinear(r);
  const lg = toLinear(g);
  const lb = toLinear(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/** Linear sRGB of an OKLab colour (may fall outside 0..1). */
function labToLinear({ L, a, b }: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export const chroma = (c: Lab) => Math.hypot(c.a, c.b);
/** Hue in degrees, 0..360. */
export const hue = (c: Lab) => ((Math.atan2(c.b, c.a) * 180) / Math.PI + 360) % 360;

/** L, chroma, hue (deg) -> sRGB, keeping L and hue and lowering chroma until it fits. */
export function lchToRgb(L: number, C: number, h: number): Rgb {
  const rad = (h * Math.PI) / 180;
  const fits = (c: number) =>
    labToLinear({ L, a: c * Math.cos(rad), b: c * Math.sin(rad) }).every(
      (v) => v >= -1e-4 && v <= 1 + 1e-4,
    );
  let lo = 0;
  let hi = Math.max(0, C);
  if (!fits(hi)) {
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) lo = mid;
      else hi = mid;
    }
    hi = lo;
  }
  const lin = labToLinear({ L, a: hi * Math.cos(rad), b: hi * Math.sin(rad) });
  return lin.map((v) => Math.round(Math.min(255, Math.max(0, fromLinear(v))))) as unknown as Rgb;
}

export const labDistance2 = (p: Lab, q: Lab) =>
  (p.L - q.L) ** 2 + (p.a - q.a) ** 2 + (p.b - q.b) ** 2;

/** '#rrggbb' (any case) -> [r, g, b]. */
export function parseHex(hex: string): Rgb {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
