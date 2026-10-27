export type RemoteChoice = 'local' | 'lan' | 'direct' | 'ssh' | 'duckdns' | 'tailscale' | 'funnel' | 'tunnel';
export const REMOTE_CHOICES: readonly RemoteChoice[];
export type SetupKind = 'switch' | 'ssh' | 'keep' | 'unavailable' | 'direct' | 'duckdns-account' | 'wsl-relay' | 'firewall' | 'tailscale-serve' | 'tailscale-funnel' | 'tailscale-funnel-consent' | 'tailscale-login' | 'tailscale-install' | 'cloudflared-install' | 'tunnel';
export type AdminSetup =
  | { kind: 'relay'; directPort: number; externalPort: number }
  | { kind: 'firewall'; firewall: 'windows' | 'wsl-mirrored'; ports: number[] };
export interface SetupFact {
  existingWorking?: 'direct' | 'duckdns' | 'tailscale' | 'funnel' | 'tunnel' | null;
  duckdnsConfigured?: boolean;
  natKind: 'open' | 'no-upnp' | 'cgnat' | 'double-nat' | 'unknown';
  upnp: boolean;
  wslMode: string | null;
  relayReady: boolean;
  wslInstructions?: string;
  relay?: AdminSetup;
  tailscaleInstalled: boolean;
  tailscaleLoggedIn: boolean;
  tailscaleLoginUrl?: string;
  /** false: the tailnet has not allowed Funnel yet (no funnel/https node attributes). */
  tailscaleFunnelAllowed?: boolean;
  tailscaleFunnelUrl?: string;
  cloudflaredInstalled: boolean;
  platform?: string;
  port?: number;
  sshUser?: string;
  sshHost?: string;
  /** The SSH server's port when it is not 22 (the scan found it). */
  sshPort?: number;
  /** The read-only scan found an SSH server answering: the plan only gives the laptop line. */
  sshFound?: boolean;
  /** WSL drives Windows' tailscale.exe. */
  tailscaleWindows?: boolean;
  /** The host firewall in front of the listener this choice opens; null or absent: none in the way. */
  firewall?: { kind: 'windows' | 'wsl-mirrored' | 'ufw' | 'firewalld' | 'macos'; add: string[]; ready: boolean; admin?: AdminSetup; confirm?: boolean } | null;
}
export type SetupAction = { kind: 'open'; url: string; label: string } | { kind: 'copy'; text: string; label: string };
/** `confirm`: the person must say they ran the commands (nothing here can read the result back). */
export interface SetupPlanStep { kind: SetupKind; text: string; guide?: string; actions?: SetupAction[]; admin?: AdminSetup; suggest?: RemoteChoice; confirm?: boolean }
export function sshTunnelCommand(o: { port: number; sshPort?: number; user: string; host: string }): string;
export function remoteSetupPlan(facts: SetupFact, choice: RemoteChoice): SetupPlanStep[];
