/**
 * 설정's "Agent rules" (RULES-DEFAULT): the rules every orchestrator session starts with. The
 * shipped defaults are read-only (collapsed); the one box is the user's own global rules, added
 * after them. Saving is privileged, and a remote device proves itself first (step-up).
 */
import { useEffect, useRef, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { t, useLanguage } from '../i18n/index.js';
import { transport } from '../transport/index.js';
import { stepUpFailedText } from './auth/authApi.js';
import { requestStepUp } from './auth/stepUp.js';
import { useCldStore } from './officeStore.js';
import { OnOff, SettingGroup, SettingRow } from './SettingRow.js';

interface Shown {
  defaults: string;
  text: string;
  useBuiltInRules: boolean;
}

export function AgentRulesOption() {
  const language = useLanguage();
  const { officeReadOnly } = useCldStore();
  const [shown, setShown] = useState<Shown | null>(null);
  const [draft, setDraft] = useState('');
  const [note, setNote] = useState('');
  const sent = useRef<{ text?: string; useBuiltInRules?: boolean } | null>(null);

  useEffect(() => {
    const off = transport.onMessage((msg) => {
      if (msg.type !== 'agentRules') return;
      setShown({ defaults: msg.defaults, text: msg.text, useBuiltInRules: msg.useBuiltInRules });
      if (sent.current === null) {
        setDraft(msg.text);
        return;
      }
      const tried = sent.current;
      if (msg.error === 'stepup') {
        void requestStepUp().then(
          (ok) =>
            ok
              ? transport.send({ type: 'agentRulesRequest', language, ...tried })
              : setNote(stepUpFailedText()),
          () => setNote(stepUpFailedText()),
        );
        return;
      }
      sent.current = null;
      if (msg.error) setNote(t(msg.error === 'read_only' ? 'rules.readOnly' : 'rules.failed'));
      else {
        setDraft(msg.text);
        setNote(t('rules.saved'));
      }
    });
    transport.send({ type: 'agentRulesRequest', language });
    return off;
  }, [language]);

  if (!shown) return null;
  const dirty = draft.trim() !== shown.text.trim();
  const mine = (
    <>
      <details>
        <summary className="text-sm cursor-pointer">{t('rules.defaults')}</summary>
        <pre
          className="mt-4 max-h-[240px] overflow-auto whitespace-pre-wrap bg-bg border border-border p-4 text-xs"
          data-testid="agent-rules-defaults"
        >
          {shown.defaults || t('rules.noDefaults')}
        </pre>
      </details>
      <p className="text-sm">{t('rules.mine')}</p>
      <textarea
        aria-label={t('rules.mine')}
        className="w-full bg-bg border border-border p-4 text-sm"
        rows={6}
        value={draft}
        disabled={officeReadOnly}
        placeholder={t('rules.placeholder')}
        onChange={(e) => {
          setDraft(e.target.value);
          setNote('');
        }}
      />
      <div className="flex items-center gap-8">
        <Button
          size="sm"
          disabled={officeReadOnly || !dirty}
          onClick={() => {
            sent.current = { text: draft };
            setNote('');
            transport.send({ type: 'agentRulesRequest', language, text: draft });
          }}
        >
          {t('rules.save')}
        </Button>
        {note && <span className="text-sm text-text-muted">{note}</span>}
      </div>
    </>
  );
  return (
    <div data-testid="agent-rules-option">
      <SettingGroup title={t('rules.title')} />
      <SettingRow
        title={t('rules.useBuiltIn')}
        help={t('rules.help')}
        note={<div className="space-y-4">{mine}</div>}
      >
        <OnOff
          label={t('rules.useBuiltIn')}
          on={shown.useBuiltInRules}
          disabled={officeReadOnly}
          onChange={(useBuiltInRules) => {
            sent.current = { useBuiltInRules };
            setNote('');
            transport.send({ type: 'agentRulesRequest', language, useBuiltInRules });
          }}
        />
      </SettingRow>
    </div>
  );
}
