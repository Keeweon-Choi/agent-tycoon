/**
 * hw-every-os: one short line per missing reading, saying what to install or turn on, with the
 * fix beside it (owner 11-06 18:37: a guide only, no measurement sources). Used by the board's
 * H/W screen and the status board's system summary; the installer's consent text and the install's
 * progress show under the lines.
 */
import type { HwSample, HwSensorNote } from '../../../core/src/messages.js';
import { t, type TranslationKey } from '../i18n/index.js';
import { bypassReadOnly } from './bypass.js';
import {
  askSensorPlan,
  closeSensorTool,
  installSensorTool,
  setNvidiaSmi,
  useSensorTool,
} from './hwSensorTool.js';
import { useCldStore } from './officeStore.js';

const FIX: Partial<Record<HwSensorNote, { label: TranslationKey; run: () => void }>> = {
  lhm: { label: 'hwFix.install', run: askSensorPlan },
  nvidiaOff: { label: 'hwFix.nvidiaOn', run: () => setNvidiaSmi(true) },
};

export function HwSensorNotes({ hw, look }: { hw: HwSample; look: 'board' | 'summary' }) {
  const tool = useSensorTool();
  // A read-only office (or connection) would refuse the fix: the guide line alone.
  const canFix = !bypassReadOnly(useCldStore());
  const line = look === 'board' ? 'led-muted hw-fix-line' : 'sb-note hw-fix-line';
  const button = look === 'board' ? 'led-fix' : 'sb-link';
  const notes = hw.sensorNotes ?? [];
  if (
    !notes.length &&
    tool.phase === 'idle' &&
    !(canFix && look === 'board' && hw.nvidiaSmi === 'on')
  )
    return null;
  const close = (
    <button type="button" className={button} onClick={closeSensorTool}>
      {t('hwFix.close')}
    </button>
  );
  return (
    <div className="hw-fix" data-testid="hw-fix">
      {notes.map((note) => {
        const fix = canFix ? FIX[note] : undefined;
        return (
          <p key={note} className={line} data-testid={`hw-fix-${note}`}>
            {t(`hwFix.${note}` as TranslationKey)}{' '}
            {fix && (
              <button
                type="button"
                className={button}
                data-testid={`hw-fix-${note}-action`}
                onClick={fix.run}
              >
                {t(fix.label)}
              </button>
            )}
          </p>
        );
      })}
      {canFix && look === 'board' && hw.nvidiaSmi === 'on' && (
        <p className={line}>
          <button
            type="button"
            className={button}
            data-testid="hw-fix-nvidia-off"
            onClick={() => setNvidiaSmi(false)}
          >
            {t('hwFix.nvidiaOff.button')}
          </button>
        </p>
      )}
      {tool.phase === 'asking' && <p className={line}>{t('hwFix.checking')}</p>}
      {tool.phase === 'plan' && (
        <div className="hw-fix-plan" data-testid="hw-fix-plan">
          {tool.lines.map((l, i) => (
            <p key={i} className={line}>
              {l}
            </p>
          ))}
          <p className={line}>
            {tool.canInstall && (
              <button
                type="button"
                className={button}
                data-testid="hw-fix-confirm"
                onClick={() => installSensorTool()}
              >
                {t('hwFix.confirm')}
              </button>
            )}{' '}
            {close}
          </p>
        </div>
      )}
      {tool.phase === 'running' && <p className={line}>{t('hwFix.running')}</p>}
      {tool.phase === 'done' && (
        <div className="hw-fix-plan" data-testid="hw-fix-done">
          {!tool.ok &&
            tool.lines.map((l, i) => (
              <p key={i} className={line}>
                {l}
              </p>
            ))}
          <p className={line}>
            {t(tool.ok ? 'hwFix.done' : 'hwFix.failed')} {close}
          </p>
        </div>
      )}
      {tool.phase === 'refused' && (
        <p className={line} data-testid="hw-fix-refused">
          {tool.error && `hwFix.error.${tool.error}` in REFUSALS
            ? t(`hwFix.error.${tool.error}` as TranslationKey)
            : (tool.error ?? '')}{' '}
          {close}
        </p>
      )}
    </div>
  );
}

const REFUSALS: Record<string, true> = Object.fromEntries(
  [
    'read_only',
    'consent',
    'stepup',
    'busy',
    'unsupported',
    'unavailable',
    'not_found',
    'write_failed',
  ].map((e) => [`hwFix.error.${e}`, true]),
);
