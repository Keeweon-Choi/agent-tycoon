import { t } from '../i18n/index.js';
import { useWaitReasons } from './waiting.js';

/** WAITING-PERSIST: 질문 대기 / 허락 대기 beside an agent's name, on every surface (cld/waiting.ts). */
export function WaitMark({ agentId }: { agentId: number | null | undefined }) {
  const why = useWaitReasons()[agentId ?? Number.NaN];
  if (!why) return null;
  return (
    <span
      className="shrink-0 border-2 border-status-permission px-4 text-xs leading-tight font-bold text-status-permission"
      data-testid="wait-mark"
      data-reason={why}
    >
      {t(`waiting.${why}`)}
    </span>
  );
}
