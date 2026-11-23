/**
 * Pinna - request limits on D1 + binding. A KV counter that is read and then
 * rewritten lets a whole parallel burst through, and one write per anonymous
 * request uses up the free quota quickly, after which everything fails open.
 */
import { test, expect, afterEach } from 'bun:test';
import app from '../worker/index';
import { signTyped } from '../worker/auth';
import { consumeRateLimit, ipKey, purgeRateLimits } from '../worker/rate-limit';
import { appFetch, makeEnv, makeD1, makeCtx, seedUser, seedProject, TEST_SECRET, sized } from './helpers/env';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function rlRows(env: { raw: { query: (s: string) => { all: () => unknown[] } } }, prefix = ''): { k: string; n: number }[] {
  return (env.raw.query('SELECT k, n FROM rate_limits').all() as { k: string; n: number }[]).filter((r) =>
    r.k.startsWith(prefix),
  );
}

/** Fake Rate Limiting binding: counts per key, like the real one within a location. */
function fakeBinding(limit = 10) {
  const counts = new Map<string, number>();
  return {
    counts,
    limit: async ({ key }: { key: string }) => {
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      return { success: n <= limit };
    },
  } as unknown as RateLimit & { counts: Map<string, number> };
}

test('ipKey: IPv6 reduced to /64, IPv4 whole, mapped IPv4 -> IPv4', () => {
  expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
  expect(ipKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
  expect(ipKey('2001:0db8:0001:0002:ffff::1')).toBe('2001:db8:1:2::/64');
  expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
  expect(ipKey('2001:db8:1:3::1')).not.toBe(ipKey('2001:db8:1:2::1'));
  expect(ipKey('::ffff:198.51.100.4')).toBe('198.51.100.4');
  expect(ipKey('::1')).toBe('0:0:0:0::/64');
});

test('parallel burst: exactly `limit` requests go through (atomic increment)', async () => {
  const { DB } = makeD1();
  const results = await Promise.all(
    Array.from({ length: 25 }, () => consumeRateLimit(DB, 'test', 'k', 5, 60)),
  );
  expect(results.filter((r) => r.allowed).length).toBe(5);
});

test('above the limit it refuses without writing (the counter stays put)', async () => {
  const env = makeEnv();
  for (let i = 0; i < 20; i++) await consumeRateLimit(env.DB, 'test', 'k', 5, 60);
  expect(rlRows(env, 'test:')).toEqual([{ k: 'test:k', n: 5 }]);
});

test('byte quota: amount counts the size', async () => {
  const { DB } = makeD1();
  expect((await consumeRateLimit(DB, 'bytes', 'u', 100, 60, { amount: 60 })).allowed).toBe(true);
  expect((await consumeRateLimit(DB, 'bytes', 'u', 100, 60, { amount: 50 })).allowed).toBe(false);
  expect((await consumeRateLimit(DB, 'bytes', 'u', 100, 60, { amount: 40 })).allowed).toBe(true);
});

function authRequest(env: ReturnType<typeof makeEnv>, email: string, ip = '203.0.113.9') {
  return appFetch(
    new Request('https://pinna.test/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ email }),
    }),
    env,
    makeCtx(),
  );
}

test('auth/request: unregistered emails write nothing to D1, identical response', async () => {
  const env = makeEnv({ RESEND_API_KEY: 're_test', ANON_RL: fakeBinding(100) });
  const res = await Promise.all(['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'].map((e) => authRequest(env, e)));
  for (const r of res) {
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  }
  expect(rlRows(env)).toEqual([]);
});

test('auth/request: burst on the same registered email -> at most 3 emails, all responses {ok:true}', async () => {
  let sent = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input instanceof Request ? input.url : input).includes('api.resend.com')) sent++;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const env = makeEnv({ RESEND_API_KEY: 're_test', ANON_RL: fakeBinding(100) });
  seedUser(env.raw, 'u_c', 'client@example.com', 'client');
  const res = await Promise.all(Array.from({ length: 10 }, () => authRequest(env, 'client@example.com')));
  for (const r of res) {
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  }
  expect(sent).toBe(3);
});

test('auth/request: the per-IP limit uses the binding (not D1) and the /48', async () => {
  const binding = fakeBinding(10);
  const env = makeEnv({ RESEND_API_KEY: 're_test', ANON_RL: binding });
  for (let i = 0; i < 10; i++) {
    expect((await authRequest(env, 'x' + i + '@example.com', '2001:db8:1:' + (i + 1).toString(16) + '::1')).status).toBe(200);
  }
  // The eleventh from another /64 of the same /48: blocked (whoever holds a /48
  // does not multiply the threshold by 65,536).
  expect((await authRequest(env, 'y@example.com', '2001:db8:1:ffff::1')).status).toBe(429);
  expect([...binding.counts.keys()]).toEqual(['auth-req:2001:db8:1::/48']);
  expect(rlRows(env)).toEqual([]);
});

test('ipKey with prefix 48: first three groups, IPv4 unchanged', () => {
  expect(ipKey('2001:db8:1:2:3:4:5:6', 48)).toBe('2001:db8:1::/48');
  expect(ipKey('2001:db8::1', 48)).toBe('2001:db8:0::/48');
  expect(ipKey('203.0.113.7', 48)).toBe('203.0.113.7');
  expect(ipKey('::ffff:198.51.100.4', 48)).toBe('198.51.100.4');
});

test('auth/request: broken binding -> 503 (fail-closed, since it sends email); verify-code goes through (fail-open)', async () => {
  const broken = { limit: async () => { throw new Error('binding down'); } } as unknown as RateLimit;
  const env = makeEnv({ RESEND_API_KEY: 're_test', ANON_RL: broken });
  expect((await authRequest(env, 'a@example.com')).status).toBe(503);
  const vc = await appFetch(
    new Request('https://pinna.test/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' },
      body: JSON.stringify({ email: 'a@example.com', code: '123456' }),
    }),
    env,
    makeCtx(),
  );
  expect(vc.status).toBe(401); // it reaches the code check
});

async function sessionSetup(envOver: Parameters<typeof makeEnv>[0] = {}) {
  const env = makeEnv(envOver);
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  const session = await signTyped('session', { uid: 'u_c', role: 'client', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  const headers = { Cookie: '__Host-pinna_session=' + session + '; __Host-pinna_csrf=tok', 'X-CSRF-Token': 'tok' };
  return { env, headers };
}

/** D1 that breaks only on the limit queries (counter unavailable). */
function breakRateLimits(env: ReturnType<typeof makeEnv>, message = 'D1_ERROR: internal error') {
  const real = env.DB;
  const boom = async () => { throw new Error(message); };
  env.DB = {
    ...real,
    prepare: (sql: string) =>
      sql.includes('rate_limits') ? ({ bind: () => ({ first: boom, run: boom, all: boom }) } as never) : real.prepare(sql),
  } as D1Database;
}

async function upload(env: ReturnType<typeof makeEnv>, headers: Record<string, string>) {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array([1, 2, 3])], 'x.txt', { type: 'text/plain' }));
  return appFetch(
    await sized(new Request('https://pinna.test/api/projects/site/attachments', { method: 'POST', headers, body: fd })),
    env,
    makeCtx(),
  );
}

test('broken counter: upload and shot fail closed (503), comments fail open', async () => {
  const { env, headers } = await sessionSetup({ BROWSER: {} as Fetcher });
  breakRateLimits(env);
  expect((await upload(env, headers)).status).toBe(503);
  const shot = await appFetch(
    await sized(new Request('https://pinna.test/api/projects/site/shot', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://staging.test/' }),
    })),
    env,
    makeCtx(),
  );
  expect(shot.status).toBe(503);
  const comment = await appFetch(
    new Request('https://pinna.test/api/projects/site/comments', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'hello', page_path: '/', page_x: 1, page_y: 1 }),
    }),
    env,
    makeCtx(),
  );
  expect(comment.status).toBe(201);
});

test('rate_limits table missing (migration 0004 not applied): no 500 and no 503', async () => {
  const { env, headers } = await sessionSetup();
  breakRateLimits(env, 'D1_ERROR: no such table: rate_limits');
  // The upload passes the limit and reaches the file validation (415 = file
  // not allowed), instead of stopping with 503.
  expect((await upload(env, headers)).status).toBe(415);
});

test('cron: purgeRateLimits removes old windows and keeps the current ones', async () => {
  const env = makeEnv();
  const now = Math.floor(Date.now() / 1000);
  env.raw.query("INSERT INTO rate_limits (k, win, n) VALUES ('old:k', ?, 3), ('new:k', ?, 1)").run(now - 3 * 86400, now);
  expect(await purgeRateLimits(env.DB)).toBe(1);
  expect(rlRows(env).map((r) => r.k)).toEqual(['new:k']);
});
