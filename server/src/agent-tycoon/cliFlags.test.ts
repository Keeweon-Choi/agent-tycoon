import { describe, expect, it } from 'vitest';

import { CliArgsError, parseArgs } from '../cli.js';

describe('agent-tycoon CLI flags', () => {
  it('requires an explicit shell opt-in', () => {
    expect(parseArgs([]).allowTerminal).toBe(false);
    expect(parseArgs(['--allow-terminal', '--no-terminal']).allowTerminal).toBe(true);
  });
  it('--read-only is on by default', () => {
    expect(parseArgs([])).toMatchObject({ readOnly: true });
    expect(parseArgs([])).not.toHaveProperty('office');
  });
  it('--allow-actions turns read-only off; the last of it and --read-only wins', () => {
    expect(parseArgs(['--allow-actions']).readOnly).toBe(false);
    expect(parseArgs(['--allow-actions', '--read-only']).readOnly).toBe(true);
    expect(parseArgs(['--read-only', '--allow-actions']).readOnly).toBe(false);
  });
  it('--allow-chat turns chat on; it is off by default; an old --chat-attaches is ignored', () => {
    expect(parseArgs([]).chat).toBe(false);
    expect(parseArgs(['--allow-chat']).chat).toBe(true);
    // An existing service unit may still pass it: unknown flags fall through, so the daemon starts.
    expect(parseArgs(['--allow-chat', '--chat-attaches', '2', '--port', '18250'])).toMatchObject({
      chat: true,
      port: 18250,
    });
  });
  it('--engine defaults to auto and accepts on/off only', () => {
    expect(parseArgs([]).engine).toBe('auto');
    expect(parseArgs(['--engine', 'on']).engine).toBe('on');
    expect(parseArgs(['--engine', 'off']).engine).toBe('off');
    expect(() => parseArgs(['--engine', 'yes'])).toThrow(CliArgsError);
    expect(() => parseArgs(['--engine'])).toThrow(CliArgsError);
  });
  it('accepts the retired Tailscale trust flag but records no trusted identity', () => {
    expect(parseArgs(['--trust-tailscale-user', 'owner@localhost'])).toMatchObject({
      legacyTailscaleTrust: true,
    });
  });
});
