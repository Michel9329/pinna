/**
 * Pinna - defenses of /shot in html mode.
 *
 * In html mode the widget sends the client's serialized DOM and the Browser
 * Rendering Chrome opens it with setContent. A regex that strips <script> on
 * its own is not enough: it can be bypassed with onerror=, <svg><script>,
 * javascript:, <iframe> to third-party sites (which run THEIR OWN JavaScript).
 * So, on top of the regex:
 * - JavaScript is disabled in the browser (setJavaScriptEnabled(false)) before
 *   the markup is loaded;
 * - requests are filtered (shotRequestAllowed): the project's staging origin
 *   passes in full; outside it only passive assets (images, CSS, fonts, media)
 *   pass, via https, from the origins in PINNA_SHOT_ASSET_ORIGINS (allowing
 *   ANY public host would let the client's markup make Pinna's Chrome load
 *   resources from any site); documents, iframes, scripts, fetch/XHR to other
 *   origins are blocked;
 * - WebSocket, WebTransport, WebRTC and workers are disabled in the page
 *   (puppeteer's request interception does not see WebSockets);
 * - a cap on the size of the body and of the html.
 * The staging host name is resolved before every /shot (dns-guard.ts).
 */
import { isBlockedHost } from './proxy';
import type { Env } from './types';

/**
 * Origins from which /shot loads passive assets besides the staging site
 * (PINNA_SHOT_ASSET_ORIGINS, comma-separated list, e.g.
 * "https://cdn.sanity.io, https://cdn.shopify.com"). Only https and public
 * hosts; everything else is discarded. Empty = only the staging site and data:.
 */
export function shotAssetOrigins(env: Env): string[] {
  const out: string[] = [];
  for (const raw of (env.PINNA_SHOT_ASSET_ORIGINS || '').split(',')) {
    const v = raw.trim();
    if (!v) continue;
    try {
      const u = new URL(v);
      if (u.protocol === 'https:' && !isBlockedHost(u.hostname)) out.push(u.origin);
    } catch {
      /* invalid entry: discarded */
    }
  }
  return out;
}

/** Above this size the request body is rejected (413). */
export const MAX_SHOT_BODY = 6 * 1024 * 1024;
/** Above this length the html is ignored and url mode is used instead. */
export const MAX_SHOT_HTML = 3 * 1024 * 1024;

/**
 * Browser Run costs: every screenshot is a metered Chrome session, so
 * rate, per-project count and duration are all capped (looser settings, such
 * as 20 per minute per user, no per-project cap and up to 30 s of
 * setContent/goto + 2.8 s of waiting, cost far more).
 */
/** Screenshots per minute per user. */
export const SHOT_PER_USER_MIN = 5;
/** Screenshots per day per project (all users together). */
export const SHOT_PER_PROJECT_DAY = 150;
/**
 * Screenshots per day per user: the widget-token lives in the staging
 * document; a third-party script that reads it cannot burn all of the
 * project's screenshots for the day on its own, at most these.
 */
export const SHOT_PER_USER_DAY = 50;
/** Cap on setContent/goto: past it, whatever is there gets captured anyway. */
export const SHOT_NAV_TIMEOUT_MS = 6000;
/** Cap on the WHOLE screenshot (browser launch included). */
export const SHOT_TOTAL_TIMEOUT_MS = 10000;
/** Wait for animations and lazy images, inside the total cap. */
export const SHOT_SETTLE_MS = 2800;

/** Rejects if `p` does not settle within `ms` (the caller must stop the work). */
export function withDeadline<T>(p: Promise<T>, ms: number, label = 'deadline'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' after ' + ms + ' ms')), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

const PASSIVE = new Set(['image', 'stylesheet', 'font', 'media']);

/**
 * True if the /shot Chrome may make this request (html AND url mode: in url
 * mode, running the page's JavaScript with no filter at all would let it call
 * or open any address).
 * Documents and iframes only on the staging origin: no navigation outside it.
 * Outside the staging site only passive assets from `assetOrigins` (shotAssetOrigins).
 */
export function shotRequestAllowed(
  rawUrl: string,
  resourceType: string,
  stagingOrigin: string,
  assetOrigins: readonly string[] = [],
): boolean {
  if (rawUrl === 'about:blank' || rawUrl.startsWith('data:')) return true;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (u.origin === stagingOrigin) return !isBlockedHost(u.hostname);
  if (u.protocol !== 'https:' || isBlockedHost(u.hostname)) return false;
  return PASSIVE.has(resourceType) && assetOrigins.includes(u.origin);
}

/**
 * Script injected into every document before its own scripts
 * (evaluateOnNewDocument): disables the connections that request
 * interception does not see (WebSocket, WebTransport, WebRTC) and workers,
 * inside which it would not run.
 */
export const SHOT_BLOCK_SOCKETS_JS = [
  '(function(){',
  'var no=function(){throw new Error("Pinna /shot: connection blocked")};',
  'var n=["WebSocket","WebTransport","RTCPeerConnection","webkitRTCPeerConnection","Worker","SharedWorker"];',
  'for(var i=0;i<n.length;i++){try{Object.defineProperty(window,n[i],{value:no,writable:false,configurable:false})}catch(e){}}',
  'try{if(navigator.serviceWorker){Object.defineProperty(navigator.serviceWorker,"register",{value:function(){',
  'return Promise.reject(new Error("Pinna /shot: blocked"))},writable:false,configurable:false})}}catch(e){}',
  '})();',
].join('');

/** The part of the puppeteer page that guardShotPage uses (for tests). */
export interface ShotRequestLike {
  url(): string;
  resourceType(): string;
  continue(): Promise<void>;
  abort(): Promise<void>;
}
export interface ShotPageLike {
  setJavaScriptEnabled(enabled: boolean): Promise<void>;
  setRequestInterception(enabled: boolean): Promise<void>;
  on(event: 'request', handler: (req: ShotRequestLike) => void): unknown;
  evaluateOnNewDocument(script: string): Promise<unknown>;
  /** CDP session (puppeteer's Page.createCDPSession): blocks ws:// and wss:// at the network level too. */
  createCDPSession?(): Promise<{ send(method: string, params?: object): Promise<unknown> }>;
  /** Puppeteer's Page.setBypassServiceWorker: requests do not go through a service worker. */
  setBypassServiceWorker?(bypass: boolean): Promise<void>;
}

/**
 * Installs the request filter on the /shot page, in both modes: every
 * request goes through shotRequestAllowed (no fetch, scripts or navigation
 * outside the staging site).
 *
 * JavaScript is disabled in BOTH modes. In url mode the staging page's
 * JavaScript would run, and the defenses against the connections that
 * interception does not see are not reliable: the script that disables
 * WebSocket and workers applies to the page's documents but not inside a
 * worker or a service worker; a service worker's fetches start from its own
 * context and escape the page's filter; and Network.setBlockedURLs without
 * Network.enable most likely does nothing. Since there is no way to prove in
 * Browser Run that the block holds in every frame and worker, the page
 * runs without JavaScript: no WebSocket, workers, service workers or script
 * fetches. Cost: in url mode (the fallback when the client's DOM does not
 * arrive) a page that only renders with JavaScript comes out empty; html
 * mode, the default, already runs with JavaScript disabled.
 * Kept as extra defenses: setBypassServiceWorker(true), the script against
 * WebSocket/WebRTC/workers in every document, ws:// and wss:// blocked via CDP
 * after Network.enable.
 */
export async function guardShotPage(
  page: ShotPageLike,
  stagingOrigin: string,
  _mode: 'html' | 'url',
  assetOrigins: readonly string[] = [],
): Promise<void> {
  await page.setJavaScriptEnabled(false);
  try {
    await page.setBypassServiceWorker?.(true);
  } catch {
    /* not available: JavaScript being disabled is enough */
  }
  // Before any document: no WebSocket/WebRTC/workers.
  await page.evaluateOnNewDocument(SHOT_BLOCK_SOCKETS_JS);
  // Second barrier, at the network level: ws:// and wss:// blocked via CDP,
  // after Network.enable (without it, setBlockedURLs has no effect). If there
  // is no CDP session, disabled JavaScript and the script above remain.
  try {
    const cdp = await page.createCDPSession?.();
    await cdp?.send('Network.enable');
    await cdp?.send('Network.setBlockedURLs', { urls: ['ws://*', 'wss://*'] });
  } catch {
    /* CDP not available */
  }
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (shotRequestAllowed(req.url(), req.resourceType(), stagingOrigin, assetOrigins)) {
      req.continue().catch(() => {});
    } else {
      req.abort().catch(() => {});
    }
  });
}

/**
 * Prepares the client's DOM for setContent: removes <script> and <noscript>
 * (with JS disabled the content of <noscript> would be shown, e.g. "enable
 * JavaScript" or the GTM iframe), removes the document's <base> tags, and
 * forces a <base> on the staging origin (relative CSS, fonts and images load
 * from the real site).
 *
 * Linear time on any input. The same edits written as regular expressions
 * (/<script[\s\S]*?<\/script\s*>/gi, the <noscript> twin, /<base\b[^>]*>/gi,
 * /<head[^>]*>/i) are quadratic on up to 3 MB of caller-supplied markup such
 * as "<script" repeated with no closing tag: every opening rescans to the end.
 * The scans below give the same output as those expressions.
 */
export function prepareShotHtml(html: string, stagingOrigin: string): string {
  let snap = removeBaseTags(removeBlocks(removeBlocks(html, 'script'), 'noscript'));
  const baseTag = '<base href="' + stagingOrigin + '/">';
  const low = asciiLower(snap);
  const head = low.indexOf('<head');
  const headEnd = head === -1 ? -1 : low.indexOf('>', head + 5);
  snap = headEnd === -1
    ? baseTag + snap
    : snap.slice(0, head) + '<head' + snap.slice(head + 5, headEnd) + '>' + baseTag + snap.slice(headEnd + 1);
  return snap;
}

/**
 * Copy with only A-Z lowercased (same length, same indexes). The patterns are
 * ASCII, and a case-insensitive regular expression without the u flag matches
 * an ASCII letter only with an ASCII letter, so this matches like /i does.
 */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

/**
 * Removes every `<tag ... </tag\s*>` block, leftmost first, each ending at the
 * first closing tag after its opening (like a lazy /<tag[\s\S]*?<\/tag\s*>/gi).
 * An opening with no closing tag after it stays, and so does everything after
 * it: no later opening can have a closing tag either.
 */
function removeBlocks(s: string, tag: string): string {
  const low = asciiLower(s);
  const open = '<' + tag;
  const close = '</' + tag;
  let out = '';
  let pos = 0;
  for (;;) {
    const i = low.indexOf(open, pos);
    if (i === -1) break;
    const end = closingEnd(low, close, i + open.length);
    if (end === -1) break;
    out += s.slice(pos, i);
    pos = end;
  }
  return out + s.slice(pos);
}

/** End (exclusive) of the first `close` + whitespace + '>' at or after `from`, or -1. */
function closingEnd(low: string, close: string, from: number): number {
  for (let k = low.indexOf(close, from); k !== -1; k = low.indexOf(close, k + 1)) {
    let j = k + close.length;
    while (j < low.length && /\s/.test(low[j]!)) j++;
    if (low[j] === '>') return j + 1;
  }
  return -1;
}

/** Removes every `<base` tag (word boundary after "base", up to the first '>'). */
function removeBaseTags(s: string): string {
  const low = asciiLower(s);
  let out = '';
  let pos = 0;
  let from = 0;
  for (;;) {
    const i = low.indexOf('<base', from);
    if (i === -1) break;
    // \b: the next character is not [a-z0-9_] (or there is none).
    if (i + 5 < low.length && /[a-z0-9_]/.test(low[i + 5]!)) {
      from = i + 1;
      continue;
    }
    const gt = low.indexOf('>', i + 5);
    // No '>' after this tag: no later <base can be closed either.
    if (gt === -1) break;
    out += s.slice(pos, i);
    pos = from = gt + 1;
  }
  return out + s.slice(pos);
}
