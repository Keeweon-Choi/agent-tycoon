/**
 * Character presets (T-0017, FR-OFC-015/016). ~/.config/agent-tycoon/characters/
 * holds sheets in the char_N.png format; ~/.config/agent-tycoon/characters.json
 * binds a character name (an engine project or a Claude session) to a preset or
 * to a built-in look. The folder is watched (fs.watch; while someone views,
 * also a scan every 30 s for what the watch missed, T-0013) and every change is published as
 * `characterPresets`. Files are checked with pngjs when scanned and served
 * from memory, so nothing swapped in after the check is ever served.
 */
import * as crypto from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';

import {
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  CHAR_FRAMES_PER_ROW,
  CHARACTER_DIRECTIONS,
  PNG_ALPHA_THRESHOLD,
} from '../../../core/src/assets/constants.js';
import {
  HUMANOID_HUE_MAX,
  leastUsedMascot,
  MASCOT_EXPRESSIONS,
  MASCOT_GEARS,
  MASCOT_SPECIES,
  MAX_PERSON_ACC,
  OWNER_LOOK_KEY,
  paletteOfLook,
  PART_ID,
  PART_SLOTS,
  PERSON_COLORS,
} from '../../../core/src/cld/looks.js';
import {
  BODY_VARIANTS,
  FACE_EXPRESSIONS,
  SLOT_REGISTRY,
} from '../../../core/src/cld/partRegistry.js';
import { koText, refused } from '../../../core/src/cld/serverText.js';
import {
  checkSheetPng,
  importHeaderIssue,
  MAX_HD_SHEET_BYTES,
  MAX_IMPORT_BYTES,
  MAX_SHEET_BYTES,
  pngHeaderIssue,
} from '../../../core/src/cld/sheetCheck.js';
import type {
  CharacterChoice,
  CharacterDrinkSteam,
  CharacterPresets as PresetsMessage,
  CharacterRefusalReason,
} from '../../../core/src/messages.js';
import { pickDiversePalette } from '../../../core/src/paletteUtils.js';
import {
  HUE_SHIFT_MAX_DEG,
  PALETTE_COUNT,
  PNG_HEAD_BYTES,
  THUMB_CACHE_DIR,
  THUMB_CACHE_VERSION,
} from '../constants.js';
import { sameOriginRequest } from './authRoutes.js';
import {
  convertSheet,
  cutSheet,
  FRAMES as SHEET_FRAMES,
  IMPORT_DENSITY,
  IMPORT_FRAME_H,
  IMPORT_FRAME_W,
  type SheetFormat,
} from './sheetImport.js';

export const PRESET_ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;
export const MAX_PRESET_BYTES = MAX_SHEET_BYTES;
/** characters.json: what this version adds stops at this many characters and bytes (a file
 *  already past them, which an older version could write, is read and kept as it is). */
export const MAX_STORE_ENTRIES = 500;
export const MAX_STORE_BYTES = 64 * 1024;
/** An automatic look (a pin, not the owner's choice) of a name not seen for this long is dropped. */
export const AUTO_PIN_TTL_DAYS = 90;
/** CHARS-1104: the built-in people are shared out among the names seen this long ago at most (an
 *  agent gone for weeks, kept up to AUTO_PIN_TTL_DAYS, no longer takes one). */
export const RECENT_PIN_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const today = () => Math.floor(Date.now() / DAY_MS);
/** A sanity cap for reading: a bigger file is not parsed (kept as a .bak-<time> copy). */
export const MAX_STORE_READ_BYTES = 1024 * 1024;
/** The file's own entry (§3.2): `{v, pinnedAt}`, written by the pin migration. */
export const STORE_META = '$meta';
/** CHARS-1104: v3 = a named agent's automatic look is a built-in person, not its provider's mascot
 *  (v2 pinned mascots, re-picked once). */
export const STORE_META_V = 3;
const SHEET_W = CHAR_FRAME_W * CHAR_FRAMES_PER_ROW;
const SHEET_H = CHAR_FRAME_H * CHARACTER_DIRECTIONS.length;
const MUGSHOT_SIDE = 16;
/** LOOKS-MEM: a 꾸미기 chip's thumbnail is at most this wide (its 32 CSS px at dpr 3), and all of
 *  them together at most this many bytes (past it a chip shows its name alone). */
const THUMB_MAX_W = 96;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const POLL_MS = 30_000;
/** The last chunk of every PNG (IEND): a thumbnail cache file without it was cut short. */
const PNG_IEND = Buffer.from('0000000049454e44ae426082', 'hex');
const WATCH_DEBOUNCE_MS = 100;
const MAX_KEY_LENGTH = 200;
const MAX_LABEL_LENGTH = 60;
/** Two base64 PNGs at the cap plus the JSON around them. */
const UPLOAD_BODY_LIMIT = 2 * Math.ceil(MAX_PRESET_BYTES / 3) * 4 + 4096;
/** SHEET-IMPORT: one generated sheet (base64) plus the JSON around it. */
const IMPORT_BODY_LIMIT = Math.ceil(MAX_IMPORT_BYTES / 3) * 4 + 4096;
/** An imported sheet: 7 frames of 192×384 in 3 rows (top view) or 2 (isometric); CHAR-ISO-1: or
 *  8, the last the walking neutral (an expansion pack's hand-made sheet; the importer makes 7);
 *  BUNNY-9COL: or 9, the 9th the other foot's passing pose (walk 2, 8, 3, 9). */
const HD_SHEET_W = IMPORT_FRAME_W * SHEET_FRAMES;
const HD_SHEET_WIDTHS = [HD_SHEET_W, HD_SHEET_W + IMPORT_FRAME_W, HD_SHEET_W + 2 * IMPORT_FRAME_W];
/** The width an imported sheet file must have: 8 or 9 columns when it says so, else 7. */
const hdWidth = (file: string): number => {
  const { w } = pngSize(file);
  return HD_SHEET_WIDTHS.includes(w) ? w : HD_SHEET_W;
};
/** CHAR-8DIR: an expansion pack's hand-made 5-row sheet (three-quarter front, three-quarter back,
 *  front, back, right side): both views in one file, 8 directions in the isometric view. */
type PresetFormat = SheetFormat | 'iso8';
const HD_SHEET_H: Record<PresetFormat, number> = {
  top: IMPORT_FRAME_H * 3,
  iso: IMPORT_FRAME_H * 2,
  iso8: IMPORT_FRAME_H * 5,
};
/** C1: an iso8 sheet may carry a 6th row, the drinking poses (columns 1-3 coffee, 4-6 a can). */
const ISO8_DRINK_H = IMPORT_FRAME_H * 6;
const DRINK_CELLS = 6;
/** How an imported sheet walks: 'steps' left, together, right, together (its columns 2, 1, 3, 1);
 *  'two' its two steps alone (2, 3). The owner picks by eye in the import preview. */
const WALKS = ['steps', 'two'] as const;
type Walk = (typeof WALKS)[number];
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const README = `# 캐릭터 프리셋

agty 사무실 캐릭터 그림을 두는 폴더입니다. 데몬이 이 폴더를 지켜보다가 바뀌면 화면에 바로 반영합니다.

## 형식

- \`<이름>.png\`: 112×96 RGBA PNG(8비트, 64 KB 이하). pixel-agents의 \`char_0.png\`와 같은 형식입니다.
  - 가로로 16 px 칸 7개: 걷기 1·2·3, 타이핑 1·2, 읽기 1·2
  - 세로로 32 px 줄 3개: 아래, 위, 오른쪽(왼쪽은 오른쪽을 뒤집어 씁니다)
- \`<이름>.json\`(선택): \`{ "label": "목록에 보일 이름" }\`
- \`<이름>.mug.png\`(선택): 카드에 보일 16×16 얼굴 그림

\`<이름>\`은 영어 소문자나 숫자로 시작하고, 소문자·숫자·\`-\`·\`_\`만 씁니다(41자까지). 다른 파일은 무시하고 데몬 로그에 한 줄 남깁니다.

## 추가하기

이 폴더에 PNG를 복사하면 됩니다. 사무실에서 캐릭터를 누르고 **캐릭터 바꾸기**를 고르면 목록에 나옵니다. **사진으로 만들기**로 만든 캐릭터는 \`photo-<시각>.png\`, 꾸미기의 편집기에서 저장한 캐릭터는 \`custom-<시각>.png\`로 여기에 저장됩니다.

## 이름과 연결

고른 결과는 \`~/.config/agent-tycoon/characters.json\`에 캐릭터 이름(엔진 프로젝트 이름이나 Claude 세션 이름)별로 저장됩니다. 아무것도 고르지 않은 캐릭터도 처음 보인 모습이 저장되어 데몬을 다시 켜도 그대로입니다.

    { "alpha": { "preset": "photo-1761040000000" }, "beta": { "palette": 3, "hueShift": 90 } }

그림 파일이 없거나 형식이 틀리면 그 캐릭터는 기본 모습으로 그립니다.
`;

/** Why `buf` is not a `w`×`h` 8-bit RGBA PNG (RGB too when `opaqueOk`), or
 *  null when it is. The header is checked before pngjs inflates anything (core's
 *  pngHeaderIssue, the browser's rule too). */
export function pngProblem(
  buf: Buffer,
  w: number,
  h: number,
  opaqueOk = false,
  maxBytes = MAX_SHEET_BYTES,
): string | null {
  const header = pngHeaderIssue(buf, w, h, opaqueOk, maxBytes);
  if (header) return header.text;
  try {
    PNG.sync.read(buf);
  } catch (err) {
    return `broken PNG (${err instanceof Error ? err.message : String(err)})`;
  }
  return null;
}

/** LOOKS-MEM: why a file is not a `w`×`h` sheet by its first PNG_HEAD_BYTES alone: the scan never
 *  inflates a sheet to judge it (29 MB for an imported one). Its size is the caller's check. */
function sheetHeadProblem(file: string, w: number, h: number, opaqueOk = false): string | null {
  const head = Buffer.alloc(PNG_HEAD_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const n = fs.readSync(fd, head, 0, PNG_HEAD_BYTES, 0);
    return pngHeaderIssue(head.subarray(0, n), w, h, opaqueOk)?.text ?? null;
  } finally {
    fs.closeSync(fd);
  }
}

/** The shrink factor and size of a `cellW`×`cellH` cell's thumbnail. */
const thumbSize = (cellW: number, cellH: number) => {
  const k = Math.max(1, Math.ceil(cellW / THUMB_MAX_W));
  return { k, w: Math.floor(cellW / k), h: Math.floor(cellH / k) };
};

/** LOOKS-MEM: a 꾸미기 chip's picture, the sheet's first cell (what the chip always showed: the
 *  standing front) shrunk by a whole factor to at most THUMB_MAX_W wide, each pixel the
 *  alpha-weighted mean of its k×k block (as the browser's imported-sheet proxies), so a phone never
 *  decodes a whole sheet (~29 MB for an imported one) per chip. */
export function thumbOf(
  img: { width: number; data: Uint8Array },
  cellW: number,
  cellH: number,
): Buffer {
  const { k, w, h } = thumbSize(cellW, cellH);
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let [r, g, b, a] = [0, 0, 0, 0];
      for (let dy = 0; dy < k; dy++)
        for (let dx = 0; dx < k; dx++) {
          const i = ((y * k + dy) * img.width + x * k + dx) * 4;
          const al = img.data[i + 3];
          [r, g, b, a] = [
            r + img.data[i] * al,
            g + img.data[i + 1] * al,
            b + img.data[i + 2] * al,
            a + al,
          ];
        }
      const o = (y * w + x) * 4;
      if (a)
        [out.data[o], out.data[o + 1], out.data[o + 2]] = [
          Math.round(r / a),
          Math.round(g / a),
          Math.round(b / a),
        ];
      out.data[o + 3] = Math.round(a / (k * k));
    }
  return PNG.sync.write(out, { colorType: 6 });
}

/** The IHDR width and height of a PNG file (its first 24 bytes), or 0s; never opens what is not a
 *  regular file (a FIFO would block the daemon). */
function pngSize(file: string): { w: number; h: number } {
  try {
    if (!fs.lstatSync(file).isFile()) return { w: 0, h: 0 };
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    fs.closeSync(fd);
    return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) };
  } catch {
    return { w: 0, h: 0 };
  }
}

/** A preset sheet's kind by its size: classic 112×96, HD 224×192 (CHAR-FACTORY), or an imported
 *  sheet at density 12 by its rows (top view 3, isometric 2, CHAR-8DIR 5). */
function sheetKind({ w, h }: { w: number; h: number }): { density: Density; format: PresetFormat } {
  if (HD_SHEET_WIDTHS.includes(w))
    return {
      density: IMPORT_DENSITY,
      format:
        h === HD_SHEET_H.iso ? 'iso' : h === HD_SHEET_H.iso8 || h === ISO8_DRINK_H ? 'iso8' : 'top',
    };
  return { density: w === SHEET_W * 2 ? 2 : 1, format: 'top' };
}

/** A v1 look (\`{palette, hueShift}\` or \`{preset}\`), or null: what a daemon before v2 reads. */
export function parseChoice(value: unknown): CharacterChoice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = Object.keys(v).sort().join(',');
  if (keys === 'preset')
    return typeof v.preset === 'string' && PRESET_ID.test(v.preset) ? { preset: v.preset } : null;
  const { palette, hueShift = 0 } = v;
  if (keys !== 'hueShift,palette' && keys !== 'palette') return null;
  if (!Number.isInteger(palette) || (palette as number) < 0 || (palette as number) >= PALETTE_COUNT)
    return null;
  if (
    !Number.isInteger(hueShift) ||
    (hueShift as number) < 0 ||
    (hueShift as number) > HUE_SHIFT_MAX_DEG
  )
    return null;
  return { palette: palette as number, hueShift: hueShift as number };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const intIn = (v: unknown, lo: number, hi: number): v is number =>
  Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  (list as readonly unknown[]).includes(v);
const onlyKeys = (v: object, keys: readonly string[]) =>
  Object.keys(v).every((k) => keys.includes(k));
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const PARTS = ['hair', 'skin', 'top', 'bottom', 'shoes'] as const;
const ACCESSORIES = ['glasses', 'headset', 'cap'] as const;

/**
 * A stored or requested look (§3.2: v1, or v2 by \`kind\`), or null when it is not
 * one. The result is the look's stored form: the v1 shape whenever the look has
 * one (a humanoid without colours or accessories, a custom sheet = \`{preset}\`;
 * photo presets are custom sheets), so a daemon before v2 still shows it.
 */
export function parseAppearance(value: unknown): CharacterChoice | null {
  if (!isObject(value)) return null;
  if (value.v === undefined) return parseChoice(value);
  if (value.v === 3) return retiredBunny(parsePerson(value));
  if (value.v !== 2) return null;
  const v = value;
  switch (v.kind) {
    case 'humanoid': {
      if (!onlyKeys(v, ['v', 'kind', 'base', 'hue', 'colors', 'acc'])) return null;
      const { base = 0, hue = 0, colors, acc } = v;
      if (!intIn(base, 0, PALETTE_COUNT - 1) || !intIn(hue, 0, HUMANOID_HUE_MAX)) return null;
      if (colors !== undefined && v.hue !== undefined) return null; // one or the other
      if (
        colors !== undefined &&
        !(
          isObject(colors) &&
          Object.entries(colors).every(
            ([part, c]) => oneOf(PARTS, part) && typeof c === 'string' && HEX_COLOR.test(c),
          )
        )
      )
        return null;
      if (
        acc !== undefined &&
        !(
          Array.isArray(acc) &&
          acc.length <= ACCESSORIES.length &&
          new Set(acc).size === acc.length &&
          acc.every((a) => oneOf(ACCESSORIES, a))
        )
      )
        return null;
      const parts = Object.entries((colors ?? {}) as Record<string, string>);
      const accs = (acc ?? []) as NonNullable<CharacterChoice['acc']>;
      if (!parts.length && !accs.length) return { palette: base, hueShift: hue };
      return {
        v: 2,
        kind: 'humanoid',
        base,
        ...(v.hue !== undefined && hue !== 0 && { hue }),
        ...(parts.length && {
          colors: Object.fromEntries(parts.map(([k, c]) => [k, c.toLowerCase()])),
        }),
        ...(accs.length && { acc: [...accs] }),
      };
    }
    case 'mascot': {
      if (!onlyKeys(v, ['v', 'kind', 'species', 'color', 'expr', 'gear'])) return null;
      const { species, color, expr, gear } = v;
      if (species !== undefined && !oneOf(MASCOT_SPECIES, species)) return null;
      if (color !== undefined && !(typeof color === 'string' && HEX_COLOR.test(color))) return null;
      if (expr !== undefined && !oneOf(MASCOT_EXPRESSIONS, expr)) return null;
      if (gear !== undefined && !oneOf(MASCOT_GEARS, gear)) return null;
      return {
        v: 2,
        kind: 'mascot',
        ...(species && { species }),
        ...(color !== undefined && { color: color.toLowerCase() }),
        ...(expr && { expr }),
        ...(gear && { gear }),
      };
    }
    case 'custom':
      return onlyKeys(v, ['v', 'kind', 'sheet']) &&
        typeof v.sheet === 'string' &&
        PRESET_ID.test(v.sheet)
        ? { preset: v.sheet }
        : null;
    default:
      return null;
  }
}

/** BUNNY-SHEET (11-04): the retired `hd-bunny/bunny` preset's parts look, read as the built-in bunny
 *  sheet (her 8-way walk). ponytail: one release of data compatibility, drop with the hd-bunny parts. */
const RETIRED_BUNNY: Record<string, string> = {
  body: 'hd-bunny/body',
  face: 'hd-bunny/face',
  hair: 'hd-bunny/hair',
  fullbody: 'hd-bunny/suit',
  legwear: 'hd-bunny/tights',
  shoes: 'hd-bunny/heels',
  wrist: 'hd-bunny/cuffs',
  neck: 'hd-bunny/bowtie',
  back: 'hd-bunny/tail',
};
const BUILTIN_BUNNY = 'builtin-bunny';
function retiredBunny(look: CharacterChoice | null): CharacterChoice | null {
  const parts = look?.parts as Record<string, unknown> | undefined;
  const same =
    parts &&
    !look?.colors &&
    Object.keys(parts).length === Object.keys(RETIRED_BUNNY).length &&
    Object.entries(RETIRED_BUNNY).every(([slot, id]) => parts[slot] === id);
  return same ? { preset: BUILTIN_BUNNY } : look;
}

/** CHAR-HUMAN: a v3 person (\`gender\`, a part id per slot, a colour per slot), its stored form
 *  (colours lower case, empty fields left out), or null. Part ids are only checked for shape: the
 *  webview draws an unknown one as its slot's built-in. */
function parsePerson(v: Record<string, unknown>): CharacterChoice | null {
  if (
    v.kind !== 'person' ||
    !onlyKeys(v, ['v', 'kind', 'gender', 'parts', 'colors', 'body', 'expr', 'adult'])
  )
    return null;
  // `adult` (an old adult-original mark, 10-25) is read and dropped: there is no such gate now
  const { gender, parts = {}, colors = {}, body, expr } = v;
  if (gender !== undefined && gender !== 'm' && gender !== 'f') return null;
  if (body !== undefined && !oneOf(BODY_VARIANTS, body)) return null;
  if (expr !== undefined && !oneOf(FACE_EXPRESSIONS, expr)) return null;
  if (!isObject(parts) || !onlyKeys(parts, PART_SLOTS)) return null;
  const outParts: NonNullable<CharacterChoice['parts']> = {};
  for (const slot of PART_SLOTS) {
    const id = parts[slot];
    if (id === undefined) continue;
    if (slot === 'acc') {
      if (
        !Array.isArray(id) ||
        id.length > MAX_PERSON_ACC ||
        new Set(id).size !== id.length ||
        !id.every((a) => typeof a === 'string' && PART_ID.test(a))
      )
        return null;
      if (id.length) outParts.acc = [...(id as string[])];
    } else if (typeof id === 'string' && PART_ID.test(id)) outParts[slot] = id;
    else return null;
  }
  if (!isObject(colors) || !onlyKeys(colors, PERSON_COLORS)) return null;
  const outColors: Record<string, string> = {};
  for (const [k, c] of Object.entries(colors)) {
    if (typeof c !== 'string' || !HEX_COLOR.test(c)) return null;
    outColors[k] = c.toLowerCase();
  }
  // a full-body suit replaces top and bottom (the registry's `clears`)
  for (const [slot, info] of Object.entries(SLOT_REGISTRY))
    if (outParts[slot as keyof typeof outParts] !== undefined)
      for (const cleared of info.clears ?? []) delete outParts[cleared as keyof typeof outParts];
  return {
    v: 3,
    kind: 'person',
    ...(gender !== undefined && { gender }),
    ...(body !== undefined && body !== 'standard' && { body }),
    ...(expr !== undefined && expr !== 'neutral' && { expr }),
    parts: outParts,
    ...(Object.keys(outColors).length && { colors: outColors }),
  };
}

/** The built-in person \`looks\` use least (random among ties; past CHAR_COUNT with a hue turn). */
function pickPerson(looks: Iterable<CharacterChoice | undefined>): {
  palette: number;
  hueShift: number;
} {
  const counts = new Array<number>(PALETTE_COUNT).fill(0);
  for (const look of looks) {
    const p = paletteOfLook(look);
    if (p && p.palette < PALETTE_COUNT) counts[p.palette]++;
  }
  return pickDiversePalette(PALETTE_COUNT, counts);
}

/**
 * The look a name gets the first time it is seen after the pin migration (§3.3 item 2). CHARS-1104:
 * a named agent (lead, teammate, engine project) gets the built-in person the \`looks\` of the names
 * \`counted\` passes use least, at random among ties; an employee (\`emp:<id>\`: a sub-agent's, a Codex
 * temporary's) the mascot (species and colour) the employees' looks use least, its provider's
 * species first among ties (decision 9). Kept per employee afterwards, as every pin is.
 */
export function firstSightLook(
  name: string,
  provider: string | null | undefined,
  looks: Readonly<Record<string, CharacterChoice>>,
  counted: (name: string) => boolean = () => true,
): CharacterChoice {
  if (!name.startsWith('emp:'))
    return pickPerson(Object.entries(looks).flatMap(([n, l]) => (counted(n) ? [l] : [])));
  const staff = Object.entries(looks).filter(([k]) => k.startsWith('emp:'));
  return {
    v: 2,
    kind: 'mascot',
    ...leastUsedMascot(
      provider,
      staff.map(([, l]) => l),
    ),
  };
}

const validKey = (key: unknown): key is string =>
  typeof key === 'string' && key.length > 0 && key.length <= MAX_KEY_LENGTH && key !== STORE_META;

/** What a pin writes: a v1 palette (the migration) or a plain mascot (a new name, CH-3). */
type AutoLook =
  | { palette: number; hueShift: number }
  | { species: NonNullable<CharacterChoice['species']>; color: string };
type AutoPin = { d: number } & AutoLook;

const autoPin = (d: number, look: AutoLook): AutoPin => ({ d, ...look });

/** The pin-shaped look of a stored entry, or null when it is no shape a pin writes. */
const autoLookOf = (value: unknown): AutoLook | null => {
  const look = parseAppearance(value);
  if (look?.palette !== undefined && look.hueShift !== undefined)
    return { palette: look.palette, hueShift: look.hueShift };
  if (look?.kind === 'mascot' && look.species && look.color && !look.expr && !look.gear)
    return { species: look.species, color: look.color };
  return null;
};

/** The stored entry of a pin's look. */
const entryOf = (look: AutoLook): CharacterChoice =>
  'palette' in look ? look : { v: 2, kind: 'mascot', species: look.species, color: look.color };

const lookId = (look: AutoLook) =>
  'palette' in look ? `p:${look.palette}:${look.hueShift}` : `m:${look.species}:${look.color}`;

const parseAutoPin = (value: unknown): AutoPin | null => {
  if (!isObject(value) || typeof value.d !== 'number' || !Number.isInteger(value.d)) return null;
  const { d, ...rest } = value;
  const look =
    'palette' in rest
      ? onlyKeys(rest, ['palette', 'hueShift']) && autoLookOf(rest)
      : onlyKeys(rest, ['species', 'color']) && autoLookOf({ v: 2, kind: 'mascot', ...rest });
  return look ? autoPin(d, look) : null;
};

/** True only while a raw entry is the precise look this pin wrote. */
const matchesAutoPin = (value: unknown, pin: AutoPin): boolean => {
  const look = autoLookOf(value);
  return !!look && lookId(look) === lookId(pin);
};

const sameAutoPin = (a: AutoPin | undefined, b: AutoPin) =>
  !!a && a.d === b.d && lookId(a) === lookId(b);

export const decode = (value: unknown): Buffer | null =>
  typeof value === 'string' && BASE64.test(value) ? Buffer.from(value, 'base64') : null;

/** The card face when none is given: 16×16 from the standing front frame (row 1, frame 2),
 *  from its first opaque row down (so a short character's head is in it too). */
function faceOf(rgba: Buffer): Buffer {
  const x0 = CHAR_FRAME_W;
  const opaqueRow = (y: number) => {
    for (let x = 0; x < CHAR_FRAME_W; x++)
      if (rgba[(y * SHEET_W + x0 + x) * 4 + 3] >= PNG_ALPHA_THRESHOLD) return true;
    return false;
  };
  let top = 0;
  while (top < CHAR_FRAME_H - MUGSHOT_SIDE && !opaqueRow(top)) top++;
  const face = new PNG({ width: MUGSHOT_SIDE, height: MUGSHOT_SIDE });
  for (let y = 0; y < MUGSHOT_SIDE; y++)
    rgba.copy(
      face.data,
      y * MUGSHOT_SIDE * 4,
      ((top + y) * SHEET_W + x0) * 4,
      ((top + y) * SHEET_W + x0 + MUGSHOT_SIDE) * 4,
    );
  return PNG.sync.write(face, { colorType: 6 });
}

type Density = 1 | 2 | typeof IMPORT_DENSITY;

interface Preset {
  id: string;
  label: string;
  /** BUNNY-BUILTIN: the folder its files are in (the user's, or a built-in pack's `sheets`). */
  dir: string;
  builtIn: boolean;
  /** The files stay on disk (`<id>.png`, `<id>.mug.png`, `<id>.iso.png`): memory keeps only
   *  which exist, not their bytes. */
  mug: boolean;
  /** LOOKS-MEM: `<id>.thumb.png`, made by the scan (null past MAX_THUMB_BYTES or if it failed). */
  thumb: Buffer | null;
  version: string;
  /** CHAR-FACTORY: 2 for an HD sheet (224×192); SHEET-IMPORT: 12 for an imported one. */
  density: Density;
  /** SHEET-IMPORT: what `<id>.png` shows (an isometric sheet: front and back three-quarter rows). */
  format: PresetFormat;
  /** SHEET-IMPORT: an isometric sheet beside a top-view one (`<id>.iso.png`). */
  iso: boolean;
  /** SHEET-IMPORT (from `<id>.json`): the columns are the owner's prompt order (standing, left
   *  foot, right foot, ...), and how it walks. */
  standFirst: boolean;
  walk: Walk;
  /** C1 (from `<id>.json`): where a held cup's steam rises in the drink row's cells. */
  drinkSteam: CharacterDrinkSteam[];
}

export interface CharacterPresetOptions {
  /** ~/.config/agent-tycoon */
  configDir: string;
  /** BUNNY-BUILTIN: read-only preset folders shipped with the daemon (built-in packs' `sheets`),
   *  read before the user's; a built-in id wins. Not watched: they never change while it runs. */
  builtInDirs?: readonly string[];
  publish(msg: PresetsMessage): void;
  /** A character by this name exists now (checked for setCharacter and uploads). */
  knownKey(key: string): boolean;
}

export class CharacterPresets {
  readonly dir: string;
  private readonly storeFile: string;
  private presets = new Map<string, Preset>();
  private assignments: Record<string, CharacterChoice> = {};
  /** Entries of characters.json this daemon cannot read: written back untouched. */
  private foreign: Record<string, unknown> = {};
  /** characters.json's \`$meta\` as read (kept as it is); null = the pin migration has not run. */
  private meta: Record<string, unknown> | null = null;
  private storeUnreadable = false;
  /** The automatic looks (pins, not the owner's choices) by name, with their exact v1 look and
   *  the day (since the epoch) each name was last seen: \`$meta.auto\`. */
  private auto = new Map<string, AutoPin>();
  /** The names the last pin saw live (evicted last). */
  private live = new Set<string>();
  /** A pin that did not fit is not retried before the next day (or a change by the owner). */
  private pinBlockedDay = -1;
  /** Characters and bytes of the file as last read or written (what a save may not grow past the limits). */
  private stored = { count: 0, bytes: 0 };
  private readonly thumbDir: string;
  private signature: string | null = null;
  private readonly logged = new Set<string>();
  private watcher: fs.FSWatcher | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: CharacterPresetOptions) {
    this.dir = path.join(opts.configDir, 'characters');
    this.storeFile = path.join(opts.configDir, 'characters.json');
    this.thumbDir = path.join(opts.configDir, THUMB_CACHE_DIR);
  }

  start(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const readme = path.join(this.dir, 'README.md');
      if (!fs.existsSync(readme)) fs.writeFileSync(readme, README);
    } catch (err) {
      console.warn(`[agty] characters: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.loadAssignments();
    this.scan();
    try {
      this.watcher = fs.watch(this.dir, () => {
        if (this.debounce) clearTimeout(this.debounce);
        this.debounce = setTimeout(() => this.scan(), WATCH_DEBOUNCE_MS);
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      // The viewing-time scan sees every change too, only later.
    }
  }

  /** While someone views: a scan now and every 30 s; nobody: fs.watch alone. */
  setViewing(on: boolean): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    if (!on) return;
    this.scan();
    this.poll = setInterval(() => this.scan(), POLL_MS);
  }

  dispose(): void {
    this.watcher?.close();
    if (this.poll) clearInterval(this.poll);
    if (this.debounce) clearTimeout(this.debounce);
  }

  message(): PresetsMessage {
    return {
      type: 'characterPresets',
      presets: [...this.presets.values()].map((p) => ({
        id: p.id,
        label: p.label,
        url: `cld/characters/${p.id}.png?v=${p.version}`,
        mugshotUrl: p.mug ? `cld/characters/${p.id}.mug.png?v=${p.version}` : null,
        ...(p.thumb && { thumbUrl: `cld/characters/${p.id}.thumb.png?v=${p.version}` }),
        ...(p.density !== 1 && { density: p.density }),
        ...(p.format !== 'top' && { format: p.format }),
        ...(p.iso && { isoUrl: `cld/characters/${p.id}.iso.png?v=${p.version}` }),
        ...(p.standFirst && { columns: 'standFirst' as const }),
        ...(p.walk !== 'steps' && { walk: p.walk }),
        ...(p.drinkSteam.length > 0 && { drinkSteam: p.drinkSteam }),
      })),
      assignments: { ...this.assignments },
    };
  }

  /** `<id>.png`, `<id>.mug.png` or `<id>.iso.png` as checked by the last scan: its path and size
   *  (the route streams it from disk), else null. */
  file(name: string): { path: string; size: number } | null {
    const m = /^([a-z0-9][a-z0-9_-]{0,40})(\.mug|\.iso)?\.png$/.exec(name);
    const preset = m ? this.presets.get(m[1]) : undefined;
    if (!m || !preset || (m[2] === '.mug' && !preset.mug) || (m[2] === '.iso' && !preset.iso))
      return null;
    try {
      // BUNNY-BUILTIN: from its own folder, and only a file right in it (no symlink out of it)
      const file = fs.realpathSync(path.join(preset.dir, name));
      if (path.dirname(file) !== fs.realpathSync(preset.dir)) return null;
      return { path: file, size: fs.statSync(file).size };
    } catch {
      return null; // deleted since the scan; the next scan drops the preset
    }
  }

  /** LOOKS-MEM: `<id>.thumb.png` as the last scan made it, else null. */
  thumb(name: string): Buffer | null {
    const m = /^([a-z0-9][a-z0-9_-]{0,40})\.thumb\.png$/.exec(name);
    return (m && this.presets.get(m[1])?.thumb) || null;
  }

  /** Re-read the folders when anything in them changed (names, sizes, mtimes): the built-in ones
   *  first (BUNNY-BUILTIN), then the user's. */
  scan(): void {
    const folders = [...(this.opts.builtInDirs ?? []), this.dir].map((dir) => {
      let names: string[] = [];
      try {
        names = fs.readdirSync(dir).sort();
      } catch {
        // No folder: no presets.
      }
      const stats = new Map<string, fs.Stats>();
      for (const name of names) {
        try {
          stats.set(name, fs.lstatSync(path.join(dir, name)));
        } catch {
          // Deleted between readdir and lstat.
        }
      }
      return { dir, stats };
    });
    const signature = folders
      .flatMap(({ dir, stats }) => [...stats].map(([n, s]) => `${dir}/${n}:${s.size}:${s.mtimeMs}`))
      .join('|');
    if (signature === this.signature) return;
    this.signature = signature;
    const next = new Map<string, Preset>();
    let thumbBytes = 0;
    const used = new Set<string>();
    for (const { dir, stats } of folders) {
      const builtIn = dir !== this.dir;
      const read = (
        name: string,
        w: number,
        h: number,
        opaqueOk = false,
        maxBytes = MAX_PRESET_BYTES,
        hash?: crypto.Hash,
      ): boolean => {
        const st = stats.get(name)!;
        let problem: string | null = null;
        if (!st.isFile()) problem = 'not a regular file';
        else if (st.size > maxBytes) problem = `too big (${st.size} bytes)`;
        else {
          try {
            // LOOKS-MEM: the header is judged, the file's size and mtime are its version (nothing
            // is read or inflated; the bytes are served from disk)
            problem = sheetHeadProblem(path.join(dir, name), w, h, opaqueOk);
            if (!problem) hash?.update(`${name}:${st.size}:${st.mtimeMs}`);
          } catch (err) {
            problem = err instanceof Error ? err.message : String(err);
          }
        }
        if (problem) this.ignore(name, st, problem);
        return !problem;
      };
      for (const [name, st] of stats) {
        if (name === 'README.md' || name.startsWith('.')) continue;
        const m = /^(.+?)(\.mug\.png|\.iso\.png|\.png|\.json)$/.exec(name);
        if (!m || !PRESET_ID.test(m[1])) {
          this.ignore(
            name,
            st,
            'not <id>.png, <id>.json, <id>.mug.png or <id>.iso.png (id: a-z 0-9 - _)',
          );
          continue;
        }
        const id = m[1];
        // BUNNY-BUILTIN: an id an earlier (built-in) folder has stays its
        const shadow = next.get(id);
        if (shadow && shadow.dir !== dir) {
          this.ignore(name, st, `${id} is a built-in preset`);
          continue;
        }
        if (m[2] !== '.png') {
          if (!stats.has(`${id}.png`)) this.ignore(name, st, `no ${id}.png beside it`);
          continue;
        }
        // CHAR-FACTORY: an HD sheet (twice the detail, the same layout) is 224×192, its portrait 32×32;
        // SHEET-IMPORT: an imported one 1344 wide (no portrait: the screen crops its own)
        const kind = st.isFile()
          ? sheetKind(pngSize(path.join(dir, name)))
          : sheetKind({ w: 0, h: 0 }); // never open a non-file
        const { density, format } = kind;
        const imported = density === IMPORT_DENSITY;
        // C1: an iso8 sheet with its drink row is one row taller
        const drinkRow = format === 'iso8' && pngSize(path.join(dir, name)).h === ISO8_DRINK_H;
        const hash = crypto.createHash('sha1');
        const ok = imported
          ? read(
              name,
              hdWidth(path.join(dir, name)),
              drinkRow ? ISO8_DRINK_H : HD_SHEET_H[format],
              false,
              MAX_HD_SHEET_BYTES,
              hash,
            )
          : read(name, SHEET_W * density, SHEET_H * density, false, MAX_PRESET_BYTES, hash);
        if (!ok) continue;
        // LOOKS-MEM: the chip's thumbnail, from the disk cache; only a sheet it has none of is
        // inflated, one at a time
        const [cellW, cellH] = imported
          ? [IMPORT_FRAME_W, IMPORT_FRAME_H]
          : [CHAR_FRAME_W * density, CHAR_FRAME_H * density];
        let thumb: Buffer | null = null;
        try {
          const t = this.thumbOfSheet(path.join(dir, name), stats.get(name)!, cellW, cellH, used);
          if (thumbBytes + t.length <= MAX_THUMB_BYTES)
            [thumb, thumbBytes] = [t, thumbBytes + t.length];
        } catch (err) {
          this.ignore(
            name,
            stats.get(name)!,
            `broken PNG (${err instanceof Error ? err.message : String(err)})`,
          );
          continue;
        }
        const mug =
          stats.has(`${id}.mug.png`) &&
          !imported &&
          read(
            `${id}.mug.png`,
            MUGSHOT_SIDE * density,
            MUGSHOT_SIDE * density,
            true,
            MAX_PRESET_BYTES,
            hash,
          );
        const iso =
          stats.has(`${id}.iso.png`) &&
          format === 'top' &&
          read(
            `${id}.iso.png`,
            hdWidth(path.join(dir, `${id}.iso.png`)),
            HD_SHEET_H.iso,
            false,
            MAX_HD_SHEET_BYTES,
            hash,
          );
        const version = hash.digest('hex').slice(0, 10);
        const meta = this.metaOf(dir, id, stats);
        next.set(id, {
          id,
          label: meta.label,
          dir,
          builtIn,
          mug,
          thumb,
          version,
          density,
          format,
          iso,
          standFirst: imported && meta.standFirst,
          walk: imported ? meta.walk : 'steps',
          drinkSteam: drinkRow ? meta.drinkSteam : [],
        });
      }
    }
    this.presets = next;
    this.pruneThumbs(used);
    this.publish();
  }

  /** LOOKS-MEM: a sheet's chip thumbnail. It is cached on disk (`<config>/${THUMB_CACHE_DIR}/<key>.png`),
   *  the key the sheet's size, mtime and cell: a changed sheet is a new key, so only it is inflated
   *  again. A cache file that is missing or not a whole PNG of the right size is made anew. Throws
   *  when the sheet does not inflate. */
  private thumbOfSheet(
    file: string,
    st: fs.Stats,
    cellW: number,
    cellH: number,
    used: Set<string>,
  ): Buffer {
    const key = crypto
      .createHash('sha1')
      .update(`${THUMB_CACHE_VERSION}:${cellW}x${cellH}:${st.size}:${st.mtimeMs}`)
      .digest('hex');
    used.add(key);
    const cached = path.join(this.thumbDir, `${key}.png`);
    const { w, h } = thumbSize(cellW, cellH);
    try {
      const buf = fs.readFileSync(cached);
      if (!pngHeaderIssue(buf, w, h) && buf.subarray(-PNG_IEND.length).equals(PNG_IEND)) return buf;
    } catch {
      // not cached yet
    }
    const t = thumbOf(PNG.sync.read(fs.readFileSync(file)), cellW, cellH);
    try {
      fs.mkdirSync(this.thumbDir, { recursive: true });
      const tmp = `${cached}.tmp`;
      fs.writeFileSync(tmp, t);
      fs.renameSync(tmp, cached);
    } catch (err) {
      console.warn(
        `[agty] characters: thumbnail cache: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return t;
  }

  /** LOOKS-MEM: the cache holds what the last scan used and nothing else. */
  private pruneThumbs(used: Set<string>): void {
    try {
      for (const n of fs.readdirSync(this.thumbDir))
        if (!used.has(n.replace(/\.png$/, '')))
          fs.rmSync(path.join(this.thumbDir, n), { force: true });
    } catch {
      // no cache folder yet
    }
  }

  /** setCharacter from a client; a refusal is answered to it (\`characterRefused\`). True when
   *  the message was this one's. */
  onClientMessage(
    msg: Record<string, unknown>,
    send?: (m: Record<string, unknown>) => void,
  ): boolean {
    if (msg.type !== 'setCharacter') return false;
    const refuse = (reason: CharacterRefusalReason) => {
      console.warn(`[agty] setCharacter ${JSON.stringify(msg.key)}: refused (${reason})`);
      send?.({
        type: 'characterRefused',
        key: typeof msg.key === 'string' ? msg.key.slice(0, MAX_KEY_LENGTH) : '',
        reason,
      });
    };
    const choice = msg.character === null ? null : parseAppearance(msg.character);
    if (!validKey(msg.key) || !this.opts.knownKey(msg.key)) refuse('unknown');
    else if (
      msg.character !== null &&
      (!choice || (choice.preset && !this.presets.has(choice.preset)))
    )
      refuse('invalid');
    else if (!this.assign(msg.key, choice)) refuse('full');
    return true;
  }

  /** POST /cld/characters {key, sheet, mugshot?, kind?}: a sheet made from a photo
   *  (`photo-<time>`) or in the editor (kind 'custom': `custom-<time>`), checked with the
   *  browser's rules (design §4.3); without a mugshot the face is cut from the front frame. */
  async saveSheet(body: unknown): Promise<{ id: string; warning?: string } | { error: string }> {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (!validKey(b.key) || !this.opts.knownKey(b.key)) return { error: 'unknown character' };
    const key = b.key;
    const custom = b.kind === 'custom';
    const sheet = decode(b.sheet);
    const hasMug = b.mugshot !== undefined && b.mugshot !== null;
    let mug = hasMug ? decode(b.mugshot) : null;
    if (!sheet || (hasMug && !mug)) return { error: 'not base64' };
    const decoded: { rgba?: Buffer } = {};
    const check = await checkSheetPng(sheet, (bytes) => {
      decoded.rgba = PNG.sync.read(Buffer.from(bytes)).data;
      return decoded.rgba;
    });
    const problem =
      check.problem?.text ?? (mug ? pngProblem(mug, MUGSHOT_SIDE, MUGSHOT_SIDE, true) : null);
    if (problem) return { error: problem };
    mug ??= faceOf(decoded.rgba!);
    const prefix = custom ? 'custom' : 'photo';
    let id = `${prefix}-${Date.now()}`;
    for (let n = 1; this.taken(id); n++) id = `${prefix}-${Date.now()}-${n}`;
    try {
      const label = koText(custom ? 'custom_label' : 'photo_label', {
        name: key.slice(0, MAX_LABEL_LENGTH - 4),
      });
      this.writeAtomic(`${id}.json`, JSON.stringify({ label }) + '\n');
      this.writeAtomic(`${id}.mug.png`, mug);
      this.writeAtomic(`${id}.png`, sheet); // last: a scan never sees it without its label
    } catch (err) {
      return { error: `not saved (${err instanceof Error ? err.message : String(err)})` };
    }
    this.scan();
    if (!this.assign(key, { preset: id })) return { error: 'characters.json is full' };
    const warning = check.warning?.text;
    if (warning) console.warn(`[agty] characters: ${id} saved with a warning: ${warning}`);
    return warning ? { id, warning } : { id };
  }

  /**
   * SHEET-IMPORT: POST /cld/characters/import(/preview) {png, label?, attach?, walk?}: a generated
   * sheet (untrusted: core importHeaderIssue's caps before decoding) cut and converted
   * (sheetImport.ts). The preview answers the converted sheet (base64 PNG), where each frame came
   * from and the report; the save writes it as a new preset `sheet-<time>` (`<id>.png`, `<id>.json`
   * with its label, column order and walk) or, with `attach`, beside an imported preset's sheet of
   * the other format (`<id>.iso.png`; a top view attached to an isometric one takes `<id>.png`
   * and moves the isometric one beside it) or over its sheet of the same format.
   */
  importSheet(
    body: unknown,
    save: boolean,
  ):
    | { id: string; format: SheetFormat }
    | { format: SheetFormat; sheet: string; places: unknown; report: unknown }
    | Refused {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const png = decode(b.png);
    if (!png) return refused('sheet_import_png', { why: 'not base64' });
    const header = importHeaderIssue(png);
    if (header) return refused('sheet_import_png', { why: header.text });
    let img: { width: number; height: number; data: Uint8Array };
    try {
      const decoded = PNG.sync.read(png);
      img = { width: decoded.width, height: decoded.height, data: decoded.data };
    } catch (err) {
      return refused('sheet_import_png', { why: err instanceof Error ? err.message : String(err) });
    }
    const cut = cutSheet(img);
    if ('code' in cut) return refused(cut.code, cut.vars);
    const conv = convertSheet(img, cut);
    const out = new PNG({ width: conv.width, height: conv.height });
    out.data = Buffer.from(conv.data);
    const sheet = PNG.sync.write(out, { colorType: 6 });
    if (!save)
      return {
        format: cut.format,
        sheet: sheet.toString('base64'),
        places: conv.places,
        report: conv.report,
      };
    const walk: Walk = WALKS.includes(b.walk as Walk) ? (b.walk as Walk) : 'steps';
    const label =
      typeof b.label === 'string' && b.label.trim()
        ? b.label.trim().slice(0, MAX_LABEL_LENGTH)
        : koText('sheet_label');
    const attach = typeof b.attach === 'string' ? this.presets.get(b.attach) : undefined;
    // CHAR-8DIR: a 5-row sheet already holds both views
    // BUNNY-BUILTIN: a built-in preset is read-only
    if (
      b.attach !== undefined &&
      (attach?.density !== IMPORT_DENSITY || attach.format === 'iso8' || attach.builtIn)
    )
      return refused('sheet_import_attach', { id: String(b.attach).slice(0, MAX_LABEL_LENGTH) });
    let id = attach?.id ?? `sheet-${Date.now()}`;
    for (let n = 1; !attach && this.taken(id); n++) id = `sheet-${Date.now()}-${n}`;
    try {
      this.writeAtomic(
        `${id}.json`,
        JSON.stringify({ label: attach ? attach.label : label, columns: 'standFirst', walk }) +
          '\n',
      );
      if (!attach || attach.format === cut.format) this.writeAtomic(`${id}.png`, sheet);
      else if (cut.format === 'iso') this.writeAtomic(`${id}.iso.png`, sheet);
      else {
        // the isometric sheet moves beside the new top view
        this.writeAtomic(`${id}.iso.png`, fs.readFileSync(path.join(this.dir, `${attach.id}.png`)));
        this.writeAtomic(`${id}.png`, sheet);
      }
    } catch (err) {
      return refused('sheet_import_png', {
        why: `not saved (${err instanceof Error ? err.message : String(err)})`,
      });
    }
    this.scan();
    console.log(`[agty] characters: imported ${id} (${cut.format}, ${conv.report.ms} ms)`);
    return { id, format: cut.format };
  }

  /**
   * Pin migration (§3.3): every character name without a look keeps the one it has now,
   * so a restart (which draws palettes at random) shows the same characters. The first
   * time (no \`$meta\`) that is also every name in the engine's registry (\`registryNames\`,
   * read from its files, so with the engine off too), then \`$meta\`; after that each new
   * name at first sight (\`firstSightLook\`). These automatic looks are remembered with the
   * exact v1 look and day each name was last seen; one not seen for AUTO_PIN_TTL_DAYS is dropped,
   * and at the limits the least recently seen gives way. One write, only when something changed.
   */
  pin(
    live: ReadonlyArray<{
      name: string;
      palette: number;
      hueShift: number;
      provider?: string | null;
    }>,
    registryNames: () => string[],
  ): void {
    const day = today();
    this.live = new Set(live.map((c) => c.name));
    if (this.pinBlockedDay === day) return;
    const first = this.meta === null;
    const next = { ...this.assignments };
    const auto = new Map(this.auto);
    const meta =
      this.meta === null
        ? { v: STORE_META_V, pinnedAt: new Date().toISOString() }
        : typeof this.meta.v === 'number' && this.meta.v >= STORE_META_V
          ? this.meta // a later version's file is left as it is
          : { ...this.meta, v: STORE_META_V };
    // CHARS-1104: the people go to the names seen lately, never to the owner's own look
    const counted = (name: string) => {
      const pinned = auto.get(name);
      return (
        name !== OWNER_LOOK_KEY &&
        (this.live.has(name) || (!!pinned && day - pinned.d <= RECENT_PIN_DAYS))
      );
    };
    const providerOf = (name: string) => live.find((c) => c.name === name)?.provider;
    // CHARS-1104: once, a named agent's automatic mascot (v2's first-sight look) becomes a person
    // and an employee's automatic palette a mascot; the owner's choices are never in \`auto\`
    if (meta !== this.meta)
      for (const [name, pinned] of auto) {
        const staff = name.startsWith('emp:');
        if (staff === 'species' in pinned) continue; // already the right kind
        const look = autoLookOf(firstSightLook(name, providerOf(name), next, counted));
        if (!look) continue;
        next[name] = entryOf(look);
        auto.set(name, autoPin(pinned.d, look));
      }
    const free = (name: string) => validKey(name) && !(name in next) && !(name in this.foreign);
    const counts = new Array<number>(PALETTE_COUNT).fill(0);
    for (const c of live) {
      if (c.palette < PALETTE_COUNT) counts[c.palette]++;
      const pinned = auto.get(c.name);
      if (pinned) auto.set(c.name, { ...pinned, d: day });
      if (!free(c.name)) continue;
      // ponytail: a palette past CHAR_COUNT (external char_N) does not validate, so it stays unpinned
      // the first start keeps a named character's palette; an employee is a mascot from the start
      const look = autoLookOf(
        first && !c.name.startsWith('emp:')
          ? { palette: c.palette, hueShift: c.hueShift }
          : firstSightLook(c.name, c.provider, next, counted),
      );
      if (!look) continue;
      next[c.name] = entryOf(look);
      auto.set(c.name, autoPin(day, look));
    }
    if (first)
      for (const name of registryNames()) {
        if (!free(name)) continue;
        const pick = pickDiversePalette(PALETTE_COUNT, counts);
        counts[pick.palette]++;
        next[name] = pick;
        auto.set(name, autoPin(day, pick));
      }
    for (const [name, seen] of auto)
      if (!this.live.has(name) && day - seen.d > AUTO_PIN_TTL_DAYS) {
        delete next[name];
        auto.delete(name);
      }
    const same =
      Object.keys(next).length === Object.keys(this.assignments).length &&
      Object.keys(next).every((k) => k in this.assignments) &&
      auto.size === this.auto.size &&
      [...auto].every(([k, v]) => sameAutoPin(this.auto.get(k), v));
    if (!first && same && meta === this.meta) return;
    if (!this.save(next, auto, meta, this.victims(auto, true))) {
      this.pinBlockedDay = day;
      return;
    }
    this.meta = meta;
    this.publish();
  }

  /** The owner's choice (null: none). False when it did not fit (nothing changed). */
  private assign(key: string, choice: CharacterChoice | null): boolean {
    const next = { ...this.assignments };
    if (choice) next[key] = choice;
    else delete next[key];
    const auto = new Map(this.auto);
    auto.delete(key);
    const foreign = this.foreign[key];
    delete this.foreign[key];
    if (!this.save(next, auto, this.meta, this.victims(auto, false))) {
      if (foreign !== undefined) this.foreign[key] = foreign;
      return false;
    }
    this.pinBlockedDay = -1; // room may have changed
    this.publish();
    return true;
  }

  /** Automatic looks in the order they give way: least recently seen first, the names live
   *  now last (or never, for a pin: it would only be pinned again). */
  private victims(auto: Map<string, AutoPin>, notLive: boolean): string[] {
    return [...auto]
      .filter(([name]) => !(notLive && this.live.has(name)))
      .sort(([a, x], [b, y]) => Number(this.live.has(a)) - Number(this.live.has(b)) || x.d - y.d)
      .map(([name]) => name);
  }

  /**
   * Write characters.json (tmp + rename) and take it as the state. What this version adds may
   * not take the file past 500 characters or 64 KB (a file already past them may shrink, not
   * grow): \`victims\` give way first; false when it still would not fit (nothing written,
   * logged once). A failed write is logged and the change kept in memory.
   */
  private save(
    assignments: Record<string, CharacterChoice>,
    auto: Map<string, AutoPin>,
    meta: Record<string, unknown> | null,
    victims: string[],
  ): boolean {
    for (const [name, pin] of auto) if (!matchesAutoPin(assignments[name], pin)) auto.delete(name);
    let text = '';
    let count = 0;
    let bytes = 0;
    // ponytail: one stringify per evicted look; at most 500, and only at the limits
    for (;;) {
      const entries = { ...this.foreign, ...assignments };
      const { auto: _old, ...rest } = meta ?? {};
      const m = meta && { ...rest, ...(auto.size && { auto: Object.fromEntries(auto) }) };
      text = JSON.stringify({ ...entries, ...(m && { [STORE_META]: m }) }, null, 2) + '\n';
      count = Object.keys(entries).length;
      bytes = Buffer.byteLength(text);
      const over =
        (count > MAX_STORE_ENTRIES && count > this.stored.count) ||
        (bytes > MAX_STORE_BYTES && bytes > this.stored.bytes);
      if (!over) break;
      const victim = victims.shift();
      if (victim === undefined) {
        const line = `[agty] characters.json not saved: more than ${MAX_STORE_ENTRIES} characters or ${MAX_STORE_BYTES} bytes`;
        if (!this.logged.has(line)) console.warn(line);
        this.logged.add(line);
        return false;
      }
      delete assignments[victim];
      auto.delete(victim);
    }
    try {
      // A new name each time: an earlier unreadable file's copy is never overwritten.
      if (this.storeUnreadable) {
        let bak = `${this.storeFile}.bak-${Date.now()}`;
        for (let n = 1; fs.existsSync(bak); n++) bak = `${this.storeFile}.bak-${Date.now()}-${n}`;
        fs.copyFileSync(this.storeFile, bak, fs.constants.COPYFILE_EXCL);
      }
      this.storeUnreadable = false;
      const tmp = `${this.storeFile}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, this.storeFile);
      this.stored = { count, bytes };
    } catch (err) {
      console.warn(
        `[agty] characters.json not saved: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.assignments = assignments;
    this.auto = auto;
    return true;
  }

  /** Read characters.json again (after projectData changed it) and publish. */
  reload(): void {
    this.assignments = {};
    this.foreign = {};
    this.meta = null;
    this.auto = new Map();
    this.storeUnreadable = false;
    this.stored = { count: 0, bytes: 0 };
    this.loadAssignments();
    this.publish();
  }

  /** The built-in palette of the name's look, for the character made under it. */
  paletteOf(name: string): { palette: number; hueShift: number } | null {
    return paletteOfLook(this.assignments[name]);
  }

  private loadAssignments(): void {
    let raw: unknown;
    try {
      if (fs.statSync(this.storeFile).size > MAX_STORE_READ_BYTES) throw new Error('too big');
      const text = fs.readFileSync(this.storeFile, 'utf-8');
      raw = JSON.parse(text);
      if (isObject(raw))
        this.stored = {
          count: Object.keys(raw).filter((k) => k !== STORE_META).length,
          bytes: Buffer.byteLength(text),
        };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      raw = undefined;
    }
    if (!isObject(raw)) {
      // Kept as characters.json.bak-<time> before the first save replaces it.
      this.storeUnreadable = true;
      console.warn(
        `[agty] characters.json is not a JSON object of at most ${MAX_STORE_READ_BYTES} bytes: every character has its default look`,
      );
      return;
    }
    for (const [key, value] of Object.entries(raw)) {
      if (key === STORE_META) {
        if (isObject(value)) {
          this.meta = value;
          if (isObject(value.auto))
            for (const [name, pin] of Object.entries(value.auto)) {
              const parsed = parseAutoPin(pin);
              if (parsed) this.auto.set(name, parsed);
            }
        } else console.warn('[agty] characters.json: $meta is not an object (rewritten)');
        continue;
      }
      const choice = parseAppearance(value);
      if (validKey(key) && choice) this.assignments[key] = choice;
      else {
        this.foreign[key] = value;
        console.warn(`[agty] characters.json: ignored ${JSON.stringify(key)}`);
      }
    }
    // An older daemon can change the entry while retaining $meta. Only the exact v1 look this
    // pin wrote remains automatic; every other shape or look is the owner's (or is gone).
    for (const [name, pin] of this.auto)
      if (!matchesAutoPin(raw[name], pin)) this.auto.delete(name);
  }

  /** `<id>.json`: its label (else the id) and, for an imported sheet, its column order and walk;
   *  C1: `drinkSteam` `[{col, x, y}]`, the steam of a held cup in the drink row (bad entries are
   *  dropped). */
  private metaOf(
    dir: string,
    id: string,
    stats: Map<string, fs.Stats>,
  ): { label: string; standFirst: boolean; walk: Walk; drinkSteam: CharacterDrinkSteam[] } {
    const name = `${id}.json`;
    const st = stats.get(name);
    const none = { label: id, standFirst: false, walk: 'steps' as Walk, drinkSteam: [] };
    if (!st) return none;
    try {
      if (!st.isFile() || st.size > 4096) throw new Error('not a small file');
      const json = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as {
        label?: unknown;
        columns?: unknown;
        walk?: unknown;
        drinkSteam?: unknown;
      };
      const label = json?.label;
      if (typeof label !== 'string' || !label.trim()) throw new Error('no "label" text');
      return {
        label: label.trim().slice(0, MAX_LABEL_LENGTH),
        standFirst: json.columns === 'standFirst',
        walk: WALKS.includes(json.walk as Walk) ? (json.walk as Walk) : 'steps',
        drinkSteam: (Array.isArray(json.drinkSteam) ? json.drinkSteam : [])
          .filter(
            (e: unknown): e is CharacterDrinkSteam =>
              isObject(e) &&
              onlyKeys(e, ['col', 'x', 'y']) &&
              intIn(e.col, 1, DRINK_CELLS) &&
              typeof e.x === 'number' &&
              e.x >= 0 &&
              e.x <= IMPORT_FRAME_W &&
              typeof e.y === 'number' &&
              e.y >= 0 &&
              e.y <= IMPORT_FRAME_H,
          )
          .slice(0, DRINK_CELLS)
          .map(({ col, x, y }) => ({ col, x, y })),
      };
    } catch (err) {
      this.ignore(name, st, err instanceof Error ? err.message : String(err));
      return none;
    }
  }

  /** A new preset may not take this id: a sheet of it is in the user's folder, or it is built in. */
  private taken(id: string): boolean {
    return fs.existsSync(path.join(this.dir, `${id}.png`)) || !!this.presets.get(id)?.builtIn;
  }

  /** One log line per file version. */
  private ignore(name: string, st: fs.Stats, why: string): void {
    const key = `${name}:${st.size}:${st.mtimeMs}`;
    if (this.logged.has(key)) return;
    this.logged.add(key);
    console.warn(`[agty] characters: ignored ${name}: ${why}`);
  }

  private writeAtomic(name: string, data: Buffer | string): void {
    const tmp = path.join(this.dir, `.${name}.tmp`);
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, path.join(this.dir, name));
  }

  private publish(): void {
    this.opts.publish(this.message());
  }
}

type RouteAuth = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
type Refused = ReturnType<typeof refused>;

/** GET /cld/characters/<id>.png|<id>.mug.png|<id>.iso.png|<id>.thumb.png, POST /cld/characters and (SHEET-IMPORT)
 *  POST /cld/characters/import/preview and /cld/characters/import, all
 *  behind `auth` (static-looking paths skip the global session gate). */
export function registerCharacterRoutes(
  app: FastifyInstance,
  auth: RouteAuth,
  presets: CharacterPresets,
): void {
  app.get<{ Params: { file: string } }>(
    '/cld/characters/:file',
    { preHandler: auth },
    async (request, reply) => {
      // LOOKS-MEM: a chip's thumbnail, from memory (small)
      const thumb = presets.thumb(request.params.file);
      if (thumb)
        return reply
          .type('image/png')
          .header('cache-control', 'private, max-age=86400')
          .send(thumb);
      const file = presets.file(request.params.file);
      if (!file) return reply.code(404).send();
      // streamed from disk: the daemon never holds a sheet's bytes
      return reply
        .type('image/png')
        .header('content-length', file.size)
        .header('cache-control', 'private, max-age=86400')
        .send(fs.createReadStream(file.path));
    },
  );
  app.post(
    '/cld/characters',
    { preHandler: auth, bodyLimit: UPLOAD_BODY_LIMIT },
    async (request, reply) => {
      if (!sameOriginRequest(request))
        return reply.code(403).send({ ...refused('origin_mismatch') });
      const result = await presets.saveSheet(request.body);
      if ('error' in result) {
        console.warn(`[agty] characters: upload refused: ${result.error}`);
        return reply.code(400).send(result);
      }
      return result;
    },
  );
  for (const [url, save] of [
    ['/cld/characters/import/preview', false],
    ['/cld/characters/import', true],
  ] as const)
    app.post(url, { preHandler: auth, bodyLimit: IMPORT_BODY_LIMIT }, async (request, reply) => {
      if (!sameOriginRequest(request))
        return reply.code(403).send({ ...refused('origin_mismatch') });
      const result = presets.importSheet(request.body, save);
      if ('error' in result) {
        console.warn(`[agty] characters: sheet import refused: ${result.error}`);
        return reply.code(400).send(result);
      }
      return result;
    });
}
