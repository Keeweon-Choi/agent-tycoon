/**
 * 설정's "동시에 붙일 에이전트 터미널" (T-0078): how many `claude attach`
 * processes the daemon keeps at once. Each costs about 150 MB, so it is a
 * choice, 1 to 4; the daemon keeps it and applies it at once. Only with chat on.
 */
import { useEffect, useState } from 'react';

import { t } from '../../i18n/index.js';
import { authFetch, passkeyError } from '../auth/authApi.js';
import { useCldStore } from '../officeStore.js';
import { Choice, SettingRow } from '../SettingRow.js';

interface Cap {
  attaches: number;
  default: number;
  min: number;
  max: number;
  live: number;
}

export const ATTACH_COST_MB = 150;

export function AttachCapOption() {
  const { officeSnapshot: officeState } = useCldStore();
  const chat = officeState?.chat === true;
  const [cap, setCap] = useState<Cap | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (!chat) return;
    authFetch<Cap>('/api/chat-attaches').then(setCap, () => undefined);
  }, [chat]);
  if (!chat || !cap) return null;
  const choose = (n: number) => {
    setNote('');
    authFetch<{ attaches: number }>('/api/chat-attaches', {
      method: 'PUT',
      body: { attaches: n },
    }).then(
      (r) => setCap({ ...cap, attaches: r.attaches }),
      (err: unknown) => setNote(passkeyError(err)),
    );
  };
  const choices = Array.from({ length: cap.max - cap.min + 1 }, (_, i) => cap.min + i);
  return (
    <SettingRow
      testId="attach-cap-option"
      title={t('terminal.attachCap')}
      help={t('terminal.attachCapHelp', { cost: ATTACH_COST_MB })}
      note={
        (cap.attaches > cap.max || note) && (
          <>
            {cap.attaches > cap.max && (
              <p className="m-0 text-sm text-text-muted">{t('terminal.serverCap', { count: cap.attaches })}</p>
            )}
            {note && (
              <p className="m-0 text-sm text-yellow-300" role="status">
                {note}
              </p>
            )}
          </>
        )
      }
    >
      <Choice
        label={t('terminal.attachCap')}
        options={choices}
        value={cap.attaches}
        onPick={choose}
        text={(n) => n}
      />
    </SettingRow>
  );
}
