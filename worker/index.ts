/**
 * Pinna - API Worker
 * Cloudflare Worker + Hono + D1. Auth: magic link + signed cookie sessions.
 * The widget (inside the iframe, on another origin) authenticates with a
 * short-lived signed widget-token in the Authorization: Bearer header (never in the URL).
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import type { Env, User, Attachment } from './types';
import * as db from './db';
import {
  newCommentSchema,
  inviteSchema,
  projectSchema,
  commentPatchSchema,
  verifyCodeSchema,
  firstError,
  COMMENTS_PER_USER_DAY,
  COMMENTS_PER_PROJECT_DAY,
  PROJECT_COMMENT_CHARS,
} from './schemas';
import {
  notifyEvent,
  reserveEmailSlot,
  releaseEmailSlot,
  AUTH_EMAIL_IP_PER_HOUR,
  AUTH_EMAIL_PER_HOUR,
  AUTH_EMAIL_PER_DAY,
} from './notify';
import { recordError, sendErrorDigest } from './alerts';
import { publicOrigin, sessionSecretOk, adminKeyOk, warnConfigOnce, MIN_SECRET_LEN } from './config';
import { applyAdminList, loginRole, syncAdmins, isListedAdmin, canPromoteListed, adminListState } from './admins';
import { checkStagingUrl, hostVerdict } from './dns-guard';
import { deleteR2InBatches } from './r2';
import {
  signTyped,
  verifyTyped,
  sha256hex,
  randomToken,
  generateOtp,
  makeSessionCookie,
  clearSessionCookie,
  readSession,
  sendMagicEmail,
  magicEmailHtml,
  safeEqual,
  makeCsrfCookie,
  clearCsrfCookie,
  adminEmails,
  isDevMode,
  isRevoked,
  signAttachmentUrl,
  clearLegacyCookies,
  readCookie,
  CSRF_COOKIE,
} from './auth';
import type { AttachmentUrlToken } from './auth';
import {
  consumeRateLimit,
  consumeSliding,
  refundRateLimit,
  refundSliding,
  applyRateLimit,
  getClientIp,
  getAnonIp,
  peekRateLimit,
  anonLimit,
  purgeRateLimits,
  userShield,
} from './rate-limit';
import {
  validateUpload,
  isInlineSafe,
  PROJECT_QUOTA_BYTES,
  PROJECT_MAX_ATTACHMENTS,
  USER_DAILY_UPLOADS,
  USER_DAILY_UPLOAD_BYTES,
  MAX_UPLOAD_FILE,
  MAX_UPLOAD_BODY,
  declaredLength,
  safeFilename,
  nameForType,
} from './upload-guard';
import { handleProxy, makeProxyToken, isBlockedHost } from './proxy';
import {
  MAX_SHOT_BODY,
  MAX_SHOT_HTML,
  guardShotPage,
  prepareShotHtml,
  shotAssetOrigins,
  SHOT_PER_USER_MIN,
  SHOT_PER_USER_DAY,
  SHOT_PER_PROJECT_DAY,
  SHOT_NAV_TIMEOUT_MS,
  SHOT_TOTAL_TIMEOUT_MS,
  SHOT_SETTLE_MS,
  withDeadline,
} from './shot-guard';
import type { ShotPageLike } from './shot-guard';
import puppeteer from '@cloudflare/puppeteer';

const app = new Hono<{ Bindings: Env }>();

// Global handler for unhandled errors. Without it an uncaught throw gives an
// opaque 500 that nobody notices. The 5xx is counted for the alert (without
// exposing the error to the client) and the response is a clean 500.
app.onError((err, c) => {
  console.error('[pinna] unhandled:', err.message);
  try { c.executionCtx.waitUntil(recordError(c.env, 'unhandled')); } catch { /* fail-open */ }
  return c.json({ error: 'internal error' }, 500);
});

// Secret check: with SESSION_SECRET missing or shorter than MIN_SECRET_LEN
// characters, no route that signs or reads tokens responds (503), so an
// instance configured with "changeme" does not half-start. Static assets are
// still served.
app.use('*', async (c, next) => {
  if (!sessionSecretOk(c.env)) {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/api/') || path === '/entra' || path === '/_proxy') {
      warnConfigOnce('session-secret', 'SESSION_SECRET missing or shorter than ' + MIN_SECRET_LEN + ' characters: API disabled');
      return c.json({ error: 'invalid server configuration' }, 503);
    }
  }
  await next();
});

// Hardening: CORS split.
// - Widget endpoints (comments + attachments with the widget-token in Authorization) run inside
//   the client's staging iframe, arbitrary origin -> open CORS.
// - Everything else (auth, projects, summary, notifications) is called
//   by the same-origin Pinna SPA: no CORS needed, the browser is left to block
//   cross-origin requests (defense-in-depth).
const widgetCors = cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
});
app.use('/api/projects/:slug/comments', widgetCors);
app.use('/api/projects/:slug/attachments', widgetCors);
app.use('/api/projects/:slug/shot', widgetCors);
app.use('/api/comments/:id', widgetCors);
app.use('/api/attachments/:id', widgetCors);

// Hardening: complete global security headers.
// Three layers:
//   1. global '*' = HSTS + Permissions-Policy (valid everywhere, assets included)
//   2. /api/* = nosniff + Referrer-Policy + strict CSP 'none' + X-Frame-Options DENY
//   3. SPA HTML pages (catch-all) = permissive CSP for the Vue app + staging frame
app.use('*', async (c, next) => {
  await next();
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
});
app.use('/api/*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  // A route that already set its own policy (the link page: same-origin) keeps it.
  if (!c.res.headers.get('Referrer-Policy')) c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  // Strict CSP for API responses (JSON only). The image responses of
  // /api/attachments/:id override this CSP in their handler with
  // a more suitable one (img-src 'self').
  if (!c.res.headers.get('Content-Security-Policy')) {
    c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  }
  c.header('X-Frame-Options', 'DENY');
});

/**
 * Widget-token lifetime: 1 hour. The widget refreshes it silently via
 * postMessage to the parent when an API call returns 401.
 * The attack window is 12x smaller than with a 12h TTL.
 */
const WIDGET_TOKEN_MS = 1 * 3600_000;

interface WidgetToken {
  uid: string;
  pid: string;
  exp: number;
  /** Issued at (epoch ms): checked against session_revocations like the session. */
  iat: number;
}

/**
 * Logged-in user from the session cookie, or null. The admin role is recomputed
 * from ADMIN_EMAILS on every request (admins.ts): an admin removed from the list
 * is demoted and their session stops being valid.
 */
async function currentUser(cookie: string | undefined, env: Env): Promise<User | null> {
  const session = await readSession(cookie, env);
  if (!session) return null;
  const user = await db.getUserById(env.DB, session.uid);
  return user ? applyAdminList(env, user) : null;
}

/** The widget-token from the `Authorization: Bearer <token>` header. */
function bearerToken(c: Context<{ Bindings: Env }>): string {
  const h = c.req.header('Authorization') || '';
  const m = h.match(/^Bearer\s+(\S+)$/i);
  return m ? (m[1] as string) : '';
}

/**
 * Auth for the comment/attachment/shot routes: widget-token or session.
 *
 * Widget-token powers (a structural security decision): the token lives in the
 * document of the site under review, where third-party scripts also run (apps
 * of a Shopify store, tag managers...) that can read it. So it is deliberately
 * weak, and it never goes in a query string such as ?wt= (readable via
 * performance.getEntriesByType('resource')):
 *  - it travels ONLY in the Authorization header (a ?wt= query is not read);
 *  - it can only read the project's comments, create comments, edit and delete
 *    its OWN, attach files (upload, /shot) and remove its own attachments;
 *  - resolving/reopening, deleting other people's comments or attachments and
 *    every admin action require the app session + CSRF (the widget asks the app
 *    via postMessage, and the app has the user confirm in ITS own page);
 *  - it carries iat and is subject to revocations like the session;
 *  - it is valid only while the user is still a member of the project.
 * With the widget-token, access is limited to the token's project (widgetPid).
 */
async function resolveUser(
  c: Context<{ Bindings: Env }>,
): Promise<{ user: User; widgetPid: string | null } | null> {
  const env = c.env;
  const wt = bearerToken(c);
  if (wt) {
    // Only 'widget' tokens (derived key distinct from the session and proxy keys).
    const p = await verifyTyped<WidgetToken>('widget', wt, env.SESSION_SECRET);
    if (!p || typeof p.uid !== 'string' || typeof p.pid !== 'string') return null;
    if (typeof p.exp !== 'number' || p.exp < Date.now()) return null;
    if (typeof p.iat !== 'number' || (await isRevoked(env, p.uid, p.iat))) return null;
    const found = await db.getUserById(env.DB, p.uid);
    const user = found ? await applyAdminList(env, found) : null;
    if (!user) return null;
    // Membership removed = token dead immediately, not at expiry.
    if (!(await db.userCanAccess(env.DB, user, p.pid))) return null;
    return { user, widgetPid: p.pid };
  }
  const user = await currentUser(c.req.header('Cookie'), env);
  return user ? { user, widgetPid: null } : null;
}

/** Response for the actions the widget-token cannot perform. */
const APP_ONLY_ERR = "action reserved for the Pinna app (requires a session)";

app.get('/api/health', (c) => c.json({ ok: true, service: 'pinna' }));

// Preview of the magic-link email (to check the design).
app.get('/api/email-preview', (c) => {
  const sample = publicOrigin(c.env, c.req.url) + '/api/auth/verify?token=SAMPLE-TOKEN';
  return c.html(magicEmailHtml(sample, '482913', 'Anna'));
});

// --- Auth ---------------------------------------------------------------

/**
 * Login CSRF: /auth/request and /auth/verify-code would otherwise also accept
 * text/plain, i.e. a form or a "simple" fetch from a third-party site (no
 * preflight). Requiring application/json forces a CORS preflight, which is not
 * granted here: from outside it does not get through.
 */
function isJsonRequest(c: Context<{ Bindings: Env }>): boolean {
  const ct = (c.req.header('content-type') || '').toLowerCase();
  return ct.split(';')[0]!.trim() === 'application/json';
}
const JSON_ERR = 'Content-Type: application/json required';

/**
 * Request bodies: c.req.json() and parseBody() read the whole body, even on
 * anonymous routes, without looking at its size. So, as for upload and /shot,
 * before reading: Content-Length is required (411) and at most BODY_MAX (413).
 * Comments have a larger cap: 5,000 characters of text plus path and selector
 * (up to 4,000 each) in JSON can exceed 16 KB with non-Latin characters, and a
 * valid comment must not get a 413.
 */
const BODY_MAX = 16 * 1024;
const COMMENT_BODY_BYTES = 64 * 1024;

/** 411/413 if the declared length is missing or exceeds `max`, otherwise undefined. */
function bodyTooBig(c: Context<{ Bindings: Env }>, max: number = BODY_MAX): Response | undefined {
  const declared = declaredLength(c.req.header('content-length'));
  if (declared === null) return c.json({ error: 'Content-Length required' }, 411);
  if (declared > max) return c.json({ error: 'request body too large' }, 413);
  return undefined;
}

/**
 * Reads a JSON body after the length check. `res`: the rejection response
 * (411/413); `data`: the JSON, or null if it is not valid JSON.
 */
async function readJsonBody(
  c: Context<{ Bindings: Env }>,
  max: number = BODY_MAX,
): Promise<{ res: Response; data?: undefined } | { res?: undefined; data: unknown }> {
  const res = bodyTooBig(c, max);
  if (res) return { res };
  const text = await c.req.text().catch(() => '');
  if (text.length > max) return { res: c.json({ error: 'request body too large' }, 413) };
  try {
    return { data: JSON.parse(text) as unknown };
  } catch {
    return { data: null };
  }
}

// Login sends per email and address, and per email only: AUTH_EMAIL_* in notify.ts.

app.post('/api/auth/request', async (c) => {
  if (!isJsonRequest(c)) return c.json({ error: JSON_ERR }, 415);
  // Without an email key and outside dev mode: 503 for EVERYONE, before the user
  // lookup (same response for registered and unknown emails, no enumeration).
  const devMode = isDevMode(c.env, c.req.url);
  if (!c.env.RESEND_API_KEY && !devMode) {
    console.error('[pinna] RESEND_API_KEY missing: email login unavailable');
    return c.json({ error: 'email not configured' }, 503);
  }
  // Per-IP limit (/48 in IPv6) BEFORE body validation, on the Rate Limiting
  // binding (no storage writes: anonymous requests do not consume quotas).
  // Fail-closed: this route sends email. The per-email-and-address limit
  // further down (D1) stays on the /64.
  const anonIp = getAnonIp(c);
  if (anonIp) {
    const blocked = await anonLimit(c, 'auth-req', anonIp, 'closed', 'too many attempts from this address, try again later');
    if (blocked) return blocked;
  }
  const ip = getClientIp(c);

  const read = await readJsonBody(c);
  if (read.res) return read.res;
  const body = (read.data && typeof read.data === 'object' ? read.data : {}) as { email?: unknown };
  const email = (typeof body.email === 'string' ? body.email : '').trim().toLowerCase();

  if (!email || !email.includes('@')) {
    return c.json({ error: 'invalid email' }, 400);
  }
  // Emails in ADMIN_EMAILS are provisioned/updated to role 'admin' BEFORE the
  // lookup, so a new admin receives the magic link on the first login too, with
  // the correct session.
  // Other emails stay on the anti-enumeration branch (no leak of who is
  // registered). ACCEPTED tradeoff: a not-yet-provisioned admin email responds
  // without the padding of the "unknown" branch, so timing reveals membership
  // in the allowlist (not access). The allowlist is a few well-known addresses,
  // not a secret, and nothing is reachable without the magic link.
  // Not with a list that contains no admin from the DB (a typo), otherwise the
  // wrong address would become admin.
  if (await canPromoteListed(c.env, email)) {
    await db.ensureAdminUser(c.env.DB, email, null);
  }
  // Always a generic response: we do not reveal which emails are registered.
  const user = await db.getUserByEmail(c.env.DB, email);
  if (!user) {
    // Hardening: equalizes the timing of the "unregistered email" branch with
    // the success branch. A dummy DB hit + a random 100-300ms delay simulate
    // the Resend round-trip of a real send.
    // Defense against email enumeration via a client-side stopwatch.
    await db.dummyAuthDelay(c.env.DB);
    await new Promise<void>((resolve) => setTimeout(resolve, 100 + Math.floor(Math.random() * 200)));
    return c.json({ ok: true });
  }

  // Code still valid: if the latest open link for this email has a usable
  // code, NO new email is sent and nothing is counted against the caps.
  // Otherwise every request, even anonymous, would send an email and consume
  // the caps: 10 requests from 4 addresses would lock that user (admin
  // included) out of email login for 24 hours. This way whoever insists
  // triggers at most one email every 90 minutes (the code lifetime), and every
  // email they trigger reaches the owner with a code that works: the code in
  // the mailbox is always the latest, the only one verifyOtp accepts. A new
  // code is sent again once the open one expires, is used, or is disabled
  // after 5 attempts. Not in dev mode (link and code are needed in the response).
  if (!devMode && db.openCodeUsable(await db.latestOpenLink(c.env.DB, email))) {
    console.log('[pinna] auth/request: code still valid, no new send');
    return c.json({ ok: true });
  }

  // Send limits, on D1 and ONLY for registered emails (unknown ones write
  // nothing). Over the limit the response is the same as a successful send
  // ({ok:true}) but no email goes out: a 429 here would tell the prober that
  // the address exists. Fail-closed (D1 down = no email).
  // Anti-lockout: with a single per-email limit of 3 an hour, anyone could
  // exhaust a client's limit with 3 requests. So the limit is 3 an hour per
  // email AND address (whoever insists from one IP does not touch the client's
  // budget from their own) plus a wider cap, 10 an hour, per email.
  const unavailable = () => c.json({ error: 'service temporarily unavailable, try again' }, 503);
  // Slots taken in the counters: if the email then fails to send, they are given back.
  const refunds: Array<() => Promise<void>> = [];
  if (ip) {
    const pairRes = await consumeRateLimit(c.env.DB, 'auth-email-ip', email + '|' + ip, AUTH_EMAIL_IP_PER_HOUR, 3600, { fail: 'closed' });
    if (pairRes.unavailable) return unavailable();
    if (!pairRes.allowed) {
      console.log('[pinna] auth/request: per-email-and-address limit reached, send skipped');
      return c.json({ ok: true });
    }
    refunds.push(() => refundRateLimit(c.env.DB, 'auth-email-ip', email + '|' + ip, 3600, pairRes.resetAt));
  }
  const emailRes = await consumeRateLimit(c.env.DB, 'auth-email', email, AUTH_EMAIL_PER_HOUR, 3600, { fail: 'closed' });
  if (emailRes.unavailable) return unavailable();
  if (!emailRes.allowed) {
    console.log('[pinna] auth/request: per-email limit reached, send skipped');
    return c.json({ ok: true });
  }
  refunds.push(() => refundRateLimit(c.env.DB, 'auth-email', email, 3600, emailRes.resetAt));
  // Resend quota: AUTH_EMAIL_PER_DAY login emails per email over the last 24
  // hours (the hourly caps alone would let 240 a day through, beyond the Resend
  // free quota) and the global cap on all emails (notify.ts), with a reserve
  // for admin logins.
  // Over it: same response as a successful send, no email, one alert
  // (at most one an hour, alerts.ts).
  const dayRes = await consumeSliding(c.env.DB, 'auth-email-day', email, AUTH_EMAIL_PER_DAY, 86400, { fail: 'closed' });
  if (dayRes.unavailable) return unavailable();
  if (!dayRes.allowed) {
    console.log('[pinna] auth/request: daily per-email cap reached, send skipped');
    c.executionCtx.waitUntil(recordError(c.env, 'email-quota'));
    return c.json({ ok: true });
  }
  refunds.push(() => refundSliding(c.env.DB, 'auth-email-day', email, dayRes.win));
  if (c.env.RESEND_API_KEY) {
    const quota = await reserveEmailSlot(c.env, { adminLogin: await isListedAdmin(c.env, user) });
    if (quota.result === 'unavailable') return unavailable();
    if (quota.result === 'over') {
      console.log('[pinna] auth/request: daily email quota reached, send skipped');
      c.executionCtx.waitUntil(recordError(c.env, 'email-quota'));
      return c.json({ ok: true });
    }
    refunds.push(() => releaseEmailSlot(c.env, quota.win));
  }

  const token = randomToken();
  // Same request = link (compat) + 6-digit code.
  const code = generateOtp();
  const tokenHash = await sha256hex(token);
  await db.createMagicLink(c.env.DB, email, tokenHash, code);
  // Public address from PINNA_PUBLIC_URL (or from the request origin).
  const link = publicOrigin(c.env, c.req.url) + '/api/auth/verify?token=' + token;
  const out = await sendMagicEmail(email, link, code, user.name, c.env);
  // Link and code in the response ONLY in dev mode (localhost + flag).
  if (out.devLink && devMode) {
    console.log('[pinna] magic link (dev): ' + out.devLink);
    console.log('[pinna] OTP code (dev): ' + (out.devCode ?? code));
    return c.json({ ok: true, devLink: out.devLink, devCode: out.devCode ?? code });
  }
  // Fail-visible: always answering {ok:true} even when Resend fails would make
  // the client see "email sent" and wait for an email that never arrives (a
  // silent lockout, since this is the only way in). So if the send did not
  // succeed (and we are not in dev), we return a VISIBLE error + count the
  // failure for the alert. This branch is reached only for existing users
  // (unknown emails exit earlier), so it does not enable enumeration.
  // Failed send: the row just created is closed and the slots taken in the
  // counters are given back. If the row stayed open, for 90 minutes every
  // request would find "code still valid" and send nothing: a one-minute
  // Resend outage would lock the client out for an hour and a half.
  if (out.sent === false) {
    await db.discardMagicLink(c.env.DB, tokenHash);
    for (const refund of refunds) await refund();
    c.executionCtx.waitUntil(recordError(c.env, 'resend'));
    return c.json({ error: 'Sending failed, try again shortly.' }, 502);
  }
  return c.json({ ok: true });
});

/**
 * Page behind the email link. A GET must not consume the link: mail scanners
 * (Microsoft 365 Safe Links, antivirus) open it first, and the client would
 * find "link expired". So the GET consumes nothing: it shows a button that
 * POSTs (scanners do not submit forms).
 *
 * The page names the account the link signs into, masked: anyone can send a
 * victim a link to THEIR OWN account (the victim would then comment as the
 * attacker), and the account shown makes that visible before the click.
 */
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return Array.from(email.slice(0, at))[0] + '***' + email.slice(at);
}

/** Style of the pages behind the email link (the link page, the "wait" page). */
const LINK_PAGE_STYLE = [
  '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6fa;',
  'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#1e293b}',
  'main{max-width:420px;margin:16px;padding:32px;background:#fff;border:1px solid #e6eaf0;border-radius:18px;text-align:center}',
  'h1{margin:0 0 8px;font-size:22px}p{margin:0 0 22px;line-height:1.55;color:#475569}',
  'button{min-height:48px;padding:0 34px;border:0;border-radius:999px;background:#0066cc;color:#fff;',
  'font:inherit;font-size:16px;font-weight:600;cursor:pointer}button:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}</style>',
].join('');

/** Headers of the pages behind the email link: no cache, nothing loaded from outside. */
const LINK_PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

/**
 * Past the anonymous limit, the person who clicked the link in an email gets a
 * page, not JSON: wait a minute and reload, the link is still valid (nothing
 * was read or consumed).
 */
function linkBusyHtml(): string {
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="same-origin"><title>Sign in to Pinna</title>',
    LINK_PAGE_STYLE,
    '</head><body><main><h1>Too many attempts</h1>',
    '<p>Too many sign-in attempts came from this address. Wait a minute and reload this page: ',
    'your link is still valid.</p></main></body></html>',
  ].join('');
}

function verifyPageHtml(token: string, maskedEmail: string): string {
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string);
  // Referrer same-origin: with no-referrer, browsers send the button's POST
  // with `Origin: null` and sameOriginPost would always reject it (tested in
  // Chromium, Firefox and WebKit): the email button would let nobody in.
  // same-origin keeps the token out of the Referer towards other sites (the
  // page loads nothing from outside).
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="same-origin"><title>Sign in to Pinna</title>',
    LINK_PAGE_STYLE,
    '</head><body><main><h1>Sign in to Pinna</h1>',
    '<p>Tap the button to finish signing in on this browser.</p>',
    '<p>This link signs you in as <b>', esc(maskedEmail), '</b>. ',
    'If that is not your address, close this page.</p>',
    '<form method="POST" action="/api/auth/verify">',
    '<input type="hidden" name="token" value="', esc(token), '">',
    '<button type="submit">Sign in</button></form></main></body></html>',
  ].join('');
}

app.get('/api/auth/verify', async (c) => {
  const appUrl = new URL(c.req.url).origin;
  const token = c.req.query('token') || '';
  if (!token) return new Response(null, { status: 302, headers: { Location: appUrl + '/login?err=link' } });
  // Anonymous shield (per IP, /48) before the D1 read, like the other sign-in
  // routes. Fail-open: reading a link costs one D1 read.
  const anonIp = getAnonIp(c);
  if (anonIp) {
    const blocked = await anonLimit(c, 'auth-link', anonIp, 'open', 'too many attempts from this address, try again later');
    if (blocked && blocked.status === 429) {
      return new Response(linkBusyHtml(), {
        status: 429,
        headers: { ...LINK_PAGE_HEADERS, 'Retry-After': blocked.headers.get('Retry-After') || '60' },
      });
    }
    if (blocked) return blocked;
  }
  // Read without consuming: unknown, used or expired -> the same path as a
  // failed POST.
  const email = await db.peekMagicLink(c.env.DB, await sha256hex(token));
  if (!email) return new Response(null, { status: 302, headers: { Location: appUrl + '/login?err=expired' } });
  return new Response(verifyPageHtml(token, maskEmail(email)), { status: 200, headers: LINK_PAGE_HEADERS });
});

/**
 * True if a POST comes from a Pinna page itself (login CSRF): Origin, or
 * Sec-Fetch-Site when it is missing. Without either (old browsers) it passes.
 * `Origin: null`: the browser sends it when the page has a restrictive
 * referrer policy, but so can a third-party site (sandboxed iframe, data:
 * URL), so on its own it proves nothing: Sec-Fetch-Site decides, which the
 * browser sets and a page cannot forge. Without Sec-Fetch-Site a "null" is
 * rejected.
 */
function sameOriginPost(c: Context<{ Bindings: Env }>): boolean {
  const origin = c.req.header('Origin');
  const site = c.req.header('Sec-Fetch-Site');
  if (origin === 'null') return site === 'same-origin';
  if (origin) return origin === new URL(c.req.url).origin;
  if (site) return site === 'same-origin';
  return true;
}

app.post('/api/auth/verify', async (c) => {
  const appUrl = new URL(c.req.url).origin;
  const fail = (err: string) =>
    new Response(null, { status: 303, headers: { Location: appUrl + '/login?err=' + err } });
  // A third-party site must not be able to log the visitor into ITS OWN account
  // with a form posting to this route (login CSRF): only POSTs from the page above.
  if (!sameOriginPost(c)) return c.json({ error: 'request not allowed' }, 403);
  // Anonymous shield (per IP, /48) before the body and the D1 write, like the
  // other sign-in routes. Fail-open, as for the code.
  const anonIp = getAnonIp(c);
  if (anonIp) {
    const blocked = await anonLimit(c, 'auth-verify', anonIp, 'open', 'too many attempts from this address, try again later');
    if (blocked) return blocked;
  }
  const tooBig = bodyTooBig(c);
  if (tooBig) return tooBig;
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const token = typeof form.token === 'string' ? form.token : '';
  if (!token) return fail('link');

  const email = await db.consumeMagicLink(c.env.DB, await sha256hex(token));
  if (!email) return fail('expired');
  const found = await db.getUserByEmail(c.env.DB, email);
  if (!found) return fail('user');

  // Admin role from ADMIN_EMAILS before signing the session (admins.ts):
  // promoted if listed, demoted if no longer listed.
  const user = await loginRole(c.env, found);

  const cookie = await makeSessionCookie(user, c.env);
  // Also issues the paired CSRF cookie (double-submit). The SPA reads it via
  // JS after the redirect and echoes it in the X-CSRF-Token header on
  // POST/PATCH/DELETE.
  const headers = new Headers({ Location: appUrl + '/' });
  headers.append('Set-Cookie', cookie);
  headers.append('Set-Cookie', makeCsrfCookie());
  for (const l of clearLegacyCookies()) headers.append('Set-Cookie', l);
  return new Response(null, { status: 303, headers });
});

/**
 * Login via 6-digit code. The client opens Pinna in THEIR browser, receives the
 * code by email and TYPES it here: the session cookie lands in the browser they
 * actually use, instead of ending up in the ephemeral cookie jar of the mail
 * app's in-app browser (the cause of "it always asks for my email again").
 * Issues the SAME cookies as the magic link (HttpOnly session + csrf), via
 * Set-Cookie on the 200 response: since it is a same-origin fetch the browser
 * stores them itself (the cookie is NOT returned in the body: HttpOnly cannot be set from JS).
 * No CSRF here: this is the login itself, pre-session (like /auth/request|verify).
 */
app.post('/api/auth/verify-code', async (c) => {
  if (!isJsonRequest(c)) return c.json({ error: JSON_ERR }, 415);
  // Per-IP limit (anti brute-force across emails) + per-email limit (anti
  // brute-force of the code), both on the Rate Limiting binding: no writes for
  // anonymous requests. They add to the atomic cap of 5 attempts per code
  // (verifyOtp), which is the real limit. Fail-open: this route costs nothing.
  // Per-IP key: /48 in IPv6 (getAnonIp).
  const anonIp = getAnonIp(c);
  if (anonIp) {
    const blocked = await anonLimit(c, 'auth-code-ip', anonIp, 'open', 'too many attempts from this address, try again later');
    if (blocked) return blocked;
  }

  const read = await readJsonBody(c);
  if (read.res) return read.res;
  const parsed = verifyCodeSchema.safeParse(read.data);
  if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
  const email = parsed.data.email.trim().toLowerCase();
  const code = parsed.data.code;
  if (!email.includes('@')) return c.json({ error: 'invalid email' }, 400);

  const blocked = await anonLimit(c, 'auth-code-email', email, 'open', 'too many attempts, wait a minute');
  if (blocked) return blocked;

  const verified = await db.verifyOtp(c.env.DB, email, code);
  if (!verified) return c.json({ error: 'invalid or expired code' }, 401);
  const found = await db.getUserByEmail(c.env.DB, verified);
  if (!found) return c.json({ error: 'user' }, 400);

  // Same computation as the magic link (ADMIN_EMAILS, admins.ts).
  const user = await loginRole(c.env, found);

  // Same cookies as the magic link, via Set-Cookie (HttpOnly preserved). The
  // /api/* middleware adds the security headers afterwards (it does not touch Set-Cookie).
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', await makeSessionCookie(user, c.env));
  headers.append('Set-Cookie', makeCsrfCookie());
  for (const l of clearLegacyCookies()) headers.append('Set-Cookie', l);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
});

app.post('/api/auth/logout', async (c) => {
  // Logout records the user's cutoff, so it closes ALL their sessions (on
  // other devices too). Only with a valid session and the right CSRF token (a
  // third-party site cannot trigger the revocation); this browser's cookies are
  // cleared regardless.
  const session = await readSession(c.req.header('Cookie'), c.env);
  // Per-user shield: over the threshold the revocation is not written, but
  // this browser's cookies are cleared all the same.
  if (session && verifyCsrf(c) && !(await userShield(c, session.uid))) {
    await db.revokeSessions(c.env.DB, session.uid, Date.now());
  }
  // Clears the session + CSRF cookies together.
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', clearSessionCookie());
  headers.append('Set-Cookie', clearCsrfCookie());
  for (const l of clearLegacyCookies()) headers.append('Set-Cookie', l);
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
});

/**
 * A global admin signs a user out (all their sessions). Their widget-tokens
 * stop working too (they carry iat and resolveUser reads the revocations).
 * Proxy-tokens stay valid until expiry (1 hour): they only give the staging
 * preview, no Pinna data; to close those immediately too, remove the
 * membership (DELETE /api/projects/:id/members/:userId).
 */
app.post('/api/users/:id/revoke-sessions', async (c) => {
  const user = await currentUser(c.req.header('Cookie'), c.env);
  if (!user || user.role !== 'admin') return c.json({ error: 'unauthorized' }, 401);
  if (!verifyCsrf(c)) return c.json({ error: CSRF_ERR }, 403);
  // Per-user shield before any write (rate-limit.ts).
  const shield = await userShield(c, user.id);
  if (shield) return shield;
  const target = await db.getUserById(c.env.DB, c.req.param('id'));
  if (!target) return c.json({ error: 'user not found' }, 404);
  const ok = await db.revokeSessions(c.env.DB, target.id, Date.now());
  if (!ok) return c.json({ error: 'revocation unavailable (migration 0003 missing)' }, 503);
  return c.json({ ok: true });
});

app.get('/api/auth/me', async (c) => {
  const user = await currentUser(c.req.header('Cookie'), c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ id: user.id, email: user.email, role: user.role, name: user.name });
});

/**
 * Hardening: constant-time ADMIN_KEY check, accepts the `X-Admin-Key`
 * header (preferred) or the `?k=` querystring (legacy, for the admin's
 * bookmark + an external dashboard's /entra proxy redirect). Audit log on
 * every attempt (row in admin_audit).
 *
 * Fail-closed: missing key or ADMIN_KEY not configured = false.
 * The audit log is skipped if no credential was provided (that is not an
 * auth attempt, it is an anonymous request). We log only the attempts
 * with something in the header or the query.
 */
/**
 * Hardening: CSRF double-submit token. Admin routes that change state
 * require `X-CSRF-Token` == the `__Host-pinna_csrf` cookie. An attacker
 * cannot set the cookie (cross-origin), so they cannot forge a valid
 * header.
 */
function verifyCsrf(c: Context<{ Bindings: Env }>): boolean {
  const cookieToken = readCookie(c.req.header('Cookie'), CSRF_COOKIE);
  if (!cookieToken) return false;
  const headerToken = c.req.header('X-CSRF-Token') || '';
  if (!headerToken) return false;
  return safeEqual(cookieToken, headerToken);
}

/**
 * CSRF on the comment/attachment/shot routes: they accept the widget-token
 * (Authorization header) OR the cookie. The browser attaches the cookie by
 * itself, so the X-CSRF-Token double-submit is also required; with the
 * widget-token it is not (a third-party site cannot make the browser attach
 * it: it has to be put in the header by hand).
 */
function csrfOkFor(c: Context<{ Bindings: Env }>, auth: { widgetPid: string | null }): boolean {
  return auth.widgetPid !== null || verifyCsrf(c);
}

const CSRF_ERR = 'CSRF token missing or invalid';

/**
 * Caps on FAILED attempts with the ADMIN_KEY. /entra and /api/summary write an
 * admin_audit row on every attempt; a per-IP cap (/64) alone is not enough,
 * because whoever holds a /48 controls 65,536 of them: rows in admin_audit and
 * in rate_limits at will, until D1 fills up or runs out of writes (and without
 * D1, login, comments and uploads stop). So, in order:
 *  1. ANON_RL shield on the /48, in memory (no writes), before anything else;
 *  2. GLOBAL cap: beyond ADMIN_FAIL_GLOBAL failures in an hour, from any
 *     address, nothing more is written, neither in admin_audit nor in
 *     rate_limits, and wrong keys get 429. The slot is reserved with an
 *     atomic increment, so a burst cannot exceed it;
 *  3. per-IP cap (/64): ADMIN_FAIL_LIMIT failures an hour; beyond it, 429 from
 *     that address even for the right key.
 * Beyond the GLOBAL cap the key is still checked: answering 429 to everyone,
 * right key included, would let 50 wrong keys an hour from different
 * addresses lock /entra and /api/summary for everybody. The global cap exists
 * to stop the writes, not to protect the key: it has at least MIN_SECRET_LEN
 * (32) characters and cannot be guessed.
 * Successes do not count (the external dashboard polling /api/summary does
 * not lock itself out) and write their own audit row.
 */
const ADMIN_FAIL_LIMIT = 10;
const ADMIN_FAIL_GLOBAL = 50;
const ADMIN_FAIL_WINDOW = 3600;
const ADMIN_FAIL_GLOBAL_KEY = 'all';
type AdminKeyResult = 'ok' | 'fail' | 'blocked' | 'none';

async function checkAdminKey(
  c: Context<{ Bindings: Env }>,
  endpoint: 'entra' | 'summary',
  provided: string,
  via: 'header' | 'query' | 'body',
): Promise<AdminKeyResult> {
  if (!provided) return 'none';
  // 1. In-memory shield on the /48. Fail-open: the D1 caps sit behind it.
  const anonIp = getAnonIp(c);
  if (anonIp && (await anonLimit(c, 'admin-key', anonIp, 'open'))) return 'blocked';
  // 3. Per-IP cap: beyond it, 429 even for the right key from that address.
  // Read only.
  const ip = getClientIp(c);
  if (ip) {
    const peek = await peekRateLimit(c.env.DB, 'admin-key-fail', ip, ADMIN_FAIL_LIMIT, ADMIN_FAIL_WINDOW);
    if (peek.blocked) return 'blocked';
  }
  const ua = c.req.header('User-Agent') || null;
  // ADMIN_KEY shorter than MIN_SECRET_LEN characters: treated as not set.
  if (c.env.ADMIN_KEY && !adminKeyOk(c.env)) {
    warnConfigOnce('admin-key', 'ADMIN_KEY shorter than ' + MIN_SECRET_LEN + ' characters: key sign-in disabled');
  }
  const adminKey = adminKeyOk(c.env) ? c.env.ADMIN_KEY : '';
  // ADMIN_KEY not configured: a server-side misconfiguration, but we log the
  // attempt anyway (the attacker cannot tell the two cases apart).
  const ok = !!adminKey && safeEqual(await sha256hex(provided), await sha256hex(adminKey));
  if (ok) {
    c.executionCtx.waitUntil(db.logAdminEntry(c.env.DB, endpoint, via, true, ip, ua));
    return 'ok';
  }
  // Failure. 2: beyond the global cap only a read, whoever insists writes
  // nothing.
  const all = await peekRateLimit(c.env.DB, 'admin-key-fail-all', ADMIN_FAIL_GLOBAL_KEY, ADMIN_FAIL_GLOBAL, ADMIN_FAIL_WINDOW);
  if (all.blocked) return 'blocked';
  // Reserve a slot in the global cap (atomic increment); without a slot
  // nothing else is written.
  const slot = await consumeRateLimit(c.env.DB, 'admin-key-fail-all', ADMIN_FAIL_GLOBAL_KEY, ADMIN_FAIL_GLOBAL, ADMIN_FAIL_WINDOW);
  if (!slot.allowed) return 'blocked';
  if (ip) await consumeRateLimit(c.env.DB, 'admin-key-fail', ip, ADMIN_FAIL_LIMIT, ADMIN_FAIL_WINDOW);
  c.executionCtx.waitUntil(db.logAdminEntry(c.env.DB, endpoint, via, false, ip, ua));
  return 'fail';
}

/**
 * Admin key for /api/summary: ONLY the `X-Admin-Key` header (sent by an
 * external dashboard). The `?k=` query (it ends up in history, logs and the
 * Referer) is not accepted anywhere: /entra reads the key from the #k=
 * fragment and sends it by POST (see below).
 */
async function verifyAdminKey(c: Context<{ Bindings: Env }>): Promise<AdminKeyResult> {
  return checkAdminKey(c, 'summary', c.req.header('X-Admin-Key') || '', 'header');
}

/**
 * Account that /entra signs into with the ADMIN_KEY, in ADMIN_EMAILS order:
 *  - the first address that ALREADY has an admin account (always taking the
 *    first of the list would, on an existing instance with another address in
 *    front, make /entra create and sign into a new account in that other
 *    address's name instead of the long-standing admin's);
 *  - if none has one, the first address, created as admin.
 * Without a valid list there is no account: /entra redirects to the login with err=user.
 * The same with a list that contains no admin from the DB: otherwise /entra
 * would create and sign into a phantom admin in the name of the first address
 * (e.g. the list pasted with its quotes).
 */
async function entraUser(env: Env): Promise<User | null> {
  const listed = adminEmails(env);
  if (!listed.length) return null;
  if ((await adminListState(env)) === 'missing') return null;
  for (const email of listed) {
    const u = await db.getUserByEmail(env.DB, email);
    if (u && u.role === 'admin') return u;
  }
  return db.ensureAdminUser(env.DB, listed[0] as string, null);
}

/**
 * The /entra page. An admin key in the query (/entra?k=<key>) would end up in
 * the Cloudflare logs, in the history and in the Referer. So the bookmark is
 * /entra#k=<key>: the fragment is never sent to the server; this page reads
 * it, removes it from the address bar and POSTs the key to /entra (like the
 * external dashboard's form). An old-style /entra?k= does not sign in: the
 * page says to update the bookmark (and the key should be changed, since it
 * has already ended up in the logs).
 * The key is valid only for the account of the first address in ADMIN_EMAILS.
 */
function entraPageHtml(nonce: string, legacyQuery: boolean): string {
  const msg = legacyQuery
    ? 'This link is no longer valid: the key no longer goes in the query. Use /entra#k=KEY and change the key, because it has ended up in the logs.'
    : 'Invalid admin sign-in link: /entra#k=KEY is required.';
  const script = legacyQuery
    ? ''
    : [
        '<script nonce="', nonce, '">(function(){',
        // No URLSearchParams on the fragment: it would turn the + of a base64
        // key into a space. decodeURIComponent leaves the + as it is.
        'var m=location.hash.slice(1).match(/(?:^|&)k=([^&]*)/);var k="";',
        'try{k=m?decodeURIComponent(m[1]):"";}catch(e){k=m?m[1]:"";}',
        'history.replaceState(null,"",location.pathname+location.search);',
        'if(!k){document.getElementById("m").hidden=false;return;}',
        'var q=new URLSearchParams(location.search);',
        'document.getElementById("k").value=k;document.getElementById("g").value=q.get("goto")||"";',
        'document.getElementById("f").submit();})();</script>',
      ].join('');
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="referrer" content="no-referrer"><title>Pinna</title>',
    '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6fa;color:#1e293b;',
    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}',
    'p{max-width:420px;margin:16px;line-height:1.55}</style></head><body>',
    '<p id="m"', legacyQuery ? '' : ' hidden', '>', msg, '</p>',
    '<form id="f" method="POST" action="/entra"><input type="hidden" name="k" id="k">',
    '<input type="hidden" name="goto" id="g"></form>',
    script,
    '</body></html>',
  ].join('');
}

app.get('/entra', (c) => {
  // The ?k= query is not even checked (no oracle, no audit).
  const legacy = new URL(c.req.url).searchParams.has('k');
  const nonce = randomToken();
  return new Response(entraPageHtml(nonce, legacy), {
    status: legacy ? 400 : 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'nonce-" + nonce + "'; style-src 'unsafe-inline'; " +
        "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
});

/**
 * Admin sign-in via POST: the key arrives in the body, from an external
 * dashboard's auto-submit form or from the GET /entra page (bookmark
 * /entra#k=). Here we validate it, set the session and 303 -> goto.
 */
app.post('/entra', async (c) => {
  const appUrl = new URL(c.req.url).origin;
  const tooBig = bodyTooBig(c);
  if (tooBig) return tooBig;
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const k = typeof form.k === 'string' ? form.k : '';
  const rawGoto = typeof form.goto === 'string' ? form.goto : '';
  const ok = (await checkAdminKey(c, 'entra', k, 'body')) === 'ok';
  if (!ok) {
    return new Response(null, { status: 303, headers: { Location: appUrl + '/login?err=link' } });
  }
  const user = await entraUser(c.env);
  if (!user) {
    return new Response(null, { status: 303, headers: { Location: appUrl + '/login?err=user' } });
  }
  const cookie = await makeSessionCookie(user, c.env);
  const safeGoto =
    rawGoto.startsWith('/') && !rawGoto.startsWith('//') && !rawGoto.includes('\\')
      ? rawGoto
      : '/';
  const headers = new Headers({ Location: appUrl + safeGoto });
  headers.append('Set-Cookie', cookie);
  headers.append('Set-Cookie', makeCsrfCookie());
  for (const l of clearLegacyCookies()) headers.append('Set-Cookie', l);
  return new Response(null, { status: 303, headers });
});

/**
 * Summary for an external dashboard: list of projects with the counts of
 * open / completed comments. The dashboard has no Pinna session, so it
 * authenticates with the same ADMIN_KEY as /entra, ONLY in the
 * `X-Admin-Key` header (the `?k=` querystring is not accepted).
 */
app.get('/api/summary', async (c) => {
  const res = await verifyAdminKey(c);
  if (res === 'blocked') return c.json({ error: 'too many attempts, try again later' }, 429);
  if (res !== 'ok') return c.json({ error: 'unauthorized' }, 401);

  const projects = await db.listAllProjects(c.env.DB);
  // One aggregate query (GROUP BY) instead of 3 per project. 1+3N queries
  // would break the Worker's 50 subrequests/invocation limit at ~17 projects.
  const stats = await db.projectStatsBatch(c.env.DB);
  const items = projects.map((p) => {
    const s = stats.get(p.id);
    return {
      id: p.id,
      name: p.name,
      slug: p.slug,
      staging_url: p.staging_url,
      created_at: p.created_at,
      open: s?.open ?? 0,
      done: s?.done ?? 0,
      // Extra metrics for the external dashboard.
      oldestOpenAt: s?.oldestOpenAt ?? null,
      avgResolveMs: s?.avgResolveMs ?? null,
    };
  });
  const totals = items.reduce(
    (acc, p) => ({
      projects: acc.projects + 1,
      open: acc.open + p.open,
      done: acc.done + p.done,
    }),
    { projects: 0, open: 0, done: 0 },
  );
  return c.json({ ok: true, generated_at: Date.now(), totals, projects: items });
});

// --- Projects -----------------------------------------------------------

app.get('/api/projects', async (c) => {
  const user = await currentUser(c.req.header('Cookie'), c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const projects = await db.listProjectsForUser(c.env.DB, user);
  // One aggregate query instead of one per project (1+N). The batch covers
  // all projects; here we map only the user's own (no leak).
  const stats = await db.projectStatsBatch(c.env.DB);
  const withCounts = projects.map((p) => {
    const s = stats.get(p.id);
    // can_admin: the user administers THIS project (global admin or the site's collab).
    return {
      ...p,
      can_admin: p.my_role === 'admin' || p.my_role === 'collab',
      counts: { open: s?.open ?? 0, done: s?.done ?? 0 },
    };
  });
  return c.json(withCounts);
});

app.post('/api/projects', async (c) => {
  const user = await currentUser(c.req.header('Cookie'), c.env);
  if (!user || user.role !== 'admin') return c.json({ error: 'unauthorized' }, 401);
  if (!verifyCsrf(c)) return c.json({ error: 'CSRF token missing or invalid' }, 403);
  // Per-user shield before any write (rate-limit.ts).
  const shield = await userShield(c, user.id);
  if (shield) return shield;
  const read = await readJsonBody(c);
  if (read.res) return read.res;
  const parsed = projectSchema.safeParse(read.data);
  if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
  const name = parsed.data.name.trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  // staging_url is validated: http(s) only, no internal hosts, not even by
  // name (dns-guard.ts). Otherwise any string would pass and then be used by
  // the iframe, the proxy and /shot. Internal hosts are allowed only in dev mode.
  const staging = await checkStagingUrl(parsed.data.staging_url || '', isDevMode(c.env, c.req.url));
  if (!staging.ok) return c.json({ error: staging.error }, 400);
  const project = await db.createProject(c.env.DB, name, staging.url);
  // Hydrates counts to 0/0: a freshly created project has zero comments. Without this field
  // the DashboardView.vue frontend crashes on `p.counts.open` (blank screen after adding
  // a project). GET /api/projects already injects counts; we replicate it here for consistency.
  return c.json({ ...project, my_role: 'admin', can_admin: true, counts: { open: 0, done: 0 } }, 201);
});

app.post('/api/projects/:id/invite', async (c) => {
  const user = await currentUser(c.req.header('Cookie'), c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  if (!verifyCsrf(c)) return c.json({ error: 'CSRF token missing or invalid' }, 403);
  // Per-user shield before any write (rate-limit.ts).
  const shield = await userShield(c, user.id);
  if (shield) return shield;
  const project = await db.getProject(c.env.DB, c.req.param('id'));
  if (!project) return c.json({ error: 'project not found' }, 404);
  // Per-project gate. A global admin everywhere; a collab only on their own sites.
  if (!(await db.canAdmin(c.env.DB, user, project.id))) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const read = await readJsonBody(c);
  if (read.res) return read.res;
  const parsed = inviteSchema.safeParse(read.data);
  if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
  const email = parsed.data.email.trim().toLowerCase();
  if (!email.includes('@')) return c.json({ error: 'invalid email' }, 400);
  const asCollab = parsed.data.role === 'collab';
  // Adding a COLLABORATOR (site admin) is reserved to a global admin.
  // A collab can only invite clients (reviewers) to their own sites.
  if (asCollab && user.role !== 'admin') {
    return c.json({ error: 'only a global admin can add collaborators' }, 403);
  }
  const invited = asCollab
    ? await db.ensureCollabUser(c.env.DB, email, parsed.data.name?.trim() || null)
    : await db.ensureClientUser(c.env.DB, email, parsed.data.name?.trim() || null);
  // PER-PROJECT role: collab only here, not on all of the user's sites.
  await db.addMembership(c.env.DB, invited.id, project.id, asCollab ? 'collab' : 'client');
  // Only ok: returning the invited user's id, email and GLOBAL role would let
  // a collab inviting an address find out whether it was already registered
  // and whether it was an admin. The app does not use them.
  return c.json({ ok: true }, 201);
});

/**
 * Members of a project, for whoever administers it: used to find the user to
 * remove with the route below.
 */
app.get('/api/projects/:id/members', async (c) => {
  const user = await currentUser(c.req.header('Cookie'), c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const project = await db.getProject(c.env.DB, c.req.param('id'));
  if (!project) return c.json({ error: 'project not found' }, 404);
  if (!(await db.canAdmin(c.env.DB, user, project.id))) return c.json({ error: 'unauthorized' }, 401);
  return c.json(await db.listMembers(c.env.DB, project.id));
});

/**
 * Removes a user from a project: membership deleted, so no more access; their
 * widget-token stops working on the next request. Project admin + CSRF. A
 * collab can remove only clients; removing a collaborator is reserved to a
 * global admin (like adding one).
 */
app.delete('/api/projects/:id/members/:userId', async (c) => {
  const user = await currentUser(c.req.header('Cookie'), c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  if (!verifyCsrf(c)) return c.json({ error: CSRF_ERR }, 403);
  // Per-user shield before any write (rate-limit.ts).
  const shield = await userShield(c, user.id);
  if (shield) return shield;
  const project = await db.getProject(c.env.DB, c.req.param('id'));
  if (!project) return c.json({ error: 'project not found' }, 404);
  if (!(await db.canAdmin(c.env.DB, user, project.id))) return c.json({ error: 'unauthorized' }, 401);
  const target = await db.getUserById(c.env.DB, c.req.param('userId'));
  if (!target) return c.json({ error: 'user not found' }, 404);
  const targetRole = await db.projectRole(c.env.DB, target, project.id);
  if (targetRole === null) return c.json({ error: 'not a member of the project' }, 404);
  if (targetRole === 'admin') return c.json({ error: 'a global admin cannot be removed from a project' }, 400);
  if (targetRole === 'collab' && user.role !== 'admin') {
    return c.json({ error: 'only a global admin can remove a collaborator' }, 403);
  }
  await db.removeMembership(c.env.DB, target.id, project.id);
  return c.json({ ok: true });
});

/** Short-lived token for the widget inside the project's iframe. */
app.get('/api/projects/:slug/widget-token', async (c) => {
  const user = await currentUser(c.req.header('Cookie'), c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  const project = await db.getProjectBySlug(c.env.DB, c.req.param('slug'));
  if (!project) return c.json({ error: 'project not found' }, 404);
  if (!(await db.userCanAccess(c.env.DB, user, project.id))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const payload: WidgetToken = {
    uid: user.id,
    pid: project.id,
    exp: Date.now() + WIDGET_TOKEN_MS,
    iat: Date.now(),
  };
  const token = await signTyped('widget', payload, c.env.SESSION_SECRET);
  // EFFECTIVE role on the project for the widget. A collab who is a member of
  // the project is admin here (IS_ADMIN in the widget: can mark as completed /
  // delete); otherwise 'client'. A global admin stays admin everywhere.
  const widgetRole = (await db.canAdmin(c.env.DB, user, project.id)) ? 'admin' : 'client';
  // Proxy-token: authorizes /_proxy ONLY on this project's staging origin, for
  // this user, for 1 hour. null if the staging_url is missing or the proxy is
  // disabled (PINNA_PROXY_ENABLED): in that case the app also hides the
  // "Proxy ON/OFF" button, which would only lead to a 503 page.
  const proxyEnabled = c.env.PINNA_PROXY_ENABLED === '1';
  const proxyToken = proxyEnabled
    ? await makeProxyToken(user.id, project.id, project.staging_url, c.env.SESSION_SECRET)
    : null;
  return c.json({
    token,
    proxy_enabled: proxyEnabled,
    proxy_token: proxyToken,
    role: widgetRole,
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      staging_url: project.staging_url,
    },
  });
});

// --- Comments (session or widget-token) ---------------------------------

/**
 * The comment shape of every route that answers with comments (the list,
 * create, edit): only the fields the widget and the app read. Storage keys
 * (r2_key), uploader and author ids and the project id are never sent.
 * 'mine' = the comment (or the file) belongs to the requesting user: the
 * widget shows "edit" / "delete" only to the author, and deletes a thread
 * directly only when every comment and file in it is the caller's.
 */
type AttachmentOut = { id: string; filename: string; content_type: string; url: string; mine: boolean };

function attachmentOut(a: Attachment, userId: string, at: string): AttachmentOut {
  return {
    id: a.id,
    filename: a.filename,
    content_type: a.content_type,
    url: '/api/attachments/' + encodeURIComponent(a.id) + '?at=' + at,
    mine: a.created_by === userId,
  };
}

function commentOut(r: db.CommentRow, userId: string, attachments: AttachmentOut[]) {
  return {
    id: r.id,
    parent_id: r.parent_id,
    page_path: r.page_path,
    anchor_selector: r.anchor_selector,
    anchor_x: r.anchor_x,
    anchor_y: r.anchor_y,
    page_x: r.page_x,
    page_y: r.page_y,
    viewport_w: r.viewport_w,
    viewport: r.viewport,
    body: r.body,
    status: r.status,
    created_at: r.created_at,
    resolved_at: r.resolved_at,
    author_role: r.author_role,
    mine: r.author_id === userId,
    attachments,
  };
}

/** One comment in the shared shape, read again from the database (null if gone). */
async function commentAnswer(c: Context<{ Bindings: Env }>, id: string, userId: string) {
  const row = await db.getCommentRow(c.env.DB, id);
  if (!row) return null;
  const atts = await db.listAttachmentsForComment(c.env.DB, id);
  const at = atts.length ? encodeURIComponent(await signAttachmentUrl(row.project_id, userId, c.env)) : '';
  return commentOut(row, userId, atts.map((a) => attachmentOut(a, userId, at)));
}

app.get('/api/projects/:slug/comments', async (c) => {
  const auth = await resolveUser(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  const project = await db.getProjectBySlug(c.env.DB, c.req.param('slug'));
  if (!project) return c.json({ error: 'project not found' }, 404);
  const ok = auth.widgetPid
    ? auth.widgetPid === project.id
    : await db.userCanAccess(c.env.DB, auth.user, project.id);
  if (!ok) return c.json({ error: 'forbidden' }, 403);
  const rows = await db.listComments(c.env.DB, project.id);
  const atts = await db.listAttachmentsForProject(c.env.DB, project.id);
  // Every attachment carries `url`: a READ-ONLY, short-lived address
  // ('att' token, 10 minutes). It is needed where the browser loads the file
  // by itself (<img>, link, new tab) and cannot send the Authorization header:
  // it is the only credential that ends up in a URL. A single token per project
  // and user, signed once per request (one HMAC per attachment would make the
  // list's CPU cost grow with the number of files).
  const byComment: Record<string, AttachmentOut[]> = {};
  const at = atts.length ? encodeURIComponent(await signAttachmentUrl(project.id, auth.user.id, c.env)) : '';
  for (const a of atts) {
    if (!a.comment_id) continue;
    (byComment[a.comment_id] ||= []).push(attachmentOut(a, auth.user.id, at));
  }
  return c.json(rows.map((r) => commentOut(r, auth.user.id, byComment[r.id] || [])));
});

app.post('/api/projects/:slug/comments', async (c) => {
  const auth = await resolveUser(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  if (!csrfOkFor(c, auth)) return c.json({ error: CSRF_ERR }, 403);
  // Per-user shield before any write (rate-limit.ts).
  const shield = await userShield(c, auth.user.id);
  if (shield) return shield;
  const project = await db.getProjectBySlug(c.env.DB, c.req.param('slug'));
  if (!project) return c.json({ error: 'project not found' }, 404);
  const ok = auth.widgetPid
    ? auth.widgetPid === project.id
    : await db.userCanAccess(c.env.DB, auth.user, project.id);
  if (!ok) return c.json({ error: 'forbidden' }, 403);

  // Rate limit 30/min per user. Global key (cross-project):
  // anti-spam per user, not per project.
  const commentsLimit = 30;
  const rlRes = await consumeRateLimit(
    c.env.DB,
    'comments-user',
    auth.user.id,
    commentsLimit,
    60,
  );
  const blocked = applyRateLimit(c, rlRes, commentsLimit, 'you are commenting too fast, wait a minute');
  if (blocked) return blocked;

  const read = await readJsonBody(c, COMMENT_BODY_BYTES);
  if (read.res) return read.res;
  const parsed = newCommentSchema.safeParse(read.data);
  if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
  const input = parsed.data;

  // Daily caps and storage quota: 30 a minute per user alone would allow up to
  // 43,200 comments of 50,000 characters a day.
  // Only valid comments are counted; fail-open like the per-minute limit (a
  // broken counter must not stop a review), the quota still applies.
  const dayUser = await consumeRateLimit(c.env.DB, 'comments-user-day', auth.user.id, COMMENTS_PER_USER_DAY, 86400);
  const blockedDay = applyRateLimit(c, dayUser, COMMENTS_PER_USER_DAY, 'you have written too many comments today, try again tomorrow');
  if (blockedDay) return blockedDay;
  const dayProject = await consumeRateLimit(c.env.DB, 'comments-project-day', project.id, COMMENTS_PER_PROJECT_DAY, 86400);
  const blockedProject = applyRateLimit(c, dayProject, COMMENTS_PER_PROJECT_DAY, 'too many comments on this project today, try again tomorrow');
  if (blockedProject) return blockedProject;
  // Quota: text, path and selector (not just the text).
  const newChars = input.body.trim().length + (input.page_path ?? '').length + (input.anchor_selector ?? '').length;
  if ((await db.projectCommentChars(c.env.DB, project.id)) + newChars > PROJECT_COMMENT_CHARS) {
    return c.json({ error: 'comment storage for this project is full' }, 413);
  }
  if (!input.parent_id && (!input.page_path || !input.page_path.trim())) {
    return c.json({ error: 'page_path is required for a pin' }, 400);
  }
  // Reply: the parent must exist, belong to the SAME project and be a
  // top-level comment (no reply-to-reply). Without this check a widget-token could
  // attach a reply to a comment of another project (orphan row, silently
  // lost) or create nesting > 1 level (orphans on delete).
  if (input.parent_id) {
    const parent = await db.getComment(c.env.DB, input.parent_id);
    if (!parent || parent.project_id !== project.id || parent.parent_id !== null) {
      return c.json({ error: 'invalid parent comment' }, 400);
    }
  }
  // The quota is checked again inside the INSERT: requests sent in parallel
  // all pass the read above, only the ones that fit get written.
  const comment = await db.createComment(c.env.DB, project.id, auth.user.id, input, PROJECT_COMMENT_CHARS);
  if (!comment) return c.json({ error: 'comment storage for this project is full' }, 413);
  let attachmentsLinked = 0;
  if (input.attachment_ids && input.attachment_ids.length) {
    // Confused-deputy fix: linkAttachments filters on
    // created_by == the comment's author. Attachments uploaded by another
    // user in the same project CANNOT be linked.
    attachmentsLinked = await db.linkAttachments(
      c.env.DB,
      comment.id,
      project.id,
      auth.user.id,
      input.attachment_ids,
    );
    if (attachmentsLinked < input.attachment_ids.length) {
      // Some attachments not linked (invalid id / already linked / other
      // uploader). We report it in the logs and in the JSON. We do NOT return 400:
      // the comment is already created, rejecting it would be inconsistent.
      console.log(
        `[pinna] linkAttachments partial: ${attachmentsLinked}/${input.attachment_ids.length} ` +
        `linked to comment ${comment.id}`,
      );
    }
  }
  const kind: 'reply' | 'new' = input.parent_id ? 'reply' : 'new';
  c.executionCtx.waitUntil(notifyEvent(c.env, project, auth.user, comment, kind, publicOrigin(c.env, c.req.url)));
  const out = await commentAnswer(c, comment.id, auth.user.id);
  if (!out) return c.json({ error: 'comment not found' }, 404);
  return c.json(
    {
      ...out,
      attachments_linked: attachmentsLinked,
      attachments_requested: input.attachment_ids?.length ?? 0,
    },
    201,
  );
});

app.patch('/api/comments/:id', async (c) => {
  const auth = await resolveUser(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  if (!csrfOkFor(c, auth)) return c.json({ error: CSRF_ERR }, 403);
  // Per-user shield before any write (rate-limit.ts).
  const shield = await userShield(c, auth.user.id);
  if (shield) return shield;
  const comment = await db.getComment(c.env.DB, c.req.param('id'));
  if (!comment) return c.json({ error: 'comment not found' }, 404);
  const ok = auth.widgetPid
    ? auth.widgetPid === comment.project_id
    : await db.userCanAccess(c.env.DB, auth.user, comment.project_id);
  if (!ok) return c.json({ error: 'forbidden' }, 403);

  const read = await readJsonBody(c, COMMENT_BODY_BYTES);
  if (read.res) return read.res;
  const parsed = commentPatchSchema.safeParse(read.data);
  if (!parsed.success) return c.json({ error: firstError(parsed.error) }, 400);
  const patch = parsed.data;
  // Changing the status (completed / reopened) is a project-admin action:
  // a global admin everywhere, a collab on their own sites. Clients cannot. And
  // NEVER with the widget-token: only from the app session (with CSRF).
  if (patch.status !== undefined) {
    if (auth.widgetPid) return c.json({ error: APP_ONLY_ERR }, 403);
    if (!(await db.canAdmin(c.env.DB, auth.user, comment.project_id))) {
      return c.json({ error: 'forbidden' }, 403);
    }
  }
  // Editing the text: only the comment's author, within the storage quota.
  if (patch.body !== undefined && comment.author_id !== auth.user.id) {
    return c.json({ error: 'forbidden' }, 403);
  }
  if (patch.body !== undefined && patch.body.length > comment.body.length) {
    const used = await db.projectCommentChars(c.env.DB, comment.project_id);
    if (used - comment.body.length + patch.body.length > PROJECT_COMMENT_CHARS) {
      return c.json({ error: 'comment storage for this project is full' }, 413);
    }
  }
  // The quota is checked again inside the UPDATE (parallel edits).
  const updated = await db.updateComment(c.env.DB, comment.id, patch, PROJECT_COMMENT_CHARS);
  if (updated === 'over-quota') return c.json({ error: 'comment storage for this project is full' }, 413);
  // Notifies the other party when the status changes (completed / reopened).
  if (updated && patch.status && updated.status !== comment.status) {
    const project = await db.getProject(c.env.DB, comment.project_id);
    if (project) {
      const kind = updated.status === 'done' ? 'resolved' : 'reopened';
      c.executionCtx.waitUntil(notifyEvent(c.env, project, auth.user, updated, kind, publicOrigin(c.env, c.req.url)));
    }
  }
  const out = await commentAnswer(c, comment.id, auth.user.id);
  if (!out) return c.json({ error: 'comment not found' }, 404);
  return c.json(out);
});

app.delete('/api/comments/:id', async (c) => {
  const auth = await resolveUser(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  if (!csrfOkFor(c, auth)) return c.json({ error: CSRF_ERR }, 403);
  // Per-user shield before any write (rate-limit.ts).
  const shield = await userShield(c, auth.user.id);
  if (shield) return shield;
  const comment = await db.getComment(c.env.DB, c.req.param('id'));
  if (!comment) return c.json({ error: 'comment not found' }, 404);
  const ok = auth.widgetPid
    ? auth.widgetPid === comment.project_id
    : await db.userCanAccess(c.env.DB, auth.user, comment.project_id);
  if (!ok) return c.json({ error: 'forbidden' }, 403);
  // Deleting: the comment's author, or a project admin (a global admin
  // everywhere, a collab on their own sites) but ONLY from the app session: with
  // the widget-token you can delete only your own comments. Deleting a pin
  // deletes its whole thread, so if the thread holds a reply or a file by
  // someone else the admin rule applies to the pin's author too.
  if (
    comment.author_id !== auth.user.id ||
    (await db.threadHasOthersWork(c.env.DB, comment.id, comment.author_id))
  ) {
    if (auth.widgetPid) return c.json({ error: APP_ONLY_ERR }, 403);
    if (!(await db.canAdmin(c.env.DB, auth.user, comment.project_id))) {
      return c.json({ error: 'forbidden' }, 403);
    }
  }
  // R2 blobs first (in batches), then the D1 rows: if R2 fails nothing is
  // touched and the user can retry (no blobs left without a row).
  const r2keys = await db.commentAttachmentKeys(c.env.DB, comment.id);
  const r2 = await deleteR2InBatches(c.env.ATTACHMENTS, r2keys);
  if (r2.failed) return c.json({ error: 'delete failed, try again' }, 502);
  await db.deleteCommentRows(c.env.DB, comment.id);
  return c.json({ ok: true });
});

// --- Notifications ------------------------------------------------------

app.get('/api/notifications/me', async (c) => {
  const user = await currentUser(c.req.header('Cookie'), c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  return c.json({ muted: await db.isMuted(c.env.DB, user.id) });
});

app.post('/api/notifications/mute', async (c) => {
  const user = await currentUser(c.req.header('Cookie'), c.env);
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  if (!verifyCsrf(c)) return c.json({ error: CSRF_ERR }, 403);
  // Per-user shield before any write (rate-limit.ts).
  const shield = await userShield(c, user.id);
  if (shield) return shield;
  const read = await readJsonBody(c);
  if (read.res) return read.res;
  const body = (read.data && typeof read.data === 'object' ? read.data : {}) as { muted?: unknown };
  await db.setMuted(c.env.DB, user.id, !!body.muted);
  return c.json({ muted: !!body.muted });
});

// --- Attachments --------------------------------------------------------

/** Attachment upload: the file goes to R2, the metadata to D1. */
app.post('/api/projects/:slug/attachments', async (c) => {
  const auth = await resolveUser(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  if (!csrfOkFor(c, auth)) return c.json({ error: CSRF_ERR }, 403);
  // Per-user shield before any write (rate-limit.ts).
  const shield = await userShield(c, auth.user.id);
  if (shield) return shield;
  const project = await db.getProjectBySlug(c.env.DB, c.req.param('slug'));
  if (!project) return c.json({ error: 'project not found' }, 404);
  const ok = auth.widgetPid
    ? auth.widgetPid === project.id
    : await db.userCanAccess(c.env.DB, auth.user, project.id);
  if (!ok) return c.json({ error: 'forbidden' }, 403);

  // Declared size BEFORE reading the body: without Content-Length 411,
  // over the cap 413, and no counter consumed.
  const declared = declaredLength(c.req.header('content-length'));
  if (declared === null) return c.json({ error: 'Content-Length required' }, 411);
  if (declared > MAX_UPLOAD_BODY) return c.json({ error: 'file too large (max 10 MB)' }, 413);

  // Rate limit 10/min per user. An upload is heavier than a comment,
  // so a tighter threshold protects R2 storage + Workers CPU time.
  const uploadLimit = 10;
  const rlRes = await consumeRateLimit(
    c.env.DB,
    'attachments-user',
    auth.user.id,
    uploadLimit,
    60,
    { fail: 'closed' },
  );
  const blocked = applyRateLimit(c, rlRes, uploadLimit, 'you are uploading too many files in a row, wait a minute');
  if (blocked) return blocked;

  const form = await c.req.parseBody();
  const file = form['file'];
  if (!(file instanceof File)) return c.json({ error: 'file missing' }, 400);
  if (file.size > MAX_UPLOAD_FILE) {
    return c.json({ error: 'file too large (max 10 MB)' }, 413);
  }
  // Project storage quota: sum of the attachments in D1. And number of
  // attachments: tiny GIFs cannot fill the project with rows.
  const usage = await db.projectAttachmentUsage(c.env.DB, project.id);
  if (usage.count >= PROJECT_MAX_ATTACHMENTS) {
    return c.json({ error: 'too many attachments in the project (max ' + PROJECT_MAX_ATTACHMENTS + ')' }, 413);
  }
  if (usage.bytes + file.size > PROJECT_QUOTA_BYTES) {
    return c.json({ error: 'attachment storage for this project is full (200 MB)' }, 413);
  }

  // Three-layer MIME validation. Allowlist + magic number + match of the
  // declared type vs the signature. SVG forbidden (stored XSS), everything that
  // is not PNG/JPEG/WebP/GIF/PDF rejected with 415.
  const check = await validateUpload(file);
  if (!check.ok) {
    const status = check.code === 'read-error' ? 400 : 415;
    return c.json({ error: check.message, code: check.code }, status);
  }
  const canonicalMime = check.mime;

  // Uploadable bytes per day per user (counted only for valid files).
  // Fail-closed: if the counter does not respond, no upload.
  const quota = await consumeRateLimit(c.env.DB, 'upload-bytes-user', auth.user.id, USER_DAILY_UPLOAD_BYTES, 86400, {
    fail: 'closed',
    amount: file.size,
  });
  const overQuota = applyRateLimit(c, quota, USER_DAILY_UPLOAD_BYTES, 'you have uploaded too many files today, try again tomorrow');
  if (overQuota) return overQuota;
  // Number of files per day per user, fail-closed.
  const count = await consumeRateLimit(c.env.DB, 'uploads-user-day', auth.user.id, USER_DAILY_UPLOADS, 86400, { fail: 'closed' });
  const overCount = applyRateLimit(c, count, USER_DAILY_UPLOADS, 'you have uploaded too many files today, try again tomorrow');
  if (overCount) return overCount;

  const id = crypto.randomUUID();
  const key = 'att/' + id;
  // We use the canonical MIME inferred from the signature, not the client's.
  // Row first, with the project's quotas inside the INSERT (parallel uploads
  // all pass the read above, only the ones that fit get a row), then the blob.
  // A failed insert leaves no object in R2; a failed put removes the row.
  const att = await db.createAttachment(
    c.env.DB,
    {
      id,
      project_id: project.id,
      r2_key: key,
      // Control characters removed, the extension made to agree with the
      // detected type, at most 200 characters (extension kept).
      filename: safeFilename(file.name || '', canonicalMime),
      content_type: canonicalMime,
      size: file.size,
      // Confused-deputy fix: records the uploader for the later filter
      // in linkAttachments.
      created_by: auth.user.id,
    },
    { maxCount: PROJECT_MAX_ATTACHMENTS, maxBytes: PROJECT_QUOTA_BYTES },
  );
  if (!att) return attachmentQuotaError(c, project.id);
  try {
    await c.env.ATTACHMENTS.put(key, file.stream(), {
      httpMetadata: { contentType: canonicalMime },
    });
  } catch (e) {
    await db.deleteAttachment(c.env.DB, id).catch(() => 0);
    throw e;
  }
  return c.json(att, 201);
});

/**
 * The quota error for an attachment insert that wrote nothing (the project
 * filled up between the check and the write): the same messages as the checks
 * made before it.
 */
async function attachmentQuotaError(c: Context<{ Bindings: Env }>, projectId: string): Promise<Response> {
  const usage = await db.projectAttachmentUsage(c.env.DB, projectId);
  if (usage.count >= PROJECT_MAX_ATTACHMENTS) {
    return c.json({ error: 'too many attachments in the project (max ' + PROJECT_MAX_ATTACHMENTS + ')' }, 413);
  }
  return c.json({ error: 'attachment storage for this project is full (200 MB)' }, 413);
}

/**
 * Robust Content-Disposition: sanitized ASCII fallback (no CR/LF/control chars/
 * quotes/backslashes, non-ASCII -> _) + RFC 5987 filename* for the real UTF-8
 * name. Prevents header injection from malicious filenames and mangled names.
 */
function contentDisposition(filename: string, inline: boolean, mime: string): string {
  const disp = inline ? 'inline' : 'attachment';
  // The cut can drop the extension (non-ASCII becomes "_" per UTF-16 unit, so
  // a name of emoji doubles in length): the type's extension is checked again
  // after it.
  const ascii = nameForType(
    filename
      .replace(/[\\"\r\n\t\x00-\x1f\x7f]/g, '')
      .replace(/[^\x20-\x7e]/g, '_')
      .slice(0, 200) || 'file',
    mime,
  );
  const utf8 = encodeURIComponent(filename).replace(
    /['()*]/g,
    (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `${disp}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/**
 * User from a read-only URL (?at=, 'att' token): valid only for the
 * attachments of the token's project, only for GET, for 10 minutes.
 * Revocations and role: a token that ignored revocations and demotion would
 * let a signed-out user or an admin removed from ADMIN_EMAILS still open the
 * files for 10 minutes. So it carries iat (without it, it is not valid), it is
 * checked with isRevoked like the session, the role goes through
 * applyAdminList and the caller checks access to the project
 * (userCanAccess, i.e. the membership).
 */
async function resolveAttachmentUrl(c: Context<{ Bindings: Env }>): Promise<{ user: User; pid: string } | null> {
  const at = c.req.query('at') || '';
  if (!at) return null;
  const p = await verifyTyped<AttachmentUrlToken>('att', at, c.env.SESSION_SECRET);
  if (!p || typeof p.pid !== 'string' || typeof p.uid !== 'string') return null;
  if (typeof p.exp !== 'number' || p.exp < Date.now()) return null;
  if (typeof p.iat !== 'number' || (await isRevoked(c.env, p.uid, p.iat))) return null;
  const found = await db.getUserById(c.env.DB, p.uid);
  const user = found ? await applyAdminList(c.env, found) : null;
  return user ? { user, pid: p.pid } : null;
}

/** Downloads or displays an attachment. */
app.get('/api/attachments/:id', async (c) => {
  const aid = c.req.param('id');
  const viaUrl = await resolveAttachmentUrl(c);
  const auth = viaUrl ? { user: viaUrl.user, widgetPid: null } : await resolveUser(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  const att = await db.getAttachment(c.env.DB, aid);
  if (!att) return c.json({ error: 'not found' }, 404);
  // The URL is valid only for the attachments of its token's project.
  if (viaUrl && viaUrl.pid !== att.project_id) return c.json({ error: 'forbidden' }, 403);
  const ok = auth.widgetPid
    ? auth.widgetPid === att.project_id
    : await db.userCanAccess(c.env.DB, auth.user, att.project_id);
  if (!ok) return c.json({ error: 'forbidden' }, 403);
  const obj = await c.env.ATTACHMENTS.get(att.r2_key);
  if (!obj) return c.json({ error: 'file not found' }, 404);
  // Inline only for allowlisted images (PNG/JPEG/WebP/GIF). PDFs are
  // always attachment (PDF.js can run JS in the domain). Other types
  // should not exist in the DB after validation, but attachment is
  // the failsafe for legacy rows.
  const inline = isInlineSafe(att.content_type);
  return new Response(obj.body, {
    headers: {
      'Content-Type': att.content_type,
      // The name agrees with the served type here too: rows stored before the
      // upload aligned it are covered as well.
      'Content-Disposition': contentDisposition(nameForType(att.filename, att.content_type), inline, att.content_type),
      // no-store: with max-age=3600 a deleted file, or one of a user removed
      // from the project, would stay openable from the browser cache for an
      // hour. The ?at= URLs change on every list anyway: caching would save
      // almost nothing.
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      // Specific CSP for the attached file. Even though it is allowlisted
      // PNG/JPEG/WebP/GIF/PDF, if the browser interpreted the body as
      // HTML (sniffing disabled by nosniff, but defense-in-depth) the 'none'
      // CSP would prevent any script from running.
      'Content-Security-Policy':
        "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
});

/**
 * Deletes a single attachment (R2 blob + D1 record). Without it there would be
 * no way to remove a photo (neither from a draft nor from an already sent
 * comment) other than deleting the whole comment.
 *
 * Two-case authorization:
 * - DRAFT attachment (comment_id IS NULL, upload started but comment not yet
 *   sent): only whoever uploaded it (created_by). Used by the X on the draft to
 *   avoid leaving R2/D1 orphans.
 * - attachment LINKED to a comment: whoever uploaded it OR a project admin
 *   (a global admin everywhere, a collab on their own sites).
 */
app.delete('/api/attachments/:id', async (c) => {
  const auth = await resolveUser(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  if (!csrfOkFor(c, auth)) return c.json({ error: CSRF_ERR }, 403);
  // Per-user shield before any write (rate-limit.ts).
  const shield = await userShield(c, auth.user.id);
  if (shield) return shield;
  const att = await db.getAttachment(c.env.DB, c.req.param('id'));
  if (!att) return c.json({ error: 'not found' }, 404);
  const ok = auth.widgetPid
    ? auth.widgetPid === att.project_id
    : await db.userCanAccess(c.env.DB, auth.user, att.project_id);
  if (!ok) return c.json({ error: 'forbidden' }, 403);
  const isOwner = att.created_by === auth.user.id;
  const isDraft = att.comment_id == null;
  // Draft: only the uploader. Linked: the uploader, or a project admin but only
  // from the app session (with the widget-token you can remove only your own files).
  if (!isOwner) {
    if (isDraft) return c.json({ error: 'forbidden' }, 403);
    if (auth.widgetPid) return c.json({ error: APP_ONLY_ERR }, 403);
    if (!(await db.canAdmin(c.env.DB, auth.user, att.project_id))) {
      return c.json({ error: 'forbidden' }, 403);
    }
  }
  // The blob first, then the row (see worker/r2.ts).
  const r2 = await deleteR2InBatches(c.env.ATTACHMENTS, [att.r2_key]);
  if (r2.failed) return c.json({ error: 'delete failed, try again' }, 502);
  await db.deleteAttachment(c.env.DB, att.id);
  return c.json({ ok: true });
});

/**
 * REAL server-side screenshot, the way markup tools do it. The widget sends
 * url + viewport + scroll + click coordinates; here a headless Chrome (Browser
 * Rendering) opens the page, scrolls to the same point, draws the dot where
 * the client clicked and takes the viewport screenshot.
 * Pixel-perfect rendering (real Chrome: real fonts/images, no server-side CORS).
 * The screenshot is saved as an R2 attachment and linked to the comment.
 *
 * Security: widget-token auth (Authorization header) + the URL MUST be on the origin of the
 * project's staging site (no SSRF: an arbitrary URL is never screenshotted).
 * Per-user rate limit (Browser Run has a cost).
 */
app.post('/api/projects/:slug/shot', async (c) => {
  const auth = await resolveUser(c);
  if (!auth) return c.json({ error: 'unauthorized' }, 401);
  if (!csrfOkFor(c, auth)) return c.json({ error: CSRF_ERR }, 403);
  // Per-user shield before any write (rate-limit.ts).
  const shield = await userShield(c, auth.user.id);
  if (shield) return shield;
  const project = await db.getProjectBySlug(c.env.DB, c.req.param('slug'));
  if (!project) return c.json({ error: 'project not found' }, 404);
  const ok = auth.widgetPid
    ? auth.widgetPid === project.id
    : await db.userCanAccess(c.env.DB, auth.user, project.id);
  if (!ok) return c.json({ error: 'forbidden' }, 403);
  if (!c.env.BROWSER) return c.json({ error: 'browser not available' }, 503);
  // Declared size BEFORE reading the body and consuming the limits:
  // without Content-Length 411, over the cap 413.
  const declared = declaredLength(c.req.header('content-length'));
  if (declared === null) return c.json({ error: 'Content-Length required' }, 411);
  if (declared > MAX_SHOT_BODY) return c.json({ error: 'page too large for a screenshot' }, 413);

  // Limits: 1 screenshot = 1 timed Chrome session (cost).
  // Per user per minute and per project per day; fail-closed. The screenshot
  // becomes an attachment: it also counts towards the project's storage quota.
  const rl = await consumeRateLimit(c.env.DB, 'shot-user', auth.user.id, SHOT_PER_USER_MIN, 60, { fail: 'closed' });
  const blocked = applyRateLimit(c, rl, SHOT_PER_USER_MIN, 'too many screenshots in a row, wait a moment');
  if (blocked) return blocked;
  // Per user per day BEFORE the project cap: a widget-token read by a
  // third-party script cannot burn all of the project's screenshots for the
  // day.
  const rlu = await consumeRateLimit(c.env.DB, 'shot-user-day', auth.user.id, SHOT_PER_USER_DAY, 86400, { fail: 'closed' });
  const blockedU = applyRateLimit(c, rlu, SHOT_PER_USER_DAY, 'too many screenshots today, try again tomorrow');
  if (blockedU) return blockedU;
  const rlp = await consumeRateLimit(c.env.DB, 'shot-project', project.id, SHOT_PER_PROJECT_DAY, 86400, { fail: 'closed' });
  const blockedP = applyRateLimit(c, rlp, SHOT_PER_PROJECT_DAY, 'too many screenshots today for this project');
  if (blockedP) return blockedP;
  const shotUsage = await db.projectAttachmentUsage(c.env.DB, project.id);
  if (shotUsage.bytes >= PROJECT_QUOTA_BYTES) {
    return c.json({ error: 'attachment storage for this project is full (200 MB)' }, 413);
  }
  if (shotUsage.count >= PROJECT_MAX_ATTACHMENTS) {
    return c.json({ error: 'too many attachments in the project (max ' + PROJECT_MAX_ATTACHMENTS + ')' }, 413);
  }

  // Content-Length is already checked above; here the text actually read.
  const rawBody = await c.req.text().catch(() => '');
  if (rawBody.length > MAX_SHOT_BODY) return c.json({ error: 'page too large for a screenshot' }, 413);
  let body: {
    url?: string; html?: string; vw?: number; vh?: number; dpr?: number;
    sx?: number; sy?: number; mx?: number; my?: number;
  } = {};
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (parsed && typeof parsed === 'object') body = parsed as typeof body;
  } catch {
    body = {};
  }
  // 'html' mode (the widget's default): snapshot of the client's DOM with the
  // DYNAMIC STATE already inside (open modal/carousel/pill). 'url' mode
  // (fallback): Chrome reloads the page (losing the dynamic state). An html
  // over MAX_SHOT_HTML is ignored and url mode is used.
  const html =
    typeof body.html === 'string' && body.html.length > 0 && body.html.length <= MAX_SHOT_HTML
      ? body.html
      : null;

  let stagingOrigin: string;
  try {
    const st = new URL(project.staging_url);
    if ((st.protocol !== 'https:' && st.protocol !== 'http:') || isBlockedHost(st.hostname)) {
      return c.json({ error: 'staging url not allowed for screenshots' }, 400);
    }
    stagingOrigin = st.origin;
  } catch {
    return c.json({ error: 'project has no staging url' }, 500);
  }
  // The staging name must resolve ONLY to public addresses:
  // 127.0.0.1.nip.io or an A record pointing to the internal network do not
  // pass. Fail-closed: if the name does not resolve, no screenshot.
  const verdict = await hostVerdict(new URL(stagingOrigin).hostname);
  if (verdict !== 'public') {
    const msg = verdict === 'internal' ? 'staging url not allowed for screenshots' : 'staging not reachable';
    return c.json({ error: msg }, 400);
  }
  const assetOrigins = shotAssetOrigins(c.env);
  // url mode: SSRF guard, the URL must be on the project's staging origin.
  let target: URL | null = null;
  if (!html) {
    try {
      target = new URL(String(body.url || ''));
    } catch {
      return c.json({ error: 'invalid url' }, 400);
    }
    if (target.origin !== stagingOrigin) {
      return c.json({ error: 'url outside the project' }, 403);
    }
  }

  const vw = Math.min(Math.max(Math.round(body.vw || 1280), 320), 2560);
  const vh = Math.min(Math.max(Math.round(body.vh || 900), 320), 2000);
  const dpr = Math.min(Math.max(body.dpr || 1, 1), 2);
  const sx = Math.max(Math.round(body.sx || 0), 0);
  const sy = Math.max(Math.round(body.sy || 0), 0);
  const mx = body.mx != null ? Math.round(body.mx) : null;
  const my = body.my != null ? Math.round(body.my) : null;
  // The markup is prepared BEFORE a browser is launched: the work on the
  // caller's input never runs while a Browser Run session is open.
  const snap = html ? prepareShotHtml(html, stagingOrigin) : '';

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;
  const started = Date.now();
  // The whole screenshot (browser launch included) within
  // SHOT_TOTAL_TIMEOUT_MS: beyond it the browser is closed and the response is 502.
  let timedOut = false;
  const capture = async (): Promise<Uint8Array> => {
    const launched = await puppeteer.launch(c.env.BROWSER as never);
    // Timed out while the browser was launching: close it immediately (no orphan sessions).
    if (timedOut) {
      await launched.close().catch(() => {});
      throw new Error('screenshot timed out');
    }
    browser = launched;
    const page = await launched.newPage();
    await page.setViewport({ width: vw, height: vh, deviceScaleFactor: dpr });
    // Emulates prefers-reduced-motion: a11y-conscious sites (e.g. GSAP +
    // matchMedia) show the FINAL STATE immediately instead of keeping the content
    // hidden behind intro/preloader animations -> the screenshot is not blank.
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
    if (html) {
      // Snapshot of the client's DOM: the DYNAMIC STATE (modal/carousel/pill)
      // is already in the markup. UNTRUSTED markup (sent by the client's browser):
      // JavaScript disabled BEFORE loading it, requests filtered (only the staging
      // origin + passive https assets), <script>/<noscript> removed, <base> forced
      // to the staging origin (see shot-guard.ts).
      await guardShotPage(page as unknown as ShotPageLike, stagingOrigin, 'html', assetOrigins);
      await page.setContent(snap, { waitUntil: 'load', timeout: SHOT_NAV_TIMEOUT_MS }).catch(() => {});
    } else if (target) {
      // Real staging page with the same request filter as html mode and
      // with JavaScript disabled here too (see guardShotPage in
      // shot-guard.ts).
      await guardShotPage(page as unknown as ShotPageLike, stagingOrigin, 'url', assetOrigins);
      // 'load' (not networkidle0: sites with animations/video never become idle).
      // Timeout swallowed: if it is slow, we capture whatever has rendered anyway.
      await page.goto(target.toString(), { waitUntil: 'load', timeout: SHOT_NAV_TIMEOUT_MS }).catch(() => {});
    }
    // evaluate passed as a STRING: it runs in the page context (DOM), not in the
    // worker -> keeps tsc from looking for window/document in the worker lib.
    await page.evaluate('window.scrollTo(' + sx + ',' + sy + ')');
    // settle: preloader + GSAP intro + lazy images + paint. ~2.8s = compromise
    // between fidelity and Browser Run cost, shortened as the cap nears.
    const left = SHOT_TOTAL_TIMEOUT_MS - (Date.now() - started) - 1500;
    await new Promise((r) => setTimeout(r, Math.max(0, Math.min(SHOT_SETTLE_MS, left))));
    // Draws the pin dot exactly where the client clicked
    // (viewport coordinates, position:fixed = relative to the screen after scrolling).
    if (mx != null && my != null) {
      const markerCss =
        'position:fixed;left:' + (mx - 13) + 'px;top:' + (my - 13) + 'px;width:26px;height:26px;' +
        'border-radius:50%;background:#0066cc;border:3px solid #fff;z-index:2147483647;' +
        'box-shadow:0 2px 10px rgba(15,23,42,.45);pointer-events:none';
      await page.evaluate(
        '(function(){var d=document.createElement("div");d.style.cssText=' +
        JSON.stringify(markerCss) +
        ';document.body.appendChild(d);})()',
      );
    }
    return (await page.screenshot({ type: 'jpeg', quality: 85 })) as Uint8Array;
  };
  try {
    const shot = await withDeadline(capture(), SHOT_TOTAL_TIMEOUT_MS, 'screenshot');
    const b = browser as { close: () => Promise<void> } | null;
    browser = null;
    if (b) await b.close().catch(() => {});

    // Saves as an R2 attachment + record (reuses the attachment pipeline):
    // row first, with the project's quotas inside the INSERT. The check before
    // the render can be passed by parallel requests; one that no longer fits
    // after rendering is discarded (the JPEG is never stored).
    const id = crypto.randomUUID();
    const key = 'att/' + id;
    const att = await db.createAttachment(
      c.env.DB,
      {
        id,
        project_id: project.id,
        r2_key: key,
        filename: 'pinna-screenshot.jpg',
        content_type: 'image/jpeg',
        size: shot.byteLength,
        created_by: auth.user.id,
      },
      { maxCount: PROJECT_MAX_ATTACHMENTS, maxBytes: PROJECT_QUOTA_BYTES },
    );
    if (!att) return attachmentQuotaError(c, project.id);
    try {
      await c.env.ATTACHMENTS.put(key, shot, { httpMetadata: { contentType: 'image/jpeg' } });
    } catch (e) {
      await db.deleteAttachment(c.env.DB, id).catch(() => 0);
      throw e;
    }
    return c.json(att, 201);
  } catch (e) {
    timedOut = true;
    const b = browser as { close: () => Promise<void> } | null;
    browser = null;
    if (b) await b.close().catch(() => {});
    // The detail (e.g. "429 Rate limit exceeded" from Browser Run under
    // burst) stays in the Worker logs (observability), NOT in the HTTP response:
    // no leak of internals to the client. The caller falls back gracefully.
    console.warn('[pinna] /shot failed:', (e as Error).message);
    // Counts the failure for the alert (Browser Run 429s under burst are the
    // signal of quota / cost exhaustion that needs to be noticed).
    c.executionCtx.waitUntil(recordError(c.env, 'shot'));
    return c.json({ error: 'screenshot failed' }, 502);
  }
});

// Proxy disabled until it is isolated (see PINNA_PROXY_ENABLED in types.ts).
app.all('/_proxy', (c) =>
  c.env.PINNA_PROXY_ENABLED === '1'
    ? handleProxy(c)
    : c.text('Pinna proxy is temporarily disabled.', 503, { 'Cache-Control': 'no-store' }),
);

// Everything else: serves the Pinna app (Vue SPA). Unknown APIs return 404.
// Adds a permissive CSP to the SPA HTML + X-Frame-Options
// SAMEORIGIN. Static assets (JS/CSS/fonts/img) inherit only HSTS +
// Permissions-Policy from the global middleware.
app.all('*', async (c) => {
  if (new URL(c.req.url).pathname.startsWith('/api/')) {
    return c.json({ error: 'not found' }, 404);
  }
  const resp = await c.env.ASSETS.fetch(c.req.raw);
  const ct = resp.headers.get('Content-Type') || '';
  if (!ct.includes('text/html')) return resp;
  const out = new Response(resp.body, resp);
  // Pinna SPA CSP: 'self' for own assets + img data: for inline previews +
  // frame-src 'https:' for the client's staging iframe (dynamic origin for
  // each project). frame-ancestors 'self' prevents the SPA from being
  // embedded in external sites (clickjacking protection).
  out.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "img-src 'self' data: blob:",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-src https:",
      "frame-ancestors 'self'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  );
  out.headers.set('X-Frame-Options', 'SAMEORIGIN');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  return out;
});

// Besides fetch (Hono app), a scheduled handler for GDPR retention.
// The Cron Trigger (wrangler.toml [triggers]) invokes it daily; it does not
// touch the request path, so live usage is not affected.
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      db.purgeRetention(env.DB).then(async (r) => {
        // Admins no longer in ADMIN_EMAILS: demoted even if they make no requests.
        const demoted = await syncAdmins(env).catch(() => 0);
        if (demoted) console.log(`[pinna] retention cron: ${demoted} admins demoted (ADMIN_EMAILS)`);
        const rl = await purgeRateLimits(env.DB);
        if (rl) console.log(`[pinna] retention cron: -${rl} rate_limits windows`);
        // Orphan attachments: R2 blobs in batches of 1,000, and each batch's D1
        // rows only after R2 has deleted it. If R2 fails, the rows stay and
        // tomorrow's cron retries.
        let orphanRows = 0;
        const r2 = await deleteR2InBatches(env.ATTACHMENTS, r.orphanKeys, async (batch) => {
          orphanRows += await db.deleteOrphanRows(env.DB, batch);
        });
        console.log(
          `[pinna] retention cron: -${r.magicLinks} magic_links, -${r.auditRows} admin_audit, -${orphanRows} orphan attachments` +
            (r2.failed ? ` (R2 failed, ${r.orphanKeys.length - r2.deleted} postponed)` : ''),
        );
        // Daily error digest (if there were any).
        await sendErrorDigest(env);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
