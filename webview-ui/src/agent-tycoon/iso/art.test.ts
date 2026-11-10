import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { ISO_MASTER_DENSITY, ISO_WALL_H } from '../../constants.js';
import {
  artDensity,
  ISO_MANIFEST,
  isoArt,
  type IsoImage,
  neededFiles,
  playingFrame,
} from './art.js';
import manifest from './art/manifest.json';
import ownerReport from './art/report-owner.json';
import { shipScales } from './ship.js';

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

  it('has all 42 objects, the model-drawn water cooler and the two derived pieces, one master PNG each at density 12', () => {
    expect(pieces.length).toBe(45);
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
    // only thing it may still flag is a spare piece (wall base off the stair line, a stray pixel),
    // which no building uses.
    const used = neededFiles();
    expect(ownerReport.flags.filter((f) => used.has(`o-${f.split(':')[0]}.png`))).toEqual([]);
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
    expect(needed.has('o-wall-entrance-a.png')).toBe(false);
  });

  // iso-prep-1104: the isometric view draws every catalog type in its own picture.
  it('gives every furniture type of the catalog its isometric picture, turned ones flipped', () => {
    const FURN = path.join(__dirname, '../../../public/assets/furniture');
    type Member = { id?: string; type: string; mirrorSide?: boolean; members?: Member[] };
    const ids: string[] = [];
    const walk = (m: Member) => {
      if (m.type === 'asset' && m.id) ids.push(m.id, ...(m.mirrorSide ? [`${m.id}:left`] : []));
      m.members?.forEach(walk);
    };
    for (const dir of fs.readdirSync(FURN))
      walk(JSON.parse(fs.readFileSync(path.join(FURN, dir, 'manifest.json'), 'utf-8')) as Member);
    // Not drawn in isometric yet (the top-down sprite stands in), or an on-state of a machine
    // (the placed type stays the machine's own).
    const topDownOnly = new Set([
      'CLOCK',
      'HANGING_PLANT',
      'LARGE_PAINTING',
      'PENDANT_LAMP',
      'SMALL_PAINTING',
      'SMALL_PAINTING_2',
      'TABLE_FRONT',
      'WOODEN_BENCH',
      ...[1, 2, 3].flatMap((k) => [`COFFEE_MACHINE_${k}`, `VENDING_MACHINE_${k}`]),
    ]);
    const missing = ids.filter((id) => !ISO_MANIFEST.types[id] && !topDownOnly.has(id));
    expect(missing).toEqual([]);
    for (const [side, front] of [
      ['DESK_SIDE', 'DESK_FRONT'],
      ['DESK_B_SIDE', 'DESK_B_FRONT'],
      ['SMALL_TABLE_SIDE', 'SMALL_TABLE_FRONT'],
    ])
      expect(ISO_MANIFEST.types[side], side).toEqual({
        piece: ISO_MANIFEST.types[front].piece,
        mirror: true,
      });
    // Every picture the owner drew is worn by a type (a seat's other facing, or a wall, counts).
    const worn = new Set([
      ...Object.values(ISO_MANIFEST.types).map((t) => t.piece),
      ...Object.values(ISO_MANIFEST.facings).flatMap((g) => Object.values(g).map((f) => f!.piece)),
    ]);
    for (const name of [
      'o-desk-b',
      'o-cabinet-a',
      'o-cabinet-b',
      'o-armchair-a',
      'o-armchair-b',
      'o-coffee-table-b',
      'o-whiteboard-b',
      'o-rug-round',
    ])
      expect(
        Object.values(ISO_MANIFEST.types).some((t) => t.piece === name) && worn.has(name),
        name,
      ).toBe(true);
    expect(ISO_MANIFEST.pieces['o-rug-round'].flat).toBe(true);
    // The water cooler's taps face the lower right: flipped, it faces the room like the machines.
    expect(ISO_MANIFEST.types.WATER_COOLER).toEqual({ piece: 'o-water-cooler', mirror: true });
  });
});

describe('C1: machines that play frames', () => {
  const coffee = ['COFFEE_MACHINE_1', 'COFFEE_MACHINE_2', 'COFFEE_MACHINE_3'];

  it('shows frame 0 idle and frame k+1 while the furniture plays its on-state k', () => {
    expect(playingFrame(undefined, coffee, 4)).toBe(0);
    expect(coffee.map((t) => playingFrame(t, coffee, 4))).toEqual([1, 2, 3]);
    expect(playingFrame('SOMETHING_ELSE', coffee, 4)).toBe(0);
    expect(playingFrame('COFFEE_MACHINE_3', coffee, 2)).toBe(1); // fewer pictures: the last
  });

  it('maps the pantry machines to pieces whose frames exist at one size and are decoded', () => {
    const needed = neededFiles();
    for (const type of ['COFFEE_MACHINE', 'VENDING_MACHINE']) {
      const p = ISO_MANIFEST.pieces[ISO_MANIFEST.types[type].piece];
      expect(p.frames?.length, type).toBe(4);
      const sizes = new Set(p.frames!.map((f) => `${read(f).width}x${read(f).height}`));
      expect(sizes.size, type).toBe(1);
      for (const f of p.frames!) expect(needed.has(f), f).toBe(true);
    }
  });
});

// iso-prep-1104: the build ships each master at the size it is drawn (vite.config.ts isoShipPlugin).
describe('pictures shipped at the size they are drawn', () => {
  const k = shipScales(ISO_MANIFEST);

  it('ships floors, back walls and the rug at the floor cache density, machines at max zoom', () => {
    const m = ISO_MANIFEST;
    for (const name of [
      ...Object.values(m.floors),
      m.walls.row.piece,
      m.walls.col.piece,
      m.walls.window.piece,
      m.walls.corner,
      'o-rug-round',
    ])
      expect(ISO_MANIFEST.pieces[name].density / k.get(ISO_MANIFEST.pieces[name].file)!, name).toBe(
        4,
      );
    for (const f of ISO_MANIFEST.pieces['o-vending'].frames!) expect(k.get(f), f).toBe(2);
    // Drawn live up to zoom 10 from density 12: no whole factor fits, shipped as is.
    for (const name of ['o-desk', 'o-chair-down', 'o-wall-low', 'o-wall-lift'])
      expect(k.has(ISO_MANIFEST.pieces[name].file), name).toBe(false);
  });

  it('reads a shipped copy with its anchor and density divided by its factor', () => {
    const img = { w: 1, h: 1 } as IsoImage;
    const p = ISO_MANIFEST.pieces['o-wall-plain'];
    const a = isoArt(new Map([[p.file, img]]), 'o-wall-plain', 4)!;
    expect(a).toMatchObject({ d: 4, k: 3, ax: p.anchor[0] / 3, ay: p.anchor[1] / 3 });
    const desk = ISO_MANIFEST.pieces['o-desk'];
    expect(isoArt(new Map([[desk.file, img]]), 'o-desk', 4)).toMatchObject({ d: 12, k: 1 });
  });
});
