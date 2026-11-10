/**
 * PROJECT-DATA: a removed engine agent's records are kept under its gone name (`~<assignment
 * id>`, core goneAgent.ts); the messenger shows that name as "(알 수 없음)". Applied where the
 * daemon's messages arrive, so every view (list, conversation, room) shows the label.
 */
import { GONE_NAMES, isGoneName } from '../../../../core/src/agent-tycoon/goneAgent.js';
import type { GroupRoom, GroupTimeline } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';

const label = (): string => t('projectData.unknown');
export const shownName = (name: string): string => (isGoneName(name) ? label() : name);
export const shownText = (text: string): string => text.replace(GONE_NAMES, label);

export const shownRoom = <R extends GroupRoom>(r: R): R =>
  r.preview && shownText(r.preview) !== r.preview ? { ...r, preview: shownText(r.preview) } : r;

export const shownTimeline = (m: GroupTimeline): GroupTimeline => ({
  ...m,
  posts: m.posts.map((p) => ({
    ...p,
    ...(p.sender && { sender: shownName(p.sender) }),
    targets: p.targets.map(shownName),
    delivery: Object.fromEntries(Object.entries(p.delivery).map(([k, v]) => [shownName(k), v])),
    replies: p.replies.map((r) => ({ ...r, member: shownName(r.member) })),
  })),
});
