/**
 * Chat (T-0014), always inside the app: the office messenger (T-0043,
 * messenger/) for every lead, and a background session's real terminal (its
 * 터미널로 보기) as a tab of the terminal workspace (terminal/, T-0078) -- an
 * upstream TerminalPane whose socket goes to /cld/attach/<background id>, where
 * the daemon runs `claude attach <id>`. All behind --allow-chat and the login.
 */
import type { OfficeSnapshot } from '../../../core/src/messages.js';
import { t } from '../i18n/index.js';
import { messengerShowing } from './messenger/messengerStore.js';
import { cldGetSnapshot, virtualAgentId } from './officeStore.js';
import { agentTerminalVisible, openAgentTerminal } from './terminal/workspaceStore.js';

/** Where a conversation's no-send line starts (T-0056: it names the reason after it). */
export const noSendNote = (): string => t('chat.noSend');

/**
 * A conversation's line when it cannot send, with the reason that is true for
 * it: the engine off, or a Claude session open in a terminal outside the
 * engine. It never blames "another terminal" for the rest.
 */
export function readOnlyNote(agentId: number, office: OfficeSnapshot | null): string {
  const orch = office?.orchestrators.find(
    (o) => (o.agentId ?? virtualAgentId(`orch:${o.name}`)) === agentId,
  );
  if (orch?.provider === 'engine') return t('chat.engineOff');
  return t('chat.outsideTerminal');
}
/** The daemon's limit for one chatSend (server/src/cld/chatSend.ts SEND_TEXT_MAX). */
export const CHAT_SEND_MAX = 20_000;

export type ChatTarget = { kind: 'background'; id: string } | { kind: 'interactive' };

/** Whether a character has a conversation (a lead, with chat on), and its
 *  background session for 터미널로 보기; null: none (chat off, codex, unknown). */
export function chatTarget(agentId: number, office: OfficeSnapshot | null): ChatTarget | null {
  if (!office?.chat) return null;
  const orch = office.orchestrators.find(
    (o) => (o.agentId ?? virtualAgentId(`orch:${o.name}`)) === agentId,
  );
  if (orch) return orch.bg?.id ? { kind: 'background', id: orch.bg.id } : { kind: 'interactive' };
  return null;
}

/** The conversation's name, for the tab. */
function agentName(agentId: number, backgroundId: string): string {
  const office = cldGetSnapshot().officeSnapshot;
  const orch = office?.orchestrators.find(
    (o) => (o.agentId ?? virtualAgentId(`orch:${o.name}`)) === agentId,
  );
  return orch?.name ?? backgroundId;
}

/** 터미널로 보기: the background session's terminal, as a tab of the terminal workspace
 *  (T-0078); a tab it already has is brought forward. */
export function requestChat(agentId: number, backgroundId: string): void {
  openAgentTerminal(backgroundId, agentName(agentId, backgroundId), agentId);
}

/** Is character `id`'s chat open and in sight on this screen: its terminal in a pane, or its
 *  conversation shown in the messenger (T-0039: you are looking at it; T-0043). */
export const chatOpenFor = (id: number): boolean =>
  agentTerminalVisible(id) || messengerShowing(id);
