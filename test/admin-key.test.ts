/**
 * Pinna - /entra and /api/summary: cap on failed attempts per IP and global,
 * ANON_RL shield on the /48 before the check, no admin_audit or rate_limits
 * rows beyond the caps, truncated User-Agent, no ?k= on /api/summary.
 */
import { test, expect } from 'bun:test';
import app from '../worker/index';
import { appFetch, makeEnv, makeCtx, seedUser } from './helpers/env';

const IP = { 'CF-Connecting-IP': '203.0.113.7' };
/** Admin key of the tests: at least 32 characters (MIN_SECRET_LEN). */
const KEY = 'real-test-key-at-least-32-chars-long';

/** Sign-in with the key in the body (the /entra#k= page and dashboards). */
async function entraPost(env: ReturnType<typeof makeEnv>, k: string, headers: Record<string, string> = {}) {
  const ctx = makeCtx();
  const res = await appFetch(
    new Request('https://pinna.test/entra', {
      method: 'POST',
      headers: { ...IP, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
      body: 'k=' + encodeURIComponent(k),
    }),
    env,
    ctx,
  );
  await ctx.settle();
  return res;
}

/** ANON_RL binding that lets everything through: the D1 cap tests isolate it from the shield. */
const allowAll = { limit: async () => ({ success: true }) } as unknown as RateLimit;

async function call(env: ReturnType<typeof makeEnv>, path: string, headers: Record<string, string> = {}) {
  const ctx = makeCtx();
  const res = await appFetch(new Request('https://pinna.test' + path, { headers: { ...IP, ...headers } }), env, ctx);
  await ctx.settle();
  return res;
}

function auditRows(env: ReturnType<typeof makeEnv>): number {
  return (env.raw.query('SELECT COUNT(*) AS n FROM admin_audit').get() as { n: number }).n;
}

function rlRows(env: ReturnType<typeof makeEnv>): number {
  return (env.raw.query('SELECT COUNT(*) AS n FROM rate_limits').get() as { n: number }).n;
}

test('summary: after 10 wrong keys from the same IP -> 429, and admin_audit stops growing', async () => {
  const env = makeEnv({ ADMIN_KEY: KEY, ANON_RL: allowAll });
  for (let i = 0; i < 10; i++) {
    expect((await call(env, '/api/summary', { 'X-Admin-Key': 'wrong' + i })).status).toBe(401);
  }
  expect(auditRows(env)).toBe(10);
  for (let i = 0; i < 20; i++) {
    expect((await call(env, '/api/summary', { 'X-Admin-Key': 'wrong' })).status).toBe(429);
  }
  expect(auditRows(env)).toBe(10);
  // Blocked even with the right key (no oracle while blocked).
  expect((await call(env, '/api/summary', { 'X-Admin-Key': KEY })).status).toBe(429);
  // Another IP is not affected.
  expect((await call(env, '/api/summary', { 'X-Admin-Key': KEY, 'CF-Connecting-IP': '198.51.100.1' })).status).toBe(200);
});

test('summary: successes do not consume the cap (a dashboard does not lock itself out)', async () => {
  const env = makeEnv({ ADMIN_KEY: KEY, ANON_RL: allowAll });
  for (let i = 0; i < 30; i++) {
    expect((await call(env, '/api/summary', { 'X-Admin-Key': KEY })).status).toBe(200);
  }
});

test('/entra: beyond the cap, redirect to /login without session and without audit', async () => {
  const env = makeEnv({ ADMIN_KEY: KEY, ANON_RL: allowAll });
  for (let i = 0; i < 10; i++) await entraPost(env, 'wrong' + i);
  const before = auditRows(env);
  const res = await entraPost(env, KEY);
  expect(res.status).toBe(303);
  expect(res.headers.get('Location')).toContain('/login?err=link');
  expect(res.headers.get('Set-Cookie')).toBeNull();
  expect(auditRows(env)).toBe(before);
});

test('ANON_RL shield before the check: blocked -> 429, no admin_audit nor rate_limits', async () => {
  const keys: string[] = [];
  const deny = {
    limit: async ({ key }: { key: string }) => {
      keys.push(key);
      return { success: false };
    },
  } as unknown as RateLimit;
  const env = makeEnv({ ADMIN_KEY: KEY, ANON_RL: deny });
  const res = await call(env, '/api/summary', { 'X-Admin-Key': 'wrong', 'CF-Connecting-IP': '2001:db8:7:1::5' });
  expect(res.status).toBe(429);
  expect(auditRows(env)).toBe(0);
  expect(rlRows(env)).toBe(0);
  // Shield key on the /48.
  expect(keys).toEqual(['admin-key:2001:db8:7::/48']);
  const entra = await entraPost(env, 'wrong');
  expect(entra.status).toBe(303);
  expect(entra.headers.get('Location')).toContain('/login?err=link');
  expect(auditRows(env)).toBe(0);
});

test('global cap: 50 failures in an hour from all-different /64s, then 429 for everyone and no writes', async () => {
  const env = makeEnv({ ADMIN_KEY: KEY, ANON_RL: allowAll });
  const ipOf = (i: number) => '2001:db8:9:' + (i + 1).toString(16) + '::1';
  for (let i = 0; i < 50; i++) {
    expect((await call(env, '/api/summary', { 'X-Admin-Key': 'wrong', 'CF-Connecting-IP': ipOf(i) })).status).toBe(401);
  }
  expect(auditRows(env)).toBe(50);
  const rows = rlRows(env);
  for (let i = 50; i < 120; i++) {
    expect((await call(env, '/api/summary', { 'X-Admin-Key': 'wrong', 'CF-Connecting-IP': ipOf(i) })).status).toBe(429);
  }
  expect(auditRows(env)).toBe(50);
  expect(rlRows(env)).toBe(rows);
  // Beyond the cap the right key still gets in (the cap must not lock out the
  // admin); it writes only its own audit row, the counters stay put.
  expect((await call(env, '/api/summary', { 'X-Admin-Key': KEY, 'CF-Connecting-IP': '198.51.100.200' })).status).toBe(200);
  expect(auditRows(env)).toBe(51);
  expect(rlRows(env)).toBe(rows);
});

test('beyond the global cap /entra with the right key signs in; the per-IP cap still holds', async () => {
  const env = makeEnv({ ADMIN_KEY: KEY, ANON_RL: allowAll });
  for (let i = 0; i < 50; i++) await call(env, '/api/summary', { 'X-Admin-Key': 'wrong', 'CF-Connecting-IP': '198.18.' + Math.floor(i / 9) + '.' + (i + 1) });
  const ok = await entraPost(env, KEY, { 'CF-Connecting-IP': '192.0.2.10' });
  expect(ok.status).toBe(303);
  expect(ok.headers.get('Set-Cookie')).toContain('__Host-pinna_session=');
});

test('global cap: a parallel burst does not exceed it', async () => {
  const env = makeEnv({ ADMIN_KEY: KEY, ANON_RL: allowAll });
  await Promise.all(
    Array.from({ length: 80 }, (_, i) =>
      call(env, '/api/summary', { 'X-Admin-Key': 'wrong', 'CF-Connecting-IP': '10.0.0.' + (i + 1) }),
    ),
  );
  expect(auditRows(env)).toBeLessThanOrEqual(50);
});

test('admin_audit: User-Agent truncated to 200 characters', async () => {
  const env = makeEnv({ ADMIN_KEY: KEY, ANON_RL: allowAll });
  await call(env, '/api/summary', { 'X-Admin-Key': 'wrong', 'User-Agent': 'A'.repeat(32_000) });
  const row = env.raw.query('SELECT ua FROM admin_audit').get() as { ua: string };
  expect(row.ua.length).toBe(200);
});

test('/api/summary no longer accepts the key in the query; /entra wants it in the body', async () => {
  const env = makeEnv({ ADMIN_KEY: KEY, ANON_RL: allowAll });
  seedUser(env.raw, 'u_admin', 'admin@example.com', 'admin');
  expect((await call(env, '/api/summary?k=real-key')).status).toBe(401);
  expect((await call(env, '/api/summary', { 'X-Admin-Key': KEY })).status).toBe(200);
  const entra = await entraPost(env, KEY);
  expect(entra.status).toBe(303);
  expect(entra.headers.get('Location')).toBe('https://pinna.test/');
  expect(entra.headers.get('Set-Cookie')).toContain('pinna_session');
});
