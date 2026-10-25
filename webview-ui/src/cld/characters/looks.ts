/**
 * Character looks in the office (T-0017). The server's `characterPresets`
 * (in the cld store) names a look per character; preset sheets are fetched
 * and decoded once per version, like char_N, into the same sprite cache; the
 * office characters' palettes follow. A preset that is missing or fails to
 * load leaves the character's default look.
 */
import { useEffect, useSyncExternalStore } from 'react';

import { rgbaToHex } from '../../../../core/src/assets/colorUtils.js';
import { paletteOfLook } from '../../../../core/src/cld/looks.js';
import type {
  CharacterChoice,
  CharacterPresets,
  OfficeSnapshot,
} from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import type { OfficeState } from '../../office/engine/officeState.js';
import {
  getCharacterTemplates,
  getCustomCharacter,
  setCustomCharacter,
} from '../../office/sprites/spriteData.js';
import type { Character, SpriteData } from '../../office/types.js';
import { employeeName, employeeOf } from '../employees.js';
import { closeWindow, openWindow } from '../hud/hudStore.js';
import { cldGetSnapshot, useCldStore, virtualAgentId } from '../officeStore.js';
import { setSipAnchor } from '../rest.js';
import { compose, type DenseSheet, lookKey, portraitOf } from './compose.js';
import type { PartData } from './parts.js';

/** Preset sheets take palette numbers from here up (the built-ins are 0-5). */
const PRESET_PALETTE_BASE = 1000;
const FRAME_W = 16;
const FRAME_H = 32;
const FRAMES = 7;
const SHEET_W = FRAME_W * FRAMES;
const SHEET_H = FRAME_H * 3;
const MUGSHOT_SIDE = 16;

interface LooksUi {
  /** Bumped when a sheet finished loading or a look was applied. */
  version: number;
  /** The character the 꾸미기 window is for (its look key). */
  picker: string | null;
}
let ui: LooksUi = { version: 0, picker: null };
const listeners = new Set<() => void>();
function update(next: Partial<LooksUi>): void {
  ui = { ...ui, ...next };
  listeners.forEach((listener) => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const useLooksUi = () => useSyncExternalStore(subscribe, () => ui);
/** CH-4: the 꾸미기 window for `name` (a window on the desktop, a page on a phone). */
export function openLooks(name: string): void {
  update({ picker: name });
  openWindow('looks');
}
export function closeLooks(): void {
  closeWindow('looks');
  update({ picker: null });
}

/** Character name per office character id: engine projects, Claude sessions. */
export function characterNames(office: OfficeSnapshot): Map<number, string> {
  const names = new Map<number, string>();
  for (const o of office.orchestrators)
    names.set(o.agentId ?? virtualAgentId(`orch:${o.name}`), o.name);
  return names;
}

/** The look key of an office character: its name, or `emp:<id>` for a temp employee. */
export function lookNameOf(id: number, office: OfficeSnapshot): string | undefined {
  const name = characterNames(office).get(id);
  if (name !== undefined) return name;
  const employee = employeeOf(id);
  return employee && `emp:${employee.employeeId}`;
}

/** The provider a look key's character runs on, when the screen knows it (its default mascot). */
export function lookProvider(name: string, snap = cldGetSnapshot()): string | null {
  if (name.startsWith('emp:'))
    return (
      snap.tempStaff.find((e) => `emp:${e.employeeId}` === name)?.execution.split(':')[0] ?? null
    );
  return snap.officeSnapshot ? providerOf(snap.officeSnapshot, name) : null;
}

/** The 꾸미기 window's title: the character's name (a temp employee by its staff name). */
export function looksTitle(name: string): string {
  const id = name.startsWith('emp:') ? name.slice(4) : null;
  const employee = id && cldGetSnapshot().tempStaff.find((e) => e.employeeId === id);
  return t('looks.title', { name: employee ? employeeName(employee) : name });
}

/** A preset's sheet once decoded (it starts loading), else null. */
export function presetSheet(id: string, presets: CharacterPresets) {
  const preset = presets.presets.find((p) => p.id === id);
  if (!preset) return null;
  load(preset.url, preset.mugshotUrl);
  const palette = sheets.get(preset.url);
  return typeof palette === 'number' ? getCustomCharacter(palette) : null;
}

async function pixelsOf(url: string): Promise<ImageData> {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob(), {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d canvas');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

function spriteOf(img: ImageData, x0: number, y0: number, w: number, h: number): SpriteData {
  const d = img.data;
  return Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => {
      const i = ((y0 + y) * img.width + x0 + x) * 4;
      return rgbaToHex(d[i], d[i + 1], d[i + 2], d[i + 3]);
    }),
  );
}

/** The char_N.png layout: rows down, up, right; 7 frames each (CHAR-FACTORY: frames 32×64 in an
 *  HD sheet, density 2). */
function sheetOf(img: ImageData, density: 1 | 2): DenseSheet {
  const [w, h] = [FRAME_W * density, FRAME_H * density];
  const row = (r: number) =>
    Array.from({ length: FRAMES }, (_, f) => spriteOf(img, f * w, r * h, w, h));
  return { down: row(0), up: row(1), right: row(2), ...(density === 2 && { density }) };
}

/** Preset url (versioned) -> palette number once drawn, or its loading state. */
const sheets = new Map<string, number | 'loading' | 'failed'>();
let nextPalette = PRESET_PALETTE_BASE;

function load(url: string, mugshotUrl: string | null): void {
  if (!url || sheets.has(url)) return;
  sheets.set(url, 'loading');
  const palette = nextPalette++;
  void (async () => {
    try {
      const img = await pixelsOf(url);
      const density = img.width === SHEET_W * 2 ? 2 : 1;
      if (img.width !== SHEET_W * density || img.height !== SHEET_H * density)
        throw new Error(`${img.width}×${img.height}, not ${SHEET_W}×${SHEET_H} (or twice that)`);
      const sheet = sheetOf(img, density);
      let mugshot: SpriteData | null = density === 2 ? portraitOf(sheet) : null;
      if (mugshotUrl) {
        try {
          const m = await pixelsOf(mugshotUrl);
          const side = MUGSHOT_SIDE * density;
          if (m.width === side && m.height === side) mugshot = spriteOf(m, 0, 0, side, side);
        } catch {
          // The card shows the sheet's head instead.
        }
      }
      setCustomCharacter(palette, sheet, mugshot);
      sheets.set(url, palette);
    } catch (err) {
      console.warn(
        `[cld] character sheet ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      sheets.set(url, 'failed');
    }
    update({ version: ui.version + 1 });
  })();
}

/** CHAR-HUMAN: the owner's parts the daemon sent (built-ins are in the bundle). */
let customParts: readonly PartData[] = [];
export const getCustomParts = (): readonly PartData[] => customParts;
export function setCustomParts(parts: readonly PartData[]): void {
  customParts = parts;
  // a person composed before its parts arrived drew built-ins: compose those again
  for (const key of [...composed.keys()]) if (key.startsWith('P:')) composed.delete(key);
  update({ version: ui.version + 1 });
}

/** CH-2: composed looks (mascots, and the fallback for a preset that failed) by lookKey. */
const composed = new Map<string, number>();

/** The palette a look composed into (made once per distinct look, then shared). */
function composedPalette(name: string, look: CharacterChoice, provider: string | null): number {
  const key = lookKey(look, provider) ?? '';
  let palette = composed.get(key);
  if (palette === undefined) {
    const c = compose(look, { templates: getCharacterTemplates(), provider, parts: customParts });
    if (c.fellBack) console.warn(`[cld] look ${name}: ${c.fellBack}`);
    palette = nextPalette++;
    setCustomCharacter(palette, c.sheet, c.mugshot);
    setSipAnchor(palette, c.sip);
    composed.set(key, palette);
  }
  return palette;
}

/** Palette and hue for a chosen look; null = the default (also while a preset loads). */
function lookOf(
  name: string,
  choice: CharacterChoice | undefined,
  presets: CharacterPresets,
  provider: string | null,
): { palette: number; hueShift: number } | null {
  if (!choice) return null;
  // A mascot, a person with part colours or accessories (CH-5) and a person of parts
  // (CHAR-HUMAN) are composed sheets.
  if (
    choice.kind === 'mascot' ||
    choice.kind === 'person' ||
    (choice.kind === 'humanoid' && (choice.colors || choice.acc))
  )
    return { palette: composedPalette(name, choice, provider), hueShift: 0 };
  // v1 palettes (and plain v2 humanoids on their base) are the built-in sheets, drawn as before.
  if (choice.preset === undefined) return paletteOfLook(choice);
  const preset = presets.presets.find((p) => p.id === choice.preset);
  load(preset?.url ?? '', preset?.mugshotUrl ?? null);
  const palette = preset ? sheets.get(preset.url) : 'failed';
  if (typeof palette === 'number') return { palette, hueShift: 0 };
  if (palette === 'loading') return null;
  // §3.5: a sheet that is gone or does not draw shows the provider's mascot, never nothing.
  return { palette: composedPalette(name, { v: 2, kind: 'mascot' }, provider), hueShift: 0 };
}

/** The provider a name's character runs on, when the screen knows it (the fallback mascot). */
function providerOf(office: OfficeSnapshot, name: string): string | null {
  if (name.startsWith('emp:')) return null; // set by the caller from the execution
  return office.orchestrators.find((o) => o.name === name)?.provider === 'claude' ? 'claude' : null;
}

/** MSG-UI2: the look pinned to a character name (`emp:<id>` for a temp employee), or null. */
export const lookByName = (name: string, presets: CharacterPresets | null) =>
  presets ? lookOf(name, presets.assignments[name], presets, null) : null;

/** The look each character had before any choice (the server's pick). */
const defaults = new WeakMap<Character, { palette: number; hueShift: number }>();

/** Set every named character's palette from its chosen look. True when one changed. */
function applyLooks(os: OfficeState, office: OfficeSnapshot, presets: CharacterPresets): boolean {
  let changed = false;
  const names = characterNames(office);
  // TEMP-PLATES: a sub-agent's or Codex temporary's look is its roster employee's (`emp:<id>`).
  const providers = new Map<string, string | null>();
  for (const id of os.characters.keys()) {
    const employee = names.has(id) ? undefined : employeeOf(id);
    if (!employee) continue;
    names.set(id, `emp:${employee.employeeId}`);
    providers.set(`emp:${employee.employeeId}`, employee.execution.split(':')[0]);
  }
  for (const [id, name] of names) {
    const ch = os.characters.get(id);
    if (!ch) continue;
    const base = defaults.get(ch) ?? { palette: ch.palette, hueShift: ch.hueShift };
    defaults.set(ch, base);
    // ponytail: an engine Lead's provider is not on the screen, so its fallback mascot is Tori
    const provider = providers.get(name) ?? providerOf(office, name);
    const want = lookOf(name, presets.assignments[name], presets, provider) ?? base;
    if (ch.palette === want.palette && ch.hueShift === want.hueShift) continue;
    ch.palette = want.palette;
    ch.hueShift = want.hueShift;
    changed = true;
  }
  return changed;
}

/** Keep the office's characters in their chosen looks (characters come and go). */
export function useCharacterLooks(
  getOfficeState: () => OfficeState,
  agents: readonly number[],
  layoutReady: boolean,
): void {
  const { officeSnapshot: officeState, characterPresets, characterParts, tempStaff } = useCldStore();
  const { version } = useLooksUi();
  useEffect(() => {
    if (characterParts !== customParts) setCustomParts(characterParts);
  }, [characterParts]);
  useEffect(() => {
    if (!officeState || !characterPresets || !layoutReady) return;
    // Re-render once more so the card bars redraw their mug shots.
    if (applyLooks(getOfficeState(), officeState, characterPresets))
      update({ version: ui.version + 1 });
  }, [getOfficeState, officeState, characterPresets, tempStaff, agents, layoutReady, version]);
}
