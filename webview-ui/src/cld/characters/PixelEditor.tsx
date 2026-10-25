/**
 * CH-6: the custom character editor (minimal, design §4.3 / §10 CH-6). One frame of the
 * 112×96 sheet at a time: pencil, eraser, eyedropper, copy a frame to another, undo/redo
 * (one stroke = one step), a live walk/type preview, PNG export and import with the
 * daemon's own checks (core/src/cld/sheetCheck.ts), and a save as custom-<time>.png.
 * Structure after upstream pixel-agents' PixelEditor (MIT); no upstream art.
 * CH-6b: with `art`, the same editor on one image of any size (a furniture sprite): no frame
 * picker, frame copy or walk preview, and the caller's save.
 */
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  artIssue,
  checkSheetPng,
  SHEET_H,
  SHEET_W,
  sheetFrameIssues,
  type SheetIssue,
} from '../../../../core/src/cld/sheetCheck.js';
import { Button } from '../../components/ui/Button.js';
import {
  PIXEL_EDITOR_CHECKER,
  PIXEL_EDITOR_DEFAULT_COLOR,
  PIXEL_EDITOR_GRID,
  PIXEL_EDITOR_PREVIEW_ZOOM,
  PIXEL_EDITOR_SHEET_ZOOM,
  PIXEL_EDITOR_SWATCHES,
  PIXEL_EDITOR_UNDO_LIMIT,
  PIXEL_EDITOR_ZOOM,
  WALK_FRAME_DURATION_SEC,
} from '../../constants.js';
import { t, type TranslationKey } from '../../i18n/index.js';
import type { LoadedCharacterData } from '../../office/sprites/spriteData.js';
import { FRAME_H, FRAME_W, FRAMES, VIEWS } from './compose.js';
import { History } from './history.js';
import {
  at,
  canvasOf,
  decodePng,
  hex2,
  origin,
  type Pixels,
  pngBase64,
  sheetRgba,
} from './sheetPixels.js';

type Tool = 'pencil' | 'eraser' | 'picker';
const TOOLS: readonly Tool[] = ['pencil', 'eraser', 'picker'];
/** Preview: front walk, side walk (sheet rows down, right), back typing (row up). */
const WALK = [0, 1, 2, 1];
const TYPE = [3, 4];
const CELLS = VIEWS.length * FRAMES;

/** A check's reason in the screen's language, one line. */
const issueText = (issue: SheetIssue) =>
  t(
    (issue.code === 'blank'
      ? 'furnitureArt.problem.blank'
      : `looks.editor.problem.${issue.code}`) as TranslationKey,
    issue.params,
  );

/** The 커스텀 tab's way in: edit what the preview shows, or import a PNG (checked first). */
export function EditorEntry({
  sheet,
  onOpen,
}: {
  sheet: LoadedCharacterData;
  onOpen: (pixels: Pixels) => void;
}) {
  const [problem, setProblem] = useState('');
  const open = async (file: File | undefined) => {
    if (!file) return;
    setProblem('');
    let pixels: Pixels | null = null;
    const check = await checkSheetPng(new Uint8Array(await file.arrayBuffer()), async (b) => {
      pixels = await decodePng(b);
      return pixels;
    });
    if (check.problem || !pixels) setProblem(check.problem ? issueText(check.problem) : '');
    else onOpen(pixels);
  };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-6 items-center">
        <Button
          size="sm"
          variant="ghost"
          data-testid="editor-open"
          onClick={() => onOpen(sheetRgba(sheet))}
        >
          {t('looks.editor.open')}
        </Button>
        <label className="text-sm cursor-pointer px-8 py-1 border-2 border-transparent text-text-muted hover:text-text">
          <input
            type="file"
            accept="image/png"
            className="sr-only"
            data-testid="editor-import"
            onChange={(e) => {
              void open(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
          {t('looks.editor.import')}
        </label>
      </div>
      {problem && (
        <p className="text-xs text-danger" data-testid="editor-import-problem">
          {t('looks.editor.importRefused', { reason: problem })}
        </p>
      )}
    </div>
  );
}

interface PixelEditorProps {
  name: string;
  start: Pixels;
  canSave: boolean;
  onBack: () => void;
  onSaved: () => void;
  /** CH-6b: one image of this size instead of the character sheet, saved by `save` (base64 PNG). */
  art?: { width: number; height: number; save: (png: string) => Promise<void> };
}

export function PixelEditor({ name, start, canSave, onBack, onSaved, art }: PixelEditorProps) {
  // The image and one editable cell of it: the sheet's 16×32 frames, or the whole art.
  const [sw, sh] = art ? [art.width, art.height] : [SHEET_W, SHEET_H];
  const [fw, fh] = art ? [art.width, art.height] : [FRAME_W, FRAME_H];
  // A big sprite zooms less, so it takes no more room than a character frame.
  const z = Math.max(
    1,
    Math.min(PIXEL_EDITOR_ZOOM, Math.floor((FRAME_H * PIXEL_EDITOR_ZOOM) / Math.max(fw, fh))),
  );
  const pixels = useRef<Pixels>(start.slice());
  const history = useRef(new History<Pixels>(PIXEL_EDITOR_UNDO_LIMIT));
  const [version, setVersion] = useState(0);
  const changed = () => setVersion((v) => v + 1);
  const [frame, setFrame] = useState(art ? 0 : 1);
  const [tool, setTool] = useState<Tool>('pencil');
  const [color, setColor] = useState(PIXEL_EDITOR_DEFAULT_COLOR);
  const [clip, setClip] = useState<Pixels | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const stroke = useRef<{ id: number; x: number; y: number } | null>(null);
  const edit = useRef<HTMLCanvasElement>(null);
  const overview = useRef<HTMLCanvasElement>(null);
  const preview = useRef<HTMLCanvasElement>(null);

  // One offscreen copy of the sheet per change: every view draws from it.
  const sheetCanvas = useMemo(
    () => canvasOf(pixels.current.slice(), sw, sh),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` is the change signal
    [version],
  );
  const issues = art
    ? { problem: artIssue(pixels.current), warning: null }
    : sheetFrameIssues(pixels.current); // 10k pixels: cheap enough per render
  const swatches = useMemo(() => {
    const counts = new Map<string, number>();
    const d = pixels.current;
    for (let p = 0; p < d.length; p += 4)
      if (d[p + 3] === 255) {
        const c = `#${hex2(d[p])}${hex2(d[p + 1])}${hex2(d[p + 2])}`;
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    return [...counts]
      .sort((a, b) => b[1] - a[1])
      .slice(0, PIXEL_EDITOR_SWATCHES)
      .map(([c]) => c);
    // the sheet's own colours as it was opened: swatches do not jump while painting
  }, []);

  // The zoomed frame: checkerboard, pixels, grid.
  useEffect(() => {
    const ctx = edit.current?.getContext('2d');
    if (!ctx) return;
    const [ox, oy] = origin(frame);
    ctx.imageSmoothingEnabled = false;
    for (let y = 0; y < fh; y++)
      for (let x = 0; x < fw; x++) {
        ctx.fillStyle = PIXEL_EDITOR_CHECKER[(x + y) % 2];
        ctx.fillRect(x * z, y * z, z, z);
      }
    ctx.drawImage(sheetCanvas, ox, oy, fw, fh, 0, 0, fw * z, fh * z);
    ctx.fillStyle = PIXEL_EDITOR_GRID;
    for (let x = 1; x < fw; x++) ctx.fillRect(x * z, 0, 1, fh * z);
    for (let y = 1; y < fh; y++) ctx.fillRect(0, y * z, fw * z, 1);
  }, [sheetCanvas, frame, fw, fh, z]);

  // The whole sheet, small: the frame picker.
  useEffect(() => {
    const ctx = overview.current?.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.drawImage(sheetCanvas, 0, 0, ctx.canvas.width, ctx.canvas.height);
  }, [sheetCanvas]);

  // Live preview: front walk, side walk, back typing, as the office plays them.
  useEffect(() => {
    const ctx = preview.current?.getContext('2d');
    if (!ctx) return;
    const pz = PIXEL_EDITOR_PREVIEW_ZOOM;
    let tick = 0;
    const draw = () => {
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      const cells = [
        [WALK[tick % WALK.length], 0],
        [WALK[tick % WALK.length], 2],
        [TYPE[Math.floor(tick / 2) % TYPE.length], 1],
      ];
      cells.forEach(([f, r], k) =>
        ctx.drawImage(
          sheetCanvas,
          f * FRAME_W,
          r * FRAME_H,
          FRAME_W,
          FRAME_H,
          k * (FRAME_W + 4) * pz,
          0,
          FRAME_W * pz,
          FRAME_H * pz,
        ),
      );
      tick++;
    };
    draw();
    const timer = window.setInterval(draw, WALK_FRAME_DURATION_SEC * 1000);
    return () => window.clearInterval(timer);
  }, [sheetCanvas]);

  const undo = (redo = false) => {
    const h = history.current;
    const entry = redo ? h.redo(pixels.current.slice()) : h.undo(pixels.current.slice());
    if (!entry) return;
    pixels.current.set(entry.state);
    setFrame(entry.frame);
    changed();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== 'z' && k !== 'y') return;
      e.preventDefault();
      undo(k === 'y' || e.shiftKey);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** Paint (or pick) one frame pixel. */
  const apply = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= fw || y >= fh) return;
    const [ox, oy] = origin(frame);
    const p = at(ox + x, oy + y, sw);
    const d = pixels.current;
    if (tool === 'picker') {
      if (d[p + 3] === 0) return;
      setColor(`#${hex2(d[p])}${hex2(d[p + 1])}${hex2(d[p + 2])}`);
      setTool('pencil');
      return;
    }
    const v = parseInt(color.slice(1), 16);
    const next = tool === 'eraser' ? [0, 0, 0, 0] : [v >> 16, (v >> 8) & 255, v & 255, 255];
    if (next.every((c, i) => d[p + i] === c)) return;
    history.current.record(() => d.slice(), frame);
    d.set(next, p);
    changed();
  };
  const cellAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return [
      Math.floor(((e.clientX - r.left) / r.width) * fw),
      Math.floor(((e.clientY - r.top) / r.height) * fh),
    ];
  };
  /** Every pixel from the last point to this one (a fast finger skips none). */
  const lineTo = (x1: number, y1: number) => {
    const s = stroke.current!;
    const n = Math.max(Math.abs(x1 - s.x), Math.abs(y1 - s.y));
    for (let i = 1; i <= n; i++)
      apply(Math.round(s.x + ((x1 - s.x) * i) / n), Math.round(s.y + ((y1 - s.y) * i) / n));
    s.x = x1;
    s.y = y1;
  };
  const endStroke = (e: React.PointerEvent) => {
    if (stroke.current?.id !== e.pointerId) return;
    stroke.current = null;
    history.current.endStep();
  };

  const paste = () => {
    if (!clip) return;
    const [ox, oy] = origin(frame);
    history.current.record(() => pixels.current.slice(), frame);
    for (let y = 0; y < FRAME_H; y++)
      pixels.current.set(clip.subarray(y * FRAME_W * 4, (y + 1) * FRAME_W * 4), at(ox, oy + y));
    changed();
  };
  const copy = () => {
    const [ox, oy] = origin(frame);
    const out = new Uint8ClampedArray(FRAME_W * FRAME_H * 4);
    for (let y = 0; y < FRAME_H; y++)
      out.set(pixels.current.subarray(at(ox, oy + y), at(ox + FRAME_W, oy + y)), y * FRAME_W * 4);
    setClip(out);
  };

  const exportPng = () =>
    canvasOf(pixels.current.slice(), sw, sh).toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${name.replace(/[^\w-]+/g, '_') || 'character'}.png`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      if (art) {
        await art.save(await pngBase64(pixels.current.slice(), sw, sh));
        onSaved();
        return;
      }
      const res = await fetch('cld/characters', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: name,
          kind: 'custom',
          sheet: await pngBase64(pixels.current.slice(), SHEET_W, SHEET_H),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
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

  const [ox, oy] = origin(frame);
  const sz = PIXEL_EDITOR_SHEET_ZOOM;
  const h = history.current;
  return (
    <div
      className="px-12 pb-10 flex flex-col gap-10"
      data-testid="pixel-editor"
      data-version={version}
    >
      <div className="flex flex-wrap gap-12 items-start">
        <canvas
          ref={edit}
          width={fw * z}
          height={fh * z}
          className="border-2 border-border cursor-crosshair max-w-full h-auto"
          style={{ imageRendering: 'pixelated', touchAction: 'none' }}
          aria-label={t('looks.editor.canvas', { frame: frame + 1 })}
          data-testid="editor-canvas"
          onPointerDown={(e) => {
            if (stroke.current) return; // one finger draws; a second one is ignored
            e.currentTarget.setPointerCapture(e.pointerId);
            const [x, y] = cellAt(e);
            stroke.current = { id: e.pointerId, x, y };
            history.current.beginStep();
            apply(x, y);
          }}
          onPointerMove={(e) => {
            if (stroke.current?.id !== e.pointerId || tool === 'picker') return;
            const [x, y] = cellAt(e);
            lineTo(x, y);
          }}
          onPointerUp={endStroke}
          onPointerCancel={endStroke}
        />
        <div className="flex flex-col gap-8 min-w-0">
          <div className="flex flex-wrap gap-4" role="group" aria-label={t('looks.editor.tools')}>
            {TOOLS.map((id) => (
              <Button
                key={id}
                size="sm"
                variant={tool === id ? 'active' : 'default'}
                aria-pressed={tool === id}
                data-testid={`editor-tool-${id}`}
                onClick={() => setTool(id)}
              >
                {t(`looks.editor.tool.${id}`)}
              </Button>
            ))}
          </div>
          <div
            className="flex flex-wrap gap-4 items-center max-w-[224px]"
            aria-label={t('looks.editor.colors')}
          >
            {swatches.map((c) => (
              <button
                key={c}
                type="button"
                className={`w-16 h-16 border-2 ${c === color ? 'border-accent' : 'border-border'}`}
                style={{ background: c }}
                aria-label={c}
                onClick={() => {
                  setColor(c);
                  if (tool === 'picker') setTool('pencil');
                }}
              />
            ))}
            <input
              type="color"
              value={color}
              aria-label={t('looks.editor.colorPick')}
              className="w-24 h-20 p-0 border-0 bg-transparent cursor-pointer"
              onChange={(e) => {
                setColor(e.target.value);
                if (tool !== 'pencil') setTool('pencil');
              }}
            />
          </div>
          <div className="flex flex-wrap gap-4">
            <Button
              size="sm"
              variant={h.canUndo ? 'default' : 'disabled'}
              disabled={!h.canUndo}
              data-testid="editor-undo"
              onClick={() => undo()}
            >
              {t('looks.editor.undo')}
            </Button>
            <Button
              size="sm"
              variant={h.canRedo ? 'default' : 'disabled'}
              disabled={!h.canRedo}
              data-testid="editor-redo"
              onClick={() => undo(true)}
            >
              {t('looks.editor.redo')}
            </Button>
          </div>
          {!art && (
            <>
              <div className="flex flex-wrap gap-4">
                <Button size="sm" onClick={copy}>
                  {t('looks.editor.copyFrame')}
                </Button>
                <Button
                  size="sm"
                  variant={clip ? 'default' : 'disabled'}
                  disabled={!clip}
                  onClick={paste}
                >
                  {t('looks.editor.pasteFrame')}
                </Button>
              </div>
              <div
                className="relative self-start"
                style={{ width: SHEET_W * sz, height: SHEET_H * sz }}
                aria-label={t('looks.editor.frames')}
              >
                <canvas
                  ref={overview}
                  width={SHEET_W * sz}
                  height={SHEET_H * sz}
                  className="block bg-bg-dark cursor-pointer"
                  style={{ imageRendering: 'pixelated' }}
                  data-testid="editor-sheet"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    const f = Math.floor(((e.clientX - r.left) / r.width) * FRAMES);
                    const row = Math.floor(((e.clientY - r.top) / r.height) * VIEWS.length);
                    setFrame(Math.min(CELLS - 1, Math.max(0, row * FRAMES + f)));
                  }}
                />
                <div
                  className="absolute border-2 border-accent pointer-events-none"
                  style={{ left: ox * sz, top: oy * sz, width: FRAME_W * sz, height: FRAME_H * sz }}
                />
              </div>
              <canvas
                ref={preview}
                width={(FRAME_W * 3 + 8) * PIXEL_EDITOR_PREVIEW_ZOOM}
                height={FRAME_H * PIXEL_EDITOR_PREVIEW_ZOOM}
                aria-label={t('character.preview')}
                data-testid="editor-preview"
                style={{ imageRendering: 'pixelated' }}
              />
            </>
          )}
        </div>
      </div>
      {issues.problem && (
        <p className="text-xs text-danger" data-testid="editor-problem">
          {issueText(issues.problem)}
        </p>
      )}
      {issues.warning && (
        <p className="text-xs text-warning" data-testid="editor-warning">
          {issueText(issues.warning)}
        </p>
      )}
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex flex-wrap gap-8">
        {canSave && (
          <Button
            size="md"
            variant={issues.problem || saving ? 'disabled' : 'accent'}
            disabled={!!issues.problem || saving}
            data-testid="editor-save"
            onClick={() => void save()}
          >
            {saving ? t('character.saving') : t('looks.save')}
          </Button>
        )}
        <Button size="md" variant="ghost" data-testid="editor-export" onClick={exportPng}>
          {t('looks.editor.export')}
        </Button>
        <Button size="md" variant="ghost" onClick={onBack}>
          {t('character.back')}
        </Button>
      </div>
    </div>
  );
}
