/**
 * Pinna - the sign-in email caps cannot be used up by anyone. Without this,
 * 10 anonymous requests from 4 addresses would close a user's email sign-in
 * (admin included) for 24 hours, and 8 known emails would exhaust the global
 * cap. With a code still valid there is no new email and no count; part of
 * the global cap is reserved for admins signing in.
 */
import { test, expect, afterEach } from 'bun:test';
import app from '../worker/index';
import { adminEmailReserve, emailDailyCap } from '../worker/notify';
import { SLIDE_BUCKET } from '../worker/rate-limit';
import { appFetch, makeEnv, makeCtx, seedUser, sized, TEST_ADMIN_EMAIL } from './helpers/env';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureResend(): string[] {
  const to: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input instanceof Request ? input.url : input).includes('api.resend.com')) {
      to.push(JSON.parse(String(init?.body ?? '{}')).to);
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return to;
}

type Env = ReturnType<typeof makeEnv>;
let ipn = 0;
async function request(env: Env, email: string, ip = '203.1.' + Math.floor(ipn / 250) + '.' + (ipn++ % 250)) {
  const ctx = makeCtx();
  const res = await appFetch(
    await sized(new Request('https://pinna.test/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ email }),
    })),
    env,
    ctx,
  );
  await ctx.settle();
  return res;
}
async function verifyCode(env: Env, email: string, code: string) {
  const ctx = makeCtx();
  const res = await appFetch(
    await sized(new Request('https://pinna.test/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.20' },
      body: JSON.stringify({ email, code }),
    })),
    env,
    ctx,
  );
  await ctx.settle();
  return res;
}
const openCode = (env: Env, email: string) =>
  (env.raw.query('SELECT code FROM magic_links WHERE email = ? AND used_at IS NULL ORDER BY created_at DESC LIMIT 1').get(email) as { code: string } | null)?.code;
const counted = (env: Env, k: string) =>
  (env.raw.query('SELECT COALESCE(SUM(n), 0) AS n FROM rate_limits WHERE k = ?').get(k) as { n: number }).n;

test('repeated anonymous requests: a single email, no cap consumed, the received code works', async () => {
  const to = captureResend();
  const env = makeEnv({ RESEND_API_KEY: 're_test' });
  seedUser(env.raw, 'u_c', 'client@example.com', 'client');
  // 10 requests from 4 addresses (the attack scenario), then 20 more.
  for (let i = 0; i < 30; i++) expect((await request(env, 'client@example.com', '203.0.113.' + (i % 4))).status).toBe(200);
  expect(to).toEqual(['client@example.com']);
  expect(counted(env, 'auth-email-day:client@example.com')).toBe(1);
  expect(counted(env, 'auth-email:client@example.com')).toBe(1);
  // The client uses the code from their email: gets in.
  expect((await verifyCode(env, 'client@example.com', openCode(env, 'client@example.com')!)).status).toBe(200);
});

test('a new code is sent again when the open one expires, is used or is locked', async () => {
  const to = captureResend();
  const env = makeEnv({ RESEND_API_KEY: 're_test' });
  seedUser(env.raw, 'u_c', 'client@example.com', 'client');
  await request(env, 'client@example.com');
  // Expired.
  env.raw.query("UPDATE magic_links SET expires_at = 1 WHERE email = 'client@example.com'").run();
  await request(env, 'client@example.com');
  expect(to.length).toBe(2);
  // Locked after 5 wrong attempts.
  for (let i = 0; i < 5; i++) await verifyCode(env, 'client@example.com', '00000' + i);
  await request(env, 'client@example.com');
  expect(to.length).toBe(3);
  // Used.
  expect((await verifyCode(env, 'client@example.com', openCode(env, 'client@example.com')!)).status).toBe(200);
  await request(env, 'client@example.com');
  expect(to.length).toBe(4);
});

test('8 known emails with 10 requests each: 8 sends, and the admin gets theirs', async () => {
  const to = captureResend();
  const env = makeEnv({ RESEND_API_KEY: 're_test' });
  for (let i = 0; i < 8; i++) seedUser(env.raw, 'u' + i, 'c' + i + '@example.com', 'client');
  for (let i = 0; i < 8; i++) for (let j = 0; j < 10; j++) await request(env, 'c' + i + '@example.com');
  expect(to.length).toBe(8);
  await request(env, TEST_ADMIN_EMAIL);
  expect(to).toContain(TEST_ADMIN_EMAIL);
});

test('global cap: the reserve stays for admins signing in', async () => {
  const to = captureResend();
  const env = makeEnv({ RESEND_API_KEY: 're_test' });
  seedUser(env.raw, 'u_c', 'client@example.com', 'client');
  const cap = emailDailyCap(env);
  const reserve = adminEmailReserve(env);
  expect(reserve).toBe(20);
  // All the non-reserved emails already sent (5 hours ago).
  const now = Math.floor(Date.now() / 1000);
  const win = now - (now % SLIDE_BUCKET) - 5 * 3600;
  env.raw.query("INSERT INTO rate_limits (k, win, n) VALUES ('email-all:all', ?, ?)").run(win, cap - reserve);
  await request(env, 'client@example.com');
  expect(to).toEqual([]);
  await request(env, TEST_ADMIN_EMAIL);
  expect(to).toEqual([TEST_ADMIN_EMAIL]);
});
