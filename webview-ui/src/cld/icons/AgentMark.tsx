/** An agent's own mark next to its name (the usage rows; any card that shows an agent may reuse it). */
import type { CSSProperties } from 'react';

import { agentLogo, markHue } from './agentLogos.js';

/** An agent's mark: its logo, or its name's initial on its own hue. `className` sizes and frames it. */
export function AgentMark({
  id,
  name,
  className,
}: {
  id: string;
  name: string;
  className: string;
}) {
  const logo = agentLogo(id);
  if (!logo)
    return (
      <span
        className={className}
        data-mark="initial"
        style={{ '--mark-hue': markHue(id) } as CSSProperties}
        aria-hidden="true"
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  return (
    <span className={className} data-mark="logo" aria-hidden="true">
      <svg viewBox="0 0 24 24" width="100%" height="100%" fill={logo.color ?? 'currentColor'}>
        <path d={logo.path} fillRule={logo.evenodd ? 'evenodd' : undefined} />
      </svg>
    </span>
  );
}
