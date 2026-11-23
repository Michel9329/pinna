/**
 * Pinna - Resend quota. With one known registered email, 240 sign-in emails a
 * day could go out, Resend free allows about 100 and the same key serves the
 * notifications. A cap of sign-in emails per address in the last 24 hours and
 * a global cap (default 80, PINNA_EMAIL_DAILY_CAP) on sign-in + notifications;
 * beyond them nothing is sent, the response is the same as if it had been,
 * and at most one alert an hour goes out.
 */
import { test, expect, afterEach } from 'bun:test';
import app from '../worker/index';
import { sendEmail, emailDailyCap, AUTH_EMAIL_PER_DAY } from '../worker/notify';
import { recordError } from '../worker/alerts';
import { SLIDE_BUCKET } from '../worker/rate-limit';
import { appFetch, makeEnv, makeCtx, seedUser } from './helpers/env';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const ALERT_TO = 'alert@example.test';
const allowAll = { limit: async () => ({ success: true }) } as unknown as RateLimit;

/** Intercepts the calls to Resend and keeps their recipient. */
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

async function request(env: ReturnType<typeof makeEnv>, email: string, ip: string) {
  const ctx = makeCtx();
  const res = await appFetch(
    new Request('https://pinna.test/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ email }),
    }),
    env,
    ctx,
  );
  await ctx.settle();
  return { status: res.status, body: await res.json() };
}

function bucketAgo(hours: number): number {
  const now = Math.floor(Date.now() / 1000);
  return now - (now % SLIDE_BUCKET) - hours * 3600;
}

test('AUTH_EMAIL_PER_DAY sign-in emails per address in 24 hours: the next one is not sent, response {ok:true}, one alert', async () => {
  const to = captureResend();
  const env = makeEnv({ RESEND_API_KEY: 're_test', ANON_RL: allowAll, ALERT_EMAIL: ALERT_TO });
  seedUser(env.raw, 'u_c', 'client@example.com', 'client');
  // All already sent 5 hours ago (the hourly caps are free). See
  // AUTH_EMAIL_PER_DAY in notify.ts for the value.
  expect(AUTH_EMAIL_PER_DAY).toBe(24);
  env.raw.query('INSERT INTO rate_limits (k, win, n) VALUES (?, ?, ?)').run('auth-email-day:client@example.com', bucketAgo(5), AUTH_EMAIL_PER_DAY);
  const r = await request(env, 'client@example.com', '203.0.113.1');
  expect(r).toEqual({ status: 200, body: { ok: true } });
  expect(to.filter((t) => t === 'client@example.com')).toEqual([]);
  expect(to.filter((t) => t === ALERT_TO).length).toBe(1);
  // The ones sent 25 hours ago do not count.
  seedUser(env.raw, 'u_d', 'other@example.com', 'client');
  env.raw.query('INSERT INTO rate_limits (k, win, n) VALUES (?, ?, ?)').run('auth-email-day:other@example.com', bucketAgo(25), AUTH_EMAIL_PER_DAY);
  await request(env, 'other@example.com', '203.0.113.2');
  expect(to.filter((t) => t === 'other@example.com').length).toBe(1);
});

test('configurable global cap: beyond the cap nothing is sent, {ok:true}, a single alert an hour', async () => {
  const to = captureResend();
  const env = makeEnv({ RESEND_API_KEY: 're_test', ANON_RL: allowAll, ALERT_EMAIL: ALERT_TO, PINNA_EMAIL_DAILY_CAP: '3' });
  for (let i = 0; i < 6; i++) seedUser(env.raw, 'u_' + i, 'c' + i + '@example.com', 'client');
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await request(env, 'c' + i + '@example.com', '203.0.113.' + (i + 10)));
  for (const r of results) expect(r).toEqual({ status: 200, body: { ok: true } });
  expect(to.filter((t) => t !== ALERT_TO)).toEqual(['c0@example.com', 'c1@example.com', 'c2@example.com']);
  expect(to.filter((t) => t === ALERT_TO).length).toBe(1);
  // During the alert cooldown no further KV writes.
  expect(await env.RATE_LIMIT.get('err:email-quota')).toBe('1');
});

test('notifications count toward the global cap; alerts skip it', async () => {
  const to = captureResend();
  const env = makeEnv({ RESEND_API_KEY: 're_test', ALERT_EMAIL: ALERT_TO, PINNA_EMAIL_DAILY_CAP: '2' });
  await sendEmail(env, 'a@example.com', 'n1', '<p>1</p>');
  await sendEmail(env, 'b@example.com', 'n2', '<p>2</p>');
  await sendEmail(env, 'c@example.com', 'n3', '<p>3</p>');
  expect(to.filter((t) => t !== ALERT_TO)).toEqual(['a@example.com', 'b@example.com']);
  // The third one raised the alert, which goes out even at a full cap.
  expect(to.filter((t) => t === ALERT_TO).length).toBe(1);
  // The cap also covers sign-in: with the notifications at full quota the sign-in email is not sent.
  seedUser(env.raw, 'u_c', 'client@example.com', 'client');
  env.ANON_RL = allowAll;
  const r = await request(env, 'client@example.com', '203.0.113.50');
  expect(r).toEqual({ status: 200, body: { ok: true } });
  expect(to).not.toContain('client@example.com');
});

test('email-quota alert: at most one an hour (cooldown 3600 s)', async () => {
  const to = captureResend();
  const puts: { k: string; ttl?: number }[] = [];
  const env = makeEnv({ RESEND_API_KEY: 're_test', ALERT_EMAIL: ALERT_TO });
  const kv = env.RATE_LIMIT;
  env.RATE_LIMIT = {
    get: kv.get.bind(kv),
    put: async (k: string, v: string, o?: { expirationTtl?: number }) => {
      puts.push({ k, ttl: o?.expirationTtl });
      await kv.put(k, v);
    },
  } as unknown as KVNamespace;
  for (let i = 0; i < 5; i++) await recordError(env, 'email-quota');
  expect(to).toEqual([ALERT_TO]);
  expect(puts.find((p) => p.k === 'alertcd:email-quota')?.ttl).toBe(3600);
  expect(puts.length).toBe(2); // counter + cooldown, then silence
});

test('PINNA_EMAIL_DAILY_CAP: default 80, invalid values -> 80', () => {
  const base = makeEnv();
  expect(emailDailyCap(base)).toBe(80);
  expect(emailDailyCap({ ...base, PINNA_EMAIL_DAILY_CAP: '0' })).toBe(80);
  expect(emailDailyCap({ ...base, PINNA_EMAIL_DAILY_CAP: 'abc' })).toBe(80);
  expect(emailDailyCap({ ...base, PINNA_EMAIL_DAILY_CAP: '50' })).toBe(50);
});
