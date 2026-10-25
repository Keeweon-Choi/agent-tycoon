import { koText } from './serverText.js';

/** The same work words on cards, the board and notices. */
export type WorkOutcome =
  '진행 중' | '끝남(성공)' | '실패' | '멈춤(사용자가 멈춤)' | '한도 대기' | '시간 초과';

export function jobOutcome(
  exit: number | null | undefined,
  ended: boolean,
  stopped = false,
): WorkOutcome {
  if (!ended) return '진행 중';
  if (stopped) return '멈춤(사용자가 멈춤)';
  if (exit === 124) return '시간 초과';
  return exit === 0 ? '끝남(성공)' : '실패';
}

export function codexOutcome(state: string): WorkOutcome {
  switch (state) {
    case 'running':
      return '진행 중';
    case 'limit':
      return '한도 대기';
    case 'done':
      return '끝남(성공)';
    case 'stopped':
      return '멈춤(사용자가 멈춤)';
    default:
      return '실패';
  }
}

export function particle(word: string, pair: '이/가' | '을/를'): string {
  const stem = word
    .trim()
    .replace(/\([^)]*\)$/, '')
    .trim();
  const last = [...stem].at(-1)?.codePointAt(0) ?? 0;
  const final = last >= 0xac00 && last <= 0xd7a3 && (last - 0xac00) % 28 !== 0;
  return pair === '이/가' ? (final ? '이' : '가') : final ? '을' : '를';
}

/** A Codex spec heading shortens to its task number: "T-0065: …" → "T-0065 작업". */
export const workSubject = (title: string): string =>
  title.startsWith('T-') ? koText('work_task_n', { id: title.split(':')[0].slice(2) }) : title;

type Particled = 'work_started' | 'work_restarted' | 'work_stopping';
type Subject = 'work_done' | 'work_failed' | 'work_timeout' | 'work_stopped' | 'work_limit';
/** "배포를 시작했어요" (English: "Started deploy"): an action on the work, object particle right. */
export function workAction(title: string, verb: Particled): string {
  const subject = workSubject(title);
  return koText(`${verb}_${particle(subject, '을/를') === '을' ? 'eul' : 'reul'}`, { subject });
}

const NOTICE: Record<Exclude<WorkOutcome, '진행 중'>, Subject> = {
  '끝남(성공)': 'work_done',
  실패: 'work_failed',
  '시간 초과': 'work_timeout',
  '멈춤(사용자가 멈춤)': 'work_stopped',
  '한도 대기': 'work_limit',
};
export function workNotice(title: string, outcome: WorkOutcome): string {
  if (outcome === '진행 중') return workAction(title, 'work_started');
  const subject = workSubject(title);
  return koText(`${NOTICE[outcome]}_${particle(subject, '이/가') === '이' ? 'i' : 'ga'}`, { subject });
}
