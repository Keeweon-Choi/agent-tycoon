/**
 * The exposure ledger (S6, threat T10): what cld-gui opened outside this PC
 * that nothing else closes again — `tailscale serve`/Funnel, the quick
 * tunnel's cloudflared, the Windows portproxy the person added for direct.
 * (Direct, UPnP and the LAN listener are closed by the daemon itself.)
 * Pure: reading and writing `<configDir>/exposure.json` stays with each caller.
 */
export const EXPOSURE_FILE = 'exposure.json';

export function emptyLedger() {
  return { v: 1, entries: [] };
}

const isInt = (value) => Number.isInteger(value);
function validEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.kind === 'tailscale') return typeof entry.host === 'string' && isInt(entry.port) && typeof entry.funnel === 'boolean';
  if (entry.kind === 'tunnel')
    return typeof entry.url === 'string' && (entry.pid === undefined || isInt(entry.pid))
      && (entry.localPort === undefined || isInt(entry.localPort)) && (entry.startTime === undefined || typeof entry.startTime === 'string');
  if (entry.kind === 'portproxy') return isInt(entry.externalPort) && isInt(entry.directPort);
  return false;
}

/**
 * The file's text as a ledger: `null` text (no file) is an empty ledger; text
 * that is not a v1 ledger we fully understand (broken JSON, another version,
 * an entry we do not know) is `null`. That file may record a live exposure,
 * so callers never overwrite or delete it: they move it aside and say so.
 */
export function parseLedger(text) {
  if (text === null || text === undefined) return emptyLedger();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || value.v !== 1 || !Array.isArray(value.entries) || !value.entries.every(validEntry)) return null;
  return { v: 1, entries: value.entries };
}

/** Where an unreadable ledger is moved aside (`exposure.json.bad-<ms>`). */
export function badLedgerPath(file, now = Date.now()) {
  return `${file}.bad-${now}`;
}

/** One node has one https:443 and the daemon one tunnel; a portproxy is keyed by its outside port. */
const sameSlot = (a, b) => a.kind === b.kind && (a.kind !== 'portproxy' || a.externalPort === b.externalPort);

export function addEntry(ledger, entry) {
  return { v: 1, entries: [...ledger.entries.filter((e) => !sameSlot(e, entry)), entry] };
}

export function removeEntry(ledger, entry) {
  return { v: 1, entries: ledger.entries.filter((e) => !sameSlot(e, entry)) };
}

function wanted(entry, state) {
  if (entry.kind === 'tailscale') return state.connector === 'tailscale' && entry.funnel === (state.funnel === true);
  if (entry.kind === 'tunnel') return state.tunnel === true;
  return state.connector === 'direct';
}

/** The entries `state` ({ connector, funnel, tunnel }) does not want; `null` (uninstall): all of them. */
export function unwantedEntries(ledger, state) {
  return ledger.entries.filter((entry) => !state || !wanted(entry, state));
}

/** The one command that undoes a tailscale entry (run only while it still serves our port). */
export function tailscaleOffArgs(entry) {
  return [entry.funnel ? 'funnel' : 'serve', '--https=443', 'off'];
}

/** What undoes the portproxy, for an administrator PowerShell (the same lines as the daemon's relayCommands().remove): quiet when it is already gone. */
export function portproxyRemoveCommands(externalPort = 443) {
  return [
    `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=${externalPort} | Out-Null`,
    `Remove-NetFirewallRule -Name cld-gui-${externalPort} -ErrorAction SilentlyContinue`,
  ];
}

/** The argv our quick tunnel starts cloudflared with (server/src/cld/remote/tunnel.ts cloudflaredArgs). */
export function tunnelArgv(localPort) {
  return ['cloudflared', 'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${localPort}`];
}

/** Field 22 (starttime, clock ticks since boot) of /proc/<pid>/stat; null when unreadable. */
export function procStartTime(stat) {
  if (typeof stat !== 'string' || !stat.includes(')')) return null;
  // The command name (field 2) may hold spaces and parentheses: count from the last ')'.
  const value = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  return value && /^\d+$/.test(value) ? value : null;
}

/**
 * A recorded tunnel pid is still OUR cloudflared only when the process has the
 * start time we recorded at spawn AND exactly our argv. Under systemd our child
 * dies with the daemon, so a live pid later is most likely reused, perhaps by
 * the person's own cloudflared. No start time recorded (older entries): never.
 */
export function isOurTunnel(entry, proc) {
  if (!entry.pid || !entry.startTime || !isInt(entry.localPort)) return false;
  if (procStartTime(proc.stat) !== entry.startTime) return false;
  const argv = typeof proc.cmdline === 'string' ? proc.cmdline.split('\0') : [];
  if (argv.at(-1) === '') argv.pop();
  const want = tunnelArgv(entry.localPort);
  return argv.length === want.length && argv.every((arg, i) => arg === want[i]);
}
