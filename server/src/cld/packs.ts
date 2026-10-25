/**
 * CHAR-FACTORY: content packs (char-pack-format.md). A pack is a folder with pack.json and its part
 * PNGs: built in (cld/packs/<id>/, copied to dist/packs/) or the user's (~/.config/cld-gui/packs/
 * <id>/: expansion packs). Every file is checked like an imported part (inside the folder, a
 * regular file, the PNG header before decoding, the part's exact size: classic or HD). Part ids
 * become `<pack>/<part>`. Every pack is on; an old pack.json's adultOnly / defaultEnabled /
 * adultOriginal keys are read past (the owner dropped that gate, 10-25). Local only: no network.
 */
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import type { PartSlot } from '../../../core/src/cld/looks.js';
import {
  downsampleHd,
  encodePixels,
  HD,
  HEAD_H,
  HEAD_W,
  PART_ALPHABET,
  type PartData,
  partProblem,
  SHEET_H,
  SHEET_W,
} from '../../../core/src/cld/partData.js';
import {
  BODY_VARIANTS,
  FACE_EXPRESSIONS,
  PART_ID,
  SLOT_REGISTRY,
} from '../../../core/src/cld/partRegistry.js';
import { pngHeaderIssue } from '../../../core/src/cld/sheetCheck.js';
import type {
  CharacterBody,
  CharacterChoice,
  CharacterPack,
  CharacterPartArt,
  PackCharacter,
  PackPreset,
} from '../../../core/src/messages.js';
import { parseAppearance } from './characterPresets.js';
import { readJson } from './jsonFile.js';
import { rampOf } from './partImport.js';

const PACK_ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;
/** pack.json and every part PNG are at most this big; a pack has at most MAX_PACK_PARTS parts. */
const MAX_PACK_FILE = 512 * 1024;
const MAX_PACK_PARTS = 400;
/** At most this many characters and presets per pack, and packs per folder (built in, the user's). */
const MAX_PACK_CHARACTERS = 100;
const MAX_PACK_PRESETS = 400;
const MAX_PACKS = 50;
const MAX_TEXT = 80;

export interface LoadedPack {
  summary: CharacterPack;
  parts: PartData[];
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown) =>
  isObj(v) && typeof v.ko === 'string' && typeof v.en === 'string'
    ? { ko: v.ko.slice(0, MAX_TEXT), en: v.en.slice(0, MAX_TEXT) }
    : null;

type Art = { palette: string[]; pixels: string; hd?: CharacterPartArt['hd'] };

/** One PNG of a pack as part art at `w`×`h` (classic) or twice that (HD, with its classic copy). */
function readArt(
  dir: string,
  entry: unknown,
  w: number,
  h: number,
  colorable: boolean,
): Art | string {
  // a file name (classic) or { file, density: 2 } (HD; the PNG's size says it too)
  const file = isObj(entry) ? entry.file : entry;
  const wantHd = isObj(entry) && entry.density === 2;
  if (
    typeof file !== 'string' ||
    !/^[a-zA-Z0-9_./-]+\.png$/.test(file) ||
    file.split('/').includes('..')
  )
    return `bad file name ${JSON.stringify(file)}`;
  const full = path.resolve(dir, file);
  if (!full.startsWith(path.resolve(dir) + path.sep)) return `${file}: outside the pack`;
  let buf: Buffer;
  try {
    const st = fs.lstatSync(full);
    if (!st.isFile()) return `${file}: not a regular file`;
    // a linked folder on the way (parts -> /elsewhere) must not lead outside either
    if (!fs.realpathSync(full).startsWith(fs.realpathSync(dir) + path.sep))
      return `${file}: outside the pack`;
    if (st.size > MAX_PACK_FILE) return `${file}: too big`;
    buf = fs.readFileSync(full);
  } catch {
    return `${file}: missing`;
  }
  const hd = buf.length > 24 && buf.readUInt32BE(16) === w * HD;
  if (wantHd && !hd) return `${file}: density 2 but not ${w * HD}×${h * HD}`;
  const issue = pngHeaderIssue(buf, hd ? w * HD : w, hd ? h * HD : h);
  if (issue) return `${file}: ${issue.text}`;
  let png: PNG;
  try {
    png = PNG.sync.read(buf);
  } catch (err) {
    return `${file}: broken PNG (${err instanceof Error ? err.message : String(err)})`;
  }
  const hexAt = (pw: number) => (x: number, y: number) => {
    const o = (y * pw + x) * 4;
    return png.data[o + 3] >= 128
      ? [0, 1, 2].map((k) => png.data[o + k].toString(16).padStart(2, '0')).join('')
      : '';
  };
  const rampFor = (e: { palette: string[]; pixels: string }) =>
    colorable ? rampOf(countsOf(e)) : [];
  if (!hd) {
    const e = encodePixels(w, h, hexAt(w));
    if (!e) return `${file}: more than 62 colours`;
    return e;
  }
  const big = encodePixels(w * HD, h * HD, hexAt(w * HD));
  if (!big) return `${file}: more than 62 colours`;
  const classic = encodePixels(w, h, downsampleHd(hexAt(w * HD)))!;
  return { ...classic, hd: { ...big, ramp: rampFor(big) } };
}

/** pack.json and its files -> the pack, or why it is skipped. */
export function loadPack(dir: string, builtIn: boolean): LoadedPack | { error: string } {
  const file = path.join(dir, 'pack.json');
  let raw: unknown;
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return { error: 'pack.json is not a regular file' };
    if (st.size > MAX_PACK_FILE) return { error: 'pack.json too big' };
    raw = readJson(file);
  } catch (err) {
    return { error: `pack.json: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isObj(raw)) return { error: 'pack.json is not an object' };
  const id = raw.id;
  if (typeof id !== 'string' || !PACK_ID.test(id) || id !== path.basename(dir))
    return { error: 'id must be the folder name (a-z 0-9 - _)' };
  const title = text(raw.title);
  if (!title || !Number.isInteger(raw.version))
    return { error: 'title {ko, en} and version are needed' };
  const parts: PartData[] = [];
  const local = new Map<string, string>(); // pack-local id -> namespaced
  for (const p of Array.isArray(raw.parts) ? raw.parts.slice(0, MAX_PACK_PARTS) : []) {
    const fail = (why: string) =>
      console.warn(`[cld] pack ${id}: part ${JSON.stringify(p?.id)} skipped (${why})`);
    if (
      !isObj(p) ||
      typeof p.id !== 'string' ||
      !PART_ID.test(p.id) ||
      p.id.includes('/') ||
      local.has(p.id)
    ) {
      fail('bad or repeated id');
      continue;
    }
    const slot = p.slot as PartSlot;
    const info = SLOT_REGISTRY[slot];
    if (!info) {
      fail('unknown slot');
      continue;
    }
    const kind = info.kind;
    const [w, h] = kind === 'sheet' ? [SHEET_W, SHEET_H] : [HEAD_W, HEAD_H];
    const colorable = p.colorable === true;
    let base: Art | string | null = null;
    let bodies: CharacterBody[] | undefined;
    const variants: Record<string, CharacterPartArt> = {};
    const expressions: Record<string, CharacterPartArt> = {};
    if (p.kind === 'face' || slot === 'face') {
      const ex = isObj(p.expressions) ? p.expressions : { neutral: p.file };
      for (const [name, f] of Object.entries(ex)) {
        if (!(FACE_EXPRESSIONS as readonly string[]).includes(name)) continue;
        const art = readArt(dir, f, w, h, false);
        if (typeof art === 'string') {
          fail(art);
          continue;
        }
        if (name === 'neutral') base = art;
        else expressions[name] = art;
      }
      if (!base) base = 'no neutral expression';
    } else if (isObj(p.bodies)) {
      const entries = Object.entries(p.bodies).filter(([b]) =>
        (BODY_VARIANTS as readonly string[]).includes(b),
      );
      // the standard drawing is the part's own; the others are its variants
      entries.sort((a, b) => Number(b[0] === 'standard') - Number(a[0] === 'standard'));
      for (const [b, f] of entries) {
        const art = readArt(dir, f, w, h, colorable);
        if (typeof art === 'string') {
          fail(art);
          continue;
        }
        if (!base || typeof base === 'string') {
          base = art;
          bodies = [b as CharacterBody];
        } else variants[b] = { ...art, ramp: colorable ? rampOf(countsOf(art)) : [] };
      }
      if (!base) base = 'no drawing';
    } else base = readArt(dir, p.file, w, h, colorable);
    if (typeof base === 'string') {
      fail(base);
      continue;
    }
    const part: PartData = {
      id: `${id}/${p.id}`,
      slot,
      kind,
      ...(p.gender === 'm' || p.gender === 'f' ? { gender: p.gender } : {}),
      name: p.id,
      ...(text(p.name) && { label: text(p.name)! }),
      ramp: colorable ? rampOf(countsOf(base)) : [],
      palette: base.palette,
      pixels: base.pixels,
      ...(base.hd && { hd: base.hd }),
      ...(bodies && bodies[0] !== 'standard' && { bodies }),
      ...(Object.keys(variants).length && { variants }),
      ...(Object.keys(expressions).length && { expressions }),
      pack: id,
    };
    const problem = partProblem(part);
    if (problem) {
      fail(problem);
      continue;
    }
    parts.push(part);
    local.set(p.id, part.id);
  }
  const characters: PackCharacter[] = [];
  for (const c of Array.isArray(raw.characters)
    ? raw.characters.slice(0, MAX_PACK_CHARACTERS)
    : []) {
    const name = isObj(c) ? text(c.name) : null;
    if (!isObj(c) || typeof c.id !== 'string' || !PACK_ID.test(c.id) || !name) continue;
    characters.push({
      id: c.id,
      name,
      ...(Number.isInteger(c.age) && { age: c.age as number }),
    });
  }
  const presets: PackPreset[] = [];
  for (const pr of Array.isArray(raw.presets) ? raw.presets.slice(0, MAX_PACK_PRESETS) : []) {
    const name = isObj(pr) ? text(pr.name) : null;
    if (!isObj(pr) || typeof pr.id !== 'string' || !PACK_ID.test(pr.id) || !name) continue;
    const look = presetLook(pr.look, local);
    if (!look) {
      console.warn(`[cld] pack ${id}: preset ${pr.id} skipped (not a person look)`);
      continue;
    }
    presets.push({
      id: `${id}/${pr.id}`,
      ...(typeof pr.character === 'string' && { character: pr.character }),
      ...(typeof pr.outfit === 'string' && { outfit: pr.outfit.slice(0, MAX_TEXT) }),
      name,
      look,
    });
  }
  return {
    summary: {
      id,
      version: raw.version as number,
      title,
      builtIn,
      characters,
      presets,
    },
    parts,
  };
}

function countsOf(e: { palette: string[]; pixels: string }) {
  const counts = new Map<string, number>();
  for (const k of e.pixels)
    if (k !== '.') {
      const c = e.palette[PART_ALPHABET.indexOf(k)];
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  return counts;
}

/** A preset's look with its pack-local part ids namespaced (ids not in the pack stay: built-ins),
 *  checked like a stored look. */
function presetLook(value: unknown, local: Map<string, string>): CharacterChoice | null {
  if (!isObj(value) || !isObj(value.parts)) return null;
  const parts: Record<string, unknown> = {};
  for (const [slot, id] of Object.entries(value.parts))
    parts[slot] = Array.isArray(id)
      ? id.map((a) => (typeof a === 'string' ? (local.get(a) ?? a) : a))
      : typeof id === 'string'
        ? (local.get(id) ?? id)
        : id;
  const look = parseAppearance({ ...value, parts });
  return look?.kind === 'person' ? look : null;
}

/** The built-in packs' folder: dist/packs in a release, cld/packs from the source tree. */
export function builtInPacksDir(): string | null {
  for (const dir of [path.join(__dirname, 'packs'), path.resolve(__dirname, '../../../cld/packs')])
    if (fs.existsSync(dir)) return dir;
  return null;
}

export class PackStore {
  private packs: LoadedPack[] = [];

  constructor(private readonly opts: { builtInDir: string | null; userDir: string }) {}

  /** Read every pack (a bad one is skipped with a log line). */
  load(): void {
    const found = new Map<string, LoadedPack>();
    for (const [root, builtIn] of [
      [this.opts.builtInDir, true],
      [this.opts.userDir, false],
    ] as const) {
      if (!root) continue;
      let names: string[] = [];
      try {
        names = fs.readdirSync(root).sort().slice(0, MAX_PACKS);
      } catch {
        continue;
      }
      for (const name of names) {
        const dir = path.join(root, name);
        try {
          if (!fs.lstatSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        const pack = loadPack(dir, builtIn);
        if ('error' in pack) {
          console.warn(`[cld] pack ${name} skipped (${pack.error})`);
          continue;
        }
        if (!found.has(pack.summary.id)) found.set(pack.summary.id, pack); // a built-in id wins
      }
    }
    this.packs = [...found.values()];
  }

  /** The packs for the looks window. */
  summaries(): CharacterPack[] {
    return this.packs.map((p) => p.summary);
  }

  /** Every pack's parts. */
  parts(): PartData[] {
    return this.packs.flatMap((p) => p.parts);
  }
}
