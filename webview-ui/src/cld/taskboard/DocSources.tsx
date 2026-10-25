/**
 * U-48 phase 2a: the 작업실 Task tab's "문서 출처" section (privileged screens only).
 * Opening it asks the daemon for the project's documents (the only time its git is
 * asked for recent candidates); every change sends the whole settings back
 * (trackingSettings), and the answer (trackingSources) replaces what is shown.
 */
import { useState } from 'react';

import type { TrackingProjectSettings } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { Chevron } from '../Chevron.js';
import { useDocSources } from './taskBoard.js';

const muted = 'text-text-muted text-xs';
const button = 'border border-border px-8 py-4 text-xs pointer-coarse:min-h-44';
const control = 'bg-bg border border-border px-4 py-2 text-xs min-w-0 flex-1';

const ERRORS = ['path', 'outside', 'tooMany', 'key', 'save', 'project', 'denied'] as const;
const errorText = (code: string) =>
  (ERRORS as readonly string[]).includes(code) ? t(`tasks.docs.error.${code as (typeof ERRORS)[number]}`) : code;

export function DocSources({ project }: { project: string }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const src = useDocSources(project);
  const ask = (settings?: TrackingProjectSettings) =>
    transport.send({ type: 'trackingSettings', project, ...(settings && { settings }) });
  const change = (next: Partial<TrackingProjectSettings>) => src && ask({ ...src.settings, ...next });
  const s = src?.settings;
  return (
    <section className="pixel-panel p-8 mb-8 min-w-0 text-xs" data-testid="doc-sources">
      <button
        type="button"
        className="flex items-center gap-4 w-full text-left"
        aria-expanded={open}
        onClick={() => {
          if (!open) ask();
          setOpen(!open);
        }}
      >
        <Chevron open={open} />
        <strong>{t('tasks.docs.title')}</strong>
      </button>
      {open && !src && <p className={`${muted} mt-4`}>{t('tasks.docs.loading')}</p>}
      {open && src && s && (
        <div className="mt-8 space-y-8 min-w-0">
          {src.error && (
            <p className="text-red-400 break-words" role="alert" data-testid="doc-sources-error">
              {errorText(src.error)}
            </p>
          )}
          <div>
            <p className={muted}>{t('tasks.docs.found')}</p>
            {src.found.length === 0 && <p className={muted}>{t('tasks.docs.none')}</p>}
            <ul className="space-y-2">
              {src.found.map((d) => (
                <li key={d.path} className="flex flex-wrap items-center gap-6 min-w-0" data-testid="doc-found" data-path={d.path}>
                  {d.conventional ? (
                    <label className="flex items-center gap-4 min-w-0">
                      <input
                        type="checkbox"
                        checked={d.on}
                        onChange={(e) =>
                          change({ off: e.target.checked ? s.off.filter((p) => p !== d.path) : [...s.off, d.path] })
                        }
                      />
                      <span className="break-all">{d.path}</span>
                    </label>
                  ) : (
                    <span className="break-all">{d.path}</span>
                  )}
                  <span className={muted}>{t(d.conventional ? 'tasks.docs.conventional' : 'tasks.docs.userOn')}</span>
                  {d.items !== undefined && <span className={muted}>{t('tasks.docs.items', { count: d.items })}</span>}
                </li>
              ))}
            </ul>
          </div>
          {s.on.length > 0 && (
            <div>
              <p className={muted}>{t('tasks.docs.paths')}</p>
              <ul className="space-y-2">
                {s.on.map((p) => (
                  <li key={p} className="flex items-center gap-6 min-w-0">
                    <span className="break-all min-w-0">{p}</span>
                    <button type="button" className={button} onClick={() => change({ on: s.on.filter((x) => x !== p) })}>
                      {t('tasks.docs.remove')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <form
            className="flex gap-6 items-center min-w-0"
            onSubmit={(e) => {
              e.preventDefault();
              const p = path.trim();
              if (!p) return;
              change({ on: [...s.on, p] });
              setPath('');
            }}
          >
            <input
              aria-label={t('tasks.docs.addLabel')}
              placeholder={t('tasks.docs.addLabel')}
              className={control}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              data-testid="doc-path"
            />
            <button type="submit" className={button}>
              {t('tasks.docs.add')}
            </button>
          </form>
          <div>
            <p className={muted} title={t('tasks.docs.candidatesHint')}>
              {t('tasks.docs.candidates')}
            </p>
            {src.candidates.length === 0 && <p className={muted}>{t('tasks.docs.noCandidates')}</p>}
            <ul className="space-y-2">
              {src.candidates.map((p) => (
                <li key={p} className="flex items-center gap-6 min-w-0" data-testid="doc-candidate" data-path={p}>
                  <span className="break-all min-w-0">{p}</span>
                  <button type="button" className={`${button} border-accent text-accent-text`} onClick={() => change({ on: [...s.on, p] })}>
                    {t('tasks.docs.turnOn')}
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <label className="flex items-center gap-4">
            <input
              type="checkbox"
              checked={s.shortIds}
              onChange={(e) => change({ shortIds: e.target.checked })}
              data-testid="doc-short-ids"
            />
            {t('tasks.docs.shortIds')}
          </label>
          {s.hidden.length > 0 && (
            <p className="flex items-center gap-6">
              <span className={muted}>{t('tasks.docs.hidden', { count: s.hidden.length })}</span>
              <button type="button" className={button} onClick={() => change({ hidden: [] })}>
                {t('tasks.docs.unhide')}
              </button>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
