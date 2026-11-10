/** O2's server values mapped to literal i18n keys for the device list. */
export function deviceKindKey(kind: string):
  | 'auth.deviceKind.phone'
  | 'auth.deviceKind.tablet'
  | 'auth.deviceKind.desktop'
  | 'auth.deviceKind.unknown' {
  switch (kind) {
    case 'phone': return 'auth.deviceKind.phone';
    case 'tablet': return 'auth.deviceKind.tablet';
    case 'desktop': return 'auth.deviceKind.desktop';
    default: return 'auth.deviceKind.unknown';
  }
}

export function devicePathKey(path: string):
  | 'auth.devicePath.local'
  | 'auth.devicePath.lan'
  | 'auth.devicePath.tailscale'
  | 'auth.devicePath.remote' {
  switch (path) {
    case 'local': return 'auth.devicePath.local';
    case 'lan': return 'auth.devicePath.lan';
    case 'tailscale': return 'auth.devicePath.tailscale';
    default: return 'auth.devicePath.remote';
  }
}
