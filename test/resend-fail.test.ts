/**
 * Pinna - failed sending of the sign-in email. Without this the code row
 * stayed open: for 90 minutes every request found "code still valid" and sent
 * nothing, and the slots in the counters stayed taken. The row is closed and
 * the slots are given back.
 */
import { test, expect, afterEach } from 'bun:test';
import { appFetch, makeEnv, makeCtx, seedUser, sized } from './helpers/env';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Env = ReturnType<typeof makeEnv>;

/** Fake Resend: `ok` decides the response; counts the calls. */
function fakeResend(ok: () => boolean): { calls: number } {
  const st = { calls: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input instanceof Request ? input.url : input).includes('api.resend.com')) {
      st.calls++;
      return ok() ? new Response('{}', { status: 200 }) : new Response('{"message":"boom"}', { status: 500 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return st;
}

async function request(env: Env, email: string, ip = '203.0.113.7') {
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

const openRows = (env: Env, email: string) =>
  (env.raw.query('SELECT COUNT(*) AS n FROM magic_links WHERE email = ? AND used_at IS NULL').get(email) as { n: number }).n;
// The email budget counters (the anonymous per-IP shield, anon-*, counts
// requests and is not given back: in production it is the ANON_RL binding).
const counters = (env: Env) =>
  env.raw.query("SELECT k, SUM(n) AS n FROM rate_limits WHERE k NOT LIKE 'anon-%' GROUP BY k ORDER BY k").all() as { k: string; n: number }[];

test('Resend fails: 502, row closed, counters given back; the next request really sends', async () => {
  let up = false;
  const resend = fakeResend(() => up);
  const env = makeEnv({ RESEND_API_KEY: 're_test' });
  seedUser(env.raw, 'u_c', 'client@example.com', 'client');

  const first = await request(env, 'client@example.com');
  expect(first.status).toBe(502);
  expect(resend.calls).toBe(2); // send + one retry
  expect(openRows(env, 'client@example.com')).toBe(0);
  // No slot taken: per email and address, per email, in the 24 hours, global.
  for (const row of counters(env)) expect(row.n).toBe(0);

  // Resend is back up: the next request goes out (without the fix: "code
  // still valid", nothing sent for 90 minutes).
  up = true;
  const second = await request(env, 'client@example.com');
  expect(second.status).toBe(200);
  expect(resend.calls).toBe(3);
  expect(openRows(env, 'client@example.com')).toBe(1);
  const byKey = Object.fromEntries(counters(env).map((r) => [r.k, r.n]));
  expect(byKey['auth-email:client@example.com']).toBe(1);
  expect(byKey['auth-email-day:client@example.com']).toBe(1);
  expect(byKey['email-all:all']).toBe(1);
});

test('repeated failures do not use up the caps: 30 failed sends, then the email goes out', async () => {
  let up = false;
  const resend = fakeResend(() => up);
  const env = makeEnv({ RESEND_API_KEY: 're_test' });
  seedUser(env.raw, 'u_c', 'client@example.com', 'client');
  // From 30 different addresses (the per-IP shield lets 10 per minute through).
  for (let i = 0; i < 30; i++) expect((await request(env, 'client@example.com', '198.51.100.' + (i + 1))).status).toBe(502);
  for (const row of counters(env)) expect(row.n).toBe(0);
  up = true;
  const ok = await request(env, 'client@example.com');
  expect(ok.status).toBe(200);
  expect(resend.calls).toBe(61);
  expect(openRows(env, 'client@example.com')).toBe(1);
});
