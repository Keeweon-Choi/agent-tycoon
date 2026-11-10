/**
 * AGENT-LATEST: the newest published version of each agent CLI, display only. Every registry answer is
 * a fake fetch; nothing here touches the network.
 */
import { describe, expect, it, vi } from 'vitest';

import { AGENT_LATEST_MAX_BYTES, AGENT_LATEST_MIN_GAP_MS, AGENT_LATEST_TTL_MS } from '../constants.js';
import { AgentLatest } from './agentLatest.js';

const reply = (body: string, status = 200) => new Response(body, { status });
const installed = { claude: { version: '2.1.319', models: [], efforts: [] }, codex: { version: '0.156.1', models: [], efforts: [] } };

function lookup(answers: Record<string, () => Response | Promise<Response>>, settings?: string) {
  const urls: string[] = [];
  let now = 1_000_000;
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    for (const [part, make] of Object.entries(answers)) if (String(url).includes(part)) return make();
    throw new Error('offline');
  });
  const readFile = () => {
    if (settings === undefined) throw new Error('ENOENT');
    return settings;
  };
  const l = new AgentLatest({ home: '/h', fetch: fetch as unknown as typeof globalThis.fetch, now: () => now, readFile });
  return { l, urls, fetch, advance: (ms: number) => (now += ms) };
}
const both = { 'claude-code': () => reply('{"version":"2.1.400"}'), 'openai/codex': () => reply('{"version":"0.167.0"}') };

describe('AgentLatest', () => {
  it('reads each CLI newest version over HTTPS and adds it to what is installed', async () => {
    const { l, urls } = lookup(both);
    expect(await l.refresh(false)).toBe(true);
    expect(urls).toEqual(['https://registry.npmjs.org/@anthropic-ai/claude-code/latest', 'https://registry.npmjs.org/@openai/codex/latest']);
    const merged = l.merge(installed);
    expect(merged.claude).toMatchObject({ version: '2.1.319', latest: '2.1.400' });
    expect(merged.codex).toMatchObject({ version: '0.156.1', latest: '0.167.0' });
    expect(installed.claude).not.toHaveProperty('latest'); // the discovery cache is not touched
  });

  it('the same version as installed is still just a field (the screen decides newer or not)', async () => {
    const { l } = lookup({ ...both, 'openai/codex': () => reply('{"version":"0.156.1"}') });
    await l.refresh(false);
    expect(l.merge(installed).codex?.latest).toBe('0.156.1');
  });

  it.each([
    ['a failure', () => Promise.reject(new Error('offline'))],
    ['an error status', () => reply('{}', 500)],
    ['bad JSON', () => reply('<html>')],
    ['no version', () => reply('{"name":"x"}')],
    ['a version that is not one', () => reply('{"version":"latest; rm -rf"}')],
    ['an oversize body', () => reply(`{"version":"9.9.9","pad":"${'x'.repeat(AGENT_LATEST_MAX_BYTES)}"}`)],
  ])('%s leaves the version unknown, quietly', async (_name, answer) => {
    const { l } = lookup({ ...both, 'openai/codex': answer });
    expect(await l.refresh(false)).toBe(true); // claude's changed
    const merged = l.merge(installed);
    expect(merged.codex).not.toHaveProperty('latest');
    expect(merged.claude?.latest).toBe('2.1.400');
  });

  it('a CLI that is not installed gets nothing added', async () => {
    const { l } = lookup(both);
    await l.refresh(false);
    expect(l.merge({ codex: installed.codex })).not.toHaveProperty('claude');
  });

  it('asks again only after an hour, a forced ask skips the hour, and never twice within 30 s', async () => {
    const { l, fetch, advance } = lookup(both);
    await l.refresh(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    advance(AGENT_LATEST_MIN_GAP_MS + 1);
    await l.refresh(false); // cached
    expect(fetch).toHaveBeenCalledTimes(2);
    await l.refresh(true); // forced, past the gap
    expect(fetch).toHaveBeenCalledTimes(4);
    await l.refresh(true); // forced again at once: throttled
    expect(fetch).toHaveBeenCalledTimes(4);
    advance(AGENT_LATEST_TTL_MS);
    await l.refresh(false);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('a failed lookup keeps the last known version and is retried after the gap, not after an hour', async () => {
    let up = true;
    const { l, fetch, advance } = lookup({ ...both, 'openai/codex': () => (up ? reply('{"version":"0.167.0"}') : reply('x', 503)) });
    await l.refresh(false);
    up = false;
    advance(AGENT_LATEST_TTL_MS);
    await l.refresh(false);
    expect(l.merge(installed).codex?.latest).toBe('0.167.0');
    const calls = fetch.mock.calls.length;
    await l.refresh(false); // within the gap of the failed try
    expect(fetch.mock.calls.length).toBe(calls);
    up = true;
    advance(AGENT_LATEST_MIN_GAP_MS + 1);
    await l.refresh(false);
    expect(fetch.mock.calls.length).toBe(calls + 1);
  });

  it('shares one lookup between two asks at the same time', async () => {
    const { l, fetch } = lookup(both);
    await Promise.all([l.refresh(false), l.refresh(false)]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("Claude Code follows the stable dist-tag when its settings pick that channel, codex never does", async () => {
    const { l, urls } = lookup(both, '{"autoUpdatesChannel":"stable"}');
    await l.refresh(false);
    expect(urls).toEqual(['https://registry.npmjs.org/@anthropic-ai/claude-code/stable', 'https://registry.npmjs.org/@openai/codex/latest']);
  });

  it.each([['no settings file', undefined], ['latest', '{"autoUpdatesChannel":"latest"}'], ['unreadable JSON', '{'], ['another value', '{"autoUpdatesChannel":3}']])(
    'Claude Code reads latest with %s',
    async (_n, settings) => {
      const { l, urls } = lookup(both, settings);
      await l.refresh(false);
      expect(urls[0]).toBe('https://registry.npmjs.org/@anthropic-ai/claude-code/latest');
    },
  );
});
