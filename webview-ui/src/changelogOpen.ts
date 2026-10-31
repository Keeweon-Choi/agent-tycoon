/** The update log opens from Settings: App owns the modal and registers how. */
let opener: (() => void) | null = null;

export function setChangelogOpener(open: () => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/** False while the app has not registered the modal yet. */
export function openChangelog(): boolean {
  if (!opener) return false;
  opener();
  return true;
}
