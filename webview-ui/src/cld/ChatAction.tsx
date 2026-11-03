import { Button } from '../components/ui/Button.js';
import { t } from '../i18n/index.js';
import { chatTarget } from './chat.js';
import { openMessenger } from './messenger/messengerStore.js';
import { useCldStore } from './officeStore.js';

/** 대화 (the character menu) / 대화 열기 (the status card): the lead's
 *  conversation in the office messenger (T-0043), whose header opens a
 *  background session's terminal. Nothing while chat is off. */
export function ChatAction({
  agentId,
  variant,
  onOpen,
  className = 'block w-full text-left text-sm whitespace-nowrap px-8 py-2 hover:bg-btn-hover',
}: {
  agentId: number;
  variant: 'menu' | 'card';
  /** Called as the chat opens (a modal that holds this button closes itself). */
  onOpen?: () => void;
  /** The menu item's look (a row in the phone's summary card has its own). */
  className?: string;
}) {
  const { officeSnapshot: officeState } = useCldStore();
  if (!chatTarget(agentId, officeState)) return null;
  const open = (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    openMessenger(agentId);
    onOpen?.();
  };
  if (variant === 'menu') {
    return (
      <button
        type="button"
        role="menuitem"
        className={className}
        onClick={open}
      >
        {t('chat.action.menu')}
      </button>
    );
  }
  return (
    <Button variant="accent" size="sm" className="text-xs" onClick={open}>
      {t('chat.action.card')}
    </Button>
  );
}
