import { useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { authFetch } from './authApi.js';

type Verdict = 'ok' | 'wrongDaemon' | 'unreachable' | 'certificate';
export interface CustomStatus {
  url: string;
  active: boolean;
  test: { verdict: Verdict; checkedAt: number } | null;
  preferred: boolean;
}

const ERRORS = ['empty', 'tooLong', 'invalid', 'credentials', 'httpsOnly'] as const;
const isError = (code: unknown): code is (typeof ERRORS)[number] => (ERRORS as readonly unknown[]).includes(code);
/** The card also shows plain http (private/VPN literals only); same warning the LAN card gives. */
const isPlainHttp = (text: string) => /^\s*http:/i.test(text);

/** O6: the address the user already reaches the office at. The daemon only records and tests it. */
export function CustomAddressCard({ custom, mayAct, onChanged }: { custom: CustomStatus | null; mayAct: boolean; onChanged: () => Promise<unknown> }) {
  const [text, setText] = useState(custom?.url ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try { await action(); } catch (err) {
      const code = (err as Error & { data?: { error?: string } }).data?.error;
      setError(isError(code) ? t(`o6.error.${code}`) : err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); await onChanged(); }
  };
  const test = () => authFetch('/api/cld/connector/custom/test', { method: 'POST', body: {} });
  const save = () => run(async () => {
    await authFetch('/api/cld/connector/custom', { method: 'POST', body: { url: text } });
    await test();
  });
  const verdict = custom?.test?.verdict;
  const state = !custom ? 'none' : !custom.active ? 'off' : !custom.test ? 'untested' : custom.preferred ? 'preferred' : 'failed';

  return <section id="access-choice-custom" className={`flex flex-col gap-5 p-8 border-2 min-w-0 ${custom?.preferred ? 'border-accent' : 'border-border'}`} data-testid="access-card-custom">
    <div className="flex items-center gap-5"><h3 className="m-0 text-base flex-1">{t('o6.title')}</h3>{custom?.preferred && <span className="text-xs text-accent-text">{t('access.inUse')}</span>}</div>
    <p className="m-0 text-sm">{t('o6.detail')}</p>
    <p className="m-0 text-xs text-text-muted">{t('access.requirements')} {t('o6.needs')}</p>
    <p className="m-0 text-xs break-all" data-testid="custom-state">{t(`o6.state.${state}`)}{custom && state !== 'none' ? ` · ${custom.url}` : ''}</p>
    {verdict && <p className={`m-0 text-xs ${verdict === 'ok' ? 'text-accent-text' : 'text-red-400'}`} role="status" data-testid="custom-verdict">{verdict === 'ok' ? '✔' : '✖'} {t(`o6.verdict.${verdict}`)}</p>}
    {mayAct && <>
      <input aria-label={t('o6.input')} placeholder="https://office.example.com" value={text} onChange={(e) => setText(e.target.value)} className="bg-bg-dark border border-border p-4 text-xs" data-testid="custom-input" />
      {isPlainHttp(text) && <p className="m-0 text-xs text-red-400" data-testid="custom-http-warning">{t('access.lanWarning.body')} {t('access.lanWarning.prefer')}</p>}
      <div className="flex flex-wrap gap-4">
        <Button size="sm" variant="accent" disabled={busy || !text.trim() || text.trim() === custom?.url} onClick={() => void save()} data-testid="custom-save">{t('o6.save')}</Button>
        {custom && <Button size="sm" disabled={busy} onClick={() => void run(test)} data-testid="custom-test">{t('o6.test')}</Button>}
        {custom && <Button size="sm" disabled={busy} onClick={() => void run(async () => { await authFetch('/api/cld/connector/custom', { method: 'DELETE' }); setText(''); })} data-testid="custom-remove">{t('o6.remove')}</Button>}
      </div>
    </>}
    {error && <p className="m-0 text-xs text-red-400" role="alert" data-testid="custom-error">{error}</p>}
  </section>;
}
