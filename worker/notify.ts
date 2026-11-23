/**
 * Pinna - email notifications.
 * On every comment event, notifies the other side of the project via Resend.
 * Routing: a client comment notifies the admins; a comment or action by an
 * admin notifies the project's clients. Anyone who muted gets nothing.
 */
import type { Env, Project, User, Comment } from './types';
import * as db from './db';
// notify <-> alerts import cycle: safe because these are hoisted functions
// called at runtime (not at module init). recordError('notify', alert=false)
// here avoids retrying an alert email when Resend itself is down.
import { recordError } from './alerts';
import { consumeSliding, refundSliding } from './rate-limit';
import { isListedAdmin } from './admins';

export type NotifyKind = 'new' | 'reply' | 'resolved' | 'reopened';

/** After an email, stay quiet for this interval: not one email per comment. */
const NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;
const FONT =
  "'Poppins',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '"' ? '&quot;' : '&#39;',
  );
}

function actorName(u: User): string {
  if (u.name && u.name.trim()) return u.name.trim();
  if (u.role === 'admin') return 'Admin';
  // Without a name set, the email still identifies WHICH client wrote
  // (better than a generic "The client", which made the notification ambiguous).
  return u.email || 'The client';
}

function subjectFor(kind: NotifyKind, project: Project): string {
  const p = project.name;
  if (kind === 'reply') return 'New reply on ' + p;
  if (kind === 'resolved') return 'Comment marked done on ' + p;
  if (kind === 'reopened') return 'Comment reopened on ' + p;
  return 'New comment on ' + p;
}

function lineFor(kind: NotifyKind, actor: string): string {
  if (kind === 'reply') return actor + ' replied to a comment.';
  if (kind === 'resolved') return actor + ' marked a comment as done.';
  if (kind === 'reopened') return actor + ' reopened a comment.';
  return actor + ' left a new comment.';
}

/** HTML of the notification email, inline styles for email clients. */
export function notifyHtml(
  recipientName: string | null,
  projectName: string,
  line: string,
  body: string,
  link: string,
): string {
  // Logo from the same origin as the link (never a hardcoded domain).
  let origin = '';
  try {
    origin = new URL(link).origin;
  } catch {
    origin = '';
  }
  // The name comes from the invite (written by whoever invites): escaped, it
  // must not be able to inject markup into the email.
  const greeting =
    recipientName && recipientName.trim() ? 'Hi ' + escapeHtml(recipientName.trim()) + ',' : 'Hi,';
  // Prominent "site" block in the BODY: you always know which site this is
  // about, even if the subject is truncated (mobile) or several projects are under review.
  const site =
    '<p style="margin:16px 0 0;font-size:11.5px;font-weight:700;letter-spacing:.05em;' +
    'text-transform:uppercase;color:#94a3b8;">Site under review</p>' +
    '<p style="margin:2px 0 0;font-size:16px;font-weight:650;color:#0f172a;">' +
    escapeHtml(projectName) +
    '</p>';
  const quote = body
    ? '<p style="margin:14px 0 0;padding:12px 14px;background:#f1f5f9;border-radius:10px;' +
      'font-size:14px;line-height:1.55;color:#334155;">' + escapeHtml(body) + '</p>'
    : '';
  return [
    '<!doctype html><html><body style="margin:0;background:#f4f6fa;font-family:', FONT, ';">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ',
    'style="background:#f4f6fa;padding:64px 16px;"><tr><td align="center">',
    '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:480px;',
    'background:#ffffff;border:1px solid #e6eaf0;border-radius:18px;">',
    '<tr><td style="padding:26px 34px 4px 20px;"><img src="', origin,
    '/pinna-wordmark-email.png" alt="Pinna" width="132" style="display:block;border:0;" /></td></tr>',
    '<tr><td style="padding:14px 34px 4px;font-family:', FONT, ';">',
    '<p style="margin:0;font-size:16px;color:#1e293b;">', greeting, '</p>',
    site,
    '<p style="margin:10px 0 0;font-size:15px;line-height:1.6;color:#475569;">',
    escapeHtml(line), '</p>', quote, '</td></tr>',
    '<tr><td style="padding:22px 34px 30px;">',
    '<a href="', link, '" style="display:inline-block;font-family:', FONT,
    ';background:#0066cc;color:#ffffff;text-decoration:none;padding:13px 30px;',
    'border-radius:999px;font-size:15px;font-weight:600;">Open Pinna</a></td></tr>',
    '<tr><td style="padding:16px 34px 24px;border-top:1px solid #eef1f5;font-family:', FONT, ';">',
    '<p style="margin:0;font-size:12px;line-height:1.6;color:#94a3b8;">',
    'You are receiving this email because you follow a site review on Pinna.</p></td></tr>',
    '</table></td></tr></table></body></html>',
  ].join('');
}

/**
 * Resend quota: the Resend free plan allows about 100 emails a day, and the
 * same key serves sign-in, notifications and alerts. Without a global cap, a
 * few known registered emails would be enough to burn the quota on sign-in
 * emails: once it ran out, no more sign-ins or notifications for anyone. Hence a
 * GLOBAL cap on the last 24 hours (sign-in + notifications, sliding counter on
 * rate_limits), 80 by default, configurable with PINNA_EMAIL_DAILY_CAP. Alerts
 * do not count and are not stopped (at most one an hour goes out for the
 * cap): they fit in the margin.
 */
export const EMAIL_DAILY_CAP_DEFAULT = 80;

export function emailDailyCap(env: Env): number {
  const n = parseInt(env.PINNA_EMAIL_DAILY_CAP || '', 10);
  return Number.isFinite(n) && n > 0 ? n : EMAIL_DAILY_CAP_DEFAULT;
}

/**
 * Share of the global cap reserved for admin SIGN-IN emails: otherwise 8
 * known client emails would be enough to exhaust the cap, after which not
 * even the admin would receive a code. Other emails (client sign-in,
 * notifications) stop at cap - reserve; only admin sign-in can reach the full
 * cap. A quarter of the cap (20 with the default 80): with a new code at most
 * every 90 minutes per address (see /auth/request) an admin uses at most
 * about twenty a day.
 */
export function adminEmailReserve(env: Env): number {
  return Math.floor(emailDailyCap(env) / 4);
}

/**
 * Limits on sign-in emails (/auth/request), here for the tests: per email and
 * IP per hour, per email per hour, per email in the last 24 hours.
 * AUTH_EMAIL_PER_DAY is 24: while a code is still valid no new email goes
 * out, so a user who keeps asking triggers at most one every 90 minutes (16 a
 * day) plus those sent after burning a code with 5 attempts (at most 4 a day,
 * OTP_FAIL_PER_EMAIL 20). With 10, the cap would run out in about 15 hours and
 * the client would be left without a code for the rest of the day; with 24 a
 * user who keeps asking does not reach it.
 */
export const AUTH_EMAIL_IP_PER_HOUR = 3;
export const AUTH_EMAIL_PER_HOUR = 10;
export const AUTH_EMAIL_PER_DAY = 24;

/**
 * Reserves a slot in the daily quota. 'over' = cap reached (do not send,
 * answer as if it had been sent, the caller raises an alert with
 * recordError(env, 'email-quota')); 'unavailable' = counter failure
 * (fail-closed: do not send). `adminLogin`: an admin sign-in email, which
 * may also use the reserve (adminEmailReserve).
 */
export async function reserveEmailQuota(
  env: Env,
  opts: { adminLogin?: boolean } = {},
): Promise<'ok' | 'over' | 'unavailable'> {
  return (await reserveEmailSlot(env, opts)).result;
}

/** Like reserveEmailQuota, also returning the bucket used (for releaseEmailSlot). */
export async function reserveEmailSlot(
  env: Env,
  opts: { adminLogin?: boolean } = {},
): Promise<{ result: 'ok' | 'over' | 'unavailable'; win: number }> {
  const cap = emailDailyCap(env);
  const limit = opts.adminLogin ? cap : cap - adminEmailReserve(env);
  const r = await consumeSliding(env.DB, 'email-all', 'all', limit, 86400, { fail: 'closed' });
  if (r.allowed) return { result: 'ok', win: r.win };
  return { result: r.unavailable ? 'unavailable' : 'over', win: r.win };
}

/** Gives back the slot taken by reserveEmailSlot: the email was not sent. */
export async function releaseEmailSlot(env: Env, win: number): Promise<void> {
  await refundSliding(env.DB, 'email-all', 'all', win);
}

// Exported: reused by alerts.ts for operational alert emails. Generic,
// silently skips without RESEND_API_KEY.
// `bypassQuota`: only for alerts (see reserveEmailQuota).
export async function sendEmail(
  env: Env,
  to: string,
  subject: string,
  html: string,
  opts: { bypassQuota?: boolean } = {},
): Promise<void> {
  if (!env.RESEND_API_KEY) return;
  if (!opts.bypassQuota) {
    const q = await reserveEmailQuota(env);
    if (q !== 'ok') {
      console.log('[pinna] email not sent: daily quota', q === 'over' ? 'reached' : 'cannot be checked');
      if (q === 'over') await recordError(env, 'email-quota');
      return;
    }
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.PINNA_FROM_EMAIL || 'Pinna <onboarding@resend.dev>',
        to,
        subject,
        html,
      }),
    });
    if (!res.ok) {
      console.log('[pinna] notify send failed:', res.status, await res.text());
      // Count the failure (alert=false: if Resend is down there is no point in
      // sending an alert email through the same broken channel; the digest shows it).
      await recordError(env, 'notify', false);
    }
  } catch (e) {
    console.log('[pinna] notify send error:', (e as Error).message);
    await recordError(env, 'notify', false);
  }
}

/**
 * Notifies the other side of the project about a comment event. `origin`:
 * public address of Pinna for the email link (config.publicOrigin).
 */
export async function notifyEvent(
  env: Env,
  project: Project,
  actor: User,
  comment: Comment,
  kind: NotifyKind,
  origin: string,
): Promise<void> {
  try {
    // Author's role ON THIS project (a collab invited here as a client writes
    // as a client): it decides whom to notify.
    const actorRole = (await db.projectRole(env.DB, actor, project.id)) ?? actor.role;
    const recipients = await db.listNotifyRecipients(env.DB, project.id, actorRole);
    if (!recipients.length) return;
    const subject = subjectFor(kind, project);
    const line = lineFor(kind, actorName(actor));
    const link = origin + '/p/' + project.slug;
    for (const r of recipients) {
      if (r.id === actor.id) continue;
      // Admin in the DB but no longer in ADMIN_EMAILS (not yet demoted): no
      // email. Without a valid list the DB role applies (admins.ts).
      if (r.role === 'admin' && !(await isListedAdmin(env, r))) continue;
      if (await db.isMuted(env.DB, r.id)) continue;
      // Anti-flood: a single email per project every NOTIFY_COOLDOWN_MS.
      if (!(await db.shouldNotify(env.DB, r.id, project.id, NOTIFY_COOLDOWN_MS))) continue;
      await sendEmail(env, r.email, subject, notifyHtml(r.name, project.name, line, comment.body, link));
    }
  } catch (e) {
    console.log('[pinna] notify error:', (e as Error).message);
  }
}
