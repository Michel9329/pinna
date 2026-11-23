/**
 * Pinna - auth: signed tokens (HMAC), cookie sessions, magic link, Resend email.
 * No passwords: the only way in is a magic link sent by email.
 */
import type { Env, User } from './types';

const enc = new TextEncoder();
const dec = new TextDecoder();

// --- Base64url ----------------------------------------------------------

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str: string): Uint8Array {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// --- HMAC ---------------------------------------------------------------

async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return new Uint8Array(sig);
}

/** Constant-time comparison (prevents timing attacks on the signature). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Signs a JSON payload: returns a "body.signature" token (base64url). */
export async function signToken(payload: object, secret: string): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = b64urlEncode(await hmac(secret, body));
  return body + '.' + sig;
}

/** Verifies a signed token. Returns the payload, or null if invalid. */
export async function verifyToken<T = unknown>(
  token: string,
  secret: string,
): Promise<T | null> {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64urlEncode(await hmac(secret, body));
  if (!safeEqual(sig, expected)) return null;
  try {
    return JSON.parse(dec.decode(b64urlDecode(body))) as T;
  } catch {
    return null;
  }
}

// --- Typed tokens -------------------------------------------------------
//
// Every token kind is signed with a DERIVED, distinct HMAC key
// (HMAC(SESSION_SECRET, "pinna-token-v2:<kind>")) and also carries the `typ`
// field, checked on verification. If session and widget tokens shared format
// and secret, readSession would accept a widget token (which travels via
// postMessage and ?wt=) as a session cookie. A token of one kind is not valid
// for another, and tokens signed with the bare secret are not valid at all
// (intended: everyone signs in again once).

// 'att': short-lived read-only attachment URLs, for the cases where the
// browser loads the file by itself (<img>, link, new tab) and cannot send the
// Authorization header. Valid for the attachments of ONE project, for one
// user (see AttachmentUrlToken).
export type TokenKind = 'session' | 'widget' | 'proxy' | 'att';

const derivedCache = new Map<string, string>();

async function kindSecret(secret: string, kind: TokenKind): Promise<string> {
  const cacheKey = kind + '\u0000' + secret;
  const hit = derivedCache.get(cacheKey);
  if (hit) return hit;
  const derived = b64urlEncode(await hmac(secret, 'pinna-token-v2:' + kind));
  derivedCache.set(cacheKey, derived);
  return derived;
}

/** Signs a token of the given kind (derived key + typ field). */
export async function signTyped(kind: TokenKind, payload: object, secret: string): Promise<string> {
  return signToken({ ...payload, typ: kind }, await kindSecret(secret, kind));
}

/** Verifies a token of the given kind. Null if signature, key or typ do not match. */
export async function verifyTyped<T = unknown>(
  kind: TokenKind,
  token: string,
  secret: string,
): Promise<(T & { typ: TokenKind }) | null> {
  if (!token) return null;
  const p = await verifyToken<T & { typ?: unknown }>(token, await kindSecret(secret, kind));
  if (!p || typeof p !== 'object' || p.typ !== kind) return null;
  return p as T & { typ: TokenKind };
}

// --- Hash + random ------------------------------------------------------

/** Hex SHA-256 (so magic link tokens are not stored in clear text). */
export async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', enc.encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Random url-safe 256-bit token (magic link, widget token). */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b64urlEncode(bytes);
}

/**
 * 6-digit sign-in code. The client TYPES it in their own browser instead of
 * clicking the link (which opens in the mail app's in-app browser, with the
 * cookie in the wrong jar). Uniform via rejection sampling: we discard the
 * tail above the largest multiple of 1e6 below 2^32, so the modulo does not
 * favor the low digits (no bias).
 */
export function generateOtp(): string {
  const buf = new Uint32Array(1);
  let n: number;
  do {
    crypto.getRandomValues(buf);
    n = buf[0] as number;
  } while (n >= 4_294_000_000); // 4_294_000_000 = largest multiple of 1_000_000 < 2^32
  return String(n % 1_000_000).padStart(6, '0');
}

// --- Session (signed cookie, stateless) ---------------------------------

const SESSION_DAYS = 30;

/**
 * Cookie names with the __Host- prefix: the browser accepts them only if
 * Secure, Path=/ and WITHOUT Domain, so a subdomain of the same domain cannot
 * plant its own session or CSRF cookie on Pinna's host (login CSRF / session
 * fixation).
 * The old unprefixed names are not read: everyone signs in again once, and
 * the old cookies are cleared at sign-in/sign-out.
 */
export const SESSION_COOKIE = '__Host-pinna_session';
export const CSRF_COOKIE = '__Host-pinna_csrf';
const LEGACY_COOKIES = ['pinna_session', 'pinna_csrf'];

/** Set-Cookie values that clear the old unprefixed cookies (to append at sign-in and sign-out). */
export function clearLegacyCookies(): string[] {
  return LEGACY_COOKIES.map((n) => n + '=; Path=/; Secure; SameSite=Lax; Max-Age=0');
}

/** Value of a cookie from the Cookie header (exact name), or null. */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  for (const part of (cookieHeader || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      const v = part.slice(i + 1).trim();
      return v || null;
    }
  }
  return null;
}

export interface Session {
  uid: string;
  role: 'admin' | 'client' | 'collab';
  exp: number;
  /** Issued at (epoch ms): compared against session_revocations. */
  iat: number;
}

/** Session cookie to put in Set-Cookie after sign-in. */
export async function makeSessionCookie(user: User, env: Env): Promise<string> {
  const session: Session = {
    uid: user.id,
    role: user.role,
    exp: Date.now() + SESSION_DAYS * 86400_000,
    iat: Date.now(),
  };
  const token = await signTyped('session', session, env.SESSION_SECRET);
  return [
    SESSION_COOKIE + '=' + token,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=' + SESSION_DAYS * 86400,
  ].join('; ');
}

/** Cookie that clears the session (sign-out). */
export function clearSessionCookie(): string {
  return SESSION_COOKIE + '=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

/**
 * CSRF cookie paired with the session.
 * Double-submit pattern: the SPA reads the cookie via JS and puts it in the
 * `X-CSRF-Token` header on POST/PATCH/DELETE; the server checks header == cookie.
 * NOT HttpOnly (it must be readable by JS), BUT SameSite=Strict to minimize
 * cross-site attacks.
 */
export function makeCsrfCookie(): string {
  const token = randomToken();
  return [
    CSRF_COOKIE + '=' + token,
    'Path=/',
    'Secure',
    'SameSite=Strict',
    'Max-Age=' + SESSION_DAYS * 86400,
  ].join('; ');
}

/** Cookie that clears the CSRF token (sign-out). */
export function clearCsrfCookie(): string {
  return CSRF_COOKIE + '=; Path=/; Secure; SameSite=Strict; Max-Age=0';
}

/** Reads and validates the session from the Cookie header. Null if missing/expired. */
export async function readSession(
  cookieHeader: string | undefined,
  env: Env,
): Promise<Session | null> {
  const raw = readCookie(cookieHeader, SESSION_COOKIE);
  if (!raw) return null;
  // Only 'session' tokens: a widget token or a proxy token is not valid here.
  const s = await verifyTyped<Session>('session', raw, env.SESSION_SECRET);
  if (!s || typeof s.uid !== 'string' || typeof s.exp !== 'number' || s.exp < Date.now()) return null;
  if (typeof s.iat !== 'number') return null;
  if (await isRevoked(env, s.uid, s.iat)) return null;
  return s;
}

/**
 * Revocation: a token (session or widget) issued before the user's cutoff in
 * session_revocations is no longer valid.
 * Failures: fail-open ONLY if the table does not exist yet (migration 0003
 * not applied: a deploy state, no revocation possible).
 * Any other D1 error = fail-closed: the token is not valid (a failure must
 * not let a signed-out user back in).
 */
export async function isRevoked(env: Env, uid: string, iat: number): Promise<boolean> {
  try {
    const row = await env.DB.prepare('SELECT revoked_before FROM session_revocations WHERE user_id = ?')
      .bind(uid)
      .first<{ revoked_before: number }>();
    return !!row && typeof row.revoked_before === 'number' && iat < row.revoked_before;
  } catch (e) {
    const msg = (e as Error).message || String(e);
    if (/no such table/i.test(msg)) {
      console.error('[pinna] session_revocations missing (migration 0003?), revocations not applied:', msg);
      return false;
    }
    console.error('[pinna] session_revocations unreadable (fail-closed):', msg);
    return true;
  }
}

/** Lifetime of the read-only attachment URL ('att' token). */
export const ATT_URL_MS = 10 * 60_000;

/**
 * Token for the read-only URLs. A token per attachment would mean that every
 * GET of the comment list signs one HMAC per file, and with a few thousand
 * attachments the list would exceed the free plan's CPU time and stop
 * answering. So there is ONE token per project and user, signed once per list
 * and put in every URL: valid only for GET, only for that project's
 * attachments, for 10 minutes, with revocations and membership checked on
 * every open. Whoever has the URL of one file and knows the id of another
 * file in the same project can open it: ids are random (UUID) and can only be
 * read from the comment list, that is, with access to the project.
 */
export interface AttachmentUrlToken {
  /** Project: the token is valid ONLY for this project's attachments. */
  pid: string;
  uid: string;
  exp: number;
  /** Issued at: checked against revocations like session and widget tokens. */
  iat: number;
}

/** Read-only token for a project's attachments (see TokenKind 'att'). */
export async function signAttachmentUrl(pid: string, uid: string, env: Env): Promise<string> {
  const now = Date.now();
  const payload: AttachmentUrlToken = { pid, uid, exp: now + ATT_URL_MS, iat: now };
  return signTyped('att', payload, env.SESSION_SECRET);
}

/**
 * True if the email is in the admin allowlist `ADMIN_EMAILS` (CSV).
 * Used at sign-in to give the 'admin' role (global admin).
 */
export function isAdminEmail(email: string, env: Env): boolean {
  const norm = email.trim().toLowerCase();
  if (!norm) return false;
  return adminEmails(env).includes(norm);
}

/**
 * The ADMIN_EMAILS addresses, normalized and in the order written. /entra
 * signs in to the first address that already has an admin account (see
 * entraUser in index.ts). Accepted separators: comma, semicolon, spaces and
 * newlines; with the comma alone, "a@example.com; b@example.com" would become
 * a single invalid address. Only entries shaped like name@domain are kept: a
 * list with no such entry is "not configured" (admins.ts adminListState), not
 * "no admins".
 *
 * Quotes and angle brackets: a list pasted with the README's quotes
 * ("a@example.com, b@example.com") would give `"a@example.com` and
 * `b@example.com"`, two entries with an @ that match nobody; "Name
 * <a@example.com>" would give `<a@example.com>`. So quotes (typographic ones
 * too), apostrophes, <> and brackets are stripped from every entry before the
 * check: a@example.com and b@example.com remain.
 */
const ADMIN_EMAIL_JUNK = /["'`<>()[\]«»‘’“”]/g;
export function adminEmails(env: Env): string[] {
  return (env.ADMIN_EMAILS || '')
    .split(/[,;\s]+/)
    .map((e) => e.replace(ADMIN_EMAIL_JUNK, '').trim().toLowerCase())
    .filter((e) => /^[^@\s]+@[^@\s]+$/.test(e));
}

/**
 * EXPLICIT dev mode: a missing RESEND_API_KEY alone must not make
 * /auth/request put the link and the code in the response, otherwise anyone
 * could sign in with anyone's email. Both are required: PINNA_DEV_MODE=1 AND
 * a request to localhost.
 * In production (a real domain) it never triggers, whatever the configuration.
 *
 * Caution: `bun run dev` passes --local-upstream localhost:8787, which
 * rewrites the host of EVERY request to localhost, including requests coming
 * from the local network. So the host check below is not enough on its own:
 * wrangler dev must listen only on 127.0.0.1 (--ip 127.0.0.1 in the script
 * and [dev] ip in wrangler.toml). Never --ip 0.0.0.0 with dev mode.
 */
export function isDevMode(env: Env, requestUrl: string): boolean {
  if (env.PINNA_DEV_MODE !== '1') return false;
  let host = '';
  try {
    host = new URL(requestUrl).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

// --- Email (Resend) -----------------------------------------------------

/** Minimal escaping of HTML characters (for text inserted into email markup). */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      case "'": return '&#39;';
      default: return ch;
    }
  });
}

/** HTML of the magic link email. Inline styles for email client compatibility. */
export function magicEmailHtml(
  link: string,
  code?: string | null,
  name?: string | null,
): string {
  // The name comes from the DB (set at invite time): escaped for safety, a
  // name with HTML characters must not be able to inject markup into the email.
  const greeting = name && name.trim() ? 'Hi ' + escapeHtml(name.trim()) + ',' : 'Hi,';
  const font =
    "'Poppins',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  // Logo from the same origin as the link (never a hardcoded domain).
  let origin = '';
  try {
    origin = new URL(link).origin;
  } catch {
    origin = '';
  }
  // 6-digit code block. The key message for the client: TYPE the code on the
  // sign-in page (so you stay in your own browser) instead of clicking the
  // link from the mail app.
  const codeBlock = code
    ? [
        '<tr><td style="padding:20px 36px 0;font-family:', font, ';">',
        '<p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:0.12em;',
        'text-transform:uppercase;color:#64748b;">Your sign-in code</p>',
        '<div style="padding:14px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;',
        "font-family:'SF Mono',ui-monospace,Menlo,Consolas,monospace;font-size:30px;font-weight:700;",
        'letter-spacing:0.18em;text-align:center;color:#0a4fae;">', escapeHtml(code), '</div>',
        '<p style="margin:9px 0 0;font-size:13px;line-height:1.55;color:#64748b;">',
        'Enter it on the Pinna page you have open in your browser.</p>',
        '</td></tr>',
      ].join('')
    : '';
  return [
    '<!doctype html><html><body style="margin:0;background:#f4f6fa;font-family:', font, ';">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ',
    'style="background:#f4f6fa;padding:72px 16px;"><tr><td align="center">',
    '<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;max-width:480px;',
    'background:#ffffff;border:1px solid #e6eaf0;border-radius:18px;">',
    '<tr><td style="padding:28px 36px 4px 20px;"><img ',
    'src="', origin, '/pinna-wordmark-email.png" ',
    'alt="Pinna" width="150" style="display:block;border:0;" /></td></tr>',
    '<tr><td style="padding:16px 36px 4px;font-family:', font, ';">',
    '<p style="margin:0;font-size:16px;color:#1e293b;">', greeting, '</p>',
    '<p style="margin:12px 0 0;font-size:16px;line-height:1.62;color:#1e293b;">',
    'You asked to sign in to Pinna to review the site.</p></td></tr>',
    codeBlock,
    '<tr><td style="padding:22px 36px 32px;">',
    '<p style="margin:0 0 12px;font-size:13px;line-height:1.55;color:#64748b;">',
    'Or tap the button to sign in directly. It is valid for 90 minutes:</p>',
    '<a href="', link,'" style="display:inline-block;font-family:', font,
    ';background:#0066cc;color:#ffffff;text-decoration:none;padding:15px 34px;',
    'border-radius:999px;font-size:16px;font-weight:600;">Sign in to Pinna</a>',
    '<p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#64748b;">',
    'Once you are in, you stay signed in for 30 days: during that time you can reopen ',
    'Pinna without signing in again.</p></td></tr>',
    '<tr><td style="padding:18px 36px 26px;border-top:1px solid #eef1f5;font-family:', font, ';">',
    '<p style="margin:0;font-size:12.5px;line-height:1.6;color:#94a3b8;">',
    'If you did not request this sign-in, you can ignore this email. ',
    'Pinna is a visual feedback tool for websites.</p></td></tr>',
    '</table></td></tr></table></body></html>',
  ].join('');
}

/**
 * Sends the magic link via Resend. Without RESEND_API_KEY it returns the
 * link: the caller uses it ONLY in dev mode (isDevMode), otherwise it answers
 * 503 before even getting here.
 */
export async function sendMagicEmail(
  email: string,
  link: string,
  code: string | null,
  name: string | null,
  env: Env,
): Promise<{ sent: boolean; status?: number; devLink?: string; devCode?: string }> {
  if (!env.RESEND_API_KEY) {
    return { sent: false, devLink: link, devCode: code ?? undefined };
  }
  const html = magicEmailHtml(link, code, name);
  const body = JSON.stringify({
    from: env.PINNA_FROM_EMAIL || 'Pinna <onboarding@resend.dev>',
    to: email,
    subject: 'Your Pinna sign-in link',
    html,
  });
  // One retry. A network/Resend blip must not leave the client without an
  // email (sign-in is the only way in). If the retry fails too, the caller
  // learns it from sent=false + status and answers with a VISIBLE error.
  let status = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + env.RESEND_API_KEY,
          'Content-Type': 'application/json',
        },
        body,
      });
      status = res.status;
      if (res.ok) return { sent: true, status };
      console.log('[pinna] resend send failed:', res.status, await res.text());
    } catch (e) {
      console.log('[pinna] resend send error:', (e as Error).message);
    }
  }
  return { sent: false, status };
}
