/**
 * MSG-UI2: whose face goes beside a message (KakaoTalk style). The Lead's replies, another agent's
 * messages, a sub-agent's work notice and (MSG-UI3) the boss's own words carry the sender's face;
 * the centred system notices carry none. Consecutive messages from one sender show the face once.
 */
import type { ChatItem, TempEmployee } from '../../../../core/src/messages.js';
import { employeeName } from '../employees.js';

/** The sender's identity for grouping, or null when the item has no face. */
export function senderKey(item: ChatItem): string | null {
  if (item.kind === 'assistant') return 'lead';
  if (shellDone(item)) return null; // a command line, not a speaker
  if (item.kind === 'user' && item.from === 'peer')
    return `peer:${item.execution ?? item.fromName ?? ''}`;
  if (item.kind === 'user' && item.from === undefined) return 'owner';
  return null;
}

/** Whether `items[index]` starts a run of one sender (a tool line between two messages does not break it). */
export function startsRun(items: readonly ChatItem[], index: number): boolean {
  const key = senderKey(items[index]);
  if (key === null) return false;
  for (let i = index - 1; i >= 0; i--) {
    if (items[i].kind === 'tool' || items[i].kind === 'result') continue;
    return senderKey(items[i]) !== key;
  }
  return true;
}

/** The built-in palettes an employee without a pinned look draws from (a stable pick per employee). */
export const BUILT_IN_PALETTES = 6;
export function employeePalette(employeeId: string): number {
  let h = 0;
  for (const c of employeeId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % BUILT_IN_PALETTES;
}

/** MSG-ALIGN: the employee a task notice belongs to: the one the server stamped on it (the roster keeps
 *  every run's, so it outlives the employee's reuse and a reload), else the current staff list's. */
export function noticeEmployee(
  item: Pick<ChatItem, 'execution' | 'employee'>,
  staff: readonly Pick<TempEmployee, 'execution' | 'employeeId' | 'nameId'>[],
): Pick<TempEmployee, 'employeeId' | 'nameId'> | undefined {
  if (item.employee) return item.employee;
  return item.execution ? staff.find((e) => e.execution === item.execution) : undefined;
}

/** MSG-UI3: a sub-agent's task notice names its temp employee (`<name> · <notice label>`); an unknown
 *  employee keeps the plain label. */
export function noticeName(label: string, employee: Pick<TempEmployee, 'nameId'> | undefined): string {
  return employee ? `${employeeName(employee)} \u00b7 ${label}` : label;
}

/** A background shell command's end (Claude Code's own wording), not a sub-agent's: the lead's command
 *  line, not a speaker (owner 10-25 00:14). Its description and exit code, or null for anything else. */
export function shellDone(item: Pick<ChatItem, 'kind' | 'from' | 'text'>): { desc: string; code: number | null } | null {
  if (item.kind !== 'user' || item.from !== 'peer') return null;
  const m = /^\*\*Background command "([\s\S]+?)" [^*]*?(?:\(exit code (-?\d+)\))?\*\*/.exec(item.text);
  return m ? { desc: m[1], code: m[2] === undefined ? null : Number(m[2]) } : null;
}
