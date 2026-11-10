/**
 * DEVROOM-PANE-CHAT (plan §4 1위, mockups D1 and P1): a 개발실 pane's 대화 view and its permission card.
 * 대화 is the messenger's own conversation (bubbles, folded tool lines, the composer; sending is the
 * messenger's chatSend queue), its transcript read only while the pane is on screen (chatView.ts). An
 * agent whose conversation the daemon does not hold says so in one line and links its runs in the
 * 현황판; nothing is made up. Over the 터미널 view the same PermissionCard sits at the pane's foot:
 * the store holds one wait and one answer per agent, so answering here, in the other view or in the
 * messenger takes the card away everywhere. Buttons only: no key answers a permission.
 */
import { useContext } from 'react';

import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { openJobs } from '../game/openJobs.js';
import { useChatView } from '../messenger/chatView.js';
import { Conversation } from '../messenger/conversation/Conversation.js';
import { MessengerLooks } from '../messenger/looksContext.js';
import { useMessenger } from '../messenger/messengerStore.js';
import { PermissionCard } from '../messenger/PermissionCard.js';
import { useAgtyStore } from '../officeStore.js';
import { setRunsProject } from '../panels/runsFilter.js';
import { DevroomLooks, SMALL } from './devroomData.js';

const NO_LOOKS = { getAppearance: () => ({ palette: 0, hueShift: 0 }), statusFor: () => null };

/** The messenger's contact of `agentId` (its conversation and its permission wait), if the daemon has one. */
function useContact(agentId: number | null) {
  const { contacts } = useMessenger();
  return agentId === null ? undefined : contacts.find((c) => c.agentId === agentId);
}

/** The 현황판's 실행 view, narrowed to the project. */
function RunsLink({ project }: { project: string }) {
  return (
    <Button
      size="sm"
      data-testid="devroom-pane-runs"
      onClick={() => {
        openJobs();
        setRunsProject(project);
      }}
    >
      {t('devroom.pane.runsLink')}
    </Button>
  );
}

export function PaneChat({
  agentId,
  project,
  on,
  onTerminal,
}: {
  agentId: number | null;
  project: string;
  /** The pane is on screen: only then is the transcript read. */
  on: boolean;
  /** 터미널에서 보기 on its permission card (null: the agent has no terminal). */
  onTerminal: (() => void) | null;
}) {
  const looks = useContext(DevroomLooks) ?? NO_LOOKS;
  const contact = useContact(agentId);
  useChatView(contact ? agentId : null, on);
  if (agentId === null || !contact)
    return (
      <div className={`p-12 flex flex-col items-start gap-8 text-text-muted ${SMALL}`} data-testid="devroom-pane-nochat">
        <p>{t('devroom.pane.noChat')}</p>
        <RunsLink project={project} />
      </div>
    );
  return (
    <MessengerLooks.Provider value={looks}>
      <Conversation agentId={agentId} statusFor={looks.statusFor} getAppearance={looks.getAppearance} pane={{ onTerminal }} />
    </MessengerLooks.Provider>
  );
}

/** Over the 터미널 view: the agent's permission card, while it waits for one. */
export function PanePermission({ agentId, name }: { agentId: number | null; name: string }) {
  const looks = useContext(DevroomLooks) ?? NO_LOOKS;
  const contact = useContact(agentId);
  const store = useAgtyStore();
  const m = useMessenger();
  const card = contact?.permission;
  if (agentId === null || !card) return null;
  return (
    <div className="absolute left-8 right-8 bottom-8 z-20 max-h-[70%] overflow-y-auto" data-testid="devroom-pane-permission">
      <MessengerLooks.Provider value={looks}>
        <PermissionCard
          key={card.toolId}
          agentId={agentId}
          name={name}
          card={card}
          canAnswer={(m.canSend[agentId] ?? contact.canSend ?? false) && !store.officeReadOnly}
          openTerminal={null}
        />
      </MessengerLooks.Provider>
    </div>
  );
}
