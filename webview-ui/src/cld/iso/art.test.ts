import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { artDensity } from './art.js';
import manifest from './art/manifest.json';

const DIR = path.join(__dirname, 'art');
const read = (f: string) => PNG.sync.read(fs.readFileSync(path.join(DIR, f)));

describe('iso pieces', () => {
  const pieces = manifest.pieces as Record<
    string,
    { file: string; density: number; footprint: number[]; anchor: number[] }
  >;

  it('has every piece at densities 4, 2 and 1, its anchor on or by the picture', () => {
    for (const [name, p] of Object.entries(pieces)) {
      const png = read(p.file);
      expect(p.density, name).toBe(4);
      // On the picture, or a tile at most off it (a piece set in from its footprint's corner).
      expect(p.anchor[0] >= -64 && p.anchor[0] <= png.width + 64, name).toBe(true);
      expect(p.anchor[1] >= -32 && p.anchor[1] <= png.height + 32, name).toBe(true);
      for (const d of [2, 1]) {
        const lod = read(p.file.replace(/\.png$/, `@${d}.png`));
        // One block more where the blocks are aligned on the anchor.
        expect(Math.abs(lod.width - png.width / (4 / d)), `${name}@${d}`).toBeLessThanOrEqual(2);
      }
    }
  });

  it('cut the pack clean: no backdrop magenta or halo, transparent around every object', () => {
    const report = JSON.parse(fs.readFileSync(path.join(DIR, 'report.json'), 'utf-8')) as Record<
      string,
      { leftover?: { magenta: number; halo: number }; edgeTouching?: number }
    >;
    for (const [name, r] of Object.entries(report)) {
      if (r.leftover) expect(r.leftover, name).toEqual({ magenta: 0, halo: expect.any(Number) });
      if (r.leftover) expect(r.leftover.halo, name).toBeLessThanOrEqual(2);
      if (r.edgeTouching !== undefined) expect(r.edgeTouching, name).toBe(0);
    }
    // A floor diamond is exactly the 64×32 tile, its corners transparent.
    const floor = read('floor-wood-light.png');
    expect([floor.width, floor.height]).toEqual([64, 32]);
    expect(floor.data[3]).toBe(0);
    expect(floor.data[(16 * 64 + 32) * 4 + 3]).toBe(255);
  });

  it('maps every furniture type to a piece that exists (or to none)', () => {
    for (const [type, t] of Object.entries(manifest.types as Record<string, { piece: string }>))
      expect(t.piece === 'none' || t.piece in pieces, type).toBe(true);
    for (const name of Object.values(manifest.floors)) expect(name in pieces).toBe(true);
  });

  it('draws the density that divides the zoom', () => {
    expect([1, 2, 3, 4, 6, 8].map(artDensity)).toEqual([1, 2, 1, 4, 2, 4]);
  });
});
