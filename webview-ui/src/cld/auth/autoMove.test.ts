import { describe, expect, it } from 'vitest';

import { autoMoveTarget } from './autoMove.js';

const OUT = 'https://outside.example';
const lan = { hostname: 'home.example', origin: 'https://home.example', protocol: 'https:' };
const me = { autoMoveTo: OUT, deviceId: 'dev' };

describe('autoMoveTarget (O5)', () => {
  it('a keyed browser tab elsewhere moves to the address the server named', () => {
    expect(autoMoveTarget(me, lan, false, null)).toBe(OUT);
    expect(autoMoveTarget(me, lan, false, 'https://older.example')).toBe(OUT);
  });

  it('stays: no address, no key, an installed app, the host’s own page, already there, already tried', () => {
    expect(autoMoveTarget({ ...me, autoMoveTo: null }, lan, false, null)).toBeNull();
    expect(autoMoveTarget({ ...me, deviceId: null }, lan, false, null)).toBeNull();
    expect(autoMoveTarget(me, lan, true, null)).toBeNull();
    expect(autoMoveTarget(me, { hostname: 'localhost', origin: 'https://localhost:18240', protocol: 'https:' }, false, null)).toBeNull();
    expect(autoMoveTarget(me, { hostname: '127.0.0.1', origin: 'https://127.0.0.1:18240', protocol: 'https:' }, false, null)).toBeNull();
    expect(autoMoveTarget(me, { hostname: 'outside.example', origin: OUT, protocol: 'https:' }, false, null)).toBeNull();
    expect(autoMoveTarget(me, lan, false, OUT)).toBeNull();
    expect(autoMoveTarget({ ...me, autoMoveTo: 'not a url' }, lan, false, null)).toBeNull();
  });

  it('only from an https page: a plain-http LAN page never moves, whatever it claims to hold', () => {
    const http = { hostname: '192.168.0.5', origin: 'http://192.168.0.5:18240', protocol: 'http:' };
    expect(autoMoveTarget(me, http, false, null)).toBeNull();
  });
});
