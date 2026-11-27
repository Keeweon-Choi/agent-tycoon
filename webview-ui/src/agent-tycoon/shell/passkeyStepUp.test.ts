/**
 * T-142: on the owner's iPhone the terminal's Face ID button did nothing. iOS opens the passkey
 * sheet only from the tap itself, and the tap first awaited the options fetch. Primed options
 * make the tap call startAuthentication before anything is awaited; a failure primes again.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const startAuthentication = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({ startAuthentication, startRegistration: vi.fn() }));

const calls: string[] = [];
let ceremonies = 0;

beforeEach(() => {
  vi.resetModules();
  calls.length = 0;
  startAuthentication.mockReset();
  startAuthentication.mockResolvedValue({ id: 'assertion' });
  vi.stubGlobal('fetch', async (path: string) => {
    calls.push(path);
    const body = path.endsWith('/verify/options')
      ? { ceremony: `c${String(++ceremonies)}`, options: { challenge: 'x' } }
      : { ok: true };
    return new Response(JSON.stringify(body), { status: 200 });
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A page whose visibility a test flips (the node environment has no document). */
function stubDocument() {
  const page = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('document', page);
  const show = (hidden: boolean) => {
    page.hidden = hidden;
    page.dispatchEvent(new Event('visibilitychange'));
  };
  return show;
}
const optionFetches = () => calls.filter((c) => c.endsWith('/verify/options')).length;

const load = () => import('./shellApi.js');
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it('a primed tap goes to Face ID before anything is awaited', async () => {
  const { passkeyStepUp, primePasskeyStepUp } = await load();
  const stop = primePasskeyStepUp();
  await settle();
  calls.length = 0;

  const tap = passkeyStepUp(); // the click handler's synchronous part
  expect(startAuthentication).toHaveBeenCalledTimes(1);
  expect(calls).toEqual([]);
  await tap;
  expect(calls[0]).toBe('/api/auth/passkeys/verify');
  stop();
});

it('without primed options the tap still fetches them first (a desktop is fine with that)', async () => {
  const { passkeyStepUp } = await load();
  const tap = passkeyStepUp();
  expect(startAuthentication).not.toHaveBeenCalled();
  await tap;
  expect(calls).toEqual(['/api/auth/passkeys/verify/options', '/api/auth/passkeys/verify']);
});

it('a refused sheet throws for the button to show and primes the next tap', async () => {
  const { passkeyStepUp } = await load();
  startAuthentication.mockRejectedValueOnce(
    Object.assign(new Error('not allowed'), { name: 'NotAllowedError' }),
  );
  await expect(passkeyStepUp()).rejects.toThrow('not allowed');
  await settle();

  calls.length = 0;
  const again = passkeyStepUp();
  expect(startAuthentication).toHaveBeenCalledTimes(2);
  await again;
  expect(calls).toEqual(['/api/auth/passkeys/verify']);
});

it('a hidden tab never fetches options and primes once when it is shown', async () => {
  vi.useFakeTimers();
  const { primePasskeyStepUp } = await load();
  const show = stubDocument();
  show(true);
  const stop = primePasskeyStepUp();
  await vi.advanceTimersByTimeAsync(180_000);
  expect(optionFetches()).toBe(0);

  show(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(optionFetches()).toBe(1);
  stop();
});

it('the overlay and the prompt together are one primer: one fetch on mount, one per minute', async () => {
  vi.useFakeTimers();
  const { primePasskeyStepUp } = await load();
  stubDocument();
  const stopA = primePasskeyStepUp();
  const stopB = primePasskeyStepUp();
  await vi.advanceTimersByTimeAsync(0);
  expect(optionFetches()).toBe(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(optionFetches()).toBe(2);

  stopA(); // the prompt is still on screen
  await vi.advanceTimersByTimeAsync(60_000);
  expect(optionFetches()).toBe(3);
  stopB();
  await vi.advanceTimersByTimeAsync(180_000);
  expect(optionFetches()).toBe(3);
});

it('after a successful tap a still-primed page has options in hand for the next tap', async () => {
  const { passkeyStepUp, primePasskeyStepUp } = await load();
  const stop = primePasskeyStepUp();
  await settle();
  await passkeyStepUp();
  await settle();

  calls.length = 0;
  const next = passkeyStepUp();
  expect(startAuthentication).toHaveBeenCalledTimes(2);
  expect(calls).toEqual([]);
  await next;
  stop();
});

it('primed options answer once: the second tap fetches new ones', async () => {
  const { passkeyStepUp, primePasskeyStepUp } = await load();
  primePasskeyStepUp()();
  await settle();
  await passkeyStepUp();

  calls.length = 0;
  await passkeyStepUp();
  expect(calls).toEqual(['/api/auth/passkeys/verify/options', '/api/auth/passkeys/verify']);
});

it('primed options older than 90 s are not used: the tap fetches first', async () => {
  const { passkeyStepUp, primePasskeyStepUp } = await load();
  primePasskeyStepUp()();
  await settle();
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 91_000);

  calls.length = 0;
  const tap = passkeyStepUp();
  expect(startAuthentication).not.toHaveBeenCalled();
  await tap;
  expect(calls).toEqual(['/api/auth/passkeys/verify/options', '/api/auth/passkeys/verify']);
  vi.restoreAllMocks();
});
