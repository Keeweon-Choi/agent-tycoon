import { t } from '../i18n/index.js';
import type { OfficeIdentity } from './officeStore.js';

/** Over the plate: OFF and 인수인계 필요 only (engine-run and attachable are in the details). */
export function OfficeBadges({ identity }: { identity: OfficeIdentity }) {
  const badges = [
    identity.off && 'OFF',
    identity.handoff && t('badge.handoff'),
  ].filter((badge): badge is string => typeof badge === 'string');
  if (!badges.length) return null;
  return (
    <div className="flex flex-wrap justify-center gap-4 max-w-192 mb-4 pointer-events-none">
      {badges.map((badge) => (
        <span
          key={badge}
          className="bg-bg border border-border px-4 text-xs leading-tight text-text whitespace-nowrap shadow-pixel"
        >
          {badge}
        </span>
      ))}
    </div>
  );
}
