/**
 * Built-in engine controls (T-0018): which buttons an engine project's card
 * shows, the confirmation and toast texts (T-0010's, reused), and the form's
 * fields. Pure; engineStore.ts keeps the flow and EngineControls.tsx draws it.
 */
import type { PathHost } from '../../../core/src/cld/projectPath.js';
import { normalizeProjectPath } from '../../../core/src/cld/projectPath.js';
import type {
  EngineAction,
  EngineActionKind,
  EngineActionResult,
  EngineProject,
} from '../../../core/src/messages.js';
import { t } from '../i18n/index.js';
import { confirmText, objectParticle } from './actionText.js';
import { serverNote, serverText } from './serverText.js';

export type SessionAction = 'start' | 'stop' | 'restart';

export const engineLabel = (action: EngineActionKind): string => t(`engine.action.${action}`);
const done = (action: EngineActionKind): string => t(`engine.done.${action}`);

/** A project's session buttons: off -> 켜기; a live background session -> 끄기,
 *  재시작; open in a terminal -> none (it is not ours to stop). */
export function sessionActions(p: EngineProject): SessionAction[] {
  if (!p.live) return ['start'];
  return p.bgId ? ['stop', 'restart'] : [];
}

export function engineConfirmText(
  action: Exclude<EngineActionKind, 'add' | 'edit' | 'promote'>,
  name: string,
): { question: string; note?: string } {
  if (action === 'remove')
    return {
      question: t('engine.confirmRemove', { name, particle: objectParticle(name) }),
      note: t('engine.confirmRemoveNote'),
    };
  return confirmText(action === 'stop' ? 'quit' : action, name);
}

export function engineToast(r: EngineActionResult): {
  text: string;
  tone: 'ok' | 'info' | 'error';
} {
  if (!r.ok) return { text: serverText(r, t('engine.failed')), tone: 'error' };
  if (!r.note) return { text: done(r.action), tone: 'ok' };
  // A start's note says what happened instead ("이미 켜져 있어요").
  const text =
    r.action === 'start' || r.action === 'restart' ? serverNote(r.note) : `${done(r.action)}. ${serverNote(r.note)}`;
  return { text, tone: 'info' };
}

/** The form's fields, all strings except its switches. */
export interface EngineForm {
  folder: string;
  name: string;
  room: string;
  rulesFile: string;
  model: string;
  permissionMode: string;
  effort: string;
  title: string;
  remoteControl: boolean;
  alwaysOn: boolean;
  /** T-0019: compactions before the renew nudge; '' = off. */
  compactionNudge: string;
}

const TEXT = ['room', 'rulesFile', 'model', 'permissionMode', 'effort', 'title'] as const;

export const NAME_RE = /^[A-Za-z0-9\uAC00-\uD7A3][A-Za-z0-9\uAC00-\uD7A3._-]{0,40}$/;

export function formFor(p: EngineProject | null): EngineForm {
  return {
    folder: p?.folder ?? '',
    name: p?.name ?? '',
    // The room shown is the folder's name unless one was chosen.
    room: p && p.room !== baseName(p.folder) ? p.room : '',
    rulesFile: p?.rulesFile ?? '',
    model: p?.model ?? '',
    permissionMode: p?.permissionMode ?? '',
    effort: p?.effort ?? '',
    title: p?.title ?? '',
    remoteControl: p?.remoteControl ?? false,
    alwaysOn: p?.alwaysOn ?? false,
    compactionNudge: p?.compactionNudge ? String(p.compactionNudge) : '',
  };
}

export const baseName = (folder: string): string =>
  folder
    .replace(/[/\\]+$/, '')
    .split(/[/\\]/)
    .pop() ?? '';

/** The rules path remains in the form value; the office only displays its file name. */
export const rulesFileLabel = (rulesFile: string): string => baseName(rulesFile) || rulesFile;

/** A first check before sending (the daemon checks everything again), with
 *  the host's folder rules once it said what it is (T-0032). */
export function formError(f: EngineForm, adding: boolean, host: PathHost | null): string | null {
  if (!f.folder.trim()) return t('engine.error.folder');
  const folder = host && normalizeProjectPath(f.folder, host);
  if (folder && 'error' in folder) return serverText(folder);
  if (adding && !NAME_RE.test(f.name))
    return t('engine.error.name');
  const nudge = f.compactionNudge.trim();
  if (nudge && !(/^\d{1,2}$/.test(nudge) && Number(nudge) >= 1))
    return t('engine.error.nudge');
  return null;
}

/** add: every filled field. edit: only what changed ('' clears, false turns off). */
export function formFields(
  f: EngineForm,
  was: EngineProject | null,
): Partial<Omit<EngineAction, 'type' | 'requestId' | 'action' | 'name'>> {
  const before = formFor(was);
  const out: Partial<Omit<EngineAction, 'type' | 'requestId' | 'action' | 'name'>> = {};
  if (!was || f.folder.trim() !== before.folder) out.folder = f.folder.trim();
  for (const k of TEXT) {
    const v = f[k].trim();
    // An add sends model and effort even when emptied: '' keeps Claude's own default, while a
    // missing one gets the Leads' default on the server (leadDefaults.ts).
    if (was ? v !== before[k] : v || k === 'model' || k === 'effort') out[k] = v;
  }
  for (const key of ['remoteControl', 'alwaysOn'] as const)
    if (was ? f[key] !== before[key] : f[key]) out[key] = f[key];
  const nudge = f.compactionNudge.trim();
  if (was ? nudge !== before.compactionNudge : nudge)
    out.compactionNudge = nudge ? Number(nudge) : 0;
  return out;
}
