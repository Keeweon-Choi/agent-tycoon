import { useCldStore } from './officeStore.js';

/** May this viewer change things (privileged, and the server not read-only)? */
export function useCanAct(): boolean {
  const { officeSnapshot: officeState, officeReadOnly } = useCldStore();
  return officeState?.readOnly === false && !officeReadOnly;
}
