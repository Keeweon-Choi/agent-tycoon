/**
 * GAME-UI-1 G2 (cockpit 09): a quest card's requirement, loaded lazily by the TaskBoard: the Task's
 * confirmed requirement (else an observed one) as a chip and that requirement's four evidence
 * lights (the 개요's questLights), or '요구사항 없음'. Nothing while tracking is off. Fetched while
 * the card is shown and again on `specChanged`, never polled.
 */
import '../../i18n/specStrings.js';

import type { TraceTaskReqs } from '../../../../core/src/agent-tycoon/spec/trace.js';
import type { BoardTask } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { Led } from '../game/parts.js';
import { questLights } from './overviewModel.js';
import { useTrace } from './traceApi.js';

// ponytail: one `…/task/:id` per card shown (the 개요 does the same per working Task); a board-wide route if boards grow past tens of cards.
export function QuestReq({ project, task }: { project: string; task: BoardTask }) {
  const { data } = useTrace<TraceTaskReqs>(project, `task/${encodeURIComponent(task.id)}`);
  if (!data?.enabled) return null;
  const edge = data.edges.find((e) => e.status === 'confirmed') ?? data.edges.find((e) => e.status === 'observed');
  const node = edge && data.nodes.find((n) => n.id === (edge.from === task.id ? edge.to : edge.from));
  if (!edge || !node)
    return (
      <span className="quest-req quest-muted" data-testid="quest-req" data-uid="">
        {t('game.quest.noReq')}
      </span>
    );
  return (
    <span className="quest-req" data-testid="quest-req" data-uid={node.id}>
      <span className="quest-chip" data-status={edge.status}>
        {node.label}
      </span>
      <span className="quest-leds">
        {questLights(task, node.state?.evidence).map((l) => (
          <Led key={l.axis} state={l.led} reason={l.why} />
        ))}
      </span>
    </span>
  );
}
