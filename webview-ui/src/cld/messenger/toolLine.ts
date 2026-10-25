import type { ChatItem, OfficeJob } from '../../../../core/src/messages.js';
import { describeActivity, type EzContext, PLAIN_CONTEXT } from '../ez/activity.js';

/** The collapsed label of a tool row (the one explanation of a tool or command: the board's job rows use it too). */
export function toolLineLabel(
  item: Pick<ChatItem, 'toolName' | 'text' | 'desc'>,
  context: EzContext = PLAIN_CONTEXT,
): string {
  const activity = describeActivity(
    { toolName: item.toolName, status: item.text, desc: item.desc },
    context,
  );
  return `${activity.emoji} ${activity.text}`;
}

/** A job's line: its own one-line description (`-d`) when it has one, else its command explained. */
export const jobLineLabel = (job: Pick<OfficeJob, 'cmd' | 'label'>, context?: EzContext): string =>
  toolLineLabel({ toolName: 'Bash', text: `Running: ${job.cmd}`, desc: job.label ?? undefined }, context);
