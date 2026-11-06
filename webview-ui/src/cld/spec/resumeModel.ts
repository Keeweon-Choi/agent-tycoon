/**
 * BRN K5 (cld/docs/design/project-brain.md §10): "where was I?" in five lines at the top of the overview:
 * now, how far, blocked, who, next. Pure: every item says where it comes from (the Lead's last renew
 * handoff with its time, the Task board, or live office state); a handoff line keeps its K1 tag; a
 * missing source is said (`note`), never filled in. No percentages, no estimates.
 */
import type {
  HandoffTag,
  ResumeSection,
  TraceResume,
} from '../../../../core/src/cld/spec/trace.js';
import type { BoardTask, DelegationApproval } from '../../../../core/src/messages.js';
import { RESUME_BOARD_SHOWN } from '../../constants.js';
import type { WaitReason } from '../waiting.js';
import type { Member } from '../workbench/workbenchState.js';

export const RESUME_LINES = ['now', 'done', 'blocked', 'who', 'next'] as const;
export type ResumeKey = (typeof RESUME_LINES)[number];
export type Handoff = NonNullable<TraceResume['handoff']>;
export type WhoState = 'working' | 'waiting' | 'resting' | 'on' | 'off';

export type ResumeItem =
  | { src: 'handoff'; text: string; tag?: HandoffTag }
  | { src: 'board'; task: Pick<BoardTask, 'id' | 'title' | 'status'>; who?: string }
  | { src: 'live'; kind: 'activity'; who: string; text: string }
  | { src: 'live'; kind: 'approval'; who: string; text: string }
  | { src: 'live'; kind: 'wait'; who: string; reason: WaitReason }
  | { src: 'live'; kind: 'member'; who: string; role: Member['role']; state: WhoState };

export interface ResumeLine {
  key: ResumeKey;
  items: ResumeItem[];
  /** The handoff lines this line could not show (the server keeps 5 a section). */
  more: number;
  /** A source this line reads that is not there: no handoff on record, or one not in the form. */
  note?: 'noHandoff' | 'freeHandoff';
}

export interface ResumeInput {
  project: string;
  tasks: readonly BoardTask[];
  /** undefined: not read yet (no note then); null: none on record. */
  handoff: Handoff | null | undefined;
  team: readonly Pick<Member, 'name' | 'role' | 'state' | 'agentId'>[];
  waiting: Readonly<Record<number, WaitReason>>;
  approvals: readonly Pick<DelegationApproval, 'project' | 'caller' | 'title'>[];
  /** The Lead's activity line while it works (the office's own words), else null. */
  leadActivity: string | null;
}

const PRIORITY = ['P0', 'P1', 'P2', undefined, 'later'] as const;
const newest = (a: BoardTask, b: BoardTask) =>
  a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
const board = (x: BoardTask): ResumeItem => ({
  src: 'board',
  task: { id: x.id, title: x.title, status: x.status },
  ...(x.assignee && { who: x.assignee.name }),
});
const fromHandoff = (s: ResumeSection | undefined): ResumeItem[] =>
  (s?.items ?? []).map((i) => ({ src: 'handoff', text: i.text, ...(i.tag && { tag: i.tag }) }));
const hidden = (s: ResumeSection | undefined) => (s ? Math.max(0, s.total - s.items.length) : 0);

/** The five lines, in their order. */
export function resumeLines(i: ResumeInput): ResumeLine[] {
  const mine = i.tasks.filter((x) => x.project === i.project);
  const by = (status: BoardTask['status']) => mine.filter((x) => x.status === status).sort(newest);
  const h = i.handoff;
  const note: ResumeLine['note'] =
    h === null ? 'noHandoff' : h?.format === 'free' ? 'freeHandoff' : undefined;
  const lead = i.team.find((m) => m.role === 'lead');
  const stateOf = (m: (typeof i.team)[number]): WhoState =>
    m.agentId !== null && i.waiting[m.agentId] ? 'waiting' : m.state;
  const todo = by('todo').sort(
    (a, b) =>
      PRIORITY.indexOf(a.priority) - PRIORITY.indexOf(b.priority) ||
      (a.createdAt < b.createdAt ? -1 : 1),
  );
  const nextFromHandoff = fromHandoff(h?.next);
  const line = (key: ResumeKey, items: ResumeItem[], more = 0, withNote = false): ResumeLine => ({
    key,
    items,
    more,
    ...(withNote && note && { note }),
  });
  return [
    line('now', [
      ...(lead && i.leadActivity
        ? [{ src: 'live', kind: 'activity', who: lead.name, text: i.leadActivity } as const]
        : []),
      ...[...by('doing'), ...by('review')].map(board),
    ]),
    line(
      'done',
      [...fromHandoff(h?.done), ...by('done').slice(0, RESUME_BOARD_SHOWN).map(board)],
      hidden(h?.done),
      true,
    ),
    line(
      'blocked',
      [
        ...by('blocked').map(board),
        ...i.approvals
          .filter((a) => a.project === i.project)
          .map((a) => ({ src: 'live', kind: 'approval', who: a.caller, text: a.title }) as const),
        ...i.team.flatMap((m) =>
          m.agentId !== null && i.waiting[m.agentId]
            ? [{ src: 'live', kind: 'wait', who: m.name, reason: i.waiting[m.agentId] } as const]
            : [],
        ),
        ...fromHandoff(h?.open),
      ],
      hidden(h?.open),
      true,
    ),
    line(
      'who',
      i.team
        .filter((m) => m.role === 'lead' || m.state !== 'off')
        .map(
          (m) =>
            ({
              src: 'live',
              kind: 'member',
              who: m.name,
              role: m.role,
              state: stateOf(m),
            }) as const,
        ),
    ),
    // The handoff's next steps when it names one, else the top of todo.
    line(
      'next',
      nextFromHandoff.length ? nextFromHandoff : todo.slice(0, RESUME_BOARD_SHOWN).map(board),
      hidden(h?.next),
      true,
    ),
  ];
}
