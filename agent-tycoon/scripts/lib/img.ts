/** Shared by the isometric asset scripts: an RGBA image with a transparent-aware getter, PNG in and out. */
import * as fs from 'fs';
import { PNG } from 'pngjs';

export type Rgba = [number, number, number, number];
export const hex = (h: string): Rgba => [
  parseInt(h.slice(1, 3), 16),
  parseInt(h.slice(3, 5), 16),
  parseInt(h.slice(5, 7), 16),
  255,
];
export const mix = (a: Rgba, b: Rgba, t: number): Rgba => [
  Math.round(a[0] + (b[0] - a[0]) * t),
  Math.round(a[1] + (b[1] - a[1]) * t),
  Math.round(a[2] + (b[2] - a[2]) * t),
  255,
];

export class Img {
  readonly data: Uint8Array;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.data = new Uint8Array(w * h * 4);
  }
  static read(file: string): Img {
    const p = PNG.sync.read(fs.readFileSync(file));
    const img = new Img(p.width, p.height);
    img.data.set(p.data);
    return img;
  }
  set(x: number, y: number, c: Rgba): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    this.data.set(c, (y * this.w + x) * 4);
  }
  get(x: number, y: number): Rgba | null {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return null;
    const i = (y * this.w + x) * 4;
    return this.data[i + 3] ? [this.data[i], this.data[i + 1], this.data[i + 2], 255] : null;
  }
  write(file: string): void {
    const png = new PNG({ width: this.w, height: this.h });
    png.data.set(this.data);
    fs.writeFileSync(file, PNG.sync.write(png));
  }
  /** Columns x0..x1-1, rows y0..y1-1. */
  crop(x0: number, y0: number, x1: number, y1: number): Img {
    const out = new Img(x1 - x0, y1 - y0);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const c = this.get(x, y);
        if (c) out.set(x - x0, y - y0, c);
      }
    return out;
  }
  /** The bounds of the opaque pixels. */
  bounds(): { x0: number; y0: number; x1: number; y1: number } {
    let [x0, y0, x1, y1] = [this.w, this.h, 0, 0];
    for (let y = 0; y < this.h; y++)
      for (let x = 0; x < this.w; x++)
        if (this.get(x, y))
          [x0, y0, x1, y1] = [
            Math.min(x0, x),
            Math.min(y0, y),
            Math.max(x1, x + 1),
            Math.max(y1, y + 1),
          ];
    return { x0, y0, x1, y1 };
  }
  trim(): Img {
    const b = this.bounds();
    return this.crop(b.x0, b.y0, b.x1, b.y1);
  }
}
