/**
 * ISO-2 art: the owner's 42 individual isometric objects (10-26: one object per image, a flat
 * magenta or pink background; `/specs/owner-iso-objs-1026/batch1..3`) become game assets in
 * webview-ui/src/cld/iso/art/ (`o-<id>.png`, one master per object) and `owner-manifest.json`,
 * which art.ts merges over the pilot's manifest.
 *
 * What the owner asked for (10-26 00:52, 03:10): furniture detailed enough, sized to the tile
 * grid in the game; not the old front-facing vending machine tilted; not a catalog sheet cut up;
 * the alignment on the real tile grid and the transparent background verified. So each object:
 *  - the background (read from the picture's border) and its halo removed, a clean 1-bit edge
 *    (lib/isoObjects.ts matte);
 *  - fitted to the grid at density 12 (coordinator 10-26: one master from which every zoom is
 *    drawn, smooth when shrunk; a 16 px world tile is a 192×96 diamond) by area averaging only:
 *    no palette, no nearest-neighbour: the owner's detail stays;
 *      floors   the tile's top face mapped on the diamond;
 *      flat     a rug mapped on the footprint's diamond;
 *      objects  uniform scale so the base spans its footprint, its lowest point on the front corner;
 *      walls    the run to a whole number of tiles, the height to the building's wall height, the
 *               base on the exact 1:2 slope so strips of one tile join (the renderer cuts them);
 *  - its id, footprint, slot (the footprint the game blocks), facing, anchor (the pixel on the
 *    footprint's front corner) and seat points in the manifest; the other facing mirrored.
 * Reports: report-owner.json (per object: alignment error in px, leftover background and halo,
 * opaque pixels on the picture's edge, flags over the tolerances) and a review sheet assembled
 * from the individual files (cld/artifacts/iso-2/review-sheet.png): footprint outlines, anchor
 * dots, seat points. The source pictures are never copied into the repo.
 *
 *   npx tsx cld/scripts/gen-iso-objects.ts [--src <dir with batch1 batch2 batch3>]
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import { ISO_HALF_H, ISO_WALL_H } from '../../webview-ui/src/constants.js';
import { Img } from './lib/img.js';
import type { Cut, Out } from './lib/isoObjects.js';
import {
  baseOf,
  check,
  contours,
  cropOut,
  decontaminate,
  fitFloor,
  fitWall,
  HH,
  HW,
  ISO_DENSITY,
  matte,
  mirrorCut,
  mirrorOut,
  resample,
  resampleUniform,
  resampleWall,
  trimOut,
} from './lib/isoObjects.js';

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'webview-ui/src/cld/iso/art');
const SHEET_OUT = path.join(ROOT, 'cld/artifacts/iso-2');
const srcArg = process.argv.indexOf('--src');
const SRC =
  srcArg > 0 ? process.argv[srcArg + 1] : path.resolve(ROOT, '../specs/owner-iso-objs-1026');

/** The wall's height at a column, cap to baseboard (iso px): its cap top lands on the height the
 *  stack's boxes assume (ISO_WALL_H above the floor at the back corner, whose base is two
 *  half-diamonds down). */
const WALL_COLUMN_H = ISO_WALL_H + 2 * ISO_HALF_H;
/** Tolerances (output px at density 12; the pilot's, scaled from density 4; a wall's base is
 *  measured against the art's own pixel stair-steps, about 8 px at this density). */
const TOL = { floorPx: 4.5, basePx: 12, wallDevPx: 7, haloShare: 0.003 };

// ── The objects ──────────────────────────────────────────────

type Facing = '+row' | '+col' | '-row' | '-col' | 'none';
type Spec = { id: string; note: string } & (
  | { kind: 'floor' }
  | { kind: 'flat'; fp: [number, number] }
  | {
      kind: 'obj';
      fp: [number, number];
      /** What the game blocks; the object stands on its front corner or centred in it. */
      slot?: [number, number];
      align?: 'front' | 'center';
      faces: Facing;
      /** Its size in the game: its height in iso px, or its width as a share of its footprint's
       *  diamond (the larger the object the more it overhangs; a bookshelf is tall, a sofa wide). */
      h?: number;
      w?: number;
      /** A seat: its height above the floor (iso px) and the seats along the long axis. */
      seat?: { z: number; count?: number; dx?: number; dy?: number };
      /** What stands on it is lifted this many iso px. */
      surface?: number;
      /** Stands on the floor even on a wall tile (not hung). */
      stands?: boolean;
    }
  | {
      kind: 'wall';
      role: 'plain' | 'window' | 'door' | 'entrance' | 'lift' | 'corner';
      flip?: boolean;
    }
);

/** Korean file name (batch/name, without the odd private-use character one name carries) -> id.
 *  The table keeps the owner's names next to what each became. */
const OBJECTS: Record<string, Spec> = {
  '1/同心花纹像素地毯': { id: 'rug-round', kind: 'flat', fp: [3, 3], note: 'round rug' },
  '1/네온 핑크 배경의 픽셀 선인장 화분': {
    id: 'cactus',
    kind: 'obj',
    fp: [1, 1],
    h: 18,
    faces: 'none',
    note: 'cactus pot',
  },
  '1/레트로 픽셀 엘리베이터 벽면': {
    id: 'wall-lift-retro',
    kind: 'wall',
    role: 'lift',
    note: 'retro elevator wall',
  },
  '1/마젠타 배경의 대리석 타일': { id: 'floor-marble', kind: 'floor', note: 'marble floor' },
  '1/마젠타 배경의 아이소메트릭 유리 출입구': {
    id: 'wall-entrance-a',
    kind: 'wall',
    role: 'entrance',
    note: 'glass entrance',
  },
  '1/마젠타 배경의 이끼빛 책장': {
    id: 'bookshelf-moss',
    kind: 'obj',
    fp: [1, 1],
    slot: [2, 1],
    align: 'center',
    h: 38,
    faces: '+row',
    note: 'mossy bookshelf',
  },
  '1/마젠타 배경의 이동식 화이트보드': {
    id: 'whiteboard-a',
    stands: true,
    kind: 'obj',
    fp: [2, 1],
    w: 1,
    slot: [2, 2],
    align: 'front',
    faces: '+row',
    note: 'mobile whiteboard',
  },
  '1/마젠타 배경의 픽셀 몬스테라 화분': {
    id: 'monstera',
    kind: 'obj',
    fp: [1, 1],
    h: 26,
    faces: 'none',
    note: 'monstera pot',
  },
  '1/마젠타 배경의 픽셀 서류 캐비닛': {
    id: 'cabinet-a',
    kind: 'obj',
    fp: [1, 1],
    h: 24,
    faces: '+row',
    note: 'filing cabinet',
  },
  '1/마젠타 배경의 픽셀 소파': {
    id: 'sofa-a',
    kind: 'obj',
    fp: [2, 1],
    w: 1,
    faces: '+row',
    seat: { z: 3, count: 2 },
    note: 'sofa',
  },
  '1/마젠타 배경의 픽셀 쓰레기통': {
    id: 'bin',
    kind: 'obj',
    fp: [1, 1],
    h: 12,
    faces: 'none',
    note: 'trash bin',
  },
  '1/마젠타 배경의 픽셀 아트 사무용 의자': {
    id: 'chair-up',
    kind: 'obj',
    fp: [1, 1],
    h: 24,
    faces: '-row',
    seat: { z: 6.5 },
    note: 'office chair seen from behind (faces the upper right)',
  },
  '1/마젠타 배경의 픽셀 아트 의자': {
    id: 'chair-left',
    kind: 'obj',
    fp: [1, 1],
    h: 24,
    faces: '-col',
    seat: { z: 6.5 },
    note: 'office chair seen from behind (faces the upper left)',
  },
  '1/마젠타 배경의 픽셀 야자 화분': {
    id: 'palm',
    kind: 'obj',
    fp: [1, 1],
    h: 34,
    faces: 'none',
    note: 'palm in a square pot',
  },
  '2/마젠타 배경의 픽셀 오피스 데스크': {
    id: 'desk',
    kind: 'obj',
    fp: [3, 1],
    w: 0.97,
    slot: [3, 2],
    align: 'front',
    faces: '+row',
    surface: 12,
    note: 'office desk',
  },
  '2/마젠타 배경의 픽셀 카펫 타일': {
    id: 'floor-carpet-blue',
    kind: 'floor',
    note: 'blue carpet tile',
  },
  '2/마젠타 배경의 픽셀 커피 테이블': {
    id: 'coffee-table-b',
    kind: 'obj',
    fp: [2, 1],
    w: 0.97,
    slot: [2, 2],
    align: 'center',
    faces: 'none',
    note: 'coffee table',
  },
  '2/분홍 배경의 아늑한 픽셀 안락의자': {
    id: 'armchair-a',
    kind: 'obj',
    fp: [1, 1],
    w: 0.95,
    faces: '+row',
    seat: { z: 4.3 },
    note: 'armchair',
  },
  '2/분홍 배경의 아이소메트릭 픽셀 엘리베이터': {
    id: 'wall-lift-b',
    kind: 'wall',
    role: 'lift',
    note: 'elevator wall (call button on the left)',
  },
  '2/분홍 배경의 야경 창문 벽면': {
    id: 'wall-window-single',
    kind: 'wall',
    role: 'window',
    note: 'night window wall, one window',
  },
  '2/분홍 배경의 픽셀 안락의자와 쿠션': {
    id: 'armchair-b',
    kind: 'obj',
    fp: [1, 1],
    w: 0.95,
    faces: '+col',
    seat: { z: 4.3 },
    note: 'armchair with a cushion',
  },
  '2/분홍빛 픽셀 카펫 타일': { id: 'floor-carpet-pink', kind: 'floor', note: 'pink carpet tile' },
  '2/아이소메트릭 모던 도어 벽면': {
    id: 'wall-door-tall',
    kind: 'wall',
    role: 'door',
    note: 'modern door wall',
  },
  '2/아이소메트릭 야경 도시 창문 벽': {
    id: 'wall-window-wide',
    kind: 'wall',
    role: 'window',
    flip: true,
    note: 'night city window wall, three windows (running down to the left)',
  },
  '2/아이소메트릭 크림 벽 코너 모듈': {
    id: 'wall-corner',
    kind: 'wall',
    role: 'corner',
    note: 'cream wall corner',
  },
  '2/아이소메트릭 픽셀 엘리베이터 벽면': {
    id: 'wall-lift',
    kind: 'wall',
    role: 'lift',
    flip: true,
    note: 'elevator wall',
  },
  '2/이색 배경의 아늑한 픽셀 책장': {
    id: 'bookshelf-cozy',
    kind: 'obj',
    fp: [1, 1],
    slot: [2, 1],
    align: 'center',
    h: 38,
    faces: '+row',
    note: 'cozy bookshelf',
  },
  '2/이소메트릭 벽 장식 스프라이트': {
    id: 'wall-plain',
    kind: 'wall',
    role: 'plain',
    note: 'cream wall panel (running down to the right)',
  },
  '3/이소메트릭 야경 창문 벽면': {
    id: 'wall-window',
    kind: 'wall',
    role: 'window',
    note: 'night window wall',
  },
  '3/이소메트릭 크림색 벽 패널': {
    id: 'wall-plain-b',
    kind: 'wall',
    role: 'plain',
    flip: true,
    note: 'cream wall panel (running down to the left)',
  },
  '3/이소메트릭 픽셀 아트 나무 바닥 타일': {
    id: 'floor-wood-dark',
    kind: 'floor',
    note: 'dark wood floor',
  },
  '3/이소메트릭 픽셀 아트 문 벽면': {
    id: 'wall-door',
    kind: 'wall',
    role: 'door',
    flip: true,
    note: 'door wall',
  },
  '3/이소메트릭 픽셀 아트 사무용 의자': {
    id: 'chair-right',
    kind: 'obj',
    fp: [1, 1],
    h: 24,
    faces: '+col',
    seat: { z: 6.5 },
    note: 'office chair seen from the front (faces the lower right)',
  },
  '3/이소메트릭 픽셀 아트 원목 바닥 타일': {
    id: 'floor-wood-light',
    kind: 'floor',
    note: 'light wood floor',
  },
  '3/이소메트릭 픽셀 파일 캐비닛': {
    id: 'cabinet-b',
    kind: 'obj',
    fp: [1, 1],
    h: 24,
    faces: '+col',
    note: 'filing cabinet, other side',
  },
  '3/이소메트릭 픽셀 화이트보드 아이디어맵': {
    id: 'whiteboard-b',
    stands: true,
    kind: 'obj',
    fp: [1, 2],
    w: 1,
    slot: [2, 2],
    align: 'front',
    faces: '+col',
    note: 'mobile whiteboard, other side',
  },
  '3/이소메트릭 픽셀아트 유리 출입구': {
    id: 'wall-entrance-b',
    kind: 'wall',
    role: 'entrance',
    note: 'glass entrance',
  },
  '3/픽셀 아트 블루그레이 사무용 의자': {
    id: 'chair-down',
    kind: 'obj',
    fp: [1, 1],
    h: 24,
    faces: '+row',
    seat: { z: 6.5 },
    note: 'office chair seen from the front (faces the lower left)',
  },
  '3/픽셀 아트 아이소메트릭 오피스 데스크': {
    id: 'desk-b',
    kind: 'obj',
    fp: [3, 1],
    w: 0.97,
    slot: [3, 2],
    align: 'front',
    faces: '+row',
    surface: 12,
    note: 'office desk, other make',
  },
  '3/픽셀 아트 원목 커피 테이블': {
    id: 'coffee-table',
    kind: 'obj',
    fp: [2, 1],
    w: 0.97,
    slot: [2, 2],
    align: 'center',
    faces: 'none',
    note: 'wooden coffee table',
  },
  '3/픽셀 아트 회색 석재 타일 플랫폼': {
    id: 'floor-stone',
    kind: 'floor',
    note: 'grey stone tile platform',
  },
  '3/핑크 배경의 픽셀 아트 소파': {
    id: 'sofa-b',
    kind: 'obj',
    fp: [1, 2],
    w: 1,
    faces: '+col',
    seat: { z: 4, count: 2 },
    note: 'sofa, other side',
  },
};

/** Letters, digits and spaces only: drops the private-use character one file name carries. */
const normal = (n: string) => n.replace(/\.png$/, '').replace(/[^\p{L}\p{N} ]/gu, '');

// ── Output ───────────────────────────────────────────────────

interface Piece {
  file: string;
  density: number;
  footprint: [number, number];
  slot?: [number, number];
  anchor: [number, number];
  faces: Facing;
  surface?: number;
  /** Seat points of a chair, armchair or sofa: iso px from the anchor, for the piece as drawn. */
  seats?: Array<[number, number]>;
  /** A wall: tiles of run, where the run starts on its base (the strips are cut from there). */
  wall?: { along: 'row' | 'col'; n: number; start: [number, number]; role: string };
  from: string;
}
const pieces: Record<string, Piece> = {};
const report: Record<string, Record<string, unknown>> = {};
const flags: string[] = [];
const outs: Record<string, Out> = {};

function toPng(o: Out): Buffer {
  const png = new PNG({ width: o.w, height: o.h });
  png.data.set(o.data);
  return PNG.sync.write(png);
}

function save(id: string, o: Out, p: Omit<Piece, 'file' | 'density'>): void {
  decontaminate(o);
  fs.writeFileSync(path.join(OUT, `o-${id}.png`), toPng(o));
  pieces[`o-${id}`] = { file: `o-${id}.png`, density: ISO_DENSITY, ...p };
  outs[`o-${id}`] = o;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

// ── Pipeline per kind ────────────────────────────────────────

function readCut(file: string): Cut {
  const p = PNG.sync.read(fs.readFileSync(file));
  return matte({ w: p.width, h: p.height, data: p.data });
}

/** Seat points of a piece standing on its footprint (iso px from the anchor): the centre of
 *  its footprint (the front corner moved back by half the footprint) lifted by the seat's
 *  height; several seats spread along the long axis. */
function seatsFor(
  fp: [number, number],
  seat: { z: number; count?: number; dx?: number; dy?: number },
  front: 'footprint',
): Array<[number, number]> {
  void front;
  const [fw, fh] = fp;
  const cx = ((fh - fw) / 2) * (HW / ISO_DENSITY);
  const cy = (-(fw + fh) / 2) * (HH / ISO_DENSITY) - seat.z;
  const n = seat.count ?? 1;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * (Math.max(fw, fh) - 1);
    // Along +col (the footprint's width) when it is wider than deep, else along +row.
    const [ux, uy] =
      fw >= fh ? [HW / ISO_DENSITY, HH / ISO_DENSITY] : [-HW / ISO_DENSITY, HH / ISO_DENSITY];
    out.push([round1(cx + t * ux + (seat.dx ?? 0)), round1(cy + t * uy + (seat.dy ?? 0))]);
  }
  return out;
}

function doFloor(s: Spec & { kind: 'floor' }, cut: Cut): void {
  const f = fitFloor(cut, 0.012);
  save(s.id, f.out, { footprint: [1, 1], anchor: [HW, 2 * HH], faces: 'none', from: s.note });
  const c = check(f.out);
  report[s.id] = {
    kind: 'floor',
    alignErrorPx: { ratio: round1(f.err.ratio), skew: round1(f.err.skew) },
    leftover: c,
    size: [f.out.w, f.out.h],
  };
  if (f.err.ratio > TOL.floorPx || f.err.skew > TOL.floorPx)
    flags.push(`${s.id}: diamond off by ${round1(Math.max(f.err.ratio, f.err.skew))} px`);
}

function doFlat(s: Spec & { kind: 'flat' }, cut: Cut): void {
  // Flat on the floor: both axes fitted to the footprint's diamond (its bounds).
  const [fw, fh] = s.fp;
  const w = (fw + fh) * HW;
  const h = (fw + fh) * HH;
  const kx = w / cut.w;
  const ky = h / cut.h;
  const out = trimOut(resample(cut, (X, Y) => [X / kx, Y / ky], w, h, 0, 0, Math.min(kx, ky)));
  save(s.id, out.img, {
    footprint: s.fp,
    anchor: [fh * HW - out.x, (fw + fh) * HH - out.y],
    faces: 'none',
    from: s.note,
  });
  report[s.id] = {
    kind: 'flat',
    scale: [round1(kx), round1(ky)],
    leftover: check(out.img),
    size: [out.img.w, out.img.h],
  };
}

function doObj(s: Spec & { kind: 'obj' }, cut: Cut): void {
  const [fw, fh] = s.fp;
  const slot = s.slot ?? s.fp;
  const base = baseOf(cut);
  const k = s.h ? (s.h * ISO_DENSITY) / cut.h : ((s.w ?? 1) * (fw + fh) * HW) / cut.w;
  // The footprint's front corner: from the base's centre, half the footprint forward.
  const front: [number, number] = [
    base.cx + (((fw - fh) / 2) * HW) / k,
    base.cy + (((fw + fh) / 2) * HH) / k,
  ];
  const r = resampleUniform(cut, k, front, [0, 0]);
  // The anchor is the slot's front corner: the object's own when it stands in front of its slot,
  // else (centred) the slot's corner relative to the object's.
  let [ax, ay] = r.anchor;
  if (s.align === 'center') {
    ax += ((slot[0] - slot[1] - (fw - fh)) / 2) * HW;
    ay += ((slot[0] + slot[1] - (fw + fh)) / 2) * HH;
  }
  ax = Math.round(ax);
  ay = Math.round(ay);
  const seats = s.seat ? seatsFor(s.fp, s.seat, 'footprint') : undefined;
  save(s.id, r.out, {
    footprint: s.fp,
    ...(slot !== s.fp && { slot }),
    anchor: [ax, ay],
    faces: s.faces,
    ...(s.surface && { surface: s.surface * ISO_DENSITY }),
    ...(s.stands && { stands: true }),
    ...(seats && { seats }),
    from: s.note,
  });
  const diamond = (fw + fh) * HW;
  const over = base.w * k - diamond;
  report[s.id] = {
    kind: 'object',
    footprint: s.fp,
    scale: Math.round(k * 1000) / 1000,
    baseWidthPx: Math.round(base.w * k),
    footprintWidthPx: diamond,
    overhangPx: round1(over),
    leftover: check(r.out),
    size: [r.out.w, r.out.h],
  };
  // The base reaches past its footprint: it would stand on the neighbouring tile's floor.
  if (over > TOL.basePx)
    flags.push(`${s.id}: base ${round1(over)} px wider than its ${fw}x${fh} diamond`);
}

/** Source px of gap between door columns that still belong to one pair of doors. */
const LIFT_GAP = 25;

/** The doors of an elevator wall (running down to the right): the columns where the middle of
 *  the wall is mostly darker than plaster (the doors and their frame; the call button panel
 *  beside them covers less than half the height), their widest run, in source px. */
function liftDoors(cut: Cut): [number, number] {
  const y0 = Math.round(cut.h * 0.3);
  const y1 = Math.round(cut.h * 0.65);
  const cols: number[] = [];
  for (let x = 0; x < cut.w; x++) {
    let n = 0;
    for (let y = y0; y < y1; y++) {
      const i = y * cut.w + x;
      if (
        cut.mask[i] &&
        0.3 * cut.rgb[i * 3] + 0.59 * cut.rgb[i * 3 + 1] + 0.11 * cut.rgb[i * 3 + 2] < 195
      )
        n++;
    }
    if (n > (y1 - y0) * 0.55) cols.push(x);
  }
  let best: [number, number] = [0, 0];
  let from = -1;
  let prev = -2;
  for (const x of [...cols, Infinity]) {
    // The leaves' seam and the frame's edges break the run: join across small gaps.
    if (x > prev + LIFT_GAP) {
      if (from >= 0 && prev - from > best[1] - best[0]) best = [from, prev + 1];
      from = x;
    }
    prev = x;
  }
  return best;
}

function doWall(s: Spec & { kind: 'wall' }, cut0: Cut): void {
  // A wall running down to the left is fitted as one running down to the right, mirrored.
  const cut = s.flip ? mirrorCut(cut0) : cut0;
  if (s.role === 'corner') return doCorner(s, cut);
  const f = fitWall(cut);
  const ky = (WALL_COLUMN_H * ISO_DENSITY) / f.height;
  let kx = ky;
  let n = Math.max(1, Math.round((f.run * ky) / HW));
  let crop: [number, number] | null = null;
  if (s.role === 'lift') {
    // The doors two tiles wide (an elevator takes two wall tiles), half a tile of wall each side.
    const [d0, d1] = liftDoors(cut);
    kx = (2 * HW) / (d1 - d0);
    const x0 = 2 * Math.round(((d0 - f.start[0]) * kx - HW / 2) / 2);
    crop = [x0, x0 + 3 * HW];
  } else kx = (n * HW) / f.run;
  const r = resampleWall(cut, f, kx, ky);
  let out = r.out;
  let anchor: [number, number] = r.anchor; // the run's start on its base (output px of `out`)
  const along = s.flip ? 'col' : 'row';
  if (crop) {
    // A finished piece: three tiles, anchored at the right end of its base.
    const left = anchor[0] + crop[0];
    const right = left + 3 * HW;
    out = cropOut(out, left, 0, right, out.h);
    // The base at the right end: HH down per HW from the run's start.
    anchor = [3 * HW, anchor[1] + Math.round((crop[1] * HH) / HW)];
    n = 3;
  }
  // Stored as one that runs down to the right; a flipped one is drawn mirrored.
  save(s.id, out, {
    footprint: [n, 1],
    anchor: crop ? anchor : [Math.round(anchor[0]) + n * HW, Math.round(anchor[1]) + n * HH],
    faces: '+row',
    wall: crop
      ? undefined
      : { along, n, start: [Math.round(anchor[0]), Math.round(anchor[1])], role: s.role },
    from: s.note + (s.flip ? ' (mirrored to run down to the right; draw it flipped)' : ''),
  });
  const c = check(out);
  report[s.id] = {
    kind: 'wall',
    role: s.role,
    tiles: n,
    scale: [round1(kx * 1000) / 1000, round1(ky * 1000) / 1000],
    alignErrorPx: round1(f.dev * Math.min(kx, ky)),
    heightPx: Math.round(f.height * ky),
    leftover: c,
    size: [out.w, out.h],
  };
  if (f.dev * Math.min(kx, ky) > TOL.wallDevPx)
    flags.push(`${s.id}: wall base off the 1:2 line by ${round1(f.dev * Math.min(kx, ky))} px`);
}

/** The inside corner: the crease (the topmost point) in the middle, an arm of one tile each way
 *  on exact 1:2 slopes, finished as one piece anchored on the crease's base. */
function doCorner(s: Spec & { kind: 'wall' }, cut: Cut): void {
  const { top } = contours(cut);
  let cx = 0;
  for (let x = 1; x < cut.w; x++) if (top[x] >= 0 && (top[cx] < 0 || top[x] < top[cx])) cx = x;
  // The arms are fitted as walls: the right one directly, the left one mirrored.
  const crop = (x0: number, x1: number): Cut => {
    const w = x1 - x0;
    const c: Cut = {
      ...cut,
      w,
      rgb: new Uint8Array(w * cut.h * 3),
      mask: new Uint8Array(w * cut.h),
      clean: new Uint8Array(w * cut.h),
    };
    for (let y = 0; y < cut.h; y++)
      for (let x = 0; x < w; x++) {
        c.mask[y * w + x] = cut.mask[y * cut.w + x + x0];
        c.clean[y * w + x] = cut.clean[y * cut.w + x + x0];
        for (let q = 0; q < 3; q++)
          c.rgb[(y * w + x) * 3 + q] = cut.rgb[(y * cut.w + x + x0) * 3 + q];
      }
    return c;
  };
  const right = crop(cx, cut.w);
  const left = mirrorCut(crop(0, cx));
  const fr = fitWall(right);
  const fl = fitWall(left);
  const ky = (WALL_COLUMN_H * ISO_DENSITY) / ((fr.height + fl.height) / 2);
  const kx = (Math.max(1, Math.round((fr.run * ky) / HW)) * HW) / fr.run;
  const R = resampleWall(right, fr, kx, ky);
  const kxl = (Math.max(1, Math.round((fl.run * ky) / HW)) * HW) / fl.run;
  const L = mirrorOut(resampleWall(left, fl, kxl, ky).out);
  const Lanchor = resampleWall(left, fl, kxl, ky).anchor;
  // One tile each way from the crease: R is cropped to [0, HW) from its anchor, L to the
  // mirror; their bases both start at the crease at the same height (the average of the two).
  const baseAt = (o: { out: Out; anchor: [number, number] }) => o.anchor[1];
  const w = 2 * HW;
  const rows = Math.max(R.out.h, L.h) + 16;
  const out: Out = { w, h: rows, data: new Uint8Array(w * rows * 4) };
  const put = (o: Out, ox: number, oy: number, x0: number, x1: number) => {
    for (let y = 0; y < o.h; y++)
      for (let x = x0; x < x1; x++) {
        const p = (y * o.w + x) * 4;
        if (!o.data[p + 3]) continue;
        const X = x - x0 + ox;
        const Y = y + oy;
        if (X < 0 || Y < 0 || X >= w || Y >= rows) continue;
        out.data.set(o.data.subarray(p, p + 4), (Y * w + X) * 4);
      }
  };
  const baseY = 8 + Math.max(baseAt(R), Lanchor[1]);
  put(R.out, HW, baseY - R.anchor[1], R.anchor[0], R.anchor[0] + HW);
  // The mirrored left arm: its run starts at its anchor from the right edge.
  put(L, 0, baseY - Lanchor[1], L.w - Lanchor[0] - HW, L.w - Lanchor[0]);
  const t = trimOut(out);
  save(s.id, t.img, {
    footprint: [1, 1],
    anchor: [HW - t.x, baseY - t.y],
    faces: 'none',
    from: s.note,
  });
  report[s.id] = {
    kind: 'wall',
    role: 'corner',
    scale: [round1(kx * 1000) / 1000, round1(ky * 1000) / 1000],
    alignErrorPx: round1(Math.max(fr.dev, fl.dev) * Math.min(kx, ky)),
    heightPx: Math.round(((fr.height + fl.height) / 2) * ky),
    leftover: check(t.img),
    size: [t.img.w, t.img.h],
  };
}

// ── Main ─────────────────────────────────────────────────────

if (!fs.existsSync(path.join(SRC, 'batch1'))) {
  console.error(`no batches in ${SRC} (pass --src <dir with batch1..3>)`);
  process.exit(1);
}
fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT))
  if (f.startsWith('o-') && f.endsWith('.png')) fs.unlinkSync(path.join(OUT, f));
const seen = new Set<string>();
for (const b of ['1', '2', '3'])
  for (const file of fs.readdirSync(path.join(SRC, `batch${b}`)).sort()) {
    const key = `${b}/${normal(file)}`;
    const spec = OBJECTS[key];
    if (!spec) {
      console.error(`no entry for ${key}`);
      process.exit(1);
    }
    seen.add(key);
    const cut = readCut(path.join(SRC, `batch${b}`, file));
    if (spec.kind === 'floor') doFloor(spec, cut);
    else if (spec.kind === 'flat') doFlat(spec, cut);
    else if (spec.kind === 'obj') doObj(spec, cut);
    else doWall(spec, cut);
    const r = report[spec.id];
    const left = r.leftover as { magenta: number; halo: number; rim: number };
    r.sourceBorder = cut.border;
    if (cut.border > 0)
      flags.push(`${spec.id}: ${cut.border} object pixels on the source picture's border`);
    if (left.magenta > 0) flags.push(`${spec.id}: ${left.magenta} background pixels left`);
    if (left.halo > Math.max(1, TOL.haloShare * left.rim))
      flags.push(`${spec.id}: ${left.halo} halo pixels`);
    console.log(`${spec.id}`.padEnd(22), JSON.stringify(r));
  }
for (const key of Object.keys(OBJECTS)) if (!seen.has(key)) throw new Error(`no file for ${key}`);

// ── Pieces derived from the owner's walls ────────────────────

/** A strip of one tile of the plain wall (its middle one), as columns of the stored picture. */
function wallStrip(id: string, j: number): { o: Out; x0: number; start: [number, number] } {
  const w = pieces[`o-${id}`].wall!;
  return { o: outs[`o-${id}`], x0: w.start[0] + j * HW, start: w.start };
}

/** The cut-away wall: a one-tile block of the owner's plain wall, as low as a counter. Its two
 *  faces are strips of the plain wall in which each column keeps its cap (the top `CAP_ROWS`) and
 *  its lowest `BODY_ROWS` (baseboard and a little plaster): the plaster between is the same all
 *  the way up, so nothing of the owner's drawing is invented. The lower-right face is the same
 *  strip flipped. The top is the cap's own top-face colour, filled on the tile's diamond. */
const CAP_ROWS = 44;
const BODY_ROWS = 100;
/** How much lighter than the cap's top face a row may be... the face below it is darker by this. */
const CAP_BAND_DROP = 14;
/** The top's rim: this share of its colour, this wide (a share of the diamond). */
const CAP_RIM = 0.8;
const CAP_RIM_WIDTH = 0.03;
/** Luminance the cap's top face is at least. */
const CAP_BRIGHT = 200;
function lowWall(): void {
  const plain = pieces['o-wall-plain'].wall!;
  const { o, x0 } = wallStrip('wall-plain', Math.floor(plain.n / 2));
  const H = CAP_ROWS + BODY_ROWS;
  const front = H + 2 * HH; // the row below the front corner's base
  const lum = (x: number, y: number) => {
    const i = (y * o.w + x) * 4;
    return 0.3 * o.data[i] + 0.59 * o.data[i + 1] + 0.11 * o.data[i + 2];
  };
  const colTop = (x: number) => {
    for (let y = 0; y < o.h; y++) if (o.data[(y * o.w + x) * 4 + 3]) return y;
    return -1;
  };
  const colBot = (x: number) => {
    for (let y = o.h - 1; y >= 0; y--) if (o.data[(y * o.w + x) * 4 + 3]) return y;
    return -1;
  };
  // The cap's top face: below the outline, the bright band at the top of a column, until the
  // face under it is darker.
  const mid = x0 + HW / 2;
  const top = colTop(mid);
  let first = 0;
  while (lum(mid, top + first) < CAP_BRIGHT && first < CAP_ROWS) first++;
  let band = first;
  while (lum(mid, top + band) > lum(mid, top + first) - CAP_BAND_DROP && band < CAP_ROWS) band++;
  const cap = [0, 0, 0];
  for (let k = first; k < band; k++)
    for (let q = 0; q < 3; q++) cap[q] += o.data[((top + k) * o.w + mid) * 4 + q] / (band - first);
  const row: Out = { w: HW, h: front, data: new Uint8Array(HW * front * 4) };
  for (let x = 0; x < HW; x++) {
    const t = colTop(x0 + x);
    const bot = colBot(x0 + x);
    const end = front - Math.round(((HW - 1 - x) * HH) / HW);
    // The faces start under the cap's top face (that band is replaced by the tile's own top).
    for (let k = 0; k < CAP_ROWS; k++) copy(o, x0 + x, t + band + k, row, x, end - H + k);
    for (let k = 0; k < BODY_ROWS; k++)
      copy(o, x0 + x, bot - BODY_ROWS + 1 + k, row, x, end - BODY_ROWS + k);
  }
  const out: Out = { w: 2 * HW, h: front, data: new Uint8Array(2 * HW * front * 4) };
  // The top diamond: its front corner at the faces' top edge, a thin darker rim.
  const yf = front - H;
  const rim = cap.map((v) => Math.round(v * CAP_RIM));
  for (let y = 0; y < front; y++)
    for (let x = 0; x < 2 * HW; x++) {
      const d = Math.abs(x + 0.5 - HW) / HW + Math.abs(y + 0.5 - (yf - HH)) / HH;
      if (d < 1) out.data.set([...(d > 1 - CAP_RIM_WIDTH ? rim : cap), 255], (y * 2 * HW + x) * 4);
    }
  const flipped = mirrorOut(row);
  for (let y = 0; y < front; y++)
    for (let x = 0; x < HW; x++) {
      copy(row, x, y, out, x, y);
      copy(flipped, x, y, out, HW + x, y);
    }
  const t = trimOut(out);
  save('wall-low', t.img, {
    footprint: [1, 1],
    anchor: [HW - t.x, front - t.y],
    faces: 'none',
    from: "derived from the owner's plain cream wall: its cap and baseboard columns (plaster between cut out) on two faces, the cap's top colour on the diamond",
  });
  report['wall-low'] = {
    kind: 'derived',
    capBandRows: band,
    leftover: check(t.img),
    size: [t.img.w, t.img.h],
  };
}
function copy(a: Out, ax: number, ay: number, b: Out, bx: number, by: number): void {
  if (ax < 0 || ay < 0 || ax >= a.w || ay >= a.h || bx < 0 || by < 0 || bx >= b.w || by >= b.h)
    return;
  // Opaque pixels only: what is behind stays where the source has nothing.
  if (a.data[(ay * a.w + ax) * 4 + 3])
    b.data.set(a.data.subarray((ay * a.w + ax) * 4, (ay * a.w + ax) * 4 + 4), (by * b.w + bx) * 4);
}

/** The elevator doors slid open: the leaves' metal (the long vertical runs of leaf-coloured
 *  pixels between the frame's sides) in the middle fifth to two fifths of the doors becomes the
 *  dark car inside; the frame, the sign and the plaster stay. */
const OPEN_SHARE = 0.4;
function liftOpen(): void {
  const src = outs['o-wall-lift'];
  const out: Out = { ...src, data: new Uint8Array(src.data) };
  const lum = (i: number) => 0.3 * src.data[i] + 0.59 * src.data[i + 1] + 0.11 * src.data[i + 2];
  const x0 = HW / 2;
  const x1 = HW / 2 + 2 * HW;
  for (let x = x0; x < x1; x++) {
    const t = (x - x0) / (x1 - x0);
    if (Math.abs(t - 0.5) > OPEN_SHARE / 2) continue;
    // Longest vertical run of leaf-coloured pixels in this column.
    let best: [number, number] = [0, 0];
    let from = -1;
    for (let y = 0; y <= src.h; y++) {
      const i = (y * src.w + x) * 4;
      const leaf = y < src.h && src.data[i + 3] > 0 && lum(i) > 115 && lum(i) < 215;
      if (leaf && from < 0) from = y;
      if (!leaf && from >= 0) {
        if (y - from > best[1] - best[0]) best = [from, y];
        from = -1;
      }
    }
    if (best[1] - best[0] < src.h * 0.25) continue;
    for (let y = best[0]; y < best[1]; y++) {
      const g = (y - best[0]) / (best[1] - best[0]);
      const c = [0x2a + 22 * g, 0x30 + 24 * g, 0x42 + 30 * g];
      const i = (y * src.w + x) * 4;
      out.data.set([c[0], c[1], c[2], 255], i);
    }
  }
  save('lift-doors-open', out, {
    ...pieces['o-wall-lift'],
    from: "derived from the owner's elevator wall: the doors slid open on the car",
  });
  report['lift-doors-open'] = { kind: 'derived', leftover: check(out), size: [out.w, out.h] };
}
lowWall();
liftOpen();

// ── The manifest ─────────────────────────────────────────────

/** Where a facing's mirror faces: the picture flipped swaps the two lower (and the two upper) ones. */
const MIRROR: Record<Facing, Facing> = {
  '+row': '+col',
  '+col': '+row',
  '-row': '-col',
  '-col': '-row',
  none: 'none',
};

const types: Record<string, { piece: string; mirror?: boolean }> = {
  DESK_FRONT: { piece: 'o-desk' },
  // The monitor is part of the desk.
  PC_FRONT_OFF: { piece: 'none' },
  PC_FRONT_ON_1: { piece: 'none' },
  PC_FRONT_ON_2: { piece: 'none' },
  PC_FRONT_ON_3: { piece: 'none' },
  CUSHIONED_BENCH: { piece: 'o-chair-down' },
  CUSHIONED_CHAIR_FRONT: { piece: 'o-chair-down' },
  CUSHIONED_CHAIR_BACK: { piece: 'o-chair-up' },
  CUSHIONED_CHAIR_SIDE: { piece: 'o-chair-right' },
  WOODEN_CHAIR_FRONT: { piece: 'o-chair-down' },
  WOODEN_CHAIR_BACK: { piece: 'o-chair-up' },
  PLANT: { piece: 'o-monstera' },
  POT: { piece: 'o-cactus' },
  CACTUS: { piece: 'o-cactus' },
  PLANT_2: { piece: 'o-palm' },
  TALL_PLANT: { piece: 'o-palm' },
  LARGE_PLANT: { piece: 'o-palm' },
  BIN: { piece: 'o-bin' },
  BOOKSHELF: { piece: 'o-bookshelf-moss' },
  DOUBLE_BOOKSHELF: { piece: 'o-bookshelf-cozy' },
  SOFA_FRONT: { piece: 'o-sofa-a' },
  SOFA_BACK: { piece: 'o-sofa-a' },
  SOFA_SIDE: { piece: 'o-sofa-b' },
  'SOFA_SIDE:left': { piece: 'o-sofa-b' },
  COFFEE_TABLE: { piece: 'o-coffee-table' },
  WHITEBOARD: { piece: 'o-whiteboard-a' },
};

/** Seating by facing: the piece whose picture faces that way, the other facing by its mirror.
 *  A facing with none (a sofa seen from behind, an armchair facing away: the owner has not drawn
 *  them) is missing: the renderer falls back to the nearest and says so in the report. */
const facings: Record<string, Partial<Record<Facing, { piece: string; mirror?: boolean }>>> = {};
for (const [id, p] of Object.entries(pieces)) {
  if (!p.seats) continue;
  const group = id.startsWith('o-chair')
    ? 'chair'
    : id.startsWith('o-armchair')
      ? 'armchair'
      : 'sofa';
  facings[group] ??= {};
  facings[group][p.faces] = { piece: id };
}
for (const [id, p] of Object.entries(pieces)) {
  if (!p.seats) continue;
  const group = id.startsWith('o-chair')
    ? 'chair'
    : id.startsWith('o-armchair')
      ? 'armchair'
      : 'sofa';
  const m = MIRROR[p.faces];
  facings[group][m] ??= { piece: id, mirror: true };
}

const manifest = {
  note: "ISO-2: the owner's individual isometric objects (cld/scripts/gen-iso-objects.ts), one master PNG each at density 12 (source px per world px; a 16 px tile is a 192x96 diamond), area-averaged, drawn at every zoom from that master. anchor: the pixel at the footprint's (slot's) front corner on the floor. seats: iso px from the anchor to a sitting character's seat, for the picture as drawn (mirrored: x negated). A wall piece is stored running down to the right; wall.start is where its base starts, its strips of one tile are cut from there.",
  floors: {
    default: 'o-floor-wood-light',
    '1': 'o-floor-carpet-blue',
    '2': 'o-floor-carpet-pink',
    '3': 'o-floor-marble',
    '7': 'o-floor-wood-dark',
    '9': 'o-floor-stone',
  },
  walls: {
    row: { piece: 'o-wall-plain' },
    col: { piece: 'o-wall-plain-b', mirror: true },
    window: { piece: 'o-wall-window', gap: 2 },
    corner: 'o-wall-corner',
    low: 'o-wall-low',
  },
  lift: { doors: 'o-wall-lift', doorsOpen: 'o-lift-doors-open' },
  pieces,
  types,
  facings,
};
fs.writeFileSync(path.join(OUT, 'owner-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

// ── The review sheet: every file on its footprint's diamond, anchors and seats marked ──

/** Drawn at 1/scale: the sheet is assembled from the files just written (read back). */
function reviewSheet(
  file: string,
  SHEET_SCALE: number,
  only?: (name: string, p: Piece) => boolean,
): void {
  const items = Object.entries(pieces)
    .filter(([name, p]) => !only || only(name, p))
    .map(([name, p]) => {
      const png = PNG.sync.read(fs.readFileSync(path.join(OUT, p.file)));
      return { name, p, w: png.width, h: png.height, data: png.data };
    });
  const PAD = 28;
  const WIDTH = only ? 2000 : 2600;
  const cellW = (it: (typeof items)[number]) =>
    Math.max(only ? 120 : 300, Math.ceil(it.w / SHEET_SCALE) + PAD);
  // (anchors can sit outside a piece's picture: the footprint outline is drawn from the anchor)
  const rows: Array<typeof items> = [[]];
  let x = PAD;
  for (const it of items) {
    if (x + cellW(it) > WIDTH) (rows.push([]), (x = PAD));
    rows[rows.length - 1].push(it);
    x += cellW(it);
  }
  const rowH = rows.map(
    (r) => Math.max(...r.map((it) => Math.ceil(it.h / SHEET_SCALE))) + 2 * PAD + 24,
  );
  const sheet = new Img(
    WIDTH,
    rowH.reduce((a, b) => a + b, PAD),
  );
  for (let i = 0; i < sheet.w * sheet.h; i++) sheet.data.set([46, 50, 64, 255], i * 4);
  const dot = (cx: number, cy: number, c: [number, number, number, number], r = 3) => {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (dx * dx + dy * dy <= r * r) sheet.set(Math.round(cx + dx), Math.round(cy + dy), c);
  };
  const line = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    c: [number, number, number, number],
  ) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let t = 0; t <= n; t++)
      sheet.set(Math.round(x0 + ((x1 - x0) * t) / n), Math.round(y0 + ((y1 - y0) * t) / n), c);
  };
  const outline = (
    ax: number,
    ay: number,
    fw: number,
    fh: number,
    c: [number, number, number, number],
  ) => {
    const hw = HW / SHEET_SCALE;
    const hh = HH / SHEET_SCALE;
    const pts: Array<[number, number]> = [
      [ax - (fw - fh) * hw, ay - (fw + fh) * hh],
      [ax + fh * hw, ay - fh * hh],
      [ax, ay],
      [ax - fw * hw, ay - fw * hh],
    ];
    for (let i = 0; i < 4; i++) line(...pts[i], ...pts[(i + 1) % 4], c);
  };
  let y = PAD;
  rows.forEach((r, k) => {
    let cx = PAD;
    const base = y + rowH[k] - PAD - 8;
    for (const it of r) {
      const cw = cellW(it);
      // Centred in its cell by its picture (a wall's anchor is at its right end).
      const ox = cx + Math.round((cw - PAD - it.w / SHEET_SCALE) / 2);
      const ax = ox + it.p.anchor[0] / SHEET_SCALE;
      const oy = base - it.p.anchor[1] / SHEET_SCALE;
      outline(ax, base, ...(it.p.slot ?? it.p.footprint), [90, 100, 130, 255]);
      outline(ax, base, ...it.p.footprint, [150, 170, 215, 255]);
      // The picture, averaged over SHEET_SCALE² blocks.
      for (let yy = 0; yy < Math.floor(it.h / SHEET_SCALE); yy++)
        for (let xx = 0; xx < Math.floor(it.w / SHEET_SCALE); xx++) {
          let [rr, gg, bb, n] = [0, 0, 0, 0];
          for (let b = 0; b < SHEET_SCALE; b++)
            for (let a = 0; a < SHEET_SCALE; a++) {
              const i = ((yy * SHEET_SCALE + b) * it.w + xx * SHEET_SCALE + a) * 4;
              if (it.data[i + 3])
                ((rr += it.data[i]), (gg += it.data[i + 1]), (bb += it.data[i + 2]), n++);
            }
          if (n * 2 >= SHEET_SCALE * SHEET_SCALE)
            sheet.set(Math.round(ox + xx), Math.round(oy + yy), [rr / n, gg / n, bb / n, 255]);
        }
      if (it.p.wall) {
        // The run's base from its start, a tick at every tile.
        const [sx, sy] = it.p.wall.start;
        for (let j = 0; j <= it.p.wall.n; j++)
          dot(
            ox + (sx + j * HW) / SHEET_SCALE,
            oy + (sy + j * HH) / SHEET_SCALE,
            [255, 210, 80, 255],
            2,
          );
      }
      dot(ax, base, [255, 80, 80, 255], 4);
      for (const s of it.p.seats ?? [])
        dot(
          ax + (s[0] * ISO_DENSITY) / SHEET_SCALE,
          base + (s[1] * ISO_DENSITY) / SHEET_SCALE,
          [80, 220, 255, 255],
          4,
        );
      cx += cw;
    }
    y += rowH[k];
  });
  fs.mkdirSync(SHEET_OUT, { recursive: true });
  sheet.write(path.join(SHEET_OUT, `${file}.png`));
  fs.writeFileSync(
    path.join(SHEET_OUT, `${file}-order.txt`),
    rows.map((r) => r.map((it) => it.name).join('  ')).join('\n') + '\n',
  );
}
reviewSheet('review-sheet', 2);
// The seats: every chair, armchair and sofa at 1/1 (the cyan dot is its seat point).
reviewSheet('seat-points', 1, (_n, p) => !!p.seats);

// ── Memory and the report ────────────────────────────────────

// What the building decodes at runtime (art.ts neededFiles): the pieces something uses.
const inUse = new Set<string>([
  ...Object.values(manifest.floors),
  manifest.walls.row.piece,
  manifest.walls.col.piece,
  manifest.walls.window.piece,
  manifest.walls.corner,
  manifest.walls.low,
  manifest.lift.doors,
  manifest.lift.doorsOpen,
  ...Object.values(types).map((t) => t.piece),
  ...Object.values(facings).flatMap((g) => Object.values(g).map((f) => f!.piece)),
]);
const mb = (b: number) => Math.round(b / 1e4) / 100;
let bytes = 0;
let usedBytes = 0;
let biggest = ['', 0] as [string, number];
const perPiece: Record<string, number> = {};
for (const [id, o] of Object.entries(outs)) {
  const b = o.w * o.h * 4;
  bytes += b;
  if (inUse.has(id)) usedBytes += b;
  perPiece[id] = mb(b);
  if (b > biggest[1]) biggest = [id, b];
}
const memory = {
  density: ISO_DENSITY,
  pieces: Object.keys(outs).length,
  decodedMB: mb(bytes),
  inUse: { pieces: inUse.size, decodedMB: mb(usedBytes) },
  biggest: biggest[0],
  biggestMB: mb(biggest[1]),
  perPieceMB: perPiece,
};
console.log(`${Object.keys(pieces).length} pieces -> ${OUT}`);
console.log(
  `decoded memory at density ${ISO_DENSITY}:`,
  JSON.stringify({ ...memory, perPieceMB: undefined }),
);
console.log(flags.length ? `flags:\n  ${flags.join('\n  ')}` : 'no flags');
fs.writeFileSync(
  path.join(OUT, 'report-owner.json'),
  JSON.stringify({ memory, report, flags }, null, 2) + '\n',
);
void Img;
