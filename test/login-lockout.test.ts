/**
 * Pinna - no login lockout from outside. Without this, anyone who knew a
 * client's email could lock them out: 3 requests per hour used up the
 * per-email limit and every new request invalidated the code already received.
 */
import { test, expect, afterEach } from 'bun:test';
import app from '../worker/index';
import * as db from '../worker/db';
import { sha256hex } from '../worker/auth';
import { appFetch, makeEnv, makeD1, makeCtx, seedUser } from './helpers/env';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function countEmails(): { n: number } {
  const box = { n: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input instanceof Request ? input.url : input).includes('api.resend.com')) box.n++;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return box;
}

function request(env: ReturnType<typeof makeEnv>, ip: string) {
  return appFetch(
    new Request('https://pinna.test/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ email: 'client@example.com' }),
    }),
    env,
    makeCtx(),
  );
}

const binding = { limit: async () => ({ success: true }) } as unknown as RateLimit;

// While a code is still valid no new email is sent (email-dedupe.test.ts).
// Here the open code is closed between one request and the next (as after a
// sign-in), to measure the caps on real sends.
const closeOpen = (env: ReturnType<typeof makeEnv>) =>
  env.raw.query("UPDATE magic_links SET used_at = 1 WHERE email = 'client@example.com' AND used_at IS NULL").run();

test("someone insisting from another address does not use up the client's sends", async () => {
  const sent = countEmails();
  const env = makeEnv({ RESEND_API_KEY: 're_test', ANON_RL: binding });
  seedUser(env.raw, 'u_c', 'client@example.com', 'client');
  for (let i = 0; i < 5; i++) {
    expect((await request(env, '203.0.113.66')).status).toBe(200);
    closeOpen(env);
  }
  expect(sent.n).toBe(3); // the attacker gets 3
  expect((await request(env, '198.51.100.7')).status).toBe(200);
  expect(sent.n).toBe(4); // the client, from their own address, gets theirs
});

test('wider cap per email: 10 sends per hour in total, then {ok:true} without sending', async () => {
  const sent = countEmails();
  const env = makeEnv({ RESEND_API_KEY: 're_test', ANON_RL: binding });
  seedUser(env.raw, 'u_c', 'client@example.com', 'client');
  for (let i = 0; i < 12; i++) {
    const r = await request(env, '203.0.113.' + (i + 1));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    closeOpen(env);
  }
  expect(sent.n).toBe(10);
});

// Only the latest code is valid (otherwise every guess would be compared
// against all the open codes). /auth/request guarantees that a new request
// does not take the code away from the client: while the latest code is valid
// it does not create another one (email-dedupe.test.ts). All links stay valid.
test('only the latest code is valid; all open links stay valid', async () => {
  const { DB } = makeD1();
  await db.createMagicLink(DB, 'c@example.com', 'h-first', '111111');
  await new Promise((r) => setTimeout(r, 2));
  await db.createMagicLink(DB, 'c@example.com', 'h-second', '222222');
  expect(await db.verifyOtp(DB, 'c@example.com', '111111')).toBeNull();
  // The button in the first email still works.
  expect(await db.consumeMagicLink(DB, 'h-first')).toBe('c@example.com');
  // Signed in: the other open links and codes are closed.
  expect(await db.verifyOtp(DB, 'c@example.com', '222222')).toBeNull();
});

test('correct latest code: signs in', async () => {
  const { DB } = makeD1();
  await db.createMagicLink(DB, 'c@example.com', 'h-first', '111111');
  await db.createMagicLink(DB, 'c@example.com', 'h-second', '222222'); // same ms: insertion order decides
  expect(await db.verifyOtp(DB, 'c@example.com', '222222')).toBe('c@example.com');
});

test('5 wrong codes disable the code but not the email button', async () => {
  const { DB } = makeD1();
  const token = 'real-link-token';
  await db.createMagicLink(DB, 'd@example.com', await sha256hex(token), '424242');
  for (let i = 0; i < 5; i++) expect(await db.verifyOtp(DB, 'd@example.com', '00000' + i)).toBeNull();
  expect(await db.verifyOtp(DB, 'd@example.com', '424242')).toBeNull();
  expect(await db.consumeMagicLink(DB, await sha256hex(token))).toBe('d@example.com');
});

test('a wrong attempt is compared and counted only against the latest code', async () => {
  const { DB, raw } = makeD1();
  await db.createMagicLink(DB, 'e@example.com', 'h1', '111111');
  await db.createMagicLink(DB, 'e@example.com', 'h2', '222222');
  await db.verifyOtp(DB, 'e@example.com', '999999');
  const rows = raw.query("SELECT token_hash, attempts FROM magic_links WHERE email = 'e@example.com' ORDER BY token_hash").all();
  expect(rows).toEqual([{ token_hash: 'h1', attempts: 0 }, { token_hash: 'h2', attempts: 1 }]);
});

test('with 5 open codes a guess counts for one only (not for all 5)', async () => {
  const { DB } = makeD1();
  for (let i = 0; i < 4; i++) await db.createMagicLink(DB, 'f@example.com', 'old' + i, '10000' + i);
  await db.createMagicLink(DB, 'f@example.com', 'last', '555555');
  for (let i = 0; i < 4; i++) expect(await db.verifyOtp(DB, 'f@example.com', '10000' + i)).toBeNull();
});
