export type ExposureEntry =
  | { kind: 'tailscale'; host: string; port: number; funnel: boolean; by: 'daemon' | 'installer'; at: number }
  | { kind: 'tunnel'; url: string; pid?: number; localPort?: number; startTime?: string; by: 'daemon'; at: number }
  | { kind: 'portproxy'; externalPort: number; directPort: number; by: 'user'; at: number };
export interface ExposureLedger { v: 1; entries: ExposureEntry[] }
export interface ExposureState { connector: string; funnel?: boolean; tunnel?: boolean }
export const EXPOSURE_FILE: string;
export function emptyLedger(): ExposureLedger;
export function parseLedger(text: string | null | undefined): ExposureLedger | null;
export function badLedgerPath(file: string, now?: number): string;
export function addEntry(ledger: ExposureLedger, entry: ExposureEntry): ExposureLedger;
export function removeEntry(ledger: ExposureLedger, entry: ExposureEntry): ExposureLedger;
export function unwantedEntries(ledger: ExposureLedger, state: ExposureState | null): ExposureEntry[];
export function tailscaleOffArgs(entry: Extract<ExposureEntry, { kind: 'tailscale' }>): string[];
export function portproxyRemoveCommands(externalPort?: number): string[];
export function tunnelArgv(localPort: number): string[];
export function procStartTime(stat: string | null | undefined): string | null;
export function isOurTunnel(entry: Extract<ExposureEntry, { kind: 'tunnel' }>, proc: { stat: string | null; cmdline: string | null }): boolean;
