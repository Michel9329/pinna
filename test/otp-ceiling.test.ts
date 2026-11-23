/**
 * Pinna - cap on wrong codes per email. Without it, 4 addresses gave 10 codes
 * per hour with 5 attempts each: 50 guesses per hour on 6 digits. Above 20
 * wrong codes in the last 24 hours the code no longer works for that email
 * (the email button still does), and the response does not reveal whether the
 * email exists.
 */
import { test, expect } from 'bun:test';
import app from '../worker/index';
import * as db from '../worker/db';
import { sha256hex } from '../worker/auth';
import { consumeSliding, SLIDE_BUCKET } from '../worker/rate-limit';
import { appFetch, makeEnv, makeD1, makeCtx, seedUser } from './helpers/env';

const allowAll = { limit: async () => ({ success: true }) } as unknown as RateLimit;

/** 20 wrong codes: 4 links with 5 attempts each (each guess counts on all open links). */
async function burn20(DB: D1Database, email: string): Promise<void> {
  for (let l = 0; l < 4; l++) {
    await db.createMagicLink(DB, email, 'h-' + email + '-' + l, '11111' + l);
    for (let i = 0; i < 5; i++) expect(await db.verifyOtp(DB, email, '99999' + i)).toBeNull();
  }
}

function otpFailSum(raw: ReturnType<typeof makeD1>['raw'], email: string): number {
  return (raw.query("SELECT COALESCE(SUM(n), 0) AS n FROM rate_limits WHERE k = ?").get('otp-fail:' + email) as { n: number }).n;
}

test('above 20 wrong codes in 24 hours the right code no longer works, the email button still does', async () => {
  const { DB, raw } = makeD1();
  await burn20(DB, 'c@example.com');
  expect(otpFailSum(raw, 'c@example.com')).toBe(20);
  const token = 'new-link-token';
  await db.createMagicLink(DB, 'c@example.com', await sha256hex(token), '424242');
  expect(await db.verifyOtp(DB, 'c@example.com', '424242')).toBeNull();
  // Blocked: no further writes (neither attempts nor counter).
  expect(otpFailSum(raw, 'c@example.com')).toBe(20);
  const row = raw.query('SELECT attempts FROM magic_links WHERE token_hash = ?').get(await sha256hex(token)) as { attempts: number };
  expect(row.attempts).toBe(0);
  expect(await db.consumeMagicLink(DB, await sha256hex(token))).toBe('c@example.com');
});

test('the right code does not count as wrong (19 wrong + 1 right -> signed in, counter 19)', async () => {
  const { DB, raw } = makeD1();
  for (let l = 0; l < 4; l++) {
    await db.createMagicLink(DB, 'd@example.com', 'h-d-' + l, '22222' + l);
    const wrong = l < 3 ? 5 : 4;
    for (let i = 0; i < wrong; i++) expect(await db.verifyOtp(DB, 'd@example.com', '99999' + i)).toBeNull();
  }
  expect(await db.verifyOtp(DB, 'd@example.com', '222223')).toBe('d@example.com');
  expect(otpFailSum(raw, 'd@example.com')).toBe(19);
});

test('unknown emails: wrong codes without writes to the counter', async () => {
  const { DB, raw } = makeD1();
  for (let i = 0; i < 30; i++) expect(await db.verifyOtp(DB, 'nobody' + i + '@example.com', '123456')).toBeNull();
  expect((raw.query('SELECT COUNT(*) AS n FROM rate_limits').get() as { n: number }).n).toBe(0);
});

test('sliding window: failures from 25 hours ago do not count, those from 23 hours ago do', async () => {
  const { DB, raw } = makeD1();
  const now = Math.floor(Date.now() / 1000);
  const bucket = now - (now % SLIDE_BUCKET);
  raw.query('INSERT INTO rate_limits (k, win, n) VALUES (?, ?, 20)').run('otp-fail:e@example.com', bucket - 25 * 3600);
  await db.createMagicLink(DB, 'e@example.com', 'h-e', '333333');
  expect(await db.verifyOtp(DB, 'e@example.com', '333333')).toBe('e@example.com');
  raw.query('INSERT INTO rate_limits (k, win, n) VALUES (?, ?, 20)').run('otp-fail:f@example.com', bucket - 23 * 3600);
  await db.createMagicLink(DB, 'f@example.com', 'h-f', '444444');
  expect(await db.verifyOtp(DB, 'f@example.com', '444444')).toBeNull();
});

test('consumeSliding: in a parallel burst exactly `limit` requests go through', async () => {
  const { DB } = makeD1();
  const res = await Promise.all(Array.from({ length: 30 }, () => consumeSliding(DB, 'test', 'k', 20, 86400)));
  expect(res.filter((r) => r.allowed).length).toBe(20);
});

test('verify-code: a blocked email with the right code and an unknown email get the same response', async () => {
  const env = makeEnv({ ANON_RL: allowAll });
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  await burn20(env.DB, 'c@example.com');
  await db.createMagicLink(env.DB, 'c@example.com', 'h-right', '555555');
  const call = async (email: string) => {
    const r = await appFetch(
      new Request('https://pinna.test/api/auth/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.5' },
        body: JSON.stringify({ email, code: '555555' }),
      }),
      env,
      makeCtx(),
    );
    return { status: r.status, body: await r.text(), cookie: r.headers.get('Set-Cookie') };
  };
  const blocked = await call('c@example.com');
  const unknown = await call('unknown@example.com');
  expect(blocked.status).toBe(401);
  expect(blocked).toEqual(unknown);
  expect(blocked.cookie).toBeNull();
});
