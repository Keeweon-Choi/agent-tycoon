/**
 * Generated stand-ins for photos (T-0017 tests and examples): painted
 * portraits with gradients and noise, so the converter sees photo-like
 * colour spreads. Deterministic; no real photo is ever used.
 */
type Rgb = [number, number, number];

export interface Photo {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

interface Portrait {
  bg: [Rgb, Rgb];
  skin: Rgb;
  hair: Rgb;
  clothes: Rgb;
  /** Hair reaches the shoulders. */
  long?: boolean;
  /** Cat ears and a white muzzle instead of a human face. */
  cat?: boolean;
}

export const PORTRAITS: Record<string, Portrait> = {
  brunette: {
    bg: [
      [176, 214, 236],
      [120, 168, 205],
    ],
    skin: [232, 180, 150],
    hair: [62, 40, 28],
    clothes: [196, 44, 52],
  },
  blonde: {
    bg: [
      [236, 224, 200],
      [214, 196, 160],
    ],
    skin: [246, 206, 178],
    hair: [236, 196, 110],
    clothes: [52, 150, 84],
    long: true,
  },
  silver: {
    bg: [
      [245, 245, 245],
      [210, 214, 220],
    ],
    skin: [196, 140, 106],
    hair: [206, 206, 214],
    clothes: [36, 52, 104],
  },
  violet: {
    bg: [
      [40, 36, 58],
      [24, 22, 36],
    ],
    skin: [250, 222, 204],
    hair: [140, 70, 190],
    clothes: [250, 200, 40],
    long: true,
  },
  cat: {
    bg: [
      [90, 180, 170],
      [50, 130, 128],
    ],
    skin: [235, 140, 60],
    hair: [235, 140, 60],
    clothes: [240, 236, 228],
    cat: true,
  },
};

function noise(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296 - 0.5;
  };
}

const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) =>
  ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

/** A size×size portrait of `kind` (a PORTRAITS key). */
export function syntheticPhoto(kind: string, size = 160): Photo {
  const p = PORTRAITS[kind];
  const data = new Uint8ClampedArray(size * size * 4);
  const rand = noise(kind.length * 7919 + size);
  const u = size / 160;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const X = x / u;
      const Y = y / u;
      const t = Y / 160;
      let c: Rgb = [0, 1, 2].map((i) => p.bg[0][i] * (1 - t) + p.bg[1][i] * t) as Rgb;
      let shade = 1;
      const hairBack = p.long && inEllipse(X, Y, 80, 82, 46, 62);
      if (hairBack) c = p.hair;
      if (inEllipse(X, Y, 80, 178, 78, 56)) {
        c = p.clothes;
        shade = 1 - Math.abs(X - 80) / 260;
      }
      if (!p.cat && X > 68 && X < 92 && Y > 100 && Y < 130) c = p.skin;
      if (p.cat && (inEllipse(X, Y, 50, 40, 16, 26) || inEllipse(X, Y, 110, 40, 16, 26)))
        c = p.hair;
      if (inEllipse(X, Y, 80, 80, 36, 42)) {
        c = p.skin;
        shade = 1 - (Math.hypot(X - 70, Y - 70) / 60) * 0.25;
      }
      if (p.cat && inEllipse(X, Y, 80, 98, 20, 14)) c = p.clothes;
      if (!p.cat && inEllipse(X, Y, 80, 58, 42, 30) && Y < 66) c = p.hair;
      if (!p.cat && p.long && (inEllipse(X, Y, 46, 86, 10, 34) || inEllipse(X, Y, 114, 86, 10, 34)))
        c = p.hair;
      if (inEllipse(X, Y, 66, 80, 4, 5) || inEllipse(X, Y, 94, 80, 4, 5))
        c = p.cat ? [40, 120, 40] : [30, 24, 22];
      if (!p.cat && inEllipse(X, Y, 80, 104, 9, 3)) c = [190, 90, 90];
      const i = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) data[i + k] = c[k] * shade + rand() * 18;
      data[i + 3] = 255;
    }
  return { width: size, height: size, data };
}
