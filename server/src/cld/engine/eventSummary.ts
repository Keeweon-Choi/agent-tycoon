/**
 * One events.jsonl line -> feed entry (the engine's log and the older tools'
 * lines that may still sit in it). Korean one-liners built from names and
 * kinds only: message bodies (`preview`), commands (`cmd`, may hold secrets)
 * and paths are never copied (NFR-SEC-007).
 */
import { koText } from '../../../../core/src/cld/serverText.js';
import { codexOutcome, jobOutcome, workAction, workNotice } from '../../../../core/src/cld/work.js';
import type { OfficeEvent } from '../../../../core/src/messages.js';
import { deriveJobName } from '../jobNames.js';
import { maskText } from '../mask.js';

type Obj = Record<string, unknown>;

const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);

/** gpu_cancel's reasons (HIF §6), as the board says them. */
const GPU_CANCEL_WORDS: Record<string, string> = {
  cancel: koText('gpu_why_cancel'),
  wait: koText('gpu_why_wait'),
  stop: koText('gpu_why_stop'),
  dead: koText('gpu_why_dead'),
};

/**
 * One events.jsonl line -> feed entry. Korean one-liners built from names and
 * kinds only: message bodies (`preview`), commands (`cmd`, may hold secrets)
 * and paths are never copied (NFR-SEC-007).
 */
export function rememberWorkName(e: Obj, names: Map<string, string>): Obj {
  const type = str(e.type) ?? '';
  const id = str(e.id) ?? (num(e.pid) !== null ? `pid:${num(e.pid)}` : null);
  if (!id || (!type.startsWith('job_') && !type.startsWith('codex_') && type !== 'stop')) return e;
  const title =
    str(e.label) ??
    str(e.title) ??
    (type === 'job_start' && str(e.cmd) ? deriveJobName(str(e.cmd)!) : null);
  if (title) names.set(id, title);
  return title || !names.has(id) ? e : { ...e, label: names.get(id) };
}

/** D5: the feed's kind for a Codex Worker's run that ended done, stopped (not failed). */
export const WORKER_RUN_END = 'codex_worker_end';

/** A send with no `from` is the boss's own: the app (with its device) or the terminal; the engine's own is the daemon's. */
function senderOf(source: string | null): string {
  if (source?.startsWith('gui:')) return koText('ev_me', { device: source.slice(4) });
  return source === 'engine' ? 'cld-gui' : koText('ev_owner');
}

export function summarizeEvent(e: Obj): Omit<OfficeEvent, 'type'> | null {
  const type = str(e.type);
  const ts = str(e.ts);
  if (!type || !ts) return null;
  // D5: the engine job under a Codex Worker's run: its codex_end is the feed's line (and the
  // only notice, when it failed).
  if (type === 'job_end' && e.kind === 'codex' && str(e.agent)) return null;
  // D5: a Codex Worker's run that ended other than failed is its Lead's news, not a notice
  // or a push (design-d5 §2.6): the feed shows it under its own kind.
  const kind =
    type === 'codex_end' && str(e.agent) && str(e.state) !== 'failed' ? WORKER_RUN_END : type;
  // A Worker's run is its character's (engine:<worker>), not the project's.
  const name = str(e.agent) ?? str(e.name);
  const who = name ?? '?';
  const id = str(e.id) ?? '?';
  const project = str(e.project);
  const workTitle = maskText(
    str(e.label) ??
      str(e.title) ??
      (str(e.cmd) ? deriveJobName(str(e.cmd)!) : kind.startsWith('codex_') ? koText('work_default_codex') : koText('work_default')),
  )
    .replace(/[\r\n]/g, ' ')
    .slice(0, 80);
  let summary: string;
  switch (kind) {
    case 'send':
      // No `from`: the boss (the app, `source: gui:<device>`, or the terminal) or, from the engine, the daemon.
      summary = koText(e.delivered === 'inbox' ? 'ev_send_inbox' : e.delivered === 'queued' ? 'ev_send_queued' : 'ev_send', {
        from: str(e.from) ?? senderOf(str(e.source)),
        to: str(e.to) ?? '?',
      });
      break;
    case 'send_edit':
      summary = koText('ev_send_edit', { to: str(e.to) ?? '?' });
      break;
    case 'send_hold':
      summary = koText(e.on === false ? 'ev_send_unhold' : 'ev_send_hold', { to: str(e.to) ?? '?' });
      break;
    case 'send_stuck':
      summary = koText('ev_send_stuck', { to: str(e.to) ?? '?' });
      break;
    case 'token_guard':
      summary = koText('ev_token_guard', { to: str(e.to) ?? '?' });
      break;
    case 'send_cancel':
      summary = koText('ev_send_cancel', { to: str(e.to) ?? '?' });
      break;
    // C6: delegate_task (names and ids only).
    case 'delegate':
      summary = koText(
        e.status === 'queued'
          ? e.newWorker === true ? 'ev_delegate_queued_new' : 'ev_delegate_queued'
          : e.newWorker === true ? 'ev_delegate_new' : 'ev_delegate',
        { from: str(e.from) ?? '?', to: str(e.to) ?? '?', task: str(e.task) ?? '' },
      );
      break;
    case 'task_report':
      summary = koText('ev_task_report', { from: str(e.from) ?? '?', task: str(e.task) ?? '', status: str(e.status) ?? '' });
      break;
    case 'delegation_approval':
      summary = koText('ev_delegation_approval', { from: str(e.from) ?? '?' });
      break;
    case 'delegation_proposal':
      summary = koText('ev_delegation_proposal', { from: str(e.from) ?? '?', who, task: str(e.task) ?? '' });
      break;
    case 'delegation_start_failed':
      summary = koText('ev_delegation_start_failed', { to: str(e.to) ?? '?', task: str(e.task) ?? '?' });
      break;
    case 'delegation_decision':
      summary = koText(e.decision === 'approve' ? 'ev_delegation_approved' : 'ev_delegation_denied', { to: str(e.to) ?? '?' });
      break;
    case 'inbox_deliver':
      summary = koText('ev_inbox_deliver', { to: str(e.to) ?? '?' });
      break;
    case 'orch_start':
      summary = koText(e.resumed === true ? 'ev_orch_resumed' : 'ev_orch_start', { who });
      break;
    case 'orch_exit':
      summary = num(e.code) !== null ? koText('ev_orch_exit_code', { who, code: num(e.code)! }) : koText('ev_orch_exit', { who });
      break;
    case 'lead_swap': {
      // D3b: names are slots: `to` is the promoted Worker under its old name.
      const to = (e.to as Obj | null)?.name;
      summary = koText(e.oldLead === 'stop' ? 'ev_lead_swap_stop' : 'ev_lead_swap_worker', {
        project: project ?? '?',
        to: str(to) ?? '?',
      });
      break;
    }
    case 'orch_giveup':
      summary = str(e.error)
        ? koText('ev_orch_giveup_why', { who, why: maskText(str(e.error)!).slice(0, 80) })
        : koText('ev_orch_giveup', { who });
      break;
    case 'turn_end':
      summary = koText('ev_turn_end', { who });
      break;
    case 'compacted':
      summary = num(e.count) !== null ? koText('ev_compacted_n', { who, count: num(e.count)! }) : koText('ev_compacted', { who });
      break;
    case 'renew_request':
      summary = koText('ev_renew_request', { who });
      break;
    case 'renew_done':
      summary = koText('ev_renew_done', { who });
      break;
    case 'orch_renew':
      summary = e.ok === false ? koText('ev_orch_renew_failed', { who, code: str(e.code) ?? '?' }) : koText('ev_orch_renew', { who });
      break;
    case 'revive':
      summary = koText('ev_revive', { count: arr(e.started).length });
      break;
    case 'codex_start':
      summary = workAction(workTitle, 'work_started');
      break;
    case 'codex_limit':
      summary = workNotice(workTitle, '한도 대기');
      break;
    case 'codex_resume':
      summary = workAction(workTitle, 'work_restarted');
      break;
    case 'codex_end':
      summary = workNotice(workTitle, codexOutcome(str(e.state) ?? 'failed'));
      break;
    case WORKER_RUN_END:
      summary = `${who} · ${workNotice(workTitle, codexOutcome(str(e.state) ?? 'failed'))}`;
      break;
    case 'job_start':
      summary = workAction(workTitle, 'work_started');
      break;
    case 'job_end':
      summary = workNotice(workTitle, jobOutcome(num(e.exit), true, e.stopped === true));
      break;
    case 'stop':
      summary = workAction(workTitle, 'work_stopping');
      break;
    case 'usage_reset_early': {
      const provider = str(e.provider) === 'codex' ? 'Codex' : 'Claude';
      summary = koText(str(e.period) === 'sevenDay' ? 'ev_usage_reset_week' : 'ev_usage_reset_5h', { provider });
      break;
    }
    case 'project':
      summary = koText('ev_project', { action: str(e.action) ?? koText('ev_project_changed'), who });
      break;
    // T-0046: the GPU reservations in words (the board's own words for the reasons).
    case 'gpu_queue':
      summary = koText('ev_gpu_queue', { name: project ?? id });
      break;
    case 'gpu_lease':
      summary = koText('ev_gpu_lease', { name: project ?? id });
      break;
    case 'gpu_release':
      summary = koText(str(e.reason) === 'dead' ? 'ev_gpu_release_dead' : 'ev_gpu_release', { name: project ?? id });
      break;
    case 'gpu_cancel':
      summary = koText('ev_gpu_cancel', { name: project ?? id, why: GPU_CANCEL_WORDS[str(e.reason) ?? ''] ?? koText('gpu_why_cancel') });
      break;
    case 'gpu_move':
      summary = num(e.position) !== null ? koText('ev_gpu_move_to', { name: project ?? id, position: num(e.position)! }) : koText('ev_gpu_move', { name: project ?? id });
      break;
    default:
      summary = kind.startsWith('gpu_') ? `GPU ${kind.slice(4)}: ${project ?? id}` : kind;
  }
  return {
    ts,
    kind,
    source: str(e.source),
    name: name ?? str(e.to) ?? project,
    summary,
    // Which job or Codex task ended, for a notice to open (T-0043).
    ...((kind === 'job_end' || kind === 'codex_end' || kind === WORKER_RUN_END) && {
      ref: str(e.id) ?? (num(e.pid) !== null ? `pid:${num(e.pid)}` : null),
    }),
    ...(kind === 'usage_reset_early' && {
      provider: str(e.provider) === 'codex' ? ('codex' as const) : ('claude' as const),
      period: str(e.period) === 'sevenDay' ? ('sevenDay' as const) : ('fiveHour' as const),
    }),
  };
}
