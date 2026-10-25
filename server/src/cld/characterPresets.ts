/**
 * Character presets (T-0017, FR-OFC-015/016). ~/.config/cld-gui/characters/
 * holds sheets in the char_N.png format; ~/.config/cld-gui/characters.json
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
  leastUsedMascotColor,
  MASCOT_EXPRESSIONS,
  MASCOT_GEARS,
  MASCOT_SPECIES,
  mascotOfProvider,
  MAX_PERSON_ACC,
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
  MAX_SHEET_BYTES,
  pngHeaderIssue,
} from '../../../core/src/cld/sheetCheck.js';
import type {
  CharacterChoice,
  CharacterPresets as PresetsMessage,
  CharacterRefusalReason,
} from '../../../core/src/messages.js';
import { pickDiversePalette } from '../../../core/src/paletteUtils.js';
import { HUE_SHIFT_MAX_DEG, PALETTE_COUNT } from '../constants.js';
import { sameOriginRequest } from './authRoutes.js';

export const PRESET_ID = /^[a-z0-9][a-z0-9_-]{0,40}$/;
export const MAX_PRESET_BYTES = MAX_SHEET_BYTES;
/** characters.json: what this version adds stops at this many characters and bytes (a file
 *  already past them, which an older version could write, is read and kept as it is). */
export const MAX_STORE_ENTRIES = 500;
export const MAX_STORE_BYTES = 64 * 1024;
/** An automatic look (a pin, not the owner's choice) of a name not seen for this long is dropped. */
export const AUTO_PIN_TTL_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const today = () => Math.floor(Date.now() / DAY_MS);
/** A sanity cap for reading: a bigger file is not parsed (kept as a .bak-<time> copy). */
export const MAX_STORE_READ_BYTES = 1024 * 1024;
/** The file's own entry (§3.2): `{v: 2, pinnedAt}`, written by the pin migration. */
export const STORE_META = '$meta';
const SHEET_W = CHAR_FRAME_W * CHAR_FRAMES_PER_ROW;
const SHEET_H = CHAR_FRAME_H * CHARACTER_DIRECTIONS.length;
const MUGSHOT_SIDE = 16;
const POLL_MS = 30_000;
const WATCH_DEBOUNCE_MS = 100;
const MAX_KEY_LENGTH = 200;
const MAX_LABEL_LENGTH = 60;
/** Two base64 PNGs at the cap plus the JSON around them. */
const UPLOAD_BODY_LIMIT = 2 * Math.ceil(MAX_PRESET_BYTES / 3) * 4 + 4096;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

const README = `# 캐릭터 프리셋

cld-gui 사무실 캐릭터 그림을 두는 폴더입니다. 데몬이 이 폴더를 지켜보다가 바뀌면 화면에 바로 반영합니다.

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

고른 결과는 \`~/.config/cld-gui/characters.json\`에 캐릭터 이름(엔진 프로젝트 이름이나 Claude 세션 이름)별로 저장됩니다. 아무것도 고르지 않은 캐릭터도 처음 보인 모습이 저장되어 데몬을 다시 켜도 그대로입니다.

    { "alpha": { "preset": "photo-1761040000000" }, "beta": { "palette": 3, "hueShift": 90 } }

그림 파일이 없거나 형식이 틀리면 그 캐릭터는 기본 모습으로 그립니다.
`;

/** Why `buf` is not a `w`×`h` 8-bit RGBA PNG (RGB too when `opaqueOk`), or
 *  null when it is. The header is checked before pngjs inflates anything (core's
 *  pngHeaderIssue, the browser's rule too). */
export function pngProblem(buf: Buffer, w: number, h: number, opaqueOk = false): string | null {
  const header = pngHeaderIssue(buf, w, h, opaqueOk);
  if (header) return header.text;
  try {
    PNG.sync.read(buf);
  } catch (err) {
    return `broken PNG (${err instanceof Error ? err.message : String(err)})`;
  }
  return null;
}

/** The IHDR width of a PNG file (its first 24 bytes), or 0. */
function pngWidth(file: string): number {
  try {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    fs.closeSync(fd);
    return head.readUInt32BE(16);
  } catch {
    return 0;
  }
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
  if (value.v === 3) return parsePerson(value);
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

/**
 * The look a name gets the first time it is seen after the pin migration (§3.3 item 2): its
 * provider's mascot (Claude → Coral, Codex → Byte, else Tori) in the colour from that species'
 * fixed list that \`looks\` (every saved look) use least.
 */
export function firstSightLook(
  provider: string | null | undefined,
  looks: Iterable<CharacterChoice | undefined>,
): CharacterChoice {
  const species = mascotOfProvider(provider);
  return { v: 2, kind: 'mascot', species, color: leastUsedMascotColor(species, looks) };
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

interface Preset {
  id: string;
  label: string;
  png: Buffer;
  mug: Buffer | null;
  version: string;
  /** CHAR-FACTORY: 2 for an HD sheet (224×192). */
  density: 1 | 2;
}

export interface CharacterPresetOptions {
  /** ~/.config/cld-gui */
  configDir: string;
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
  private signature: string | null = null;
  private readonly logged = new Set<string>();
  private watcher: fs.FSWatcher | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: CharacterPresetOptions) {
    this.dir = path.join(opts.configDir, 'characters');
    this.storeFile = path.join(opts.configDir, 'characters.json');
  }

  start(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const readme = path.join(this.dir, 'README.md');
      if (!fs.existsSync(readme)) fs.writeFileSync(readme, README);
    } catch (err) {
      console.warn(`[cld] characters: ${err instanceof Error ? err.message : String(err)}`);
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
        ...(p.density === 2 && { density: 2 as const }),
      })),
      assignments: { ...this.assignments },
    };
  }

  /** `<id>.png` or `<id>.mug.png` as checked by the last scan, else null. */
  file(name: string): Buffer | null {
    const m = /^([a-z0-9][a-z0-9_-]{0,40})(\.mug)?\.png$/.exec(name);
    const preset = m ? this.presets.get(m[1]) : undefined;
    return (m?.[2] ? preset?.mug : preset?.png) ?? null;
  }

  /** Re-read the folder when anything in it changed (names, sizes, mtimes). */
  scan(): void {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).sort();
    } catch {
      // No folder: no presets.
    }
    const stats = new Map<string, fs.Stats>();
    for (const name of names) {
      try {
        stats.set(name, fs.lstatSync(path.join(this.dir, name)));
      } catch {
        // Deleted between readdir and lstat.
      }
    }
    const signature = [...stats].map(([n, s]) => `${n}:${s.size}:${s.mtimeMs}`).join('|');
    if (signature === this.signature) return;
    this.signature = signature;
    const read = (name: string, w: number, h: number, opaqueOk = false): Buffer | null => {
      const st = stats.get(name)!;
      let problem: string | null = null;
      let buf: Buffer | null = null;
      if (!st.isFile()) problem = 'not a regular file';
      else if (st.size > MAX_PRESET_BYTES) problem = `too big (${st.size} bytes)`;
      else {
        try {
          buf = fs.readFileSync(path.join(this.dir, name));
          problem = pngProblem(buf, w, h, opaqueOk);
        } catch (err) {
          problem = err instanceof Error ? err.message : String(err);
        }
      }
      if (problem) this.ignore(name, st, problem);
      return problem ? null : buf;
    };
    const next = new Map<string, Preset>();
    for (const [name, st] of stats) {
      if (name === 'README.md' || name.startsWith('.')) continue;
      const m = /^(.+?)(\.mug\.png|\.png|\.json)$/.exec(name);
      if (!m || !PRESET_ID.test(m[1])) {
        this.ignore(name, st, 'not <id>.png, <id>.json or <id>.mug.png (id: a-z 0-9 - _)');
        continue;
      }
      const id = m[1];
      if (m[2] !== '.png') {
        if (!stats.has(`${id}.png`)) this.ignore(name, st, `no ${id}.png beside it`);
        continue;
      }
      // CHAR-FACTORY: an HD sheet (twice the detail, the same layout) is 224×192, its portrait 32×32
      const density = st.isFile() && pngWidth(path.join(this.dir, name)) === SHEET_W * 2 ? 2 : 1; // never open a non-file
      const png = read(name, SHEET_W * density, SHEET_H * density);
      if (!png) continue;
      const mug = stats.has(`${id}.mug.png`)
        ? read(`${id}.mug.png`, MUGSHOT_SIDE * density, MUGSHOT_SIDE * density, true)
        : null;
      const version = crypto
        .createHash('sha1')
        .update(png)
        .update(mug ?? '')
        .digest('hex')
        .slice(0, 10);
      next.set(id, { id, label: this.labelOf(id, stats), png, mug, version, density });
    }
    this.presets = next;
    this.publish();
  }

  /** setCharacter from a client; a refusal is answered to it (\`characterRefused\`). True when
   *  the message was this one's. */
  onClientMessage(
    msg: Record<string, unknown>,
    send?: (m: Record<string, unknown>) => void,
  ): boolean {
    if (msg.type !== 'setCharacter') return false;
    const refuse = (reason: CharacterRefusalReason) => {
      console.warn(`[cld] setCharacter ${JSON.stringify(msg.key)}: refused (${reason})`);
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
    for (let n = 1; fs.existsSync(path.join(this.dir, `${id}.png`)); n++)
      id = `${prefix}-${Date.now()}-${n}`;
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
    if (warning) console.warn(`[cld] characters: ${id} saved with a warning: ${warning}`);
    return warning ? { id, warning } : { id };
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
    const free = (name: string) => validKey(name) && !(name in next) && !(name in this.foreign);
    const counts = new Array<number>(PALETTE_COUNT).fill(0);
    for (const c of live) {
      if (c.palette < PALETTE_COUNT) counts[c.palette]++;
      const pinned = auto.get(c.name);
      if (pinned) auto.set(c.name, { ...pinned, d: day });
      if (!free(c.name)) continue;
      // ponytail: a palette past the built-in 6 (external char_N) does not validate, so it stays unpinned
      const look = autoLookOf(
        first
          ? { palette: c.palette, hueShift: c.hueShift }
          : firstSightLook(c.provider, Object.values(next)),
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
    if (!first && same) return;
    const meta = this.meta ?? { v: 2, pinnedAt: new Date().toISOString() };
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
        const line = `[cld] characters.json not saved: more than ${MAX_STORE_ENTRIES} characters or ${MAX_STORE_BYTES} bytes`;
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
        `[cld] characters.json not saved: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.assignments = assignments;
    this.auto = auto;
    return true;
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
        `[cld] characters.json is not a JSON object of at most ${MAX_STORE_READ_BYTES} bytes: every character has its default look`,
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
        } else console.warn('[cld] characters.json: $meta is not an object (rewritten)');
        continue;
      }
      const choice = parseAppearance(value);
      if (validKey(key) && choice) this.assignments[key] = choice;
      else {
        this.foreign[key] = value;
        console.warn(`[cld] characters.json: ignored ${JSON.stringify(key)}`);
      }
    }
    // An older daemon can change the entry while retaining $meta. Only the exact v1 look this
    // pin wrote remains automatic; every other shape or look is the owner's (or is gone).
    for (const [name, pin] of this.auto)
      if (!matchesAutoPin(raw[name], pin)) this.auto.delete(name);
  }

  private labelOf(id: string, stats: Map<string, fs.Stats>): string {
    const name = `${id}.json`;
    const st = stats.get(name);
    if (!st) return id;
    try {
      if (!st.isFile() || st.size > 4096) throw new Error('not a small file');
      const label = (
        JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf-8')) as { label?: unknown }
      )?.label;
      if (typeof label !== 'string' || !label.trim()) throw new Error('no "label" text');
      return label.trim().slice(0, MAX_LABEL_LENGTH);
    } catch (err) {
      this.ignore(name, st, err instanceof Error ? err.message : String(err));
      return id;
    }
  }

  /** One log line per file version. */
  private ignore(name: string, st: fs.Stats, why: string): void {
    const key = `${name}:${st.size}:${st.mtimeMs}`;
    if (this.logged.has(key)) return;
    this.logged.add(key);
    console.warn(`[cld] characters: ignored ${name}: ${why}`);
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

/** GET /cld/characters/<id>.png|<id>.mug.png and POST /cld/characters, both
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
      const png = presets.file(request.params.file);
      if (!png) return reply.code(404).send();
      return reply.type('image/png').header('cache-control', 'private, max-age=86400').send(png);
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
        console.warn(`[cld] characters: upload refused: ${result.error}`);
        return reply.code(400).send(result);
      }
      return result;
    },
  );
}
