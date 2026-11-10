/**
 * INHERIT (계승): in the add dialog of an orchestrator or a Worker, the removed agents of the
 * chosen folder whose records remain (the daemon's `engineInheritable`, asked again as the
 * folder changes). One: a checkbox, off. Several: the checkbox opens a list, the newest picked.
 * `onChange` gets the chosen gone name, or null.
 */
import { useEffect, useRef, useState } from 'react';

import type { InheritableAgent, ServerMessage } from '../../../core/src/messages.js';
import { INHERIT_ASK_MS } from '../constants.js';
import { t } from '../i18n/index.js';
import { transport } from '../transport/index.js';

let sequence = 0;

export function InheritChoice({
  folder,
  who,
  value,
  onChange,
}: {
  folder: string;
  who: 'lead' | 'worker';
  value: string | null;
  onChange: (key: string | null) => void;
}) {
  const [agents, setAgents] = useState<InheritableAgent[]>([]);
  const request = useRef('');
  useEffect(
    () =>
      transport.onMessage((m: ServerMessage) => {
        if (m.type === 'engineInheritableResult' && m.requestId === request.current) setAgents(m.agents);
      }),
    [],
  );
  useEffect(() => {
    setAgents([]);
    onChange(null);
    request.current = '';
    if (!folder.trim()) return;
    const timer = window.setTimeout(() => {
      request.current = `inherit-${++sequence}`;
      transport.send({ type: 'engineInheritable', requestId: request.current, folder: folder.trim() });
    }, INHERIT_ASK_MS);
    return () => window.clearTimeout(timer);
    // onChange is the form's setter: a new folder clears the choice
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);
  if (!agents.length) return null;
  const date = (ms: number) => new Date(ms).toLocaleDateString();
  const stats = (a: InheritableAgent) => ({ level: a.level, rebirths: a.rebirths, count: a.conversations });
  const whoText = t(`inherit.${who}`);
  const one = agents.length === 1 ? agents[0] : null;
  return (
    <div className="space-y-4 border-2 border-border p-8" data-testid="inherit-choice">
      <label className="flex gap-4 items-start text-xs">
        <input
          type="checkbox"
          className="mt-2"
          data-testid="inherit-toggle"
          checked={value !== null}
          onChange={(e) => onChange(e.target.checked ? agents[0].key : null)}
        />
        <span>
          {one ? t('inherit.one', { who: whoText, ...stats(one) }) : t('inherit.many', { who: whoText, count: agents.length })}
        </span>
      </label>
      {one && <p className="text-xs text-text-muted break-words">{t('inherit.from', { name: one.name, date: date(one.removedAt) })}</p>}
      {!one &&
        value !== null &&
        agents.map((a) => (
          <label key={a.key} className="flex gap-4 items-start text-xs pl-16">
            <input type="radio" className="mt-2" name="inherit-from" checked={value === a.key} onChange={() => onChange(a.key)} />
            <span className="break-words">{t('inherit.row', { name: a.name, ...stats(a), date: date(a.removedAt) })}</span>
          </label>
        ))}
    </div>
  );
}
