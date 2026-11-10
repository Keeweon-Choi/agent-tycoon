import { useAgtyStore } from './officeStore.js';

/** May this viewer change things (privileged, and the server not read-only)? */
export function useCanAct(): boolean {
  const { officeSnapshot: officeState, officeReadOnly } = useAgtyStore();
  return officeState?.readOnly === false && !officeReadOnly;
}
