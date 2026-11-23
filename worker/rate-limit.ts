/**
 * Pinna - request limits.
 *
 * A fixed-window counter on KV, read and then rewritten, has two structural
 * flaws: (1) a parallel burst reads the same value and gets through in full;
 * (2) every request, even an anonymous one, is a KV write, and the free plan
 * allows 1,000 a day: a few hundred requests exhaust the quota and from then
 * on ALL limits become fail-open.
 *
 * So two tools, each where it fits:
 *
 * 1. Counter on D1 (rate_limits table, migration 0004) for the limits of
 *    authenticated users and for those with long windows (hour, day, bytes):
 *      - first a READ: if the threshold is already reached, reject without
 *        writing (whoever keeps going past the limit does not burn write quota);
 *      - then a single `INSERT ... ON CONFLICT DO UPDATE SET n = n + ? RETURNING n`
 *        that increments and reads in one atomic step: in a parallel burst
 *        every request gets a different n and only the first `limit` pass.
 *    D1 free: 100,000 writes and 5 million reads a day; old rows are removed
 *    by the cron (purgeRateLimits).
 *
 * 2. Workers Rate Limiting binding (ANON_RL in wrangler.toml) for the
 *    ANONYMOUS routes (login, code, admin key): it counts in memory at the
 *    Cloudflare location, no storage writes, no quota to exhaust.
 *    It is approximate (per location, period only 10 or 60 s), so it acts as a
 *    shield against bursts; the precise limits stay on D1, but only where the
 *    request already "belongs to someone" (registered email, logged-in user).
 *    Without the binding (tests, wrangler dev without config) it falls back to D1.
 *
 * Failures: `fail: 'closed'` on the routes that cost money (sending email,
 * /shot, upload): if the counter does not answer, reject with 503. The others
 * are fail-open (a D1 failure must not block a comment). Exception: missing
 * rate_limits table (migration 0004 not applied yet) = fail-open on the costly
 * ones too, with an error in the logs: it is a deploy state, not an attack,
 * and the deploy order must not be able to switch off login.
 */
import type { Context } from 'hono';
import type { Env } from './types';

type RLContext = Context<{ Bindings: Env }>;

export type FailMode = 'open' | 'closed';

/** Threshold of the ANON_RL binding: keep it equal to [[ratelimits]] in wrangler.toml. */
export const ANON_LIMIT = 10;
export const ANON_PERIOD = 60;

/**
 * IP key for the limits. Full IPv4; IPv6 reduced to the /64 (a single
 * client usually controls a whole one: limiting the exact address would mean
 * 2^64 free attempts). IPv4-mapped IPv6 -> IPv4.
 * With `prefix = 48` IPv6 is reduced to the /48: that is the key of the
 * ANON_RL shield on the anonymous routes (see getAnonIp).
 */
export function ipKey(raw: string, prefix: 48 | 64 = 64): string {
  const ip = raw.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!ip.includes(':')) return ip;
  const mapped = ip.match(/^[0:]*ffff:(\d+\.\d+\.\d+\.\d+)$/) || ip.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1] as string;
  // Expand '::' and the abbreviated forms.
  const parts = ip.split('::');
  const h = parts[0] ? parts[0].split(':') : [];
  let groups: string[];
  if (parts.length < 2) {
    groups = h;
  } else {
    const t = parts[1] ? parts[1].split(':') : [];
    const fill = Math.max(0, 8 - h.length - t.length);
    groups = [...h, ...Array<string>(fill).fill('0'), ...t];
  }
  const n = prefix === 48 ? 3 : 4;
  const head = groups.slice(0, n).map((g) => (g || '0').replace(/^0+(?=.)/, ''));
  while (head.length < n) head.push('0');
  return head.join(':') + '::/' + prefix;
}

/**
 * Client IP behind Cloudflare, already as a limit key (see ipKey).
 * Uses ONLY CF-Connecting-IP: on CF it is always set by the edge and cannot
 * be forged by the client. X-Forwarded-For is NOT used (spoofable: rotating
 * the header would bypass the per-IP limit). If missing (local dev) -> null and
 * the per-IP limit is skipped (the others remain).
 */
export function getClientIp(c: RLContext): string | null {
  const cf = c.req.header('CF-Connecting-IP');
  return cf && cf.trim() ? ipKey(cf) : null;
}

/**
 * IP key for the ANON_RL shield of the anonymous routes (login, code, admin
 * key): like getClientIp, but IPv6 reduced to the /48. Whoever has a /48 (any
 * hosting provider hands one out) controls 65,536 /64s: with the key on the
 * /64 they would multiply the shield threshold by as much. The shield counts
 * in memory, so the wider key costs no writes; the precise limits on D1
 * (registered emails, logged-in users) stay on the /64.
 */
export function getAnonIp(c: RLContext): string | null {
  const cf = c.req.header('CF-Connecting-IP');
  return cf && cf.trim() ? ipKey(cf, 48) : null;
}

export interface RateLimitResult {
  /** True if the request passes, false if the limit is reached. */
  allowed: boolean;
  /** How many requests remain after this one (0 if blocked). */
  remaining: number;
  /** Epoch second at which the window resets. */
  resetAt: number;
  /** Seconds to wait before retrying (>0 only if !allowed). */
  retryAfter: number;
  /** True if the counter did not answer and the route is fail-closed (-> 503). */
  unavailable?: boolean;
}

/**
 * D1 error "missing table or column" (migration not applied). SQLite says it
 * in two ways: "no such table/column" on a read, "table X has no column
 * named Y" in an INSERT.
 */
export function isMissingSchema(e: unknown): boolean {
  return /no such (table|column)|has no column named/i.test(String((e as Error)?.message ?? e));
}

function windowOf(windowSeconds: number): { now: number; win: number; resetAt: number } {
  const now = Math.floor(Date.now() / 1000);
  const win = now - (now % windowSeconds);
  return { now, win, resetAt: win + windowSeconds };
}

function blockedResult(resetAt: number, now: number): RateLimitResult {
  return { allowed: false, remaining: 0, resetAt, retryAfter: Math.max(1, resetAt - now) };
}

/**
 * Consumes `amount` units (default 1; for byte quotas the size) from the
 * `rule:key` counter in the current window. See the header for the
 * read-before-write and the atomic increment.
 *
 * A rejection does not increment: otherwise, in a burst, the requests that
 * had read a value below the threshold would increment anyway and only then
 * find out they were over (the counter would climb past `limit` and every
 * rejection would be a write). The increment is conditional (DO UPDATE ...
 * WHERE n + amount <= limit): past the threshold the statement does not touch
 * the row and RETURNING returns nothing.
 */
export async function consumeRateLimit(
  DB: D1Database,
  rule: string,
  key: string,
  limit: number,
  windowSeconds: number,
  opts: { fail?: FailMode; amount?: number } = {},
): Promise<RateLimitResult> {
  const amount = Math.max(1, Math.floor(opts.amount ?? 1));
  const k = rule + ':' + key;
  const { now, win, resetAt } = windowOf(windowSeconds);
  if (amount > limit) return blockedResult(resetAt, now);
  try {
    const cur = await DB.prepare('SELECT n FROM rate_limits WHERE k = ? AND win = ?')
      .bind(k, win)
      .first<{ n: number }>();
    if (cur && cur.n + amount > limit) return blockedResult(resetAt, now);
    const row = await DB.prepare(
      `INSERT INTO rate_limits (k, win, n) VALUES (?, ?, ?)
       ON CONFLICT(k, win) DO UPDATE SET n = rate_limits.n + excluded.n
         WHERE rate_limits.n + excluded.n <= ?
       RETURNING n`,
    )
      .bind(k, win, amount, limit)
      .first<{ n: number }>();
    // No row: there was a conflict and the increment would have exceeded the threshold.
    if (!row || typeof row.n !== 'number') return blockedResult(resetAt, now);
    const n = row.n;
    if (n > limit) return blockedResult(resetAt, now);
    return { allowed: true, remaining: Math.max(0, limit - n), resetAt, retryAfter: 0 };
  } catch (e) {
    const msg = (e as Error).message;
    if (isMissingSchema(e)) {
      console.error('[pinna] rate_limits missing (migration 0004?), limit skipped:', rule, msg);
      return { allowed: true, remaining: limit, resetAt, retryAfter: 0 };
    }
    console.error('[pinna] rate-limit unavailable:', rule, msg);
    if (opts.fail === 'closed') {
      return { allowed: false, remaining: 0, resetAt, retryAfter: 30, unavailable: true };
    }
    return { allowed: true, remaining: limit, resetAt, retryAfter: 0 };
  }
}

/**
 * SLIDING window of `spanSeconds`: sum of hourly buckets in the same
 * rate_limits table (one row per rule:key and hour). For the "last 24 hours"
 * caps, where a fixed window aligned to UTC midnight would let twice as much
 * through across the day boundary.
 * Like consumeRateLimit: first a read (past the cap nothing is written), then
 * the atomic increment of the current bucket with RETURNING n. The previous
 * buckets no longer change, so "previous + n" is exact even in a parallel
 * burst: at most `limit` requests pass. `win` = bucket used, for
 * refundSliding.
 */
export const SLIDE_BUCKET = 3600;

export interface SlidingResult {
  allowed: boolean;
  /** True if the counter did not answer and the call is fail-closed. */
  unavailable?: boolean;
  /** Start of the incremented bucket (epoch seconds). */
  win: number;
}

function slideOf(spanSeconds: number): { win: number; from: number } {
  const now = Math.floor(Date.now() / 1000);
  const win = now - (now % SLIDE_BUCKET);
  return { win, from: win - Math.max(SLIDE_BUCKET, spanSeconds) + SLIDE_BUCKET };
}

/** Sum of the buckets in the window: `prev` = closed buckets, `total` = including the current one. */
async function slidingSum(DB: D1Database, k: string, from: number, win: number): Promise<{ prev: number; total: number }> {
  const row = await DB.prepare(
    `SELECT COALESCE(SUM(CASE WHEN win < ? THEN n ELSE 0 END), 0) AS prev, COALESCE(SUM(n), 0) AS total
       FROM rate_limits WHERE k = ? AND win >= ?`,
  )
    .bind(win, k, from)
    .first<{ prev: number; total: number }>();
  return { prev: Number(row?.prev ?? 0), total: Number(row?.total ?? 0) };
}

export async function consumeSliding(
  DB: D1Database,
  rule: string,
  key: string,
  limit: number,
  spanSeconds: number,
  opts: { fail?: FailMode } = {},
): Promise<SlidingResult> {
  const k = rule + ':' + key;
  const { win, from } = slideOf(spanSeconds);
  try {
    const { prev, total } = await slidingSum(DB, k, from, win);
    if (total + 1 > limit) return { allowed: false, win };
    // Conditional increment (as in consumeRateLimit): a rejection does not
    // touch the bucket. `prev` (closed buckets) no longer changes.
    const row = await DB.prepare(
      `INSERT INTO rate_limits (k, win, n) VALUES (?, ?, 1)
       ON CONFLICT(k, win) DO UPDATE SET n = rate_limits.n + 1
         WHERE rate_limits.n + 1 + ? <= ?
       RETURNING n`,
    )
      .bind(k, win, prev, limit)
      .first<{ n: number }>();
    if (!row || typeof row.n !== 'number') return { allowed: false, win };
    if (prev + row.n > limit) return { allowed: false, win };
    return { allowed: true, win };
  } catch (e) {
    const msg = (e as Error).message;
    if (isMissingSchema(e)) {
      console.error('[pinna] rate_limits missing (migration 0004?), limit skipped:', rule, msg);
      return { allowed: true, win };
    }
    console.error('[pinna] rate-limit unavailable:', rule, msg);
    if (opts.fail === 'closed') return { allowed: false, unavailable: true, win };
    return { allowed: true, win };
  }
}

/** Is the sliding cap already full? Read only, fail-open. */
export async function peekSliding(
  DB: D1Database,
  rule: string,
  key: string,
  limit: number,
  spanSeconds: number,
): Promise<boolean> {
  try {
    const { win, from } = slideOf(spanSeconds);
    return (await slidingSum(DB, rule + ':' + key, from, win)).total >= limit;
  } catch (e) {
    console.log('[pinna] rate-limit peek failed (fail-open):', (e as Error).message);
    return false;
  }
}

/**
 * Gives back the slot taken by consumeRateLimit (e.g. the sign-in email was
 * not sent). `resetAt` is the one from the consume result, so the same window
 * is decremented even if the new one has started in the meantime.
 */
export async function refundRateLimit(
  DB: D1Database,
  rule: string,
  key: string,
  windowSeconds: number,
  resetAt: number,
): Promise<void> {
  try {
    await DB.prepare('UPDATE rate_limits SET n = n - 1 WHERE k = ? AND win = ? AND n > 0')
      .bind(rule + ':' + key, resetAt - windowSeconds)
      .run();
  } catch (e) {
    console.log('[pinna] rate-limit refund failed:', (e as Error).message);
  }
}

/** Gives back the slot taken by consumeSliding (e.g. the code was correct). */
export async function refundSliding(DB: D1Database, rule: string, key: string, win: number): Promise<void> {
  try {
    await DB.prepare('UPDATE rate_limits SET n = n - 1 WHERE k = ? AND win = ? AND n > 0')
      .bind(rule + ':' + key, win)
      .run();
  } catch (e) {
    console.log('[pinna] rate-limit refund failed:', (e as Error).message);
  }
}

/**
 * Reads the counter WITHOUT incrementing it. Used by the limits that only
 * count failures (admin key): check first, increment with consumeRateLimit
 * only if the attempt fails. Fail-open.
 */
export async function peekRateLimit(
  DB: D1Database,
  rule: string,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ blocked: boolean; retryAfter: number }> {
  const { now, win, resetAt } = windowOf(windowSeconds);
  try {
    const cur = await DB.prepare('SELECT n FROM rate_limits WHERE k = ? AND win = ?')
      .bind(rule + ':' + key, win)
      .first<{ n: number }>();
    if (cur && cur.n >= limit) return { blocked: true, retryAfter: Math.max(1, resetAt - now) };
  } catch (e) {
    console.log('[pinna] rate-limit peek failed (fail-open):', (e as Error).message);
  }
  return { blocked: false, retryAfter: 0 };
}

/**
 * Shield for the ANONYMOUS routes: Workers Rate Limiting binding (no storage
 * writes). `bucket` separates the counters per route. Returns the rejection
 * response (429, or 503 if fail-closed and the binding breaks) or undefined
 * if the request passes. Without the binding it falls back to D1 with the
 * same threshold, so tests and local development behave the same way.
 */
export async function anonLimit(
  c: RLContext,
  bucket: string,
  key: string,
  fail: FailMode,
  message?: string,
): Promise<Response | undefined> {
  const binding = c.env.ANON_RL;
  if (binding) {
    try {
      const { success } = await binding.limit({ key: bucket + ':' + key });
      if (success) return undefined;
      c.header('Retry-After', String(ANON_PERIOD));
      return c.json({ error: message || 'too many requests, try again later' }, 429);
    } catch (e) {
      console.error('[pinna] ANON_RL binding unavailable:', (e as Error).message);
      if (fail === 'closed') return c.json({ error: 'service temporarily unavailable, try again' }, 503);
      return undefined;
    }
  }
  const res = await consumeRateLimit(c.env.DB, 'anon-' + bucket, key, ANON_LIMIT, ANON_PERIOD, { fail });
  return applyRateLimit(c, res, ANON_LIMIT, message);
}

/**
 * Shield per AUTHENTICATED user on the routes that write: without it, PATCH
 * of a comment and mute have no limit at all (300 out of 300 get through) and
 * every request is a D1 write. Rate Limiting binding USER_RL ([[ratelimits]]
 * in wrangler.toml), key = user id: it counts in memory, no storage writes.
 * Call it after authentication and before any write (D1 counters included).
 * Fail-open: the D1 limits of the costly routes remain behind it.
 * USER_LIMIT/USER_PERIOD equal to the binding in wrangler.toml.
 * Without the binding (tests, wrangler dev without config): fixed-window
 * counter in the isolate's memory, separate per database (one test
 * environment does not see another's counters); a rejection does not
 * increment.
 */
export const USER_LIMIT = 60;
export const USER_PERIOD = 60;

const userMem = new WeakMap<object, Map<string, { win: number; n: number }>>();

export async function userShield(c: RLContext, uid: string): Promise<Response | undefined> {
  const reject = () => {
    c.header('Retry-After', String(USER_PERIOD));
    return c.json({ error: 'too many requests, wait a minute' }, 429);
  };
  const binding = c.env.USER_RL;
  if (binding) {
    try {
      const { success } = await binding.limit({ key: 'u:' + uid });
      return success ? undefined : reject();
    } catch (e) {
      console.error('[pinna] USER_RL binding unavailable:', (e as Error).message);
      return undefined;
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const win = now - (now % USER_PERIOD);
  let m = userMem.get(c.env.DB);
  if (!m) {
    m = new Map();
    userMem.set(c.env.DB, m);
  }
  const cur = m.get(uid);
  if (!cur || cur.win !== win) {
    if (m.size > 10_000) m.clear();
    m.set(uid, { win, n: 1 });
    return undefined;
  }
  if (cur.n >= USER_LIMIT) return reject();
  cur.n++;
  return undefined;
}

/**
 * Sets informational headers on the response and, if blocked, returns 429 (or
 * 503 if the counter did not answer on a fail-closed route).
 * Usage: `const blocked = applyRateLimit(c, result, limit, message); if (blocked) return blocked;`.
 */
export function applyRateLimit(
  c: RLContext,
  result: RateLimitResult,
  limit: number,
  message?: string,
): Response | undefined {
  if (result.unavailable) {
    c.header('Retry-After', String(result.retryAfter));
    return c.json({ error: 'service temporarily unavailable, try again' }, 503);
  }
  c.header('X-RateLimit-Limit', String(limit));
  c.header('X-RateLimit-Remaining', String(result.remaining));
  c.header('X-RateLimit-Reset', String(result.resetAt));
  if (!result.allowed) {
    c.header('Retry-After', String(result.retryAfter));
    return c.json({ error: message || 'too many requests, try again later' }, 429);
  }
  return undefined;
}

/** Cron: removes the windows closed more than 2 days ago (the longest one is 1 day). */
export async function purgeRateLimits(DB: D1Database): Promise<number> {
  try {
    const cutoff = Math.floor(Date.now() / 1000) - 2 * 86400;
    const r = await DB.prepare('DELETE FROM rate_limits WHERE win < ?').bind(cutoff).run();
    return r.meta?.changes ?? 0;
  } catch (e) {
    console.log('[pinna] rate_limits purge skipped:', (e as Error).message);
    return 0;
  }
}
