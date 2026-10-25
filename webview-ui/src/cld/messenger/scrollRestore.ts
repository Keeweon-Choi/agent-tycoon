export interface ScrollRestoreState {
  stuck: boolean;
  anchorTop: number | null;
  rowOffsetTop: number | null;
  savedTop: number;
}

export interface ScrollSize {
  scrollHeight: number;
  clientHeight: number;
}

/** A list without layout is not being read. */
export function isHidden({
  clientHeight,
  isConnected,
}: {
  clientHeight: number;
  isConnected: boolean;
}): boolean {
  return clientHeight === 0 || !isConnected;
}

/** Put the reader back where it was before its list lost layout. */
export function restoreTop(
  { stuck, anchorTop, rowOffsetTop, savedTop }: ScrollRestoreState,
  { scrollHeight, clientHeight }: ScrollSize,
): number {
  if (stuck) return Math.max(0, scrollHeight - clientHeight);
  if (anchorTop !== null && rowOffsetTop !== null) return rowOffsetTop - anchorTop;
  return savedTop;
}

/** Paging belongs only to a visible reader after its place is restored. */
export function mayFetchOlder({
  hidden,
  restoring,
}: {
  hidden: boolean;
  restoring: boolean;
}): boolean {
  return !hidden && !restoring;
}
