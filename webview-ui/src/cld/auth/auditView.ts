/** O3: one line of the security record, as a sentence for the 보안 panel. */
import type { t as translate } from '../../i18n/index.js';
import { deviceKindKey } from './deviceListView.js';

/** The record's line as the daemon serves it (server/src/cld/audit.ts). */
export interface AuditRow {
  at: number;
  kind: string;
  device?: { id: string; label: string; kind?: string };
  by?: string;
  via?: string;
  peer?: string;
  detail?: string | number;
}

type T = typeof translate;

/**
 * The newest page arrived while older pages are on screen: the lines written since `since` (the
 * record's size at the last sync) go on top and the pages already loaded stay. Starts over when
 * nothing is loaded or the numbers do not add up (the record was rotated or cleared).
 */
export function mergeNewest(
  rows: AuditRow[],
  since: number,
  page: { lines: AuditRow[]; total: number },
): { rows: AuditRow[]; since: number } {
  const added = page.total - since;
  if (rows.length === 0 || added < 0 || added > page.lines.length)
    return { rows: page.lines, since: page.total };
  return { rows: [...page.lines.slice(0, added), ...rows], since: page.total };
}

/** What an exposure or connector word means to a person; an unknown word is shown as it is. */
function nameOf(word: string, t: T): string {
  switch (word) {
    case 'local': return t('auth.audit.what.local');
    case 'lan': return t('auth.audit.what.lan');
    case 'direct': return t('auth.audit.what.direct');
    case 'tailscale':
    case 'tailscale serve': return t('auth.audit.what.tailscale');
    case 'tailscale funnel': return t('auth.audit.what.funnel');
    case 'tunnel': return t('auth.audit.what.tunnel');
    case 'portproxy': return t('auth.audit.what.portproxy');
    default: return word;
  }
}

/** What happened. */
export function auditWhat(row: AuditRow, t: T): string {
  const detail = String(row.detail ?? '');
  switch (row.kind) {
    case 'deviceRegistered':
      if (detail === 'replaced') return t('auth.audit.deviceReplaced');
      if (detail === 'passkey') return t('auth.audit.devicePasskey');
      if (detail === 'unknown') return t('auth.audit.deviceUnknown');
      return t('auth.audit.deviceNew');
    case 'inviteCreated': return t('auth.audit.inviteCreated');
    case 'inviteUsed': return t('auth.audit.inviteUsed');
    case 'inviteRefused':
      return t(detail === 'expired' ? 'auth.audit.inviteExpired' : 'auth.audit.inviteCancelled');
    case 'loginCodeCreated': return t('auth.audit.loginCodeCreated');
    case 'loginCodeUsed':
      return t(detail === 'move' ? 'autoMove.audit.moveUsed' : 'auth.audit.loginCodeUsed');
    case 'moveCodeCreated':
      return t(detail === 'auto' ? 'autoMove.audit.auto' : 'autoMove.audit.manual');
    case 'moveRefused': return t('autoMove.audit.refused');
    case 'handoffCodeCreated': return t('autoMove.audit.handoff');
    case 'approvalAnswered':
      return t(detail === 'approved' ? 'auth.audit.approvalApproved' : 'auth.audit.approvalRefused');
    case 'deviceRevoked': return t('auth.audit.deviceRevoked');
    case 'revokeOthers': return t('auth.audit.revokeOthers', { count: detail });
    case 'passkeyRemoved': return t('auth.audit.passkeyRemoved');
    case 'passkeyRequired':
      return t(detail === 'on' ? 'auth.audit.passkeyRequiredOn' : 'auth.audit.passkeyRequiredOff');
    case 'stepUpPassed': return t('auth.audit.stepUpPassed');
    case 'stepUpFailed': return t('auth.audit.stepUpFailed', { count: detail });
    case 'exposure': {
      const [what, state] = [detail.replace(/ (on|off)$/, ''), detail.endsWith(' off') ? 'off' : 'on'];
      return t(state === 'on' ? 'auth.audit.exposureOn' : 'auth.audit.exposureOff', { what: nameOf(what, t) });
    }
    case 'connector': {
      const [from, to] = detail.split('>');
      return t('auth.audit.connector', { from: nameOf(from, t), to: nameOf(to ?? '', t) });
    }
    case 'allowedHosts': return t('auth.audit.allowedHosts', { count: detail });
    case 'tokenRotated':
      return t(detail === 'host' ? 'auth.audit.tokenHost' : 'auth.audit.tokenPath');
    case 'lockout':
      return t(detail === 'direct' ? 'auth.audit.lockoutDirect' : 'auth.audit.lockoutShort');
    default: return row.kind;
  }
}

/** Which device, and from where it came in. */
export function auditWho(row: AuditRow, t: T): string {
  const device = row.device
    ? [row.device.label, row.device.kind ? t(deviceKindKey(row.device.kind)) : '']
        .filter(Boolean)
        .join(' · ')
    : '';
  const via = row.via ? t(`auth.audit.via.${row.via === 'local' || row.via === 'lan' ? row.via : 'remote'}`) : '';
  const by = row.by === 'host' ? t('auth.audit.byHost') : (row.by ?? '');
  // The actor only when it is not the device itself.
  const actor = by && by !== row.device?.label ? t('auth.audit.by', { name: by }) : '';
  return [device, actor, via, row.peer ?? ''].filter(Boolean).join(' · ');
}
