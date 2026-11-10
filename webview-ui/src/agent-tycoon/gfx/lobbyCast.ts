/** GFX2: the lobby's picture files and the looks of its cast (LobbyLife.tsx draws them; BootScreen.tsx
 *  gets them ready first). */
import type { CharacterChoice, CharacterPresets } from '../../../../core/src/messages.js';
import { lookByName, ownerChoice } from '../characters/looks.js';
import tall from './art/title-tall.webp';
import wide from './art/title-wide.webp';
import type { LobbyArtKind } from './titleSceneState.js';

export const LOBBY_SRC: Record<LobbyArtKind, string> = { wide, tall };
const TORI: CharacterChoice = { v: 2, kind: 'mascot', species: 'tori' };

/** Tori's and the owner's looks at the counter (null: none, or its sheet still loading; asking
 *  starts the load). */
export function lobbyLooks(presets: CharacterPresets) {
  return [TORI, ownerChoice(presets)].map((choice, i) =>
    choice
      ? lookByName(`lobby:${i}`, { ...presets, assignments: { [`lobby:${i}`]: choice } })
      : null,
  );
}
