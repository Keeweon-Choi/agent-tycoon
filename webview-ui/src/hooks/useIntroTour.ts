import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import type { HooksConsentRequest } from '../../../core/src/messages.js';
import { chooseBypass, useBypass } from '../cld/bypass.js';
import { BYPASS_ANSWER_TIMEOUT_MS } from '../constants.js';
import { transport } from '../transport/index.js';
import type { BypassStatus, ConsentChoice } from './introTourState.js';
import { INTRO_TOUR_IDLE, reduceIntroTour } from './introTourState.js';

/**
 * Everything the App needs to run the Intro, off the wire state useExtensionMessages already tracks. The semantics —
 * which asks survive being mooted, when a hooksStatus is this tour's verdict — live in the pure reducer
 * (introTourState.ts); this only turns props into events and choices into sends. The verdict is driven by
 * `hooksStatusSeq` per provider, not `hooksInstalled`: a FAILED install re-reports the `false` already held, so only
 * the message's ARRIVAL says the server answered, and another provider's status never settles this tour.
 */
export function useIntroTour(args: {
  consentRequest: HooksConsentRequest | null;
  hooksInstalled: Record<string, boolean>;
  hooksStatusSeq: Record<string, number>;
  dismissConsentRequest: (providerId: string | null) => void;
  /** O4: the skip-permissions question is unanswered and this viewer may answer it (not read-only). */
  bypassUnanswered: boolean;
}): {
  /** The ask to render, or null while no tour should be up. */
  intro: HooksConsentRequest | null;
  /** O4: the tour carries the skip-permissions and remote steps. A tour is up when this or `intro` is set. */
  onboarding: boolean;
  bypass: BypassStatus;
  /** A bypass-step button: saves the choice (see chooseBypass). */
  onBypass: (allow: boolean) => void;
  /** The closing step's verdict: the install this tour asked for failed. */
  installFailed: boolean;
  /** An install was sent and its verdict hasn't arrived yet: the consent step
   *  holds with its buttons disabled until this falls, so the closing step
   *  only ever renders with a verdict — never one it does not have. */
  installPending: boolean;
  /** A consent-step button click: sends the choice, arms the verdict wait. */
  onChoice: (choice: ConsentChoice) => void;
  /** Every way the tour ends. Sends NOTHING — an unanswered ask must return
   *  on the next open. */
  onClose: () => void;
} {
  const [state, dispatch] = useReducer(reduceIntroTour, INTRO_TOUR_IDLE);
  // Closing the tour without answering changes nothing and the question returns next open (a reload), not at once.
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    dispatch({ kind: 'onboardingOpen', open: args.bypassUnanswered && !dismissed });
  }, [args.bypassUnanswered, dismissed]);

  // A choice with no confirmation (the daemon refused, the connection dropped) gives the buttons back.
  useEffect(() => {
    if (state.bypass !== 'waiting') return;
    const timer = window.setTimeout(() => dispatch({ kind: 'bypassRefused' }), BYPASS_ANSWER_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [state.bypass]);

  // The daemon refused the choice (read-only, step-up not proved, a failed write): the buttons come back at once.
  const { error: bypassError } = useBypass();
  useEffect(() => {
    if (bypassError && state.bypass === 'waiting') dispatch({ kind: 'bypassRefused' });
  }, [bypassError, state.bypass]);

  const onBypass = useCallback((allow: boolean) => {
    dispatch({ kind: 'bypassSent' });
    chooseBypass(allow ? 'bypass' : 'ask');
  }, []);

  // Fan the per-provider seq map out into one statusArrived event per bumped
  // provider. The previous counts live in a ref: the dispatch must fire once
  // per ARRIVAL, and only for the provider whose seq moved.
  const prevSeqRef = useRef<Record<string, number>>({});
  useEffect(() => {
    for (const [providerId, seq] of Object.entries(args.hooksStatusSeq)) {
      if (seq !== (prevSeqRef.current[providerId] ?? 0)) {
        dispatch({
          kind: 'statusArrived',
          providerId,
          installed: args.hooksInstalled[providerId] === true,
        });
      }
    }
    prevSeqRef.current = args.hooksStatusSeq;
    // hooksInstalled is read on the seq bump, deliberately not a dependency:
    // only the ARRIVAL of a hooksStatus may settle the verdict (see above).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [args.hooksStatusSeq]);

  // The snapshot's provider is what a choice answers about — captured in a
  // ref so onChoice stays referentially stable across the per-frame renders.
  const providerIdRef = useRef<string | null>(null);
  providerIdRef.current = state.intro?.providerId ?? providerIdRef.current;

  const onChoice = useCallback((choice: ConsentChoice) => {
    const providerId = providerIdRef.current;
    if (!providerId) return; // no ask on screen: nothing to answer about
    dispatch({ kind: 'choiceSent', choice });
    transport.send({ type: 'hooksConsentResponse', providerId, choice });
  }, []);

  const { dismissConsentRequest } = args;
  const onClose = useCallback(() => {
    dispatch({ kind: 'closed' });
    setDismissed(true);
    // Dismiss the ask THIS tour was about (the snapshot's provider) so a
    // queued ask for another provider is never dropped in its place.
    // (None for an onboarding-only tour: there is no ask of its own to remove, and a null would drop the queue head.)
    if (providerIdRef.current) dismissConsentRequest(providerIdRef.current);
  }, [dismissConsentRequest]);

  return {
    intro: state.intro,
    onboarding: state.onboarding,
    bypass: state.bypass,
    onBypass,
    installFailed: state.installFailed,
    installPending: state.awaitingOutcome,
    onChoice,
    onClose,
  };
}
