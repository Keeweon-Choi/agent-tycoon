import { createContext } from 'react';

import type { AgentAppearance, TabStatus } from '../../components/AgentCard.js';

/** The terminal drawer's per-agent look and activity, for every face the messenger draws. */
export const MessengerLooks = createContext<{
  getAppearance: (agentId: number) => AgentAppearance;
  statusFor: (agentId: number) => TabStatus | null;
} | null>(null);

