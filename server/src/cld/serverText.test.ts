/**
 * I1: texts that reach the owner without passing through koText() in the daemon -- the plain-JS
 * setup plan the installer shares, and the shipped job names -- must still be in the text table,
 * or an English browser would show them in Korean.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { matchKorean } from '../../../core/src/cld/serverText.js';
const shipped = JSON.parse(readFileSync(path.join(__dirname, 'jobRules.json'), 'utf8')) as unknown;

const HANGUL = /[가-힣]/;

describe('server text table covers what the daemon cannot build from it', () => {
  it('every Korean line of the remote setup plan is a table entry', async () => {
    const { REMOTE_CHOICES, remoteSetupPlan } =
      await import('../../../core/src/remoteSetupPlan.mjs');
    const base = {
      port: 18240,
      platform: 'linux',
      natKind: 'open',
      duckdnsConfigured: false,
      cloudflaredInstalled: false,
      tailscaleInstalled: false,
      tailscaleLoggedIn: false,
    };
    const variants = [
      {},
      { platform: 'win32' },
      { natKind: 'cgnat' },
      { wslMode: 'nat', relayReady: false },
      { duckdnsConfigured: true },
      { cloudflaredInstalled: true },
      { tailscaleInstalled: true },
      { tailscaleInstalled: true, tailscaleLoggedIn: true },
      { tailscaleInstalled: true, tailscaleLoggedIn: true, tailscaleFunnelAllowed: false },
      { existingWorking: 'direct' },
      { platform: 'darwin' },
      { platform: 'wsl' },
      { sshFound: true },
      ...(['windows', 'wsl-mirrored', 'ufw', 'firewalld', 'macos'] as const).flatMap((kind) => [
        { firewall: { kind, add: ['x'], ready: false, confirm: true } },
        { firewall: { kind, add: ['x'], ready: false, confirm: false } },
      ]),
    ];
    const lines = new Set<string>();
    for (const choice of REMOTE_CHOICES)
      for (const change of variants)
        for (const step of remoteSetupPlan({ ...base, ...change } as never, choice) as Array<{
          text: string;
          guide?: string;
          actions?: Array<{ label: string }>;
        }>) {
          lines.add(step.text);
          for (const line of step.guide?.split('\n') ?? []) lines.add(line);
          for (const action of step.actions ?? []) lines.add(action.label);
        }
    const missing = [...lines].filter((line) => HANGUL.test(line) && !matchKorean(line));
    expect(missing).toEqual([]);
  });

  it('every shipped job name and digest step has an English word', () => {
    const names = (shipped as { names: Array<{ name: string }> }).names.map((n) => n.name);
    const steps = (
      shipped as { digests: Array<{ steps?: Array<{ name: string }> }> }
    ).digests.flatMap((d) => (d.steps ?? []).map((s) => s.name));
    const missing = [...names, ...steps].filter(
      (name) => !matchKorean(name.replace(/\$\d+/g, 'x')),
    );
    expect(missing).toEqual([]);
  });
});
