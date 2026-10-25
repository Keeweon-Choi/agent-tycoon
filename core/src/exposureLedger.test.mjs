import assert from 'node:assert/strict';
import test from 'node:test';

import { addEntry, emptyLedger, isOurTunnel, parseLedger, portproxyRemoveCommands, procStartTime, removeEntry, tailscaleOffArgs, unwantedEntries } from './exposureLedger.mjs';

const serve = { kind: 'tailscale', host: 'a.ts.net', port: 18240, funnel: false, by: 'daemon', at: 1 };
const funnel = { ...serve, funnel: true, by: 'installer' };
const tunnel = { kind: 'tunnel', url: 'https://x.trycloudflare.com/s/', pid: 4242, by: 'daemon', at: 2 };
const proxy = { kind: 'portproxy', externalPort: 443, directPort: 18443, by: 'user', at: 3 };

test('no file is an empty ledger; a broken, newer or unknown one is null (never read as empty)', () => {
  assert.deepEqual(parseLedger(null), emptyLedger());
  assert.deepEqual(parseLedger(JSON.stringify({ v: 1, entries: [serve, proxy] })).entries, [serve, proxy]);
  assert.equal(parseLedger('{"v":1,"entries":[{"kind":"tail'), null);
  assert.equal(parseLedger(JSON.stringify({ v: 2, entries: [funnel] })), null);
  assert.equal(parseLedger(JSON.stringify({ v: 1, entries: [serve, { kind: 'upnp', port: 443 }] })), null);
  assert.equal(parseLedger('null'), null);
});

test('one entry per slot: a new tailscale set-up replaces the old one; remove drops it', () => {
  const ledger = addEntry(addEntry(addEntry(emptyLedger(), serve), proxy), funnel);
  assert.deepEqual(ledger.entries, [proxy, funnel]);
  assert.deepEqual(removeEntry(ledger, funnel).entries, [proxy]);
});

test('what a state does not want', () => {
  const ledger = { v: 1, entries: [serve, tunnel, proxy] };
  assert.deepEqual(unwantedEntries(ledger, { connector: 'tailscale', funnel: false, tunnel: true }), [proxy]);
  assert.deepEqual(unwantedEntries(ledger, { connector: 'tailscale', funnel: true }), [serve, tunnel, proxy]);
  assert.deepEqual(unwantedEntries(ledger, { connector: 'direct' }), [serve, tunnel]);
  assert.deepEqual(unwantedEntries(ledger, { connector: 'local' }), [serve, tunnel, proxy]);
  assert.deepEqual(unwantedEntries(ledger, null), ledger.entries);
});

test('the undo commands', () => {
  assert.deepEqual(tailscaleOffArgs(serve), ['serve', '--https=443', 'off']);
  assert.deepEqual(tailscaleOffArgs(funnel), ['funnel', '--https=443', 'off']);
  assert.match(portproxyRemoveCommands()[0], /portproxy delete v4tov4 listenaddress=0\.0\.0\.0 listenport=443/);
});

/** A /proc/<pid>/stat line whose command name has a space and a ')', start time 987654. */
const stat = (start) => `4242 (cloud flared)) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 9 0 ${start} 123456 789 18446744073709551615`;
const ours = 'cloudflared\0tunnel\0--no-autoupdate\0--url\0http://127.0.0.1:40001\0';

test('procStartTime reads field 22, counting from the last parenthesis', () => {
  assert.equal(procStartTime(stat(987654)), '987654');
  assert.equal(procStartTime(null), null);
  assert.equal(procStartTime('garbage'), null);
});

test('a recorded tunnel pid is ours only with the same start time and exactly our argv', () => {
  const entry = { ...tunnel, localPort: 40001, startTime: '987654' };
  assert.equal(isOurTunnel(entry, { stat: stat(987654), cmdline: ours }), true);
  assert.equal(isOurTunnel(entry, { stat: stat(111), cmdline: ours }), false, 'reused pid');
  assert.equal(isOurTunnel(entry, { stat: stat(987654), cmdline: 'cloudflared\0tunnel\0run\0my-named-tunnel\0' }), false, 'other argv');
  assert.equal(isOurTunnel(entry, { stat: stat(987654), cmdline: ours.replace('40001', '40002') }), false, 'another port');
  assert.equal(isOurTunnel(entry, { stat: null, cmdline: null }), false, 'gone');
  assert.equal(isOurTunnel(tunnel, { stat: stat(987654), cmdline: ours }), false, 'older entry without a start time');
});
