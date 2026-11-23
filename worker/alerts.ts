/**
 * Pinna - minimal operational alerting.
 *
 * Without this module every failure (Resend down, Browser Run 429,
 * unhandled 5xx) would end up only in console.log, and the first to notice
 * would be the client. Here errors are counted in KV (the existing RATE_LIMIT
 * namespace) and, when an error kind exceeds a threshold, ONE email goes to
 * the alert recipient (with an anti-flood cooldown). A daily digest in the
 * cron sums up the day.
 *
 * Principles:
 * - fully fail-open: a problem in alerting must NEVER break a legitimate
 *   request (everything is in a try/catch that swallows errors).
 * - no dependency on D1: only KV + Resend (via sendEmail in notify.ts).
 * - the recipient is env.ALERT_EMAIL and nothing else: no hardcoded
 *   fallback, otherwise every instance installed by someone else would send
 *   its alerts to that address. Without ALERT_EMAIL the counters remain
 *   (readable in the logs and in KV) but no email is sent.
 */
import type { Env } from './types';
import { sendEmail } from './notify';
import { alertRecipient } from './config';

/** Tracked error kinds. */
export type ErrKind = 'resend' | 'notify' | 'shot' | 'proxy' | 'unhandled' | 'email-quota';

const ALL_KINDS: ErrKind[] = ['resend', 'notify', 'shot', 'proxy', 'unhandled', 'email-quota'];

/**
 * Per-kind rules that differ from the default. 'email-quota': an email cap
 * reached (per address or daily, see notify.ts) alerts on the first
 * occurrence, at most once an hour; during the cooldown not even the counter
 * is written, so whoever keeps pushing past the cap does not consume KV
 * writes (1,000 a day on the free plan).
 */
const KIND_RULES: Partial<Record<ErrKind, { threshold: number; cooldown: number; quietInCooldown: boolean }>> = {
  'email-quota': { threshold: 1, cooldown: 3600, quietInCooldown: true },
};

function alertText(kind: ErrKind, cur: number, cooldown: number): { subject: string; html: string } {
  const foot = `<p style="color:#94a3b8;font-size:12px">Automatic alert, at most one every ${Math.round(cooldown / 3600)}h. Full digest at 03:00 UTC.</p>`;
  if (kind === 'email-quota') {
    return {
      subject: '[Pinna] email cap reached, sending paused',
      html:
        '<p>Pinna has stopped sending some emails: the per-address cap (24 sign-in emails in 24 hours) '
        + 'or the daily cap on all emails (PINNA_EMAIL_DAILY_CAP, default 80) was reached. The cap keeps the Resend quota from running out.</p>'
        + '<p>Whoever requests access still gets the normal response. If this is not expected traffic, check the logs '
        + '(wrangler tail pinna) to see where the requests come from.</p>' + foot,
    };
  }
  return {
    subject: `[Pinna] "${kind}" errors (${cur} in the last few hours)`,
    html:
      `<p>Pinna recorded <b>${cur}</b> errors of kind <b>${kind}</b> in the last few hours.</p>`
      + `<p>Check the Worker logs (wrangler tail pinna) or the Cloudflare dashboard.</p>` + foot,
  };
}

// Alert threshold per kind within the counter window. A small spike is enough
// to let us know; the cooldown prevents flooding.
const ALERT_THRESHOLD = 3;
// Counter TTL: 25h, so the daily digest (03:00 cron) sees the whole day.
// Every increment renews the TTL: a stream of errors keeps the counter alive,
// and it deletes itself once the errors stop.
const COUNTER_TTL = 90_000;
// Cooldown between two alerts of the same kind: 6h.
const ALERT_COOLDOWN = 21_600;
/**
 * Cap on counter writes: without it every failed /shot (and every 5xx, which
 * anyone can trigger) would write to KV, and the free plan allows 1,000 writes
 * a day. Once at COUNTER_CAP the counter stops increasing (shown in the digest
 * as "20+") and is only read; the alert still goes out once per cooldown.
 * Maximum writes: COUNTER_CAP per kind every 25 hours plus one per alert.
 */
export const COUNTER_CAP = 20;


/**
 * Records an error: increments the counter in KV and, if it exceeds the
 * threshold and no cooldown is active, sends an alert. ONLY for "external"
 * errors (Resend/shot/5xx spikes). Fail-open: any problem here is swallowed.
 *
 * `alert=false` (used by the notify branch, so as not to attempt an alert email
 * when Resend itself is down: it only increments, the digest will show it).
 */
export async function recordError(env: Env, kind: ErrKind, alert = true): Promise<void> {
  try {
    const kv = env.RATE_LIMIT;
    const rule = KIND_RULES[kind];
    const threshold = rule?.threshold ?? ALERT_THRESHOLD;
    const cooldown = rule?.cooldown ?? ALERT_COOLDOWN;
    const cdKey = 'alertcd:' + kind;
    if (rule?.quietInCooldown && (await kv.get(cdKey))) return;
    const key = 'err:' + kind;
    const prev = parseInt((await kv.get(key)) || '0', 10);
    const cur = Math.min(prev + 1, COUNTER_CAP);
    if (prev < COUNTER_CAP) await kv.put(key, String(cur), { expirationTtl: COUNTER_TTL });
    if (!alert || cur < threshold) return;
    const to = alertRecipient(env);
    if (!to) return; // no recipient configured: count only
    if (await kv.get(cdKey)) return; // alert already sent recently
    await kv.put(cdKey, '1', { expirationTtl: cooldown });
    const { subject, html } = alertText(kind, cur, cooldown);
    // Alerts bypass the email cap (they must get through precisely when it triggers).
    await sendEmail(env, to, subject, html, { bypassQuota: true });
  } catch {
    // fail-open: alerting must never break the main flow.
  }
}

/**
 * Daily digest (called by the scheduled cron after purgeRetention).
 * Reads the err:* counters and, if any is > 0, sends a summary. It does not
 * reset the counters: they expire on their own via the TTL.
 */
export async function sendErrorDigest(env: Env): Promise<void> {
  try {
    const to = alertRecipient(env);
    if (!to) return;
    const kv = env.RATE_LIMIT;
    const lines: string[] = [];
    for (const k of ALL_KINDS) {
      const n = parseInt((await kv.get('err:' + k)) || '0', 10);
      if (n > 0) lines.push(`${k}: ${n}${n >= COUNTER_CAP ? '+' : ''}`);
    }
    if (!lines.length) return; // clean day, no noise
    await sendEmail(
      env,
      to,
      '[Pinna] daily error digest',
      `<p>Pinna error summary (window ~24h):</p><ul>`
        + lines.map((l) => `<li>${l}</li>`).join('')
        + `</ul><p style="color:#94a3b8;font-size:12px">Automatic digest, sent at 03:00 UTC.</p>`,
      { bypassQuota: true },
    );
  } catch {
    // fail-open.
  }
}
