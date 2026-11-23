/**
 * Pinna - the email link routes have the same anonymous shield as the other
 * sign-in routes (ANON_RL, per IP): past the limit the answer is 429 and no
 * D1 statement runs, for the link page (GET) and the sign-in (POST).
 */
import { test, expect } from 'bun:test';
import { sha256hex } from '../worker/auth';
import { appFetch, makeEnv, makeCtx, seedUser } from './helpers/env';

const TOKEN = 'tok-' + 'c'.repeat(40);
const LIMIT = 10;

/** ANON_RL like the binding: LIMIT per key, then refused. */
function anonRl() {
  const seen = new Map<string, number>();
  return {
    limit: async ({ key }: { key: string }) => {
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return { success: n <= LIMIT };
    },
  } as unknown as RateLimit;
}

async function setup() {
  const env = makeEnv({ ANON_RL: anonRl() });
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  env.raw
    .query('INSERT INTO magic_links (token_hash, email, expires_at, used_at, code, created_at) VALUES (?, ?, ?, NULL, NULL, ?)')
    .run(await sha256hex(TOKEN), 'c@example.com', Date.now() + 600_000, Date.now());
  // Counts the D1 statements prepared by the Worker.
  let statements = 0;
  const real = env.DB;
  env.DB = new Proxy(real, {
    get: (t, k) => (k === 'prepare' ? (sql: string) => (statements++, t.prepare(sql)) : Reflect.get(t, k)),
  });
  return { env, count: () => statements };
}

const IP = { 'CF-Connecting-IP': '203.0.113.7' };

test('GET of the link page: past the limit 429, and no D1 statement', async () => {
  const { env, count } = await setup();
  for (let i = 0; i < LIMIT; i++) {
    const res = await appFetch(new Request('https://pinna.test/api/auth/verify?token=' + TOKEN, { headers: IP }), env, makeCtx());
    expect(res.status).toBe(200);
  }
  const before = count();
  for (let i = 0; i < 5; i++) {
    const res = await appFetch(new Request('https://pinna.test/api/auth/verify?token=' + TOKEN, { headers: IP }), env, makeCtx());
    expect(res.status).toBe(429);
    // A person clicked a link in an email: a page, not JSON, saying the link still works.
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(res.headers.get('Retry-After')).toBe('60');
    const html = await res.text();
    expect(html).toContain('Wait a minute and reload this page');
    expect(html).toContain('your link is still valid');
    expect(html).not.toContain(TOKEN);
  }
  expect(count()).toBe(before);
});

test('the shield fails open: when the limiter throws, both link routes still answer', async () => {
  const { env } = await setup();
  env.ANON_RL = {
    limit: async () => {
      throw new Error('binding down');
    },
  } as unknown as RateLimit;
  const get = await appFetch(new Request('https://pinna.test/api/auth/verify?token=' + TOKEN, { headers: IP }), env, makeCtx());
  expect(get.status).toBe(200);
  const post = await appFetch(
    new Request('https://pinna.test/api/auth/verify', {
      method: 'POST',
      headers: { ...IP, Origin: 'https://pinna.test', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'token=' + TOKEN,
    }),
    env,
    makeCtx(),
  );
  expect(post.status).toBe(303);
  expect(post.headers.get('Set-Cookie')).toContain('__Host-pinna_session=');
});

test('POST of the link: past the limit 429, and no D1 statement (the link is not consumed)', async () => {
  const { env, count } = await setup();
  const post = () =>
    appFetch(
      new Request('https://pinna.test/api/auth/verify', {
        method: 'POST',
        headers: { ...IP, Origin: 'https://pinna.test', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'token=wrong-token',
      }),
      env,
      makeCtx(),
    );
  for (let i = 0; i < LIMIT; i++) expect((await post()).status).toBe(303);
  const before = count();
  for (let i = 0; i < 5; i++) {
    const res = await post();
    expect(res.status).toBe(429);
    // The POST keeps the JSON answer of the other sign-in routes.
    expect(res.headers.get('Content-Type')).toContain('application/json');
  }
  expect(count()).toBe(before);
  expect((env.raw.query('SELECT used_at FROM magic_links').get() as { used_at: number | null }).used_at).toBeNull();
});
