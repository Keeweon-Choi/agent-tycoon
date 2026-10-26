/**
 * CHAR-HUMAN: the owner's imported parts, one folder each under ~/.config/agent-tycoon/parts/<id>/
 * (0700) holding `part.json` (0600, write-then-rename). The id is `p-<slot>-<name>`: importing the
 * same name again replaces it, and a body row (`-down`, `-up`, `-right`) replaces only that row of
 * it. Sent to every client as `characterParts`; the routes sit behind the login and the office's
 * own origin, like the redrawn furniture.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import type { PartSlot } from '../../../core/src/cld/looks.js';
import { PART_ID, PART_SLOTS } from '../../../core/src/cld/looks.js';
import {
  encodePixels,
  HD,
  HEAD_H,
  HEAD_W,
  PART_ALPHABET,
  PART_FRAMES,
  PART_VIEWS,
  type PartData,
  partProblem,
  SHEET_H,
  SHEET_W,
} from '../../../core/src/cld/partData.js';
import { refused } from '../../../core/src/cld/serverText.js';
import { importHeaderIssue, MAX_IMPORT_BYTES } from '../../../core/src/cld/sheetCheck.js';
import type { CharacterParts as PartsMessage, PersonPreset } from '../../../core/src/messages.js';
import { MERGE_DISTANCE, mergePalette } from './assetSnap.js';
import { sameOriginRequest } from './authRoutes.js';
import { decode, parseAppearance } from './characterPresets.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';
import type { PackStore } from './packs.js';
import {
  type ImportedPart,
  importPart,
  type MismatchMode,
  partKind,
  type PartView,
  rampOf,
} from './partImport.js';

/** At most this many parts are kept (each sheet part is ~11 KB on the wire). */
export const MAX_PARTS = 200;
/** At most this many named person looks; a name has at most PRESET_NAME characters. */
export const MAX_PERSON_PRESETS = 50;
const PRESET_NAME = 40;
const PRESETS_FILE = 'presets.json';
/** A part.json larger than this is not read. */
const MAX_PART_FILE = 256 * 1024;
const MAX_NAME = 40;
/** Merges widen by this step until a part fits the 62-colour pixel alphabet. */
const MERGE_STEP = 8;
const BODY_LIMIT = Math.ceil(MAX_IMPORT_BYTES / 3) * 4 + 4096;
const OWN_ID = /^p-[a-z]+-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ImportRequest {
  png: Buffer;
  slot: PartSlot;
  name: string;
  gender?: 'm' | 'f';
  view: PartView | null;
  /** What a frame drawn facing the wrong way becomes, and the owner's own call per frame. */
  mismatch?: MismatchMode;
  frames?: Partial<Record<number, MismatchMode>>;
}
const MODES: readonly MismatchMode[] = ['borrow', 'empty', 'keep'];

/** A body's `{png, slot, name, gender?, view?}`, checked (the PNG's header before any decoding). */
export function importRequest(body: unknown): ImportRequest | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  if (typeof b.slot !== 'string' || !(PART_SLOTS as readonly string[]).includes(b.slot))
    return { error: 'unknown slot' };
  const name =
    typeof b.name === 'string'
      ? b.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, MAX_NAME)
          .replace(/-+$/, '')
      : '';
  if (!name) return { error: 'no name' };
  if (b.gender !== undefined && b.gender !== 'm' && b.gender !== 'f')
    return { error: 'bad gender' };
  const view = b.view === undefined || b.view === null ? null : b.view;
  if (view !== null && !(PART_VIEWS as readonly unknown[]).includes(view))
    return { error: 'bad row' };
  if (b.mismatch !== undefined && !MODES.includes(b.mismatch as MismatchMode))
    return { error: 'bad mismatch' };
  let frames: ImportRequest['frames'];
  if (b.frames !== undefined) {
    if (!b.frames || typeof b.frames !== 'object' || Array.isArray(b.frames))
      return { error: 'bad frames' };
    frames = {};
    for (const [k, mode] of Object.entries(b.frames)) {
      const i = Number(k);
      if (
        !Number.isInteger(i) ||
        i < 0 ||
        i >= PART_FRAMES ||
        !MODES.includes(mode as MismatchMode)
      )
        return { error: 'bad frames' };
      frames[i] = mode as MismatchMode;
    }
  }
  const png = decode(b.png);
  if (!png) return { error: 'not base64' };
  const header = importHeaderIssue(png);
  if (header) return { error: header.text };
  return {
    ...(b.mismatch !== undefined && { mismatch: b.mismatch as MismatchMode }),
    ...(frames && { frames }),
    png,
    slot: b.slot as PartSlot,
    name,
    ...(b.gender ? { gender: b.gender as 'm' | 'f' } : {}),
    view: view as PartView | null,
  };
}

/** The request converted into the part it saves as (`previous`: the same id's part, whose other
 *  rows a one-row import keeps). */
export function convertRequest(
  req: ImportRequest,
  previous?: PartData,
): { part: PartData; report: ImportedPart['report']; hd: ImportedPart['hd'] } | { error: string } {
  let rgba: { width: number; height: number; data: Uint8Array };
  try {
    const png = PNG.sync.read(req.png);
    rgba = { width: png.width, height: png.height, data: png.data };
  } catch (err) {
    return { error: `broken PNG (${err instanceof Error ? err.message : String(err)})` };
  }
  const got = importPart(rgba, req.slot, req.view, { mismatch: req.mismatch, frames: req.frames });
  if ('error' in got) return got;
  const row = req.view === null ? null : PART_VIEWS.indexOf(req.view);
  const keepRows = row !== null && previous?.kind === 'sheet' ? previous : undefined;
  const [w, h] = got.kind === 'head' ? [HEAD_W, HEAD_H] : [SHEET_W, SHEET_H];
  const classic = combine(w, h, row, got, keepRows);
  if ('error' in classic) return classic;
  const { palette, pixels } = classic;
  // the HD art (a drawing finer than its blocks keeps that detail): the same rows kept
  let hd: PartData['hd'];
  if (got.hd) {
    const fresh = encodeRgba(got.hd.width, got.hd.height, got.hd.data);
    const both = combine(w * HD, h * HD, row, fresh, keepRows?.hd);
    if ('error' in both) return both;
    hd = { ...both, ramp: rampOf(countsOf(both)) };
  }
  const ramp = [
    ...new Set([
      ...got.ramp,
      ...(keepRows ? keepRows.ramp.filter((c) => palette.includes(c)) : []),
    ]),
  ].filter((c) => palette.includes(c));
  return {
    part: {
      id: `p-${req.slot}-${req.name}`,
      slot: req.slot,
      kind: partKind(req.slot),
      ...(req.gender && { gender: req.gender }),
      name: req.name,
      ramp,
      palette,
      pixels,
      ...(hd && { hd }),
    },
    report: got.report,
    hd: got.hd,
  };
}

type Encoded = { palette: string[]; pixels: string };
const countsOf = (e: Encoded) => {
  const counts = new Map<string, number>();
  for (const k of e.pixels)
    if (k !== '.') {
      const c = e.palette[PART_ALPHABET.indexOf(k)];
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  return counts;
};
/** RGBA -> palette and pixels, its colours merged (wider each time) until they fit the alphabet. */
function encodeRgba(w: number, h: number, data: Uint8Array): Encoded {
  const cells = { cols: w, rows: h, data: new Uint8Array(data) };
  let n = mergePalette(cells);
  for (let d = MERGE_DISTANCE + MERGE_STEP; n > PART_ALPHABET.length; d += MERGE_STEP)
    n = mergePalette(cells, d);
  return encodePixels(w, h, (x, y) => {
    const o = (y * w + x) * 4;
    return cells.data[o + 3]
      ? [0, 1, 2].map((k) => cells.data[o + k].toString(16).padStart(2, '0')).join('')
      : '';
  })!;
}
/** The new art, with the previous art's other rows when a one-row import lands on an existing
 *  part (`row` null: the new art is the whole part). */
function combine(
  w: number,
  h: number,
  row: number | null,
  fresh: Encoded,
  previous?: Encoded,
): Encoded | { error: string } {
  if (row === null || !previous) return fresh;
  const rowH = h / PART_VIEWS.length;
  if (previous.pixels.length !== w * h) return fresh; // a previous part of another size: replaced
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const from = Math.floor(Math.floor(i / w) / rowH) === row ? fresh : previous;
    const k = from.pixels[i];
    if (k === '.') continue;
    const c = from.palette[PART_ALPHABET.indexOf(k)];
    data.set(
      [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16), 255],
      i * 4,
    );
  }
  return encodeRgba(w, h, data);
}

export class CharacterPartStore {
  private parts = new Map<string, PartData>();
  /** Named person looks (presets.json next to the part folders), in the order saved. */
  private presets: PersonPreset[] = [];

  constructor(
    readonly dir: string,
    private readonly publish: (msg: PartsMessage) => void,
    /** CHAR-FACTORY: content packs; their parts go out with the imported ones. */
    readonly packs: PackStore | null = null,
  ) {}

  /** Read every folder (a bad one is skipped with a log line) and send the list. */
  start(): void {
    this.packs?.load();
    this.parts.clear();
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).sort();
    } catch {
      // no parts yet
    }
    for (const id of names) {
      if (!OWN_ID.test(id) || this.parts.size >= MAX_PARTS) continue;
      const file = path.join(this.dir, id, 'part.json');
      try {
        if (fs.statSync(file).size > MAX_PART_FILE) throw new Error('too big');
        const p = readJson(file) as PartData;
        const problem = p && p.id === id ? partProblem(p) : 'id does not match its folder';
        if (problem) throw new Error(problem);
        this.parts.set(id, p);
      } catch (err) {
        console.warn(
          `[cld] parts: ${id} skipped (${err instanceof Error ? err.message : String(err)})`,
        );
      }
    }
    this.presets = [];
    try {
      const file = path.join(this.dir, PRESETS_FILE);
      if (fs.existsSync(file) && fs.statSync(file).size <= MAX_PART_FILE) {
        const list = readJson(file);
        if (Array.isArray(list))
          for (const entry of list.slice(0, MAX_PERSON_PRESETS)) {
            const preset = personPreset(entry);
            if (preset) this.presets.push(preset);
          }
      }
    } catch (err) {
      console.warn(
        `[cld] parts: ${PRESETS_FILE} skipped (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    this.publish(this.message());
  }

  message(): PartsMessage {
    return {
      type: 'characterParts',
      parts: [...(this.packs?.parts() ?? []), ...this.parts.values()],
      presets: [...this.presets],
      packs: this.packs?.summaries() ?? [],
    };
  }

  /** Save (or with \`look: null\` remove) a named person look; the same name replaces it. */
  setPreset(body: unknown): { ok: true } | { error: string } {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name.trim().slice(0, PRESET_NAME) : '';
    if (!name) return { error: 'no name' };
    const next = this.presets.filter((p) => p.name !== name);
    if (b.look !== null) {
      const preset = personPreset({ name, look: b.look });
      if (!preset) return { error: 'not a person look' };
      if (next.length >= MAX_PERSON_PRESETS)
        return { error: `at most ${MAX_PERSON_PRESETS} presets` };
      next.push(preset);
    }
    try {
      writeJsonAtomic(path.join(this.dir, PRESETS_FILE), next);
    } catch (err) {
      return { error: `not saved (${err instanceof Error ? err.message : String(err)})` };
    }
    this.presets = next;
    this.publish(this.message());
    return { ok: true };
  }

  get(id: string): PartData | undefined {
    return this.parts.get(id);
  }

  /** `source`: the uploaded drawing, kept beside the part as source-<row>.png (the HD art itself is
   *  in part.json's \`hd\`). */
  save(
    part: PartData,
    source?: { png: Buffer; view: PartView | null },
  ): { id: string } | { error: string } {
    if (!OWN_ID.test(part.id) || !PART_ID.test(part.id)) return { error: 'bad id' };
    const problem = partProblem(part);
    if (problem) return { error: problem };
    if (!this.parts.has(part.id) && this.parts.size >= MAX_PARTS)
      return { error: `at most ${MAX_PARTS} parts` };
    const folder = path.join(this.dir, part.id);
    try {
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.dir, 0o700);
      if (source) {
        const name = `source-${source.view ?? 'all'}.png`;
        const tmp = path.join(folder, `.${name}.tmp`);
        fs.writeFileSync(tmp, source.png, { mode: 0o600 });
        fs.renameSync(tmp, path.join(folder, name));
      }
      writeJsonAtomic(path.join(folder, 'part.json'), part);
    } catch (err) {
      return { error: `not saved (${err instanceof Error ? err.message : String(err)})` };
    }
    this.parts.set(part.id, part);
    this.publish(this.message());
    return { id: part.id };
  }

  /** Only an imported part's own folder (never a link). */
  remove(id: unknown): { ok: true } | { error: string } {
    if (typeof id !== 'string' || !OWN_ID.test(id)) return { error: 'not an imported part' };
    const folder = path.join(this.dir, id);
    try {
      if (!fs.lstatSync(folder).isDirectory()) return { error: 'not found' };
    } catch {
      return { error: 'not found' };
    }
    fs.rmSync(folder, { recursive: true });
    this.parts.delete(id);
    this.publish(this.message());
    return { ok: true };
  }

  /** Convert (and with `save`, store) one import; the answer carries the part for the preview. */
  /** The answer carries the part for the preview and the import report (each frame's facing and
   *  what became of it), shown as warnings. */
  import(
    body: unknown,
    save: boolean,
  ): { part: PartData; report: ImportedPart['report'] } | { error: string } {
    const req = importRequest(body);
    if ('error' in req) return req;
    const got = convertRequest(req, this.parts.get(`p-${req.slot}-${req.name}`));
    if ('error' in got) return got;
    if (save) {
      const saved = this.save(got.part, { png: req.png, view: req.view });
      if ('error' in saved) return saved;
    }
    return { part: got.part, report: got.report };
  }
}

/** A stored or sent \`{name, look}\`: a v3 person only (the look as the daemon stores it), or null. */
function personPreset(value: unknown): PersonPreset | null {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > PRESET_NAME) return null;
  const look = parseAppearance(v.look);
  return look?.kind === 'person' ? { name: v.name.trim(), look } : null;
}

type RouteAuth = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** POST /cld/parts/preview and /cld/parts {png, slot, name, gender?, view?}; DELETE /cld/parts/<id>;
 *  POST /cld/parts/presets {name, look | null}.
 *  Behind `auth` (login session or Bearer) and from the office's own page only. */
export function registerPartRoutes(
  app: FastifyInstance,
  auth: RouteAuth,
  store: CharacterPartStore,
): void {
  const refuse = (request: FastifyRequest, reply: FastifyReply) =>
    sameOriginRequest(request) ? null : reply.code(403).send(refused('origin_mismatch'));
  for (const [url, save] of [
    ['/cld/parts/preview', false],
    ['/cld/parts', true],
  ] as const)
    app.post(url, { preHandler: auth, bodyLimit: BODY_LIMIT }, async (request, reply) => {
      const no = refuse(request, reply);
      if (no) return no;
      const result = store.import(request.body, save);
      if ('error' in result) {
        console.warn(`[cld] parts: import refused: ${result.error}`);
        return reply.code(400).send(result);
      }
      if (save) console.log(`[cld] parts: saved ${result.part.id}`);
      return result;
    });
  app.post('/cld/parts/presets', { preHandler: auth }, async (request, reply) => {
    const no = refuse(request, reply);
    if (no) return no;
    const result = store.setPreset(request.body);
    if ('error' in result) return reply.code(400).send(result);
    return result;
  });
  app.delete<{ Params: { id: string } }>(
    '/cld/parts/:id',
    { preHandler: auth },
    async (request, reply) => {
      const no = refuse(request, reply);
      if (no) return no;
      const result = store.remove(request.params.id);
      if ('error' in result) return reply.code(400).send(result);
      console.log(`[cld] parts: removed ${request.params.id}`);
      return result;
    },
  );
}
