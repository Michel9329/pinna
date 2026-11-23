/**
 * Pinna - cookies with the __Host- prefix: without the prefix a subdomain of
 * the parent domain could plant pinna_session (login CSRF). __Host- = Secure,
 * Path=/, no Domain.
 */
import { test, expect } from 'bun:test';
import app from '../worker/index';
import { makeSessionCookie, makeCsrfCookie, signTyped, readCookie } from '../worker/auth';
import { appFetch, makeEnv, makeCtx, seedUser, TEST_SECRET } from './helpers/env';

test('session and CSRF: __Host- prefix, Secure, Path=/, no Domain', async () => {
  const env = makeEnv();
  const session = await makeSessionCookie({ id: 'u', email: 'u@example.com', role: 'client', name: null, created_at: 0 }, env);
  for (const ck of [session, makeCsrfCookie()]) {
    expect(ck.startsWith('__Host-pinna_')).toBe(true);
    expect(ck).toContain('; Secure');
    expect(ck).toContain('; Path=/');
    expect(ck.toLowerCase()).not.toContain('domain=');
  }
  expect(session.startsWith('__Host-pinna_session=')).toBe(true);
});

test('the old pinna_session cookie (plantable from a subdomain) is no longer valid', async () => {
  const env = makeEnv();
  seedUser(env.raw, 'u_a', 'a@example.com', 'client');
  const tok = await signTyped('session', { uid: 'u_a', role: 'client', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  const me = (cookie: string) =>
    appFetch(new Request('https://pinna.test/api/auth/me', { headers: { Cookie: cookie } }), env, makeCtx());
  expect((await me('pinna_session=' + tok)).status).toBe(401);
  expect((await me('__Host-pinna_session=' + tok)).status).toBe(200);
});

test('CSRF: only __Host-pinna_csrf counts', async () => {
  const env = makeEnv();
  seedUser(env.raw, 'u_a', 'a@example.com', 'client');
  const tok = await signTyped('session', { uid: 'u_a', role: 'client', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  const mute = (cookie: string) =>
    appFetch(
      new Request('https://pinna.test/api/notifications/mute', {
        method: 'POST',
        headers: { Cookie: cookie, 'X-CSRF-Token': 't', 'Content-Type': 'application/json' },
        body: JSON.stringify({ muted: true }),
      }),
      env,
      makeCtx(),
    );
  expect((await mute('__Host-pinna_session=' + tok + '; pinna_csrf=t')).status).toBe(403);
  expect((await mute('__Host-pinna_session=' + tok + '; __Host-pinna_csrf=t')).status).toBe(200);
});

test('logout: also clears the old cookies without prefix', async () => {
  const env = makeEnv();
  const res = await appFetch(new Request('https://pinna.test/api/auth/logout', { method: 'POST' }), env, makeCtx());
  const all = res.headers.getSetCookie();
  expect(all.some((c) => c.startsWith('__Host-pinna_session=;'))).toBe(true);
  expect(all.some((c) => c.startsWith('pinna_session=;') && c.includes('Max-Age=0'))).toBe(true);
  expect(all.some((c) => c.startsWith('pinna_csrf=;') && c.includes('Max-Age=0'))).toBe(true);
});

test('readCookie: exact name (a cookie whose name contains the wanted one does not count)', () => {
  expect(readCookie('x__Host-pinna_session=a; __Host-pinna_session=b', '__Host-pinna_session')).toBe('b');
  expect(readCookie('pinna_session=a', '__Host-pinna_session')).toBeNull();
});
