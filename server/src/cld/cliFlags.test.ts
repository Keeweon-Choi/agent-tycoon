import { describe, expect, it } from 'vitest';

import { CliArgsError, parseArgs } from '../cli.js';

describe('cld-gui CLI flags', () => {
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
  it('--allow-chat turns chat on; it is off by default; --chat-attaches takes 1-10', () => {
    expect(parseArgs([]).chat).toBe(false);
    expect(parseArgs(['--allow-chat']).chat).toBe(true);
    expect(parseArgs([]).chatAttaches).toBeUndefined();
    expect(parseArgs(['--chat-attaches', '2']).chatAttaches).toBe(2);
    for (const bad of ['0', '11', 'x', '1.5']) {
      expect(() => parseArgs(['--chat-attaches', bad])).toThrow(CliArgsError);
    }
    expect(() => parseArgs(['--chat-attaches'])).toThrow(CliArgsError);
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
