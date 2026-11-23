/**
 * Pinna - reverse-proxy MVP for "any URL" (Shopify/Wix/WordPress too).
 *
 * Problem: already-live third-party sites block the iframe (X-Frame-Options /
 * frame-ancestors), so they cannot be shown inside Pinna's frame to comment
 * on them. Solution: the Worker reverse-proxies ONLY the top-level HTML,
 * serves it from the pinna origin (so the same-origin SPA can frame it) and
 * injects pinna.js into it.
 *
 * Isolation: if the pages served from /_proxy ran on Pinna's origin, a
 * third-party site's script could use the user's session. So:
 * - EVERY proxy response (documents, subresources, errors) carries
 *   `Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups`
 *   without allow-same-origin: the document has an opaque origin ("null"), it
 *   cannot read cookies, storage or responses of the Pinna APIs;
 * - the proxy does NOT read the session cookie: it authenticates with a
 *   signed token of type 'proxy' in the URL (?pinna_pt=), bound to user,
 *   project and the project's staging ORIGIN, short-lived; it rejects every URL
 *   (and every redirect) outside that origin. The token travels in the
 *   rewritten URLs (passthrough);
 * - the widget inside the proxied page talks to the app via postMessage from
 *   origin "null": the app only accepts messages whose source is its own
 *   iframe and that carry a proxy-token it issued (see ProjectView.vue).
 *
 * MVP choices (honest about the limits):
 * - static assets (CSS/JS/img) are NOT proxied: a <base href> makes them
 *   resolve directly on the target site's origin. This avoids the Worker's
 *   subrequest limits (50/invocation on the free plan) and egress bandwidth.
 *   Browsers load cross-origin CSS/JS/img without CORS, so they render.
 * - The target's same-origin DYNAMIC requests (fetch/XHR/form/click) DO go
 *   through the proxy: an interceptor injected into the page reroutes them to
 *   /_proxy?...&pinna_sub=1, so they become "same-origin pinna" and do not hit
 *   CORS. This makes cart/live search/forms of Shopify & co. work.
 * - Auth + comments stay on the existing flow: the widget is dormant until
 *   the parent (Pinna SPA) sends it the 'pinna-init' postMessage handshake
 *   with the widget-token. The proxy does not touch that mechanism.
 * - Per-page anchoring in proxy mode: location.pathname inside the frame is
 *   always '/_proxy', so we inject data-pinna-path = REAL path of the target
 *   and the widget uses it as page_path (otherwise all comments collapse onto
 *   a single path). See pinna.js (var PATH).
 *
 * Remaining known MVP limits (documented, out of scope by choice):
 * - the target's cross-origin requests (analytics, CDN, third-party APIs) are
 *   NOT proxied: they either already have CORS or are fire-and-forget;
 * - the target's session cookies do NOT persist (we do not forward our
 *   Cookie to the target and do not relay its Set-Cookie on the pinna origin):
 *   "logged-in" cart/checkout/login areas can lose state. The Pinna proxy is
 *   for commenting on LOOK and CONTENT, not for testing the funnel;
 * - a direct location.href = '...' cannot be intercepted (Location is unforgeable):
 *   a custom JS menu/button that uses it leaves the frame (single interaction);
 * - the target's realtime SSE/WebSocket and Service Worker are not handled
 *   (absent on brochure sites; the SW is rejected natively cross-origin anyway);
 * - comment anchoring per page = PATHNAME only (like direct mode): pages
 *   that differ only by query (?id=5 vs ?id=9, legacy routing) share their
 *   comments. Path-based brochure sites (the norm) are not affected;
 * - SPA sites with routing delegated on document: internal clicks become
 *   proxied full reloads instead of client-side transitions (see proxyInterceptorSource).
 */
import type { Context } from 'hono';
import type { Env } from './types';
import { signTyped, verifyTyped } from './auth';
import * as db from './db';
import { applyAdminList } from './admins';
import { consumeRateLimit } from './rate-limit';
import { declaredLength } from './upload-guard';

/** Proxy-token lifetime: short, like the widget-token. Expired -> a page that
 *  asks the app to reload with a new token (see expiredPage). */
export const PROXY_TOKEN_MS = 1 * 3600_000;

/** Proxy-token payload (signed with the derived 'proxy' key). */
export interface ProxyToken {
  uid: string;
  pid: string;
  /** The project's staging origin at issue time. */
  o: string;
  exp: number;
}

/** Origin (scheme+host+port) of a URL, or null if it is not valid http(s). */
export function originOf(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/** Issues a proxy-token for user + project, bound to the staging origin. */
export async function makeProxyToken(
  uid: string,
  pid: string,
  stagingUrl: string,
  secret: string,
  ttlMs: number = PROXY_TOKEN_MS,
): Promise<string | null> {
  const o = originOf(stagingUrl);
  if (!o) return null;
  const payload: ProxyToken = { uid, pid, o, exp: Date.now() + ttlMs };
  return signTyped('proxy', payload, secret);
}

/** CSP of every proxy response: sandboxed document (opaque origin). */
export const PROXY_CSP =
  "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox; frame-ancestors 'self'";

/** Per-user proxy rate limit (pages; HTML subresources count as pages, see handleProxy). */
const PROXY_RL_LIMIT = 60; // pages per minute per user (non-HTML subresources do not count)
const PROXY_RL_WINDOW = 60;

/**
 * Largest request body forwarded to the staging site (form posts, fetch/XHR).
 * Like the other routes with a body: Content-Length required (411) and
 * checked before reading (413), so the Worker never buffers an unbounded body.
 */
export const PROXY_BODY_MAX = 2 * 1024 * 1024;

/**
 * Headers common to ALL proxy responses. ACAO '*' (without credentials):
 * the sandboxed document has origin "null", so its fetch/XHR to /_proxy are
 * cross-origin; the proxy uses no cookies, so there is nothing private to
 * protect with credentials.
 */
function secure(h: Headers): Headers {
  h.set('Content-Security-Policy', PROXY_CSP);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'no-referrer');
  h.set('Cache-Control', 'no-store');
  h.set('Access-Control-Allow-Origin', '*');
  return h;
}

function plain(status: number, text: string): Response {
  return new Response(text, {
    status,
    headers: secure(new Headers({ 'content-type': 'text/plain; charset=utf-8' })),
  });
}

/**
 * Page shown when the proxy-token has expired (valid signature). It asks the
 * parent app to reload the URL with a new token. The message carries the old
 * token (the app recognizes it as its own) and the requested URL.
 */
function expiredPage(pt: string, url: string): Response {
  const cfg = JSON.stringify({ type: 'pinna-proxy-expired', pt, url })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
  const html =
    '<!doctype html><meta charset="utf-8"><title>Pinna</title>' +
    '<p style="font:15px system-ui,sans-serif;padding:24px;color:#334155">' +
    "The preview has expired and is being reloaded. If nothing happens, reload the Pinna page.</p>" +
    '<script>try{window.parent.postMessage(' + cfg + ',"*")}catch(e){}</script>';
  return new Response(html, {
    status: 401,
    headers: secure(new Headers({ 'content-type': 'text/html; charset=utf-8' })),
  });
}

// Anti-SSRF: no internal, loopback, link-local, private or reserved hosts.
// NB: this is a filter on the hostname, it does NOT mitigate DNS rebinding (a
// public host that resolves to an internal IP). Low severity on a Worker (no
// internal network behind fetch + metadata IP blocked), but a SaaS should
// cover every documented range.
//
// A list of regexes on the string is not enough: it lets through
// [::ffff:169.254.169.254] (which new URL normalizes to [::ffff:a9fe:a9fe]),
// [::], 100.64.0.0/10 and "x.internal." with a trailing dot. So the host is
// normalized (lowercase, no brackets or trailing dot) and, if it is an
// address, PARSED: an IPv6 with an IPv4 inside (mapped, compatible, NAT64) is
// reduced to the IPv4 and checked as such.

/** Blocked IPv4 ranges, as CIDR: [a, b, c, d, prefix bits]. */
const BLOCKED_V4: [number, number, number, number, number][] = [
  [0, 0, 0, 0, 8], // "this network"
  [10, 0, 0, 0, 8], // RFC1918
  [100, 64, 0, 0, 10], // CGNAT (RFC6598)
  [127, 0, 0, 0, 8], // loopback
  [169, 254, 0, 0, 16], // link-local + cloud metadata
  [172, 16, 0, 0, 12], // RFC1918
  [192, 0, 0, 0, 24], // IETF protocol assignments
  [192, 0, 2, 0, 24], // documentation
  [192, 88, 99, 0, 24], // 6to4 relay
  [192, 168, 0, 0, 16], // RFC1918
  [198, 18, 0, 0, 15], // benchmark
  [198, 51, 100, 0, 24], // documentation
  [203, 0, 113, 0, 24], // documentation
  [224, 0, 0, 0, 4], // multicast
  [240, 0, 0, 0, 4], // reserved + broadcast
];

function v4Blocked(o: number[]): boolean {
  const ip = ((o[0]! << 24) >>> 0) + (o[1]! << 16) + (o[2]! << 8) + o[3]!;
  return BLOCKED_V4.some(([a, b, c, d, bits]) => {
    const net = ((a << 24) >>> 0) + (b << 16) + (c << 8) + d;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return ((ip & mask) >>> 0) === ((net & mask) >>> 0);
  });
}

function parseV4(h: string): number[] | null {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const o = m.slice(1).map(Number);
  return o.every((n) => n <= 255) ? o : null;
}

/** IPv6 as 8 groups of 16 bits (accepts a trailing IPv4), or null. */
function parseV6(h: string): number[] | null {
  if (!h.includes(':')) return null;
  let s = h;
  // Trailing IPv4 (e.g. ::ffff:1.2.3.4) -> two hex groups.
  const v4 = s.match(/(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (v4) {
    const o = parseV4(v4[1]!);
    if (!o) return null;
    s = s.slice(0, s.length - v4[1]!.length) + ((o[0]! << 8) + o[1]!).toString(16) + ':' + ((o[2]! << 8) + o[3]!).toString(16);
  }
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const toNums = (x: string) => (x ? x.split(':') : []).map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN));
  const head = toNums(parts[0]!);
  const rest = parts.length === 2 ? toNums(parts[1]!) : [];
  let groups: number[];
  if (parts.length === 2) {
    if (head.length + rest.length > 7) return null;
    groups = [...head, ...Array<number>(8 - head.length - rest.length).fill(0), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || groups.some((g) => Number.isNaN(g))) return null;
  return groups;
}

function v6Blocked(g: number[]): boolean {
  const zero5 = g.slice(0, 5).every((x) => x === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated): IPv4 inside.
  if (zero5 && (g[5] === 0xffff || g[5] === 0)) {
    if (g[5] === 0 && g[6] === 0 && (g[7] === 0 || g[7] === 1)) return true; // :: and ::1
    return v4Blocked([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]);
  }
  // NAT64 64:ff9b::/96: IPv4 inside.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return v4Blocked([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]);
  }
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xffc0) === 0xfec0) return true; // site-local (deprecated) fec0::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8
  if (first === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (first === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return true; // discard 100::/64
  return false;
}

/** Names that never go out to the Internet. */
const BLOCKED_NAME = /(^|\.)(localhost|internal|local|localdomain|home\.arpa|intranet|lan)$/;

export function isBlockedHost(hostname: string): boolean {
  const h = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!h) return true;
  const v4 = parseV4(h);
  if (v4) return v4Blocked(v4);
  if (h.includes(':')) {
    const v6 = parseV6(h.replace(/%.*$/, ''));
    return v6 ? v6Blocked(v6) : true; // unparseable IPv6 address: blocked
  }
  // An all-numeric/hex name that is not a clean IPv4 (e.g. 0x7f.1,
  // 2130706433) only gets here if it did not go through new URL: blocked.
  if (/^[0-9.]+$/.test(h) || /^0x[0-9a-f.x]+$/.test(h)) return true;
  return BLOCKED_NAME.test(h);
}

const MAX_REDIRECTS = 5;

/**
 * Fetch that follows redirects MANUALLY, re-validating the host at every hop.
 * With redirect:'follow' a hostile target (untrusted by design) could answer
 * 302 to an internal host, bypassing BLOCKED_HOST. Here every Location goes
 * through isBlockedHost + the scheme check again. Returns the final response +
 * the effective URL (post-redirect, for <base>/interceptor).
 */
export async function fetchFollowingSafely(
  startUrl: string,
  init: { method: string; headers: Record<string, string>; body?: ArrayBuffer },
  allowedOrigin?: string,
): Promise<{ error?: Response; resp?: Response; finalUrl?: string }> {
  let url = startUrl;
  let method = init.method;
  let body = init.body;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let resp: Response;
    try {
      resp = await fetch(url, { method, headers: init.headers, body, redirect: 'manual' });
    } catch (e) {
      return { error: plain(502, 'Pinna proxy: fetch failed - ' + (e as Error).message) };
    }
    const status = resp.status;
    const loc = resp.headers.get('location');
    if (status >= 300 && status < 400 && loc) {
      let next: URL;
      try {
        next = new URL(loc, url);
      } catch {
        return { error: plain(502, 'Pinna proxy: invalid redirect') };
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') {
        return { error: plain(502, 'Pinna proxy: redirect scheme not supported') };
      }
      if (isBlockedHost(next.hostname)) {
        return { error: plain(403, 'Pinna proxy: redirect to a blocked host') };
      }
      // A redirect cannot lead outside the project's staging origin.
      if (allowedOrigin && next.origin !== allowedOrigin) {
        return {
          error: plain(
            403,
            "Pinna proxy: the site redirects outside the project's address (" +
              next.origin +
              "). Update the project's staging URL.",
          ),
        };
      }
      url = next.toString();
      // HTTP semantics: 301/302/303 on a method with a body -> the browser
      // re-issues it as GET without a body (POST-redirect-GET). 307/308 keep method+body.
      if ((status === 301 || status === 302 || status === 303) && method !== 'GET' && method !== 'HEAD') {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    return { resp, finalUrl: url };
  }
  return { error: plain(508, 'Pinna proxy: too many redirects') };
}

export async function handleProxy(c: Context<{ Bindings: Env }>): Promise<Response> {
  const method = c.req.method.toUpperCase();
  // CORS preflight of the proxied page's fetch/XHR (origin "null").
  // No side effects: it is answered without touching the target.
  if (method === 'OPTIONS') {
    const h = secure(new Headers());
    h.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    const reqHeaders = c.req.header('Access-Control-Request-Headers');
    if (reqHeaders) h.set('Access-Control-Allow-Headers', reqHeaders.slice(0, 1000));
    h.set('Access-Control-Max-Age', '600');
    return new Response(null, { status: 204, headers: h });
  }

  const reqUrl = new URL(c.req.url);
  const rawTarget = reqUrl.searchParams.get('url');
  // pinna_sub=1 marks a SUBRESOURCE (fetch/XHR relaunched by the interceptor):
  // raw relay, no <base>/injection/rewriting, and it does not count toward the
  // page limit. It does not apply to a navigation (Sec-Fetch-Dest document/iframe):
  // that is a page, whatever the query says.
  const dest = (c.req.header('Sec-Fetch-Dest') || '').toLowerCase();
  const isNavigation = dest === 'document' || dest === 'iframe' || dest === 'frame' || dest === 'embed' || dest === 'object';
  const isSub = reqUrl.searchParams.get('pinna_sub') === '1' && !isNavigation;

  // Auth gate: ONLY the proxy-token in the URL. The session cookie counts
  // for nothing here (the proxied document must not be able to act as the user).
  const pt = reqUrl.searchParams.get('pinna_pt') || '';
  const tok = await verifyTyped<ProxyToken>('proxy', pt, c.env.SESSION_SECRET);
  if (!tok || typeof tok.uid !== 'string' || typeof tok.pid !== 'string' || typeof tok.o !== 'string') {
    return plain(403, 'Pinna proxy: unauthorized access');
  }
  if (typeof tok.exp !== 'number' || tok.exp < Date.now()) {
    return isSub || method !== 'GET'
      ? plain(401, 'Pinna proxy: preview expired')
      : expiredPage(pt, rawTarget || '');
  }
  // The project must exist and still have the SAME staging origin the token
  // was issued for (if an admin changes the URL, old tokens die).
  const project = await db.getProject(c.env.DB, tok.pid);
  const allowedOrigin = project ? originOf(project.staging_url) : null;
  if (!project || !allowedOrigin || allowedOrigin !== tok.o) {
    return plain(403, 'Pinna proxy: invalid project');
  }
  // User still a member of the project: a removed membership (or an admin
  // removed from ADMIN_EMAILS) also closes the proxy, on pages AND
  // subresources. Checking pages only would let fetch, XHR and assets keep
  // passing with the old proxy-token for up to an hour after the revocation.
  // It costs two D1 reads per request (reads do not have the tight quota of
  // writes); the per-user limit stays on pages only.
  {
    const found = await db.getUserById(c.env.DB, tok.uid);
    const user = found ? await applyAdminList(c.env, found) : null;
    if (!user || !(await db.userCanAccess(c.env.DB, user, project.id))) {
      return plain(403, 'Pinna proxy: project access revoked');
    }
  }

  // Per-user rate limit on pages only (not on subresources): every consume
  // is a D1 write; also counting the images, CSS and JS of every page would
  // waste write quota without protecting anything more.
  // Subresources stay bound to the proxy-token and the staging origin.
  if (!isSub) {
    const rl = await consumeRateLimit(c.env.DB, 'proxy-user', tok.uid, PROXY_RL_LIMIT, PROXY_RL_WINDOW);
    if (!rl.allowed) {
      const r = plain(429, 'Pinna proxy: too many requests, wait a minute');
      r.headers.set('Retry-After', String(rl.retryAfter));
      return r;
    }
  }

  if (!rawTarget) return plain(400, 'Pinna proxy: missing ?url= parameter');
  let target: URL;
  try {
    target = new URL(rawTarget);
  } catch {
    return plain(400, 'Pinna proxy: invalid url');
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') {
    return plain(400, 'Pinna proxy: scheme not supported');
  }
  // Only the project's staging origin (any path under it).
  if (target.origin !== allowedOrigin) {
    return plain(403, "Pinna proxy: address outside the project's site");
  }
  if (isBlockedHost(target.hostname)) {
    return plain(403, 'Pinna proxy: blocked host');
  }
  // The slug comes from the token's project, not from the query (?p= ignored).
  const slug = project.slug;

  const selfOrigin = reqUrl.origin;

  // Forward method + body to the target (form POST, non-GET fetch/XHR). We
  // do NOT forward Pinna's Cookie (no leak of the admin session to the third-party site).
  const fwdHeaders: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Accept: isSub
      ? '*/*'
      : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  const hasBody = method !== 'GET' && method !== 'HEAD';
  let body: ArrayBuffer | undefined;
  if (hasBody) {
    // A request without a body (e.g. a plain DELETE) has nothing to measure;
    // one with a body needs its length declared and within the cap.
    if (c.req.raw.body !== null) {
      const declared = declaredLength(c.req.header('content-length'));
      if (declared === null) return plain(411, 'Pinna proxy: Content-Length required');
      if (declared > PROXY_BODY_MAX) return plain(413, 'Pinna proxy: request body too large');
    }
    const incomingCT = c.req.header('content-type');
    if (incomingCT) fwdHeaders['content-type'] = incomingCT;
    try {
      body = await c.req.raw.arrayBuffer();
    } catch {
      body = undefined;
    }
    if (body && body.byteLength > PROXY_BODY_MAX) return plain(413, 'Pinna proxy: request body too large');
  }

  const followed = await fetchFollowingSafely(
    target.toString(),
    { method, headers: fwdHeaders, body },
    allowedOrigin,
  );
  if (followed.error) return followed.error;
  const upstream = followed.resp!;
  // EFFECTIVE post-redirect URL: <base>, interceptor and link/form rewriting
  // resolve against it (a cross-host redirect must not use the old origin).
  let eff: URL;
  try {
    eff = new URL(followed.finalUrl!);
  } catch {
    eff = target;
  }
  const effOrigin = eff.origin;

  // Params to propagate in rewritten links/forms/fetches (everything except
  // 'url' and the internal markers): so navigation stays inside the proxy and
  // the widget re-initializes (pinna_pm/pinna_project/pinna_api/pinna_role + p).
  const passthrough = new URLSearchParams(reqUrl.searchParams);
  passthrough.delete('url');
  passthrough.delete('pinna_sub');
  const proxify = (abs: string): string => {
    const p = new URLSearchParams(passthrough);
    p.set('url', abs);
    return selfOrigin + '/_proxy?' + p.toString();
  };

  const ct = upstream.headers.get('content-type') || '';

  // Subresource (fetch/XHR): raw same-origin pinna relay, no injection.
  // The target's Set-Cookie/CSP are stripped (they must not touch our origin).
  // Status + content-type are kept so the target's JS reads the data.
  // The subresource carries the sandbox CSP too: if someone opened its URL
  // as a document (direct navigation) it would still stay in an opaque origin.
  if (isSub) {
    // An HTML response counts as a PAGE even if requested as a subresource:
    // otherwise pinna_sub=1 would bypass the page limit.
    if (ct.toLowerCase().includes('text/html')) {
      const rl = await consumeRateLimit(c.env.DB, 'proxy-user', tok.uid, PROXY_RL_LIMIT, PROXY_RL_WINDOW);
      if (!rl.allowed) {
        const r = plain(429, 'Pinna proxy: too many requests, wait a minute');
        r.headers.set('Retry-After', String(rl.retryAfter));
        return r;
      }
    }
    const h = new Headers();
    if (ct) h.set('content-type', ct);
    const cd = upstream.headers.get('content-disposition');
    if (cd) h.set('content-disposition', cd);
    return new Response(upstream.body, { status: upstream.status, headers: secure(h) });
  }

  // Top-level non-HTML (PDF, image, JSON, direct asset): raw passthrough.
  if (!ct.toLowerCase().includes('text/html')) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: secure(new Headers({ 'content-type': ct || 'application/octet-stream' })),
    });
  }

  // Absolute URL for our scripts: the <base> must NOT divert them to the target.
  // data-pinna-path = REAL path of the target (per-page anchoring in proxy mode).
  const apiBase = selfOrigin;
  const scriptTag =
    `<script src="${selfOrigin}/pinna.js" data-pinna-project="${escapeAttr(slug)}"` +
    ` data-pinna-path="${escapeAttr(eff.pathname || '/')}" data-pinna-api="${apiBase}"` +
    ` data-pinna-proxy="1"></script>`;
  const baseTag = `<base href="${escapeAttr(effOrigin)}/">`;

  // Interceptor injected as early as possible in <head>: it reroutes the
  // target's same-origin DYNAMIC requests to /_proxy (sub) so they do not break
  // on CORS. Config as JSON, escaped against a </script> breakout.
  const interceptorCfg = JSON.stringify({
    proxyBase: selfOrigin + '/_proxy',
    targetOrigin: effOrigin,
    current: eff.toString(),
    pass: passthrough.toString(),
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e');
  const interceptorTag = `<script>${proxyInterceptorSource(interceptorCfg)}</script>`;

  const rewriter = new HTMLRewriter()
    // 1. Remove CSP / X-Frame declared via <meta http-equiv> in the HTML
    //    (they would block our script or the framing) and rewrite a
    //    same-host meta refresh to /_proxy (otherwise it leaves the frame).
    .on('meta[http-equiv]', {
      element(el) {
        const k = (el.getAttribute('http-equiv') || '').toLowerCase();
        if (k === 'content-security-policy' || k === 'x-frame-options') {
          el.remove();
          return;
        }
        if (k === 'refresh') {
          const content = el.getAttribute('content') || '';
          const m = content.match(/^\s*([\d.]+)\s*;\s*url=(.+)$/i);
          if (!m || !m[2]) return;
          const delay = m[1] || '0';
          let abs: URL;
          try {
            abs = new URL(m[2].trim().replace(/^['"]|['"]$/g, ''), eff.toString());
          } catch {
            return;
          }
          if (abs.origin === effOrigin) {
            el.setAttribute('content', delay + ';url=' + proxify(abs.toString()));
          }
        }
      },
    })
    // 1b. Rewrites the target site's INTERNAL links -> they go through /_proxy,
    //     so clicking a link stays in the frame instead of going to the real site.
    .on('a[href]', {
      element(el) {
        const href = (el.getAttribute('href') || '').trim();
        if (!href) return;
        const low = href.toLowerCase();
        if (
          low.startsWith('#') ||
          low.startsWith('javascript:') ||
          low.startsWith('mailto:') ||
          low.startsWith('tel:') ||
          low.startsWith('data:')
        ) {
          return;
        }
        let abs: URL;
        try {
          abs = new URL(href, eff.toString());
        } catch {
          return;
        }
        if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
        if (abs.origin !== effOrigin) {
          // External link: in a new tab, with no opener or Referer. Otherwise
          // it would navigate the frame, and the external document would end
          // up in the app's iframe.
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
          return;
        }
        el.setAttribute('href', proxify(abs.toString()));
        el.removeAttribute('target'); // no _blank: stays in the iframe
      },
    })
    // 1c. Rewrites the action of same-host POST forms -> /_proxy (top-level
    //     navigation with the body forwarded by the Worker). GET forms are
    //     handled by the JS interceptor (an /_proxy action would be overwritten by the fields).
    .on('form[action]', {
      element(el) {
        const m = (el.getAttribute('method') || 'get').toLowerCase();
        if (m !== 'post') return; // GET -> JS interceptor
        const action = (el.getAttribute('action') || '').trim();
        if (!action) return; // empty action: native POST to the document URL (already proxied)
        const low = action.toLowerCase();
        if (low.startsWith('javascript:') || low.startsWith('#') || low.startsWith('data:')) return;
        let abs: URL;
        try {
          abs = new URL(action, eff.toString());
        } catch {
          return;
        }
        if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return;
        if (abs.origin !== effOrigin) return;
        el.setAttribute('action', proxify(abs.toString()));
      },
    })
    // 2. <base> + interceptor as the FIRST children of <head>: relative URLs
    //    resolve on the target's origin (assets) and the interceptor patches
    //    fetch/XHR/form/click/location before the target's scripts run.
    .on('head', {
      element(el) {
        el.prepend(baseTag + interceptorTag, { html: true });
      },
    })
    // 3. Injects pinna.js at the end of <body> (dormant until the SPA does the handshake).
    .on('body', {
      element(el) {
        el.append(scriptTag, { html: true });
      },
    });

  const transformed = rewriter.transform(upstream);
  // Keep the real status (the target's 404/500 must not be masked as 200).
  const outStatus = upstream.status >= 200 && upstream.status < 600 ? upstream.status : 200;
  // Sandbox CSP (opaque origin) + frameable ONLY by the Pinna SPA (frame-ancestors).
  // NB: no X-Frame-Options here (the SPA must be able to frame it).
  return new Response(transformed.body, {
    status: outStatus,
    headers: secure(new Headers({ 'content-type': 'text/html; charset=utf-8' })),
  });
}

/**
 * Source of the client-side interceptor (string injected inline).
 * Reroutes ONLY the target's same-origin requests to /_proxy:
 *  - fetch / XMLHttpRequest  -> sub (pinna_sub=1), no CORS;
 *  - clicks on <a> and form submits (GET and dynamic POST) -> navigation via proxy;
 *  - location.assign/replace + window.open + sendBeacon -> best effort.
 * The click/submit listeners run in the BUBBLE phase and skip if ev.defaultPrevented:
 * so an AJAX form or an SPA router that calls preventDefault on the element (React
 * onClick & co.) is NOT overridden. CAVEAT: a router that DELEGATES the click on
 * document in the bubble phase runs AFTER us (we are registered first), so on
 * those sites we force a PROXIED full reload instead of the client-side transition:
 * the page still loads correctly in the frame (fine for visual review),
 * but it is not SPA routing. Acceptable: the main target is full-reload brochure sites.
 * Cross-origin requests (CDN/analytics/third-party APIs) stay direct.
 * A direct location.href = '...' still cannot be intercepted (Location is unforgeable).
 */
function proxyInterceptorSource(cfgJson: string): string {
  return `(function(){
  var CFG = ${cfgJson};
  var PB = CFG.proxyBase, TO = CFG.targetOrigin, PASS = CFG.pass, CUR = CFG.current;
  function toProxy(u, sub){
    try {
      var abs = new URL(u, TO);
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return null;
      if (abs.origin !== TO) return null;            // same-origin target only
      if (abs.href.indexOf(PB) === 0) return null;   // already proxied
      var p = new URLSearchParams(PASS);
      p.set('url', abs.href);
      if (sub) p.set('pinna_sub', '1');
      return PB + '?' + p.toString();
    } catch(e){ return null; }
  }
  // fetch
  var _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function(input, init){
      try {
        if (typeof input === 'string' || input instanceof URL) {
          var px = toProxy(String(input), true);
          if (px) return _fetch.call(this, px, init);
        } else if (input && input.url) {
          var px2 = toProxy(input.url, true);
          if (px2) return _fetch.call(this, new Request(px2, input), init);
        }
      } catch(e){}
      return _fetch.call(this, input, init);
    };
  }
  // XMLHttpRequest
  var _open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m, url){
    try {
      var px = toProxy(String(url), true);
      if (px) { arguments[1] = px; }
    } catch(e){}
    return _open.apply(this, arguments);
  };
  // click on a same-origin-target <a> (also catches anchors injected by JS).
  // Bubble + defaultPrevented: respects whoever calls preventDefault on the element
  // (see CAVEAT in the docstring for SPA routers delegated on document).
  document.addEventListener('click', function(ev){
    try {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href');
      if (!href) return;
      var low = href.toLowerCase();
      if (low.charAt(0) === '#' || low.indexOf('javascript:') === 0 || low.indexOf('mailto:') === 0 || low.indexOf('tel:') === 0) return;
      var px = toProxy(href, false);
      if (px) { ev.preventDefault(); window.location.assign(px); return; }
      // External link added by the page's JS: new tab, no opener.
      // (Already proxied links, which start with PB, stay in the frame.)
      var ext = new URL(href, CUR);
      if ((ext.protocol === 'http:' || ext.protocol === 'https:') && ext.origin !== TO && ext.href.indexOf(PB) !== 0) {
        ev.preventDefault();
        window.open(ext.href, '_blank', 'noopener,noreferrer');
      }
    } catch(e){}
  }, false);
  // form submit (GET serialized; dynamic POST: action -> proxy). Bubble +
  // defaultPrevented: AJAX forms handled by the site stay untouched.
  document.addEventListener('submit', function(ev){
    try {
      if (ev.defaultPrevented) return;
      var f = ev.target;
      if (!f || f.tagName !== 'FORM') return;
      var m = (f.getAttribute('method') || 'get').toLowerCase();
      var raw = f.getAttribute('action');
      var abs;
      try { abs = raw ? new URL(raw, TO) : new URL(CUR); } catch(e){ return; }
      if (abs.origin !== TO) return;                 // form to a third party: leave it
      if (m === 'get') {
        ev.preventDefault();
        var fd = new URLSearchParams();
        new FormData(f).forEach(function(v, k){ if (typeof v === 'string') fd.append(k, v); }); // skips Files
        abs.search = fd.toString();
        var px = toProxy(abs.href, false);
        if (px) window.location.assign(px);
      } else if (raw) {
        // Dynamic POST with an explicit action not yet proxied (static forms
        // are already rewritten server-side). No preventDefault: native submit.
        var pxp = toProxy(abs.href, false);
        if (pxp && f.getAttribute('action') !== pxp) f.setAttribute('action', pxp);
      }
    } catch(e){}
  }, false);
  // location.assign / replace + window.open + sendBeacon (best-effort)
  try {
    var L = window.location;
    if (L.assign) { var _a = L.assign.bind(L); L.assign = function(u){ var px = toProxy(String(u), false); _a(px || u); }; }
    if (L.replace) { var _r = L.replace.bind(L); L.replace = function(u){ var px = toProxy(String(u), false); _r(px || u); }; }
  } catch(e){}
  if (window.open) {
    var _o = window.open;
    window.open = function(u, n, ff){ var px = u ? toProxy(String(u), false) : null; return _o.call(window, px || u, n, ff); };
  }
  if (navigator.sendBeacon) {
    var _b = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function(u, data){ var px = toProxy(String(u), true); return _b(px || u, data); };
  }
})();`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
