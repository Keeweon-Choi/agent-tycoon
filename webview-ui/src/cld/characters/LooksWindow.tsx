/**
 * CH-4: 꾸미기, one character's look (design §6). A window on the desktop, a page on a phone.
 * The preview draws the compositor's sheet on its own canvases (never the office cache);
 * 저장 sends one setCharacter and the office, cards and messenger follow the store.
 */
import type { CSSProperties } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  HUMANOID_ACCESSORIES,
  HUMANOID_HUE_MAX,
  HUMANOID_HUE_STEP,
  HUMANOID_PARTS,
  MASCOT_COLORS,
  MASCOT_EXPRESSIONS,
  MASCOT_GEARS,
  MASCOT_SPECIES,
  mascotOfProvider,
  randomLook,
  swatchesOf,
} from '../../../../core/src/cld/looks.js';
import { BODY_VARIANTS, SLOT_REGISTRY } from '../../../../core/src/cld/partRegistry.js';
import type {
  CharacterAccessory,
  CharacterChoice,
  CharacterColors,
  CharacterPresets,
} from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import {
  MUGSHOT_CROP_SIDE_PX,
  MUGSHOT_RENDER_ZOOM,
  WALK_FRAME_DURATION_SEC,
} from '../../constants.js';
import { getLanguage, t, useLanguage } from '../../i18n/index.js';
import { getCachedSprite } from '../../office/sprites/spriteCache.js';
import { getCharacterTemplates } from '../../office/sprites/spriteData.js';
import type { SpriteData } from '../../office/types.js';
import { transport } from '../../transport/index.js';
import { useCldStore } from '../officeStore.js';
import { serverLine } from '../serverText.js';
import { compose, type ComposedLook, FRAME_H, FRAME_W, lookKey, portraitOf } from './compose.js';
import { getCustomParts, lookProvider, presetSheet, useLooksUi } from './looks.js';
import { PartImport } from './PartImport.js';
import type { PartData, PartGender, PartSlot } from './parts.js';
import {
  artFor,
  BUILT_IN_PARTS,
  COLOR_OF_SLOT,
  composePerson,
  defaultPart,
  PART_SLOTS,
  partsForSlot,
  randomPerson,
  REQUIRED_SLOTS,
} from './parts.js';
import { PhotoMaker } from './PhotoMaker.js';
import { EditorEntry, PixelEditor } from './PixelEditor.js';

/** World pixels to CSS pixels; even, so an HD sheet (density 2) draws at half of it, crisp. */
const PREVIEW_ZOOM = 4;
const THUMB_ZOOM = 2;
const PREVIEW_GAP_PX = 12;
/** Walk frames as the office plays them; the back view types. */
const WALK = [0, 1, 2, 1];
const TYPE = [3, 4];
const BODIES = [0, 1, 2, 3, 4, 5];

type Tab = 'mascot' | 'person' | 'humanoid' | 'custom';
const TABS: readonly Tab[] = ['mascot', 'person', 'humanoid', 'custom'];

const kindOf = (look: CharacterChoice | undefined): Tab =>
  look?.preset !== undefined
    ? 'custom'
    : look?.kind === 'mascot'
      ? 'mascot'
      : look?.kind === 'person'
        ? 'person'
        : 'humanoid';

const chip = (on: boolean) =>
  `px-8 py-4 text-xs border-2 cursor-pointer pointer-coarse:min-h-44 ${on ? 'border-accent bg-active-bg text-accent-text' : 'border-border bg-btn-bg hover:bg-btn-hover'}`;

/** One sprite frame on a canvas, crisp at an integer zoom (world pixels; an HD frame, twice as
 *  tall in sprite pixels, is drawn at half the zoom: the same size, twice the detail). */
function Frame({ sprite, zoom }: { sprite: SpriteData; zoom: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    const density = Math.max(1, Math.round(sprite.length / FRAME_H));
    ctx.clearRect(0, 0, FRAME_W * zoom, FRAME_H * zoom);
    const scale = zoom / density;
    if (Number.isInteger(scale)) ctx.drawImage(getCachedSprite(sprite, scale), 0, 0);
    else {
      // an HD64 frame in a small thumbnail: its pixels drawn at the thumbnail's size, nearest
      // (ponytail: every other pixel at ×2; its 32×64 copy if thumbnails ever look rough)
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(getCachedSprite(sprite, 1), 0, 0, FRAME_W * zoom, FRAME_H * zoom);
    }
  }, [sprite, zoom]);
  return (
    <canvas
      ref={ref}
      width={FRAME_W * zoom}
      height={FRAME_H * zoom}
      className="block"
      style={{ imageRendering: 'pixelated' }}
    />
  );
}

/** Front walk, side walk and back typing, looping as in the office; the card face beside them. */
function Preview({ look }: { look: ComposedLook }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), WALK_FRAME_DURATION_SEC * 1000);
    return () => window.clearInterval(timer);
  }, []);
  const mug = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = mug.current?.getContext('2d');
    if (!ctx) return;
    const side = MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, side, side);
    // the look's own portrait, or the crop of its standing front frame at the sheet's density
    const portrait = look.mugshot ?? portraitOf(look.sheet);
    const face = getCachedSprite(portrait, Math.max(1, Math.floor(side / portrait.length)));
    ctx.drawImage(face, (side - face.width) / 2, (side - face.height) / 2);
  }, [look]);
  const { down, right, up } = look.sheet;
  return (
    <div
      className="pixel-panel p-8 flex items-end justify-center shrink-0"
      style={{ gap: PREVIEW_GAP_PX }}
      aria-label={t('character.preview')}
      data-testid="looks-preview"
    >
      <Frame sprite={down[WALK[tick % WALK.length]]} zoom={PREVIEW_ZOOM} />
      <Frame sprite={right[WALK[tick % WALK.length]]} zoom={PREVIEW_ZOOM} />
      <Frame sprite={up[TYPE[Math.floor(tick / 2) % TYPE.length]]} zoom={PREVIEW_ZOOM} />
      <canvas
        ref={mug}
        width={MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM}
        height={MUGSHOT_CROP_SIDE_PX * MUGSHOT_RENDER_ZOOM}
        className="border-2 border-border self-start"
        style={{ imageRendering: 'pixelated' }}
        aria-hidden="true"
      />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section aria-label={label}>
      <h3 className="text-xs text-text-muted mb-4">{label}</h3>
      <div className="flex flex-wrap gap-6">{children}</div>
    </section>
  );
}

function MascotOptions({
  look,
  provider,
  onChange,
}: {
  look: CharacterChoice;
  provider: string | null;
  onChange: (look: CharacterChoice) => void;
}) {
  const species = look.species ?? mascotOfProvider(provider);
  const color = look.color ?? MASCOT_COLORS[species][0];
  const expr = look.expr ?? 'smile';
  const set = (patch: Partial<CharacterChoice>) => {
    const next = { v: 2, kind: 'mascot', species, color, expr, gear: look.gear, ...patch };
    if (!next.gear) delete next.gear;
    onChange(next as CharacterChoice);
  };
  const thumbs = useMemo(
    () =>
      MASCOT_SPECIES.map(
        (s) => compose({ v: 2, kind: 'mascot', species: s }, { templates: [] }).sheet.down[0],
      ),
    [],
  );
  return (
    <>
      <Row label={t('looks.species')}>
        {MASCOT_SPECIES.map((s, i) => (
          <button
            key={s}
            type="button"
            className={`${chip(s === species)} flex flex-col items-center gap-2`}
            aria-pressed={s === species}
            onClick={() => set({ species: s, color: MASCOT_COLORS[s][0] })}
          >
            <Frame sprite={thumbs[i]} zoom={THUMB_ZOOM} />
            {t(`looks.species.${s}`)}
          </button>
        ))}
      </Row>
      <Row label={t('looks.color')}>
        {MASCOT_COLORS[species].map((c) => (
          <button
            key={c}
            type="button"
            className={`size-32 pointer-coarse:size-44 border-2 cursor-pointer ${c === color ? 'border-accent' : 'border-border'}`}
            style={{ background: c }}
            aria-label={c}
            aria-pressed={c === color}
            onClick={() => set({ color: c })}
          />
        ))}
        <label
          className={`${chip(!MASCOT_COLORS[species].includes(color))} flex items-center gap-4`}
        >
          {t('looks.colorPick')}
          <input
            type="color"
            value={color}
            className="size-24 pointer-coarse:size-44 cursor-pointer"
            onChange={(e) => set({ color: e.target.value.toLowerCase() })}
          />
        </label>
      </Row>
      <Row label={t('looks.expr')}>
        {MASCOT_EXPRESSIONS.map((e) => (
          <button
            key={e}
            type="button"
            className={chip(e === expr)}
            aria-pressed={e === expr}
            onClick={() => set({ expr: e })}
          >
            {t(`looks.expr.${e}`)}
          </button>
        ))}
      </Row>
      <Row label={t('looks.gear')}>
        {[undefined, ...MASCOT_GEARS].map((g) => (
          <button
            key={g ?? 'none'}
            type="button"
            className={chip(g === look.gear)}
            aria-pressed={g === look.gear}
            onClick={() => set({ gear: g })}
          >
            {t(`looks.gear.${g ?? 'none'}`)}
          </button>
        ))}
      </Row>
    </>
  );
}

/** The look a person's choices make: the v1 shape while it has no part colours or accessories
 *  (the daemon stores it that way); part colours replace the hue (one or the other, §3.2). */
function humanoidLook(
  base: number,
  hue: number,
  colors: CharacterColors,
  acc: readonly CharacterAccessory[],
): CharacterChoice {
  const parts = Object.keys(colors).length > 0;
  if (!parts && !acc.length) return { palette: base, hueShift: hue };
  return {
    v: 2,
    kind: 'humanoid',
    base,
    ...(parts ? { colors } : hue ? { hue } : {}),
    ...(acc.length && { acc: HUMANOID_ACCESSORIES.filter((a) => acc.includes(a)) }),
  };
}

function HumanoidOptions({
  look,
  onChange,
}: {
  look: CharacterChoice;
  onChange: (look: CharacterChoice) => void;
}) {
  const body = look.palette ?? look.base ?? 0;
  const hue = look.hueShift ?? look.hue ?? 0;
  const colors = look.colors ?? {};
  const acc = look.acc ?? [];
  const set = (patch: {
    base?: number;
    hue?: number;
    colors?: CharacterColors;
    acc?: CharacterAccessory[];
  }) =>
    onChange(
      humanoidLook(patch.base ?? body, patch.hue ?? hue, patch.colors ?? colors, patch.acc ?? acc),
    );
  const setPart = (part: keyof CharacterColors, color: string | null) => {
    const next = { ...colors };
    if (color) next[part] = color.toLowerCase();
    else delete next[part];
    set({ colors: next, hue: 0 });
  };
  const colorsKey = JSON.stringify(colors);
  const thumbs = useMemo(
    () =>
      BODIES.map(
        (palette) =>
          compose(humanoidLook(palette, hue, JSON.parse(colorsKey) as CharacterColors, []), {
            templates: getCharacterTemplates(),
          }).sheet.down[0],
      ),
    [hue, colorsKey],
  );
  return (
    <>
      <Row label={t('looks.body')}>
        {BODIES.map((palette) => (
          <button
            key={palette}
            type="button"
            className={chip(palette === body)}
            aria-label={t('looks.bodyNumber', { number: palette + 1 })}
            aria-pressed={palette === body}
            onClick={() => set({ base: palette })}
          >
            <Frame sprite={thumbs[palette]} zoom={THUMB_ZOOM} />
          </button>
        ))}
      </Row>
      {HUMANOID_PARTS.map((part) => {
        const color = colors[part];
        const swatches = swatchesOf(part);
        return (
          <Row key={part} label={t(`looks.person.part.${part}`)}>
            <button
              type="button"
              className={chip(!color)}
              aria-pressed={!color}
              onClick={() => setPart(part, null)}
            >
              {t('looks.person.original')}
            </button>
            {swatches.map((c) => (
              <button
                key={c}
                type="button"
                className={`size-24 pointer-coarse:size-44 border-2 cursor-pointer ${c === color ? 'border-accent' : 'border-border'}`}
                style={{ background: c }}
                aria-label={c}
                aria-pressed={c === color}
                data-testid={`looks-person-${part}-${c}`}
                onClick={() => setPart(part, c)}
              />
            ))}
            <label
              className={`${chip(!!color && !swatches.includes(color))} flex items-center gap-4`}
            >
              {t('looks.colorPick')}
              <input
                type="color"
                value={color ?? swatches[0]}
                className="size-24 pointer-coarse:size-44 cursor-pointer"
                onChange={(e) => setPart(part, e.target.value)}
              />
            </label>
          </Row>
        );
      })}
      <Row label={t('looks.person.acc')}>
        {HUMANOID_ACCESSORIES.map((a) => {
          const on = acc.includes(a);
          return (
            <button
              key={a}
              type="button"
              className={chip(on)}
              aria-pressed={on}
              onClick={() => set({ acc: on ? acc.filter((x) => x !== a) : [...acc, a] })}
            >
              {t(`looks.person.acc.${a}`)}
            </button>
          );
        })}
      </Row>
      {/* The hue turns the whole body; with part colours chosen it has nothing left to turn. */}
      {!Object.keys(colors).length && (
        <label className="flex items-center gap-8 text-xs">
          {t('character.changeColor')}
          <input
            type="range"
            min={0}
            max={HUMANOID_HUE_MAX}
            step={HUMANOID_HUE_STEP}
            value={hue}
            onChange={(e) => set({ hue: Number(e.target.value) })}
            className="pixel-range flex-1"
            style={{ '--range-fill': `${(hue / HUMANOID_HUE_MAX) * 100}%` } as CSSProperties}
          />
          <span className="w-40 text-right">{hue}°</span>
        </label>
      )}
    </>
  );
}

const GENDERS: readonly (PartGender | undefined)[] = ['m', 'f', undefined];

/** A part's name in the picker: its pack's name, the owner's file name, or the slot and number. */
function partLabel(p: PartData): string {
  if (p.label) return p.label[getLanguage()];
  if (p.name) return p.name;
  const n = BUILT_IN_PARTS.filter((b) => b.slot === p.slot).indexOf(p) + 1;
  return t('parts.builtIn', { slot: t(`parts.slot.${p.slot}`), number: n });
}

/** CHAR-FACTORY (C8): the person tab's groups and the slots in each. */
const LOOK_SLOTS: readonly PartSlot[] = ['body', 'face', 'hair'];
const OUTFIT_SLOTS: readonly PartSlot[] = PART_SLOTS.filter((s) => !LOOK_SLOTS.includes(s));
const KNOWN_OUTFITS = [
  'basic',
  'office',
  'casual',
  'fantasy',
  'sleepwear',
  'hero',
  'bunny',
  'summer',
];

function Group({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <details open className="flex flex-col gap-8" data-testid={`looks-group-${id}`}>
      <summary className="text-sm cursor-pointer pointer-coarse:min-h-44 mb-6">
        {t(`parts.group.${id as 'basic'}`)}
      </summary>
      <div className="flex flex-col gap-10">{children}</div>
    </details>
  );
}

/** CHAR-HUMAN, CHAR-FACTORY (C8): 기본 정보 (성별, 체형), 외형 (피부, 얼굴, 표정,
 *  머리), 의상 (each outfit slot: thumbnails, the gender's own first, with the slot's swatches),
 *  프리셋 (the packs' presets by outfit, the saved looks). */
function PersonOptions({
  look,
  canSave,
  onChange,
}: {
  look: CharacterChoice;
  canSave: boolean;
  onChange: (look: CharacterChoice) => void;
}) {
  const { version } = useLooksUi(); // the owner's parts arriving redraw the thumbnails
  useLanguage();
  const custom = getCustomParts();
  const parts = look.parts ?? {};
  const colors = look.colors ?? {};
  const set = (patch: Partial<CharacterChoice>) => {
    const next: CharacterChoice = {
      v: 3,
      kind: 'person',
      ...(look.gender && { gender: look.gender }),
      ...(look.body && { body: look.body }),
      ...(look.expr && { expr: look.expr }),
      parts,
      ...patch,
    };
    for (const k of ['gender', 'body', 'expr'] as const) if (!next[k]) delete next[k];
    const c = patch.colors ?? colors;
    if (Object.keys(c).length) next.colors = c;
    else delete next.colors;
    onChange(next);
  };
  const setGender = (gender: PartGender | undefined) => {
    const face = custom.concat(BUILT_IN_PARTS).find((p) => p.id === parts.face);
    const nextParts = { ...parts };
    // a face of the other gender gives way to the gender's own built-in face
    if (gender && face?.gender && face.gender !== gender)
      nextParts.face = defaultPart('face', gender)!;
    set({ gender, parts: nextParts });
  };
  const setPart = (slot: PartSlot, id: string | null) => {
    const next: NonNullable<CharacterChoice['parts']> = { ...parts };
    if (slot === 'acc') {
      const acc = next.acc ?? [];
      next.acc =
        id === null ? [] : acc.includes(id) ? acc.filter((a) => a !== id) : [...acc, id].slice(-3);
      if (!next.acc.length) delete next.acc;
    } else if (id === null) delete next[slot];
    else {
      next[slot] = id;
      // a full-body suit replaces top and bottom (the registry's clears)
      for (const cleared of SLOT_REGISTRY[slot].clears ?? []) delete next[cleared as 'top'];
      if (slot === 'top' || slot === 'bottom') delete next.fullbody;
    }
    set({ parts: next });
  };
  const setColor = (key: keyof CharacterColors, color: string | null) => {
    const next = { ...colors };
    if (color) next[key] = color.toLowerCase();
    else delete next[key];
    set({ colors: next });
  };
  const { personPresets, characterPacks } = useCldStore();
  const [presetName, setPresetName] = useState('');
  const [removeError, setRemoveError] = useState('');
  const post = (url: string, body: unknown) =>
    fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null);
  const savePreset = async (name: string, preset: CharacterChoice | null) => {
    setRemoveError('');
    const res = await post('cld/parts/presets', { name, look: preset });
    if (!res?.ok) setRemoveError(t('parts.preset.failed', { name }));
    else if (preset) setPresetName('');
  };
  const remove = async (p: PartData) => {
    if (!window.confirm(t('parts.deleteConfirm', { name: partLabel(p) }))) return;
    setRemoveError('');
    const res = await fetch(`cld/parts/${encodeURIComponent(p.id)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    }).catch(() => null);
    if (!res?.ok) setRemoveError(t('parts.deleteFailed', { name: partLabel(p) }));
    else setPart(p.slot, null);
  };
  const lookJson = JSON.stringify(look);
  const shown = useMemo(() => {
    const base = JSON.parse(lookJson) as CharacterChoice;
    const mine = version >= 0 ? getCustomParts() : []; // read again on every version
    const thumbs = new Map<string, SpriteData>();
    const unavailable = new Set<string>();
    for (const slot of PART_SLOTS)
      for (const p of partsForSlot(slot, base.gender, mine)) {
        if (!artFor(p, base)) unavailable.add(p.id);
        const wear =
          slot === 'acc' ? { ...base.parts, acc: [p.id] } : { ...base.parts, [slot]: p.id };
        const c = composePerson({ ...base, parts: wear }, mine).sheet;
        thumbs.set(p.id, c.down[1]);
      }
    return { thumbs, unavailable };
  }, [lookJson, version]);
  const faceExpressions = (() => {
    const face = partsForSlot('face', look.gender, custom).find(
      (p) => p.id === (parts.face ?? defaultPart('face', look.gender)),
    );
    return face?.expressions ? ['neutral', ...Object.keys(face.expressions)] : [];
  })();
  const lang = getLanguage();
  const packPresets = characterPacks.flatMap((p) => p.presets);
  const outfits = [...new Set(packPresets.map((p) => p.outfit ?? 'other'))].sort(
    (a, b) => KNOWN_OUTFITS.indexOf(a) - KNOWN_OUTFITS.indexOf(b),
  );
  const slotRow = (slot: PartSlot) => {
    const options = partsForSlot(slot, look.gender, custom);
    const worn =
      slot === 'acc'
        ? (parts.acc ?? [])
        : [
            parts[slot as Exclude<PartSlot, 'acc'>] ??
              (REQUIRED_SLOTS.includes(slot) &&
              !(parts.fullbody && SLOT_REGISTRY.fullbody.clears?.includes(slot))
                ? defaultPart(slot, look.gender)
                : null),
          ];
    const colorKey = COLOR_OF_SLOT[slot];
    const color = colorKey ? colors[colorKey] : undefined;
    const swatches = colorKey
      ? swatchesOf(colorKey === 'skin' || colorKey === 'hair' ? colorKey : 'top')
      : [];
    const optional =
      !REQUIRED_SLOTS.includes(slot) || (parts.fullbody && (slot === 'top' || slot === 'bottom'));
    return (
      <section key={slot} aria-label={t(`parts.slot.${slot}`)} data-testid={`looks-slot-${slot}`}>
        <h3 className="text-xs text-text-muted mb-4">{t(`parts.slot.${slot}`)}</h3>
        <div className="flex flex-wrap gap-6">
          {optional && (
            <button
              type="button"
              className={chip(!worn.some(Boolean))}
              aria-pressed={!worn.some(Boolean)}
              onClick={() => setPart(slot, null)}
            >
              {t('parts.none')}
            </button>
          )}
          {options.map((p) => {
            const missing = shown.unavailable.has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                className={`${chip(worn.includes(p.id))} ${missing ? 'opacity-40' : ''}`}
                aria-label={
                  missing ? t('parts.unavailableFor', { name: partLabel(p) }) : partLabel(p)
                }
                title={missing ? t('parts.unavailableFor', { name: partLabel(p) }) : partLabel(p)}
                aria-pressed={worn.includes(p.id)}
                disabled={missing && !worn.includes(p.id)}
                data-testid={`looks-part-${p.id}`}
                onClick={() => setPart(slot, p.id)}
              >
                <Frame sprite={shown.thumbs.get(p.id)!} zoom={THUMB_ZOOM} />
              </button>
            );
          })}
          {canSave &&
            options
              .filter((p) => p.name && !p.pack && worn.includes(p.id))
              .map((p) => (
                <Button key={`rm-${p.id}`} size="sm" variant="ghost" onClick={() => void remove(p)}>
                  {t('parts.delete', { name: partLabel(p) })}
                </Button>
              ))}
        </div>
        {colorKey && (
          <div
            className="flex flex-wrap gap-6 mt-4"
            aria-label={t('parts.color', { slot: t(`parts.slot.${slot}`) })}
          >
            <button
              type="button"
              className={chip(!color)}
              aria-pressed={!color}
              onClick={() => setColor(colorKey, null)}
            >
              {t('looks.person.original')}
            </button>
            {swatches.map((c) => (
              <button
                key={c}
                type="button"
                className={`size-24 pointer-coarse:size-44 border-2 cursor-pointer ${c === color ? 'border-accent' : 'border-border'}`}
                style={{ background: c }}
                aria-label={c}
                aria-pressed={c === color}
                data-testid={`looks-color-${slot}-${c}`}
                onClick={() => setColor(colorKey, c)}
              />
            ))}
            <label
              className={`${chip(!!color && !swatches.includes(color))} flex items-center gap-4`}
            >
              {t('looks.colorPick')}
              <input
                type="color"
                value={color ?? swatches[0]}
                className="size-24 pointer-coarse:size-44 cursor-pointer"
                onChange={(e) => setColor(colorKey, e.target.value)}
              />
            </label>
          </div>
        )}
      </section>
    );
  };
  return (
    <>
      <Group id="basic">
        <Row label={t('parts.gender')}>
          {GENDERS.map((g) => (
            <button
              key={g ?? 'none'}
              type="button"
              className={chip(g === look.gender)}
              aria-pressed={g === look.gender}
              data-testid={`looks-gender-${g ?? 'none'}`}
              onClick={() => setGender(g)}
            >
              {t(`parts.gender.${g ?? 'none'}`)}
            </button>
          ))}
        </Row>
        <Row label={t('parts.body')}>
          {BODY_VARIANTS.map((b) => (
            <button
              key={b}
              type="button"
              className={chip((look.body ?? 'standard') === b)}
              aria-pressed={(look.body ?? 'standard') === b}
              data-testid={`looks-body-${b}`}
              onClick={() => set({ body: b === 'standard' ? undefined : b })}
            >
              {t(`parts.body.${b}`)}
            </button>
          ))}
        </Row>
      </Group>
      <Group id="look">
        {slotRow('body')}
        {slotRow('face')}
        {faceExpressions.length > 0 && (
          <Row label={t('parts.expr')}>
            {faceExpressions.map((e) => (
              <button
                key={e}
                type="button"
                className={chip((look.expr ?? 'neutral') === e)}
                aria-pressed={(look.expr ?? 'neutral') === e}
                data-testid={`looks-expr-${e}`}
                onClick={() =>
                  set({ expr: e === 'neutral' ? undefined : (e as CharacterChoice['expr']) })
                }
              >
                {t(`parts.expr.${e as 'neutral'}`)}
              </button>
            ))}
          </Row>
        )}
        {slotRow('hair')}
      </Group>
      <Group id="outfit">{OUTFIT_SLOTS.map(slotRow)}</Group>
      <Group id="presets">
        {outfits.map((o) => (
          <Row key={o} label={KNOWN_OUTFITS.includes(o) ? t(`parts.outfit.${o as 'basic'}`) : o}>
            {packPresets
              .filter((p) => (p.outfit ?? 'other') === o)
              .map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={chip(lookKey(p.look) === lookKey(look))}
                  data-testid={`looks-pack-preset-${p.id}`}
                  onClick={() => onChange(p.look)}
                >
                  {p.name[lang]}
                </button>
              ))}
          </Row>
        ))}
        <Row label={t('parts.preset')}>
          {personPresets.map((p) => (
            <span key={p.name} className="flex items-center">
              <button
                type="button"
                className={chip(lookKey(p.look) === lookKey(look))}
                data-testid={`looks-preset-${p.name}`}
                onClick={() => onChange(p.look)}
              >
                {p.name}
              </button>
              {canSave && (
                <button
                  type="button"
                  className={chip(false)}
                  aria-label={t('parts.preset.delete', { name: p.name })}
                  onClick={() => {
                    if (window.confirm(t('parts.preset.deleteConfirm', { name: p.name })))
                      void savePreset(p.name, null);
                  }}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {canSave && (
            <span className="flex items-center gap-4">
              <input
                className="border-2 border-border bg-bg px-4 py-2 text-xs pointer-coarse:min-h-44"
                value={presetName}
                maxLength={40}
                placeholder={t('parts.preset.name')}
                aria-label={t('parts.preset.name')}
                data-testid="looks-preset-name"
                onChange={(e) => setPresetName(e.target.value)}
              />
              <Button
                size="sm"
                disabled={!presetName.trim()}
                data-testid="looks-preset-save"
                onClick={() => void savePreset(presetName.trim(), look)}
              >
                {t('parts.preset.save')}
              </Button>
            </span>
          )}
        </Row>
      </Group>
      {removeError && <p className="text-xs text-danger">{removeError}</p>}
      <PartImport look={look} canSave={canSave} onSaved={(p) => setPart(p.slot, p.id)} />
    </>
  );
}

function CustomOptions({
  look,
  presets,
  canSave,
  onChange,
  onPhoto,
}: {
  look: CharacterChoice;
  presets: CharacterPresets['presets'];
  canSave: boolean;
  onChange: (look: CharacterChoice) => void;
  onPhoto: () => void;
}) {
  return (
    <>
      <Row label={t('character.presets')}>
        {presets.length === 0 ? (
          <p className="text-xs text-text-muted">{t('character.presetHelp')}</p>
        ) : (
          presets.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`${chip(look.preset === p.id)} flex flex-col items-center gap-2`}
              aria-label={t('character.presetName', { name: serverLine(p.label) })}
              aria-pressed={look.preset === p.id}
              onClick={() => onChange({ preset: p.id })}
            >
              <span
                className="block"
                style={{
                  width: FRAME_W * THUMB_ZOOM,
                  height: FRAME_H * THUMB_ZOOM,
                  backgroundImage: `url(${p.url})`,
                  backgroundSize: `${FRAME_W * 7 * THUMB_ZOOM}px ${FRAME_H * 3 * THUMB_ZOOM}px`,
                  imageRendering: 'pixelated',
                }}
              />
              <span className="text-2xs max-w-64 truncate">{serverLine(p.label)}</span>
            </button>
          ))
        )}
      </Row>
      {canSave && (
        <div>
          <Button size="sm" variant="ghost" onClick={onPhoto}>
            {t('character.makeFromPhoto')}
          </Button>
        </div>
      )}
    </>
  );
}

/** The window's body for one character (keyed by name: another character starts afresh). */
/** `inWindow`: the desktop window's body already carries the side padding (WINDOW_PAD). */
export function LooksBody({ name, inWindow = false }: { name: string; inWindow?: boolean }) {
  const { characterPresets, officeReadOnly } = useCldStore();
  useLooksUi(); // a preset sheet that finished loading redraws the preview
  const saved = characterPresets?.assignments[name];
  const provider = lookProvider(name);
  const [draft, setDraft] = useState<CharacterChoice | null>(null);
  const [tab, setTab] = useState<Tab>(() => kindOf(saved));
  const [photo, setPhoto] = useState(false);
  const [editing, setEditing] = useState<Uint8ClampedArray<ArrayBuffer> | null>(null);
  // No saved look yet: the automatic one is the provider's mascot (the daemon pins it).
  const look: CharacterChoice = draft ?? saved ?? { v: 2, kind: 'mascot' };
  const custom =
    look.preset !== undefined && characterPresets
      ? presetSheet(look.preset, characterPresets)
      : null;
  const composed = compose(look, {
    templates: getCharacterTemplates(),
    provider,
    custom,
    parts: getCustomParts(),
  });
  const key = (l: CharacterChoice | undefined) => lookKey(l, provider);
  const dirty = draft !== null && key(draft) !== key(saved);
  const canSave = !officeReadOnly;

  const showTab = (next: Tab) => {
    setTab(next);
    if (next === kindOf(look) || next === 'custom') return;
    setDraft(
      next === kindOf(saved)
        ? null
        : next === 'mascot'
          ? { v: 2, kind: 'mascot', species: mascotOfProvider(provider) }
          : next === 'person'
            ? { v: 3, kind: 'person', parts: { hair: 'hair-0' } }
            : { palette: 0, hueShift: 0 },
    );
  };
  const random = () => {
    if (tab === 'custom') return;
    if (tab === 'person') {
      setDraft(
        look.kind === 'person'
          ? randomPerson(look.gender, getCustomParts(), Math.random, { body: look.body })
          : randomPerson(undefined, getCustomParts()),
      );
      return;
    }
    const others = Object.entries(characterPresets?.assignments ?? {})
      .filter(([n]) => n !== name)
      .map(([, l]) => key(l) ?? '');
    setDraft(randomLook(tab, new Set(others), (l) => key(l) ?? ''));
  };
  const revert = () => {
    setDraft(null);
    setTab(kindOf(saved));
  };

  if (editing)
    return (
      <div className="overflow-y-auto min-h-0 flex-1">
        <PixelEditor
          name={name}
          start={editing}
          canSave={canSave}
          onBack={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setDraft(null);
          }}
        />
      </div>
    );
  if (photo)
    return (
      <div className="overflow-y-auto min-h-0 flex-1">
        <PhotoMaker
          name={name}
          onBack={() => setPhoto(false)}
          onSaved={() => {
            setPhoto(false);
            setDraft(null);
          }}
        />
      </div>
    );
  return (
    <div className="flex flex-col min-h-0 flex-1" data-testid="looks-window" data-name={name}>
      {/* Outside the scrolling options: the preview stays in sight while picking. */}
      <div className={`shrink-0 ${inWindow ? '' : 'px-12'} pb-8`}>
        <Preview look={composed} />
        {composed.fellBack && !(look.preset !== undefined && !custom) && (
          <p className="text-xs text-text-muted mt-4">{t('looks.fellBack')}</p>
        )}
        {composed.sheet.density === 2 && (
          <p className="text-xs text-text-muted mt-4" data-testid="looks-hd">
            {t('parts.hd')}
            {JSON.stringify(composed.sheet.down[3]) === JSON.stringify(composed.sheet.down[1]) &&
              ` ${t('parts.seatedFromStanding')}`}
          </p>
        )}
      </div>
      <div
        className={`overflow-y-auto min-h-0 flex-1 ${inWindow ? '' : 'px-12'} pb-8 flex flex-col gap-10`}
      >
        <nav className="flex gap-4" aria-label={t('looks.kinds')}>
          {TABS.map((id) => (
            <Button
              key={id}
              size="sm"
              variant={tab === id ? 'active' : 'default'}
              aria-pressed={tab === id}
              onClick={() => showTab(id)}
            >
              {t(`looks.tab.${id}`)}
            </Button>
          ))}
        </nav>
        {tab === 'mascot' && <MascotOptions look={look} provider={provider} onChange={setDraft} />}
        {tab === 'person' && <PersonOptions look={look} canSave={canSave} onChange={setDraft} />}
        {tab === 'humanoid' && <HumanoidOptions look={look} onChange={setDraft} />}
        {tab === 'custom' && (
          <CustomOptions
            look={look}
            presets={characterPresets?.presets ?? []}
            canSave={canSave}
            onChange={setDraft}
            onPhoto={() => setPhoto(true)}
          />
        )}
        {tab === 'custom' && <EditorEntry sheet={composed.sheet} onOpen={setEditing} />}
        {!canSave && <p className="text-xs text-text-muted">{t('looks.readOnly')}</p>}
      </div>
      <div className="shrink-0 border-t-2 border-border px-12 py-8 flex flex-wrap gap-6 items-center">
        <Button size="sm" variant="ghost" disabled={tab === 'custom'} onClick={random}>
          {t('looks.random')}
        </Button>
        <Button size="sm" variant="ghost" disabled={!dirty} onClick={revert}>
          {t('looks.revert')}
        </Button>
        {canSave && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              transport.send({ type: 'setCharacter', key: name, character: null });
              setDraft(null);
              setTab('mascot');
            }}
          >
            {t('looks.default')}
          </Button>
        )}
        {canSave && (
          <Button
            size="sm"
            variant="accent"
            className="ml-auto"
            disabled={!dirty}
            data-testid="looks-save"
            onClick={() =>
              draft && transport.send({ type: 'setCharacter', key: name, character: draft })
            }
          >
            {t('looks.save')}
          </Button>
        )}
      </div>
    </div>
  );
}
