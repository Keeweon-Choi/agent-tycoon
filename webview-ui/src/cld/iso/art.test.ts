import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { ISO_MASTER_DENSITY, ISO_WALL_H } from '../../constants.js';
import { artDensity, ISO_MANIFEST, neededFiles } from './art.js';
import manifest from './art/manifest.json';
import ownerReport from './art/report-owner.json';

const DIR = path.join(__dirname, 'art');
const read = (f: string) => PNG.sync.read(fs.readFileSync(path.join(DIR, f)));
const HW = 8 * ISO_MASTER_DENSITY;
const HH = 4 * ISO_MASTER_DENSITY;

describe('pilot pieces still drawn from the starter pack or the script', () => {
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

  it('draws the density that divides the zoom', () => {
    expect([1, 2, 3, 4, 6, 8].map(artDensity)).toEqual([1, 2, 1, 4, 2, 4]);
  });
});

describe("the owner's pieces (gen-iso-objects.ts)", () => {
  const pieces = Object.entries(ISO_MANIFEST.pieces).filter(
    ([, p]) => p.density === ISO_MASTER_DENSITY,
  );

  it('has all 42 objects and the two derived pieces, one master PNG each at density 12', () => {
    expect(pieces.length).toBe(44);
    for (const [name, p] of pieces) {
      const png = read(p.file);
      expect(Number.isInteger(p.anchor[0]) && Number.isInteger(p.anchor[1]), name).toBe(true);
      // The anchor is on the picture or in the footprint's own diamond's reach of it.
      expect(p.anchor[0] >= -HW && p.anchor[0] <= png.width + 3 * HW, name).toBe(true);
      expect(p.anchor[1] >= 0 && p.anchor[1] <= png.height + 3 * HH, name).toBe(true);
      expect(p.footprint.length).toBe(2);
    }
  });

  it('cut the pictures clean: transparent around every object, no backdrop or halo left', () => {
    // The generator's own report, tolerances applied there (halo share, wall base, ...): the
    // only thing it may still flag is a spare piece's base, which no building uses.
    expect(ownerReport.flags.filter((f) => !f.startsWith('wall-window-wide'))).toEqual([]);
    for (const [name, p] of pieces) {
      const png = read(p.file);
      // A transparent corner: nothing of a backdrop box is left around the object.
      const corners = [
        0,
        (png.width - 1) * 4,
        (png.height - 1) * png.width * 4,
        png.data.length - 4,
      ];
      expect(
        corners.some((c) => png.data[c + 3] === 0),
        name,
      ).toBe(true);
    }
  });

  it('puts every floor on the exact 192x96 diamond of one tile', () => {
    for (const name of new Set(Object.values(ISO_MANIFEST.floors))) {
      const p = ISO_MANIFEST.pieces[name];
      const png = read(p.file);
      expect([png.width, png.height], name).toEqual([2 * HW, 2 * HH]);
      expect(p.anchor).toEqual([HW, 2 * HH]);
      for (let y = 0; y < png.height; y++)
        for (let x = 0; x < png.width; x++) {
          const a = (x + 0.5 - HW) / HW;
          const b = (y + 0.5) / HH;
          const inside = (a + b) / 2 > 0 && (b - a) / 2 > 0 && (a + b) / 2 < 1 && (b - a) / 2 < 1;
          if (png.data[(y * png.width + x) * 4 + 3] > 0 !== inside)
            throw new Error(
              `${name}: pixel ${x},${y} ${inside ? 'missing' : 'outside the diamond'}`,
            );
        }
    }
  });

  it('stands every wall on the 1:2 slope of its tiles at the building height', () => {
    for (const [name, p] of pieces) {
      if (!p.wall || name === 'o-wall-window-wide') continue;
      const png = read(p.file);
      const bottom = (x: number) => {
        for (let y = png.height - 1; y >= 0; y--)
          if (png.data[(y * png.width + x) * 4 + 3]) return y + 1;
        return -1;
      };
      const top = (x: number) => {
        for (let y = 0; y < png.height; y++) if (png.data[(y * png.width + x) * 4 + 3]) return y;
        return -1;
      };
      const [sx, sy] = p.wall.start;
      for (let j = 1; j < p.wall.n; j++) {
        const x = sx + j * HW;
        // One art stair-step (about 8 px at this density) is the base's own roughness.
        expect(Math.abs(bottom(x) - (sy + j * HH)), `${name} tile ${j}`).toBeLessThanOrEqual(10);
      }
      // Height away from the ends: cap to baseboard is the wall height of the building (its top
      // lands on ISO_WALL_H above the floor at the back corner, the base two half diamonds below).
      const x = sx + Math.floor(p.wall.n / 2) * HW;
      expect(
        Math.abs(bottom(x) - top(x) - (ISO_WALL_H + 2 * 4) * ISO_MASTER_DENSITY),
        name,
      ).toBeLessThanOrEqual(12);
    }
  });

  it('maps every type, floor and facing to a piece that exists, and decodes only what is used', () => {
    for (const [type, t] of Object.entries(ISO_MANIFEST.types))
      expect(t.piece === 'none' || t.piece in ISO_MANIFEST.pieces, type).toBe(true);
    for (const name of Object.values(ISO_MANIFEST.floors))
      expect(name in ISO_MANIFEST.pieces).toBe(true);
    for (const [group, by] of Object.entries(ISO_MANIFEST.facings))
      for (const [facing, f] of Object.entries(by))
        expect(f!.piece in ISO_MANIFEST.pieces, `${group} ${facing}`).toBe(true);
    const needed = neededFiles();
    expect(needed.has('o-floor-wood-light.png')).toBe(true);
    // A spare variant nothing uses is not decoded.
    expect(needed.has('o-wall-window-wide.png')).toBe(false);
    expect(needed.has('o-rug-round.png')).toBe(false);
  });
});
