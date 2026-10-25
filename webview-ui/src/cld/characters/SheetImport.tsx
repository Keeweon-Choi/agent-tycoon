/**
 * SHEET-IMPORT 시트 가져오기 (꾸미기 > 커스텀): a generated sheet -> the daemon cuts and converts
 * it (POST cld/characters/import/preview) -> the source with each figure's box, the 192×384 frames,
 * the walk / type / read cycles in every direction (isometric and top-down, zoom 2 and 4, drawn
 * as the office draws them), the quality report -> a name -> 저장 (POST cld/characters/import),
 * a new 커스텀 preset or the other format of an imported one.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import type { CharacterPreset } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import {
  IMPORT_DENSITY,
  IMPORT_PROXY_DENSITY,
  IMPORT_WORLD_H,
  IMPORT_WORLD_W,
  SHEET_BOX_COLOR,
  WALK_FRAME_DURATION_SEC,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import { getCachedSprite } from '../../office/sprites/spriteCache.js';
import type { SpriteData } from '../../office/types.js';
import { mirrorSprite } from '../iso/sprites.js';
import { serverText } from '../serverText.js';
import { FRAMES } from './compose.js';
import { importedSheet } from './importedSheet.js';

/** The source picture's width in the window, CSS px; a converted frame's in the grid. */
const SOURCE_PX = 560;
const GRID_ZOOM = 2;
const ZOOMS = [2, 4] as const;
/** The walks the owner picks between (column indexes): left, together, right, together; or the
 *  two steps alone. */
const WALKS = { steps: [1, 0, 2, 0], two: [1, 2] } as const;
type Walk = keyof typeof WALKS;
const TYPE = [3, 4];
const READ = [5, 6];

interface Report {
  format: 'iso' | 'top';
  scale: number;
  headJitter: { walk: { x: number; y: number }; seated: { x: number; y: number } };
  footJitter: number;
  fit: { row: number; col: number; shrink: number } | null;
  bleed: { moved: number };
  walkLegs: number[];
  walkAlike: number[];
  magenta: number;
  halo: number;
  specks: number;
  split: number;
  ms: number;
}
interface Preview {
  format: 'iso' | 'top';
  sheet: string;
  places: { box: number[] }[][];
  report: Report;
}

function base64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(serverText(json, `HTTP ${res.status}`));
  return json;
}

async function imageDataOf(blob: Blob): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob, {
    premultiplyAlpha: 'none',
    colorSpaceConversion: 'none',
  });
  const c = document.createElement('canvas');
  [c.width, c.height] = [bitmap.width, bitmap.height];
  const ctx = c.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, c.width, c.height);
}

/** One frame as the office draws it at world zoom `zoom` (its master, smoothly). */
function Sprite({ sprite, zoom }: { sprite: SpriteData; zoom: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dpr = window.devicePixelRatio || 1;
  const [w, h] = [IMPORT_WORLD_W * zoom * dpr, IMPORT_WORLD_H * zoom * dpr];
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(getCachedSprite(sprite, (zoom * dpr) / IMPORT_PROXY_DENSITY), 0, 0);
  }, [sprite, zoom, dpr, w, h]);
  return (
    <canvas
      ref={ref}
      width={w}
      height={h}
      className="block bg-bg-dark"
      style={{ width: IMPORT_WORLD_W * zoom, height: IMPORT_WORLD_H * zoom }}
    />
  );
}

/** The figures' boxes on the source picture, as the daemon cut them. */
function SourceBoxes({ url, places }: { url: string; places: Preview['places'] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const c = ref.current;
      const ctx = c?.getContext('2d');
      if (!c || !ctx) return;
      const k = SOURCE_PX / img.naturalWidth;
      [c.width, c.height] = [SOURCE_PX, Math.round(img.naturalHeight * k)];
      ctx.drawImage(img, 0, 0, c.width, c.height);
      ctx.strokeStyle = SHEET_BOX_COLOR;
      ctx.lineWidth = 2;
      for (const row of places)
        for (const { box } of row)
          ctx.strokeRect(box[0] * k, box[1] * k, (box[2] - box[0]) * k, (box[3] - box[1]) * k);
    };
    img.src = url;
  }, [url, places]);
  return <canvas ref={ref} className="block max-w-full" data-testid="sheet-import-source" />;
}

export function SheetImport({
  presets,
  canSave,
  onSaved,
  onBack,
}: {
  presets: readonly CharacterPreset[];
  canSave: boolean;
  onSaved: (id: string) => void;
  onBack: () => void;
}) {
  const [png, setPng] = useState<{ b64: string; url: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [img, setImg] = useState<ImageData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [walk, setWalk] = useState<Walk>('steps');
  const [zoom, setZoom] = useState<(typeof ZOOMS)[number]>(4);
  const [view, setView] = useState<'iso' | 'top'>('iso');
  const [label, setLabel] = useState('');
  const [attach, setAttach] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), WALK_FRAME_DURATION_SEC * 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => () => (png ? URL.revokeObjectURL(png.url) : undefined), [png]);

  const open = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setPreview(null);
    setImg(null);
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const b64 = base64(bytes);
      setPng({ b64, url: URL.createObjectURL(file) });
      const p = await post<Preview>('cld/characters/import/preview', { png: b64 });
      const bin = Uint8Array.from(atob(p.sheet), (c) => c.charCodeAt(0));
      setImg(await imageDataOf(new Blob([bin], { type: 'image/png' })));
      setPreview(p);
      setView(p.format === 'iso' ? 'iso' : 'top');
      setLabel((l) => l || file.name.replace(/\.png$/i, '').slice(0, 40));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // the frames as the office loads them (both walks: their proxies are the same frames)
  const sheet = useMemo(
    () =>
      img && preview
        ? importedSheet(img, { iso: preview.format === 'iso', standFirst: true, twoStep: false })
        : null,
    [img, preview],
  );

  const save = async () => {
    if (!png) return;
    setBusy(true);
    setError('');
    try {
      const { id } = await post<{ id: string }>('cld/characters/import', {
        png: png.b64,
        label: label.trim(),
        walk,
        ...(attach && { attach }),
      });
      onSaved(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // directions: isometric ↘ ↙ ↗ ↖ (front row, mirrored, back row, mirrored); top-down front,
  // back, right, left (a top sheet's side row; an isometric sheet's front row stands in)
  const dirs = sheet
    ? view === 'iso'
      ? ([
          ['se', sheet.down, false],
          ['sw', sheet.down, true],
          ['ne', sheet.up, false],
          ['nw', sheet.up, true],
        ] as const)
      : ([
          ['front', sheet.down, false],
          ['back', sheet.up, false],
          ['right', sheet.right, false],
          ['left', sheet.right, true],
        ] as const)
    : [];
  const cycles: Array<[string, readonly number[]]> = [
    [t('sheetImport.walkSteps'), WALKS.steps],
    [t('sheetImport.walkTwo'), WALKS.two],
    [t('sheetImport.type'), TYPE],
    [t('sheetImport.read'), READ],
  ];
  const r = preview?.report;
  const imported = presets.filter((p) => p.density === IMPORT_DENSITY);
  return (
    <div className="px-10 pb-10 flex flex-col gap-10" data-testid="sheet-import">
      <div className="flex flex-wrap gap-6 items-center">
        <Button size="sm" variant="ghost" onClick={onBack}>
          {t('sheetImport.back')}
        </Button>
        <label className="self-start">
          <input
            type="file"
            accept="image/png"
            className="sr-only"
            aria-label={t('sheetImport.choose')}
            data-testid="sheet-import-file"
            onChange={(e) => void open(e.target.files?.[0])}
          />
          <span className="inline-block border-2 border-accent bg-accent px-12 py-2 cursor-pointer hover:bg-accent-bright">
            {png ? t('sheetImport.chooseOther') : t('sheetImport.choose')}
          </span>
        </label>
      </div>
      <p className="text-xs text-text-muted">{t('sheetImport.help')}</p>
      {busy && <p className="text-xs">{t('sheetImport.working')}</p>}
      {error && (
        <p className="text-xs text-danger" role="alert" data-testid="sheet-import-error">
          {error}
        </p>
      )}
      {png && preview && <SourceBoxes url={png.url} places={preview.places} />}
      {sheet && preview && (
        <>
          <section aria-label={t('sheetImport.frames')}>
            <h3 className="text-xs text-text-muted mb-4">{t('sheetImport.frames')}</h3>
            <div
              className="grid gap-2 w-max"
              style={{ gridTemplateColumns: `repeat(${FRAMES}, auto)` }}
              data-testid="sheet-import-frames"
            >
              {[sheet.down, sheet.up, ...(preview.format === 'top' ? [sheet.right] : [])].map(
                (row, ri) =>
                  row.map((f, c) => (
                    <div key={`${ri}-${c}`} className="border-2 border-border">
                      <Sprite sprite={f} zoom={GRID_ZOOM} />
                    </div>
                  )),
              )}
            </div>
          </section>
          <div className="flex flex-wrap gap-6">
            {(['iso', 'top'] as const).map((v) => (
              <Button
                key={v}
                size="sm"
                variant={view === v ? 'active' : 'default'}
                aria-pressed={view === v}
                data-testid={`sheet-import-view-${v}`}
                onClick={() => setView(v)}
              >
                {t(`sheetImport.view.${v}`)}
              </Button>
            ))}
            {ZOOMS.map((z) => (
              <Button
                key={z}
                size="sm"
                variant={zoom === z ? 'active' : 'default'}
                aria-pressed={zoom === z}
                data-testid={`sheet-import-zoom-${z}`}
                onClick={() => setZoom(z)}
              >
                {t('sheetImport.zoom', { zoom: z })}
              </Button>
            ))}
          </div>
          <section aria-label={t('sheetImport.preview')} data-testid="sheet-import-preview">
            <table className="border-collapse">
              <thead>
                <tr>
                  <th />
                  {dirs.map(([d]) => (
                    <th key={d} className="text-2xs text-text-muted font-normal px-4">
                      {t(`sheetImport.dir.${d}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {cycles.map(([name, cols]) => (
                  <tr key={name}>
                    <th className="text-2xs text-text-muted font-normal text-left pr-6">{name}</th>
                    {dirs.map(([d, row, mirror]) => {
                      const f = row[cols[tick % cols.length]];
                      return (
                        <td key={d} className="p-2">
                          <Sprite sprite={mirror ? mirrorSprite(f) : f} zoom={zoom} />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section aria-label={t('sheetImport.walk')} className="flex flex-wrap gap-6 items-center">
            <span className="text-xs text-text-muted">{t('sheetImport.walk')}</span>
            {(Object.keys(WALKS) as Walk[]).map((w) => (
              <Button
                key={w}
                size="sm"
                variant={walk === w ? 'active' : 'default'}
                aria-pressed={walk === w}
                data-testid={`sheet-import-walk-${w}`}
                onClick={() => setWalk(w)}
              >
                {t(w === 'steps' ? 'sheetImport.walkSteps' : 'sheetImport.walkTwo')}
              </Button>
            ))}
          </section>
          {r && (
            <section
              aria-label={t('sheetImport.report')}
              className="pixel-panel p-8 text-xs flex flex-col gap-2"
              data-testid="sheet-import-report"
            >
              <span>{t(`sheetImport.format.${r.format}`)}</span>
              <span>{t('sheetImport.scale', { scale: r.scale })}</span>
              <span>
                {t('sheetImport.jitter', {
                  wx: r.headJitter.walk.x,
                  wy: r.headJitter.walk.y,
                  sx: r.headJitter.seated.x,
                  sy: r.headJitter.seated.y,
                  foot: r.footJitter,
                })}
              </span>
              <span>{t('sheetImport.magenta', { magenta: r.magenta, halo: r.halo })}</span>
              <span>{t('sheetImport.time', { ms: r.ms })}</span>
              {r.bleed.moved > 0 && <span>{t('sheetImport.bleed', { px: r.bleed.moved })}</span>}
              {r.fit && (
                <span className="text-warning" data-testid="sheet-import-fit">
                  {t('sheetImport.fit', {
                    row: r.fit.row,
                    col: r.fit.col,
                    pct: Math.round(r.fit.shrink * 100),
                  })}
                </span>
              )}
              {r.walkAlike.length > 0 && (
                <span className="text-warning" data-testid="sheet-import-walk-alike">
                  {t('sheetImport.walkAlike', { rows: r.walkAlike.join(', ') })}
                </span>
              )}
            </section>
          )}
          {canSave && (
            <div className="flex flex-wrap gap-6 items-center">
              <input
                className="border-2 border-border bg-bg px-4 py-2 text-xs pointer-coarse:min-h-44"
                value={label}
                maxLength={40}
                placeholder={t('sheetImport.name')}
                aria-label={t('sheetImport.name')}
                data-testid="sheet-import-name"
                onChange={(e) => setLabel(e.target.value)}
              />
              {imported.length > 0 && (
                <select
                  className="border-2 border-border bg-bg px-4 py-2 text-xs pointer-coarse:min-h-44"
                  value={attach}
                  aria-label={t('sheetImport.attach')}
                  data-testid="sheet-import-attach"
                  onChange={(e) => setAttach(e.target.value)}
                >
                  <option value="">{t('sheetImport.attachNew')}</option>
                  {imported.map((p) => (
                    <option key={p.id} value={p.id}>
                      {t('sheetImport.attachTo', { name: p.label })}
                    </option>
                  ))}
                </select>
              )}
              <Button
                size="sm"
                variant="accent"
                disabled={busy}
                data-testid="sheet-import-save"
                onClick={() => void save()}
              >
                {t('sheetImport.save')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
