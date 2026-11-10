/** O3: a notice (the new-device push) opens the 보안 panel; AuthLayer owns it and registers how. */
let opener: (() => void) | null = null;

export function setSecurityOpener(open: () => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/** False while the layer that shows the panel is not mounted yet (the caller asks again). */
export function openSecurity(): boolean {
  if (!opener) return false;
  opener();
  return true;
}
