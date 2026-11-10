/**
 * Order of two dotted numeric versions ("0.156.1" < "0.167.0" < "0.167.10"): <0, 0, >0. An agent CLI's
 * `--version` and the registry's version are both plain numbers, so no pre-release rules here
 * (agent-tycoon/install/update.mjs has the full semver order for our own bundles; the webview cannot import .mjs).
 */
export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}
