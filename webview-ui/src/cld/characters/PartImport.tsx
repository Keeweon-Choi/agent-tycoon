/**
 * CHAR-HUMAN 부품 가져오기: the owner's drawing (a template drawn on, big blocks or 1:1) -> the daemon
 * converts it (POST cld/parts/preview) -> all 21 frames on the person being dressed -> 저장
 * (POST cld/parts), which sends the new parts list to every client.
 */
import { useEffect, useRef, useState } from 'react';

import { parsePartFileName,PART_VIEWS } from '../../../../core/src/cld/partData.js';
import { SLOT_REGISTRY } from '../../../../core/src/cld/partRegistry.js';
import type { CharacterChoice, CharacterGender } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { getCachedSprite } from '../../office/sprites/spriteCache.js';
import { FRAME_H, FRAME_W } from './compose.js';
import { getCustomParts } from './looks.js';
import { composePerson, PART_SLOTS, type PartData, type PartSlot } from './parts.js';

const GRID_ZOOM = 2;
const HEAD_SLOTS: readonly PartSlot[] = PART_SLOTS.filter((s) => SLOT_REGISTRY[s].kind === 'head');
type Row = (typeof PART_VIEWS)[number] | 'all';

type Mode = 'borrow' | 'empty' | 'keep';
const MODES: readonly Mode[] = ['keep', 'borrow', 'empty'];
/** The daemon's import report (server/src/cld/partImport.ts FrameReport): one per frame. */
interface FrameReport {
  frame: number;
  want: 'front' | 'back' | 'unknown';
  seen: 'front' | 'back' | 'unknown';
  fix: 'kept' | 'borrowed' | 'emptied';
  from?: number;
}

async function call(
  url: string,
  body: unknown,
): Promise<{ part: PartData; frames: FrameReport[] }> {
  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as {
    part?: PartData;
    report?: { frames?: FrameReport[] };
    error?: string;
  };
  if (!res.ok || !json.part) throw new Error(json.error ?? `HTTP ${res.status}`);
  return { part: json.part, frames: json.report?.frames ?? [] };
}

function base64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

/** The 21 frames of `sheet`, 7 by 3, on one canvas. */
function Grid({ look, part }: { look: CharacterChoice; part: PartData }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    const wear =
      part.slot === 'acc'
        ? { ...look.parts, acc: [part.id] }
        : { ...look.parts, [part.slot]: part.id };
    const others = getCustomParts().filter((p) => p.id !== part.id);
    const { sheet } = composePerson({ ...look, parts: wear }, [...others, part]);
    ctx.clearRect(0, 0, ref.current!.width, ref.current!.height);
    (['down', 'up', 'right'] as const).forEach((view, r) =>
      sheet[view].forEach((frame, f) =>
        ctx.drawImage(
          // an HD look (density 2) at half the zoom: the same size, twice the detail
          getCachedSprite(frame, GRID_ZOOM / (sheet.density ?? 1)),
          f * FRAME_W * GRID_ZOOM,
          r * FRAME_H * GRID_ZOOM,
        ),
      ),
    );
  }, [look, part]);
  return (
    <canvas
      ref={ref}
      width={7 * FRAME_W * GRID_ZOOM}
      height={3 * FRAME_H * GRID_ZOOM}
      // its own size (a flex column would stretch it to the window width and twice the height,
      // taller than the scrolling area); narrower than that on a phone, scaled down evenly
      className="block self-start max-w-full h-auto border-2 border-border"
      style={{ imageRendering: 'pixelated' }}
      data-testid="part-import-preview"
      aria-label={t('parts.import.preview')}
    />
  );
}

export function PartImport({
  look,
  canSave,
  onSaved,
}: {
  look: CharacterChoice;
  canSave: boolean;
  onSaved: (part: PartData) => void;
}) {
  const [png, setPng] = useState<string | null>(null);
  const [slot, setSlot] = useState<PartSlot>('top');
  const [row, setRow] = useState<Row>('all');
  const [name, setName] = useState('');
  const [gender, setGender] = useState<CharacterGender | ''>('');
  const [part, setPart] = useState<PartData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<FrameReport[]>([]);
  /** The owner's call per frame (index in the row or head view), over the automatic one. */
  const [frames, setFrames] = useState<Partial<Record<number, Mode>>>({});
  const head = HEAD_SLOTS.includes(slot);
  const request = (overrides: Partial<Record<number, Mode>>) => ({
    png,
    slot,
    name,
    ...(gender && { gender }),
    ...(!head && row !== 'all' && { view: row }),
    ...(Object.keys(overrides).length && { frames: overrides }),
  });
  const run = async (url: string, overrides = frames) => {
    setBusy(true);
    setError('');
    try {
      const { part: got, frames: got2 } = await call(url, request(overrides));
      setPart(got);
      setReport(got2);
      return got;
    } catch (err) {
      setError(
        t('parts.import.refused', { reason: err instanceof Error ? err.message : String(err) }),
      );
      return null;
    } finally {
      setBusy(false);
    }
  };
  const setFrame = (i: number, mode: Mode | '') => {
    const next = { ...frames };
    if (mode) next[i] = mode;
    else delete next[i];
    setFrames(next);
    void run('cld/parts/preview', next);
  };
  const facing = (f: FrameReport['seen']) => t(`parts.facing.${f}`);
  const warnings = report.filter(
    (f) => f.fix !== 'kept' || (f.seen !== 'unknown' && f.seen !== f.want),
  );
  const pick = async (file: File | undefined) => {
    setPart(null);
    setReport([]);
    setFrames({});
    setError('');
    if (!file) return setPng(null);
    const what = parsePartFileName(file.name);
    if (what) {
      setSlot(what.slot);
      setName(what.name);
      setGender(what.gender ?? '');
      setRow(what.view ?? 'all');
    } else setName(file.name.replace(/\.png$/i, ''));
    setPng(base64(new Uint8Array(await file.arrayBuffer())));
  };
  const field = 'border-2 border-border bg-bg px-4 py-2 text-xs pointer-coarse:min-h-44';
  return (
    <section
      aria-label={t('parts.import')}
      className="flex flex-col gap-6"
      data-testid="part-import"
    >
      <h3 className="text-xs text-text-muted">{t('parts.import')}</h3>
      <p className="text-2xs text-text-muted">{t('parts.import.help')}</p>
      <input
        type="file"
        accept="image/png"
        className="text-xs"
        aria-label={t('parts.import.file')}
        data-testid="part-import-file"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      <div className="flex flex-wrap gap-6 items-center text-xs">
        <label className="flex items-center gap-4">
          {t('parts.import.slot')}
          <select
            className={field}
            value={slot}
            onChange={(e) => (setSlot(e.target.value as PartSlot), setPart(null))}
          >
            {PART_SLOTS.map((s) => (
              <option key={s} value={s}>
                {t(`parts.slot.${s}`)}
              </option>
            ))}
          </select>
        </label>
        {!head && (
          <label className="flex items-center gap-4">
            {t('parts.import.row')}
            <select
              className={field}
              value={row}
              onChange={(e) => (setRow(e.target.value as Row), setPart(null))}
            >
              {(['all', ...PART_VIEWS] as const).map((r) => (
                <option key={r} value={r}>
                  {t(`parts.import.row.${r}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-4">
          {t('parts.gender')}
          <select
            className={field}
            value={gender}
            onChange={(e) => setGender(e.target.value as CharacterGender | '')}
          >
            <option value="">{t('parts.gender.none')}</option>
            <option value="m">{t('parts.gender.m')}</option>
            <option value="f">{t('parts.gender.f')}</option>
          </select>
        </label>
        <label className="flex items-center gap-4">
          {t('parts.import.name')}
          <input
            className={field}
            value={name}
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-6">
        <Button
          size="sm"
          disabled={!png || !name || busy}
          onClick={() => void run('cld/parts/preview')}
          data-testid="part-import-run"
        >
          {t('parts.import.preview')}
        </Button>
        {canSave && (
          <Button
            size="sm"
            variant="accent"
            disabled={!part || busy}
            data-testid="part-import-save"
            onClick={() =>
              void run('cld/parts').then((saved) => {
                if (saved) onSaved(saved);
              })
            }
          >
            {t('parts.import.save')}
          </Button>
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {part && <Grid look={look} part={part} />}
      {warnings.length > 0 && (
        <ul className="text-xs text-warning flex flex-col gap-2" data-testid="part-import-warnings">
          {warnings.map((f) => (
            <li key={f.frame}>
              {t('parts.import.frame', { number: f.frame + 1 })}:{' '}
              {f.seen !== 'unknown' && f.seen !== f.want
                ? t('parts.import.warn.facing', { seen: facing(f.seen), want: facing(f.want) })
                : t('parts.import.warn.marked')}{' '}
              {f.fix === 'borrowed'
                ? t('parts.import.fix.borrowed', { number: (f.from ?? 0) + 1 })
                : f.fix === 'emptied'
                  ? t('parts.import.fix.emptied')
                  : t('parts.import.fix.kept')}
            </li>
          ))}
        </ul>
      )}
      {part && report.length > 0 && (
        <div
          className="flex flex-wrap gap-4 items-center text-2xs"
          aria-label={t('parts.import.frames')}
        >
          {report.map((f) => (
            <label key={f.frame} className="flex items-center gap-2">
              {t('parts.import.frame', { number: f.frame + 1 })}
              <select
                className={field}
                value={frames[f.frame] ?? ''}
                data-testid={`part-import-frame-${f.frame}`}
                onChange={(e) => setFrame(f.frame, e.target.value as Mode | '')}
              >
                <option value="">{t('parts.import.mode.auto')}</option>
                {MODES.map((m) => (
                  <option key={m} value={m}>
                    {t(`parts.import.mode.${m}`)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
    </section>
  );
}
