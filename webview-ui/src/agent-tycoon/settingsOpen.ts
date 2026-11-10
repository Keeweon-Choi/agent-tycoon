/** GFX: the title scene's 설정 and 원격 연결 open 설정 (on a tab); GameOptions registers how. */
export type SettingsTab = 'general' | 'display' | 'access' | 'security' | 'advanced';

let opener: ((tab?: SettingsTab) => void) | null = null;

export function setSettingsOpener(open: (tab?: SettingsTab) => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/** False while no 설정 button is mounted (a read-only viewer's bar has one too). */
export function openSettings(tab?: SettingsTab): boolean {
  if (!opener) return false;
  opener(tab);
  return true;
}
