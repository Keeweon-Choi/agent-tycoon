/**
 * Kept as a compatibility export while standalone moves to HttpOnly cookies.
 * Browser code must never recover the long-lived server token from a URL.
 */
export const serverToken: string | null = null;
