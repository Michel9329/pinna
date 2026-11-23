/**
 * Pinna - instance configuration.
 *
 * The public address and the alert recipient come from environment
 * variables, never from the code: otherwise every installed instance would
 * send its alerts to a hardcoded address, and the links and logo in its
 * emails would point to someone else's domain.
 */
import type { Env } from './types';

/**
 * Public origin of Pinna (scheme + host + port, no trailing slash):
 * PINNA_PUBLIC_URL if set and valid, otherwise the request origin.
 * Empty string if neither is available (e.g. in the cron, with no request).
 */
export function publicOrigin(env: Env, requestUrl?: string): string {
  const fixed = (env.PINNA_PUBLIC_URL || '').trim();
  if (fixed) {
    try {
      const u = new URL(fixed);
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.origin;
    } catch {
      /* invalid value: fall back to the request origin */
    }
    console.error('[pinna] PINNA_PUBLIC_URL is invalid, using the request origin');
  }
  if (!requestUrl) return '';
  try {
    return new URL(requestUrl).origin;
  } catch {
    return '';
  }
}

/** Alert recipient: ALERT_EMAIL, or nobody (alerts are not sent). */
export function alertRecipient(env: Env): string | null {
  const to = (env.ALERT_EMAIL || '').trim();
  return to.includes('@') ? to : null;
}

/**
 * Minimum length of SESSION_SECRET and ADMIN_KEY. A short key (e.g.
 * "changeme") can be guessed offline from a token or an attempt: with
 * SESSION_SECRET below the minimum the API answers 503, with ADMIN_KEY
 * below the minimum /entra and /api/summary accept no key at all.
 * Generate them with: openssl rand -base64 48
 */
export const MIN_SECRET_LEN = 32;

export function sessionSecretOk(env: Env): boolean {
  return typeof env.SESSION_SECRET === 'string' && env.SESSION_SECRET.length >= MIN_SECRET_LEN;
}

/** ADMIN_KEY usable: set and at least MIN_SECRET_LEN long. */
export function adminKeyOk(env: Env): boolean {
  return typeof env.ADMIN_KEY === 'string' && env.ADMIN_KEY.length >= MIN_SECRET_LEN;
}

const warned = new Set<string>();
/** A configuration error is logged once per isolate, not on every request. */
export function warnConfigOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.error('[pinna] configuration: ' + msg);
}
