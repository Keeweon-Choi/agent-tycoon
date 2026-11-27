import { useRef } from 'react';

import { CHAT_WS_PREFIX } from '../../../../core/src/constants.js';
import { MobileKeyBar } from '../../components/MobileKeyBar.js';
import { submitTerminalLine } from '../../components/mobileSend.js';
import { type TerminalInputHandle, TerminalPane } from '../../components/TerminalPane.js';
import { Button } from '../../components/ui/Button.js';
import { MOBILE_TERMINAL_FONT_SIZE_PX } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { readClipboardText } from '../../terminal/clipboard.js';
import { terminalMessages } from '../terminal/workspace.js';

/**
 * T-81 C: a command the owner sent opened a picker or dialog in the lead's terminal (bare /model,
 * /config, ...): its live terminal (the same `claude attach` view as 터미널로 보기) slides up over
 * the conversation, already showing it, so the choice is made exactly as in the terminal: keys on a
 * desktop, the terminal key bar on a phone. The conversation closes it once the picker is gone.
 */
export function PickerSheet({
  agentId,
  backgroundId,
  phone,
  onClose,
}: {
  agentId: number;
  backgroundId: string;
  phone: boolean;
  onClose: () => void;
}) {
  const input = useRef<TerminalInputHandle | null>(null);
  return (
    <section
      role="dialog"
      aria-label={t('messenger.picker.sheet')}
      data-testid="picker-sheet"
      className="absolute inset-x-0 bottom-0 z-20 h-[70%] flex flex-col border-ui rounded-ui-card border-border bg-bg shadow-pixel"
    >
      <header className="shrink-0 flex items-center gap-8 px-12 py-6 border-b border-border text-xs">
        <span className="flex-1 min-w-0">{t('messenger.picker.sheetNote')}</span>
        <Button size="sm" data-testid="picker-sheet-close" onClick={onClose}>
          {t('common.close')}
        </Button>
      </header>
      <div className="flex-1 min-h-0">
        <TerminalPane
          agentId={agentId}
          socketPath={`${CHAT_WS_PREFIX}/${backgroundId}`}
          isActive
          messages={terminalMessages()}
          // Drawn at the sheet's width while it is open; the Lead's PTY gets its size back after.
          restoreSize
          autoFocus={!phone}
          mobileKeyBar={phone}
          {...(phone && { fontSizePx: MOBILE_TERMINAL_FONT_SIZE_PX })}
          onRegisterInput={(_, handle) => (input.current = handle)}
        />
      </div>
      {phone && (
        // A picker needs arrows, Enter and Esc, not the keyboard: the key bar is always there.
        <MobileKeyBar
          onKey={(seq) => input.current?.send(seq)}
          onPaste={() => {
            void readClipboardText(t('upstream.paste')).then((text) => {
              if (text) input.current?.paste(text);
            });
          }}
          onSend={() => {
            if (input.current) submitTerminalLine(input.current);
          }}
        />
      )}
    </section>
  );
}
