import { describe, expect, it } from 'vitest';

import { runRemoteSetup } from './setup.js';

const facts = { natKind: 'open' as const, upnp: true, wslMode: null, relayReady: false, tailscaleInstalled: false, tailscaleLoggedIn: false, cloudflaredInstalled: false, platform: 'linux' };

describe('selected remote setup execution', () => {
  it('waits for a Windows relay with a copy action', async () => {
    const outcome = await runRemoteSetup({ ...facts, wslMode: 'nat', wslInstructions: 'netsh interface portproxy add v4tov4 ...' }, 'direct',
      async () => { throw new Error('must not run'); }, async () => { throw new Error('must not test'); });
    expect(outcome.pending).toBe(true);
    expect(outcome.steps[0].actions?.[0]).toMatchObject({ kind: 'copy', text: 'netsh interface portproxy add v4tov4 ...' });
  });
  it('does not switch away from direct on CGNAT', async () => {
    const outcome = await runRemoteSetup({ ...facts, natKind: 'cgnat' }, 'direct',
      async () => { throw new Error('must not run'); }, async () => { throw new Error('must not test'); });
    expect(outcome.steps[0].suggest).toBe('tailscale');
    expect(outcome.pending).toBe(false);
  });
  it('waits for Tailscale installation and then tests Serve', async () => {
    const first = await runRemoteSetup(facts, 'tailscale', async () => { throw new Error('must not run'); }, async () => { throw new Error('must not test'); });
    expect(first.steps[0].actions?.[0]).toMatchObject({ kind: 'open', url: 'https://tailscale.com/download/linux' });
    const called: string[] = [];
    const second = await runRemoteSetup({ ...facts, tailscaleInstalled: true, tailscaleLoggedIn: true }, 'tailscale', async (kind) => {
      called.push(kind);
      return { ok: true, url: 'https://mine.ts.net/', connector: 'tailscale' };
    }, async (url) => ({ ok: true, url, checkedAt: 1, steps: [{ ok: true, text: '로그인 화면' }] }));
    expect(second.ok).toBe(true);
    expect(called).toEqual(['tailscale-serve']);
  });
  it('tests a temporary public address only after its explicit choice', async () => {
    const called: string[] = [];
    const outcome = await runRemoteSetup({ ...facts, cloudflaredInstalled: true }, 'tunnel',
      async (kind) => { called.push(kind); return { ok: true, url: 'https://temp.trycloudflare.com/secret/', connector: 'tunnel' }; },
      async (url) => ({ ok: true, url, checkedAt: 2, steps: [{ ok: true, text: '로그인 화면' }] }));
    expect(called).toEqual(['tunnel']);
    expect(outcome.ok).toBe(true);
  });
});
