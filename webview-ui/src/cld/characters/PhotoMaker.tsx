import type { CSSProperties } from 'react';
import { useEffect, useRef, useState } from 'react';

import { rgbaToHex } from '../../../../core/src/assets/colorUtils.js';
import { Button } from '../../components/ui/Button.js';
import { WALK_FRAME_DURATION_SEC } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { serverText } from '../serverText.js';
import type { Conversion } from './convert.js';
import { convertPhoto, DEFAULT_COLORS, MAX_COLORS, MIN_COLORS, MUGSHOT_SIDE } from './convert.js';
import { canvasOf, pngBase64 } from './sheetPixels.js';
import type { Region } from './template.js';

/** The crop area's longer side, CSS px. */
const BOX_PX = 240;
/** A .pixel-range slider's accent fill up to its thumb. */
const rangeFill = (value: number, min: number, max: number) =>
  ({ '--range-fill': `${((value - min) / (max - min)) * 100}%` }) as CSSProperties;
/** The crop is drawn at this size for the converter (a multiple of its 32). */
const WORK_PX = 64;
/** Start with this share of the photo's short side; never smaller than MIN_CROP. */
const START_CROP = 0.8;
const MIN_CROP = 0.2;
const CONVERT_DELAY_MS = 50;
const PREVIEW_ZOOM = 3;
const SHEET_W = 112;
const SHEET_H = 96;
/** Walk cycle as the office plays it: frames 1, 2, 3, 2. */
const WALK = [0, 1, 2, 1];
/** Preview rows: down, right, up. */
const PREVIEW_ROWS = [0, 2, 1];
const REGIONS: Region[] = ['hair', 'skin', 'top', 'bottom', 'shoes'];

interface Crop {
  x: number;
  y: number;
  size: number;
}

function clampCrop(c: Crop, w: number, h: number): Crop {
  const size = Math.min(Math.max(c.size, 1), w, h);
  return {
    size,
    x: Math.min(Math.max(c.x, 0), w - size),
    y: Math.min(Math.max(c.y, 0), h - size),
  };
}

interface PhotoMakerProps {
  /** The character it is for. */
  name: string;
  onBack: () => void;
  onSaved: () => void;
}

/**
 * 사진으로 만들기 (FR-OFC-016): the photo never leaves the browser; only the
 * 112×96 sheet and the 16×16 portrait are uploaded.
 */
export function PhotoMaker({ name, onBack, onSaved }: PhotoMakerProps) {
  const [photo, setPhoto] = useState<{ img: HTMLImageElement; url: string } | null>(null);
  const [crop, setCrop] = useState<Crop>({ x: 0, y: 0, size: 0 });
  const [colors, setColors] = useState(DEFAULT_COLORS);
  const [result, setResult] = useState<Conversion | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const drag = useRef<{ id: number; x: number; y: number; from: Crop } | null>(null);
  const preview = useRef<HTMLCanvasElement>(null);
  const face = useRef<HTMLCanvasElement>(null);

  useEffect(() => () => (photo ? URL.revokeObjectURL(photo.url) : undefined), [photo]);

  const open = (file: File | undefined) => {
    if (!file) return;
    setError('');
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const size = Math.min(w, h) * START_CROP;
      setPhoto({ img, url });
      setCrop(clampCrop({ x: (w - size) / 2, y: (h - size) / 2, size }, w, h));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setError(t('character.openPhotoFailed'));
    };
    img.src = url;
  };

  // Convert whenever the crop or the colour count changes.
  useEffect(() => {
    if (!photo || !crop.size) return;
    const timer = window.setTimeout(() => {
      const canvas = document.createElement('canvas');
      canvas.width = WORK_PX;
      canvas.height = WORK_PX;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(photo.img, crop.x, crop.y, crop.size, crop.size, 0, 0, WORK_PX, WORK_PX);
      setResult(convertPhoto(ctx.getImageData(0, 0, WORK_PX, WORK_PX), colors));
    }, CONVERT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [photo, crop, colors]);

  // The preview walks: down, right, up; the portrait beside it.
  useEffect(() => {
    const canvas = preview.current;
    const ctx = canvas?.getContext('2d');
    if (!result || !canvas || !ctx) return;
    const sheet = canvasOf(result.sheet, SHEET_W, SHEET_H);
    const fctx = face.current?.getContext('2d');
    if (fctx) {
      fctx.imageSmoothingEnabled = false;
      fctx.clearRect(0, 0, MUGSHOT_SIDE * PREVIEW_ZOOM, MUGSHOT_SIDE * PREVIEW_ZOOM);
      fctx.drawImage(
        canvasOf(result.mugshot, MUGSHOT_SIDE, MUGSHOT_SIDE),
        0,
        0,
        MUGSHOT_SIDE * PREVIEW_ZOOM,
        MUGSHOT_SIDE * PREVIEW_ZOOM,
      );
    }
    ctx.imageSmoothingEnabled = false;
    let step = 0;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      PREVIEW_ROWS.forEach((row, k) =>
        ctx.drawImage(
          sheet,
          WALK[step % WALK.length] * 16,
          row * 32,
          16,
          32,
          k * 20 * PREVIEW_ZOOM,
          0,
          16 * PREVIEW_ZOOM,
          32 * PREVIEW_ZOOM,
        ),
      );
      step++;
    };
    draw();
    const timer = window.setInterval(draw, WALK_FRAME_DURATION_SEC * 1000);
    return () => window.clearInterval(timer);
  }, [result]);

  const save = async () => {
    if (!result) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch('cld/characters', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: name,
          sheet: await pngBase64(result.sheet, SHEET_W, SHEET_H),
          mugshot: await pngBase64(result.mugshot, MUGSHOT_SIDE, MUGSHOT_SIDE),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(serverText(body, `HTTP ${res.status}`));
      }
      onSaved();
    } catch (err) {
      setError(
        t('character.saveFailed', { error: err instanceof Error ? err.message : String(err) }),
      );
    } finally {
      setSaving(false);
    }
  };

  const w = photo?.img.naturalWidth ?? 1;
  const h = photo?.img.naturalHeight ?? 1;
  const scale = BOX_PX / Math.max(w, h);
  const short = Math.min(w, h);
  const box = { left: crop.x * scale, top: crop.y * scale, size: crop.size * scale };
  return (
    <div className="px-10 pb-10 flex flex-col gap-10 w-[min(340px,100%)]">
      <label className="self-start">
        <input
          type="file"
          accept="image/*"
          className="sr-only"
          aria-label={t('character.choosePhoto')}
          onChange={(e) => open(e.target.files?.[0])}
        />
        <span className="inline-block border-2 border-accent bg-accent px-12 py-2 cursor-pointer hover:bg-accent-bright">
          {photo ? t('character.chooseOtherPhoto') : t('character.choosePhoto')}
        </span>
      </label>
      <p className="text-xs text-text-muted">{t('character.photoPrivacy')}</p>
      {photo && (
        <>
          <div
            className="relative self-center overflow-hidden select-none cursor-move"
            style={{ width: w * scale, height: h * scale, touchAction: 'none' }}
            aria-label={t('character.cropDrag')}
            data-testid="photo-crop"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: crop };
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d || d.id !== e.pointerId) return;
              setCrop(
                clampCrop(
                  {
                    ...d.from,
                    x: d.from.x + (e.clientX - d.x) / scale,
                    y: d.from.y + (e.clientY - d.y) / scale,
                  },
                  w,
                  h,
                ),
              );
            }}
            onPointerUp={() => (drag.current = null)}
            onPointerCancel={() => (drag.current = null)}
          >
            <img
              src={photo.url}
              alt=""
              draggable={false}
              className="block w-full h-full pointer-events-none"
            />
            <div className="absolute inset-x-0 top-0 bg-black/55" style={{ height: box.top }} />
            <div
              className="absolute inset-x-0 bottom-0 bg-black/55"
              style={{ top: box.top + box.size }}
            />
            <div
              className="absolute left-0 bg-black/55"
              style={{ top: box.top, height: box.size, width: box.left }}
            />
            <div
              className="absolute right-0 bg-black/55"
              style={{ top: box.top, height: box.size, left: box.left + box.size }}
            />
            <div
              className="absolute border-2 border-accent-bright pointer-events-none"
              style={{ left: box.left, top: box.top, width: box.size, height: box.size }}
            />
          </div>
          <label className="flex items-center gap-8 text-sm">
            {t('character.size')}
            <input
              type="range"
              min={Math.round(MIN_CROP * 100)}
              max={100}
              value={Math.round((crop.size / short) * 100)}
              onChange={(e) => {
                const size = (short * Number(e.target.value)) / 100;
                setCrop((c) =>
                  clampCrop(
                    { x: c.x + (c.size - size) / 2, y: c.y + (c.size - size) / 2, size },
                    w,
                    h,
                  ),
                );
              }}
              className="pixel-range flex-1"
              style={rangeFill(
                Math.round((crop.size / short) * 100),
                Math.round(MIN_CROP * 100),
                100,
              )}
            />
          </label>
          <label className="flex items-center gap-8 text-sm">
            {t('character.colorCount')}
            <input
              type="range"
              min={MIN_COLORS}
              max={MAX_COLORS}
              value={colors}
              onChange={(e) => setColors(Number(e.target.value))}
              className="pixel-range flex-1"
              style={rangeFill(colors, MIN_COLORS, MAX_COLORS)}
              aria-label={t('character.colorCount')}
            />
            <span className="w-24 text-right">{colors}</span>
          </label>
          <div className="flex items-end gap-12" aria-label={t('character.preview')}>
            <canvas
              ref={preview}
              width={(16 + 2 * 20) * PREVIEW_ZOOM}
              height={32 * PREVIEW_ZOOM}
              data-testid="photo-preview"
              style={{ imageRendering: 'pixelated' }}
            />
            <canvas
              ref={face}
              width={MUGSHOT_SIDE * PREVIEW_ZOOM}
              height={MUGSHOT_SIDE * PREVIEW_ZOOM}
              data-testid="photo-mugshot"
              className="border-2 border-border"
              style={{ imageRendering: 'pixelated' }}
            />
          </div>
          {result && (
            <div className="flex flex-wrap gap-x-10 gap-y-4 text-xs">
              {REGIONS.map((region) => {
                const c = result.looks[region];
                return (
                  <span key={region} className="flex items-center gap-4">
                    <span
                      className="inline-block w-12 h-12 border border-border"
                      style={{ background: c ? rgbaToHex(c[0], c[1], c[2], 255) : undefined }}
                    />
                    {t(`character.region.${region}`)}
                    {c ? '' : t('character.unchangedSuffix')}
                  </span>
                );
              })}
            </div>
          )}
        </>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex gap-8">
        <Button
          size="md"
          variant={result && !saving ? 'accent' : 'disabled'}
          disabled={!result || saving}
          onClick={() => void save()}
        >
          {saving ? t('character.saving') : t('engine.save')}
        </Button>
        <Button size="md" variant="ghost" onClick={onBack}>
          {t('character.back')}
        </Button>
      </div>
    </div>
  );
}
