/**
 * Pinna - session revocation. session_revocations table (migration 0003), iat
 * in the payload, logout that records the cutoff, admin endpoint, fail-open if
 * the table is missing.
 */
import { test, expect } from 'bun:test';
import app from '../worker/index';
import { signTyped, readSession } from '../worker/auth';
import * as db from '../worker/db';
import { appFetch, makeEnv, makeD1, makeCtx, seedUser, TEST_SECRET } from './helpers/env';

const sessionFor = (uid: string, role: string, iat: number) =>
  signTyped('session', { uid, role, exp: Date.now() + 3600_000, iat }, TEST_SECRET);

async function me(env: ReturnType<typeof makeEnv>, token: string) {
  return appFetch(new Request('https://pinna.test/api/auth/me', { headers: { Cookie: '__Host-pinna_session=' + token } }), env, makeCtx());
}

async function logout(env: ReturnType<typeof makeEnv>, token: string, csrf: boolean) {
  return appFetch(
    new Request('https://pinna.test/api/auth/logout', {
      method: 'POST',
      headers: {
        Cookie: '__Host-pinna_session=' + token + '; __Host-pinna_csrf=t1',
        ...(csrf ? { 'X-CSRF-Token': 't1' } : {}),
      },
    }),
    env,
    makeCtx(),
  );
}

test('logout with CSRF: the old session (on other devices too) stops working, a new one works', async () => {
  const env = makeEnv();
  seedUser(env.raw, 'u_a', 'a@example.com', 'client');
  const oldA = await sessionFor('u_a', 'client', Date.now() - 5000);
  const oldB = await sessionFor('u_a', 'client', Date.now() - 4000); // another device
  expect((await me(env, oldB)).status).toBe(200);
  const out = await logout(env, oldA, true);
  expect(out.status).toBe(200);
  expect(out.headers.get('Set-Cookie')).toContain('__Host-pinna_session=;');
  expect((await me(env, oldA)).status).toBe(401);
  expect((await me(env, oldB)).status).toBe(401);
  const fresh = await sessionFor('u_a', 'client', Date.now() + 1);
  expect((await me(env, fresh)).status).toBe(200);
});

test('logout without CSRF: clears the cookies but does not record the revocation', async () => {
  const env = makeEnv();
  seedUser(env.raw, 'u_a', 'a@example.com', 'client');
  const old = await sessionFor('u_a', 'client', Date.now() - 5000);
  expect((await logout(env, old, false)).status).toBe(200);
  expect((await me(env, old)).status).toBe(200);
});

test('a session without iat is not valid', async () => {
  const env = makeEnv();
  seedUser(env.raw, 'u_a', 'a@example.com', 'client');
  const noIat = await signTyped('session', { uid: 'u_a', role: 'client', exp: Date.now() + 3600_000 }, TEST_SECRET);
  expect(await readSession('__Host-pinna_session=' + noIat, env)).toBeNull();
});

test('the admin signs a user out: their sessions drop, only the admin and only with CSRF', async () => {
  const env = makeEnv();
  seedUser(env.raw, 'u_admin', 'm@example.com', 'admin');
  seedUser(env.raw, 'u_a', 'a@example.com', 'client');
  const admin = await sessionFor('u_admin', 'admin', Date.now() - 5000);
  const userA = await sessionFor('u_a', 'client', Date.now() - 5000);
  const revoke = (tok: string, csrf: boolean) =>
    appFetch(
      new Request('https://pinna.test/api/users/u_a/revoke-sessions', {
        method: 'POST',
        headers: { Cookie: '__Host-pinna_session=' + tok + '; __Host-pinna_csrf=t1', ...(csrf ? { 'X-CSRF-Token': 't1' } : {}) },
      }),
      env,
      makeCtx(),
    );
  expect((await revoke(userA, true)).status).toBe(401); // a client cannot
  expect((await revoke(admin, false)).status).toBe(403); // not without CSRF
  expect((await revoke(admin, true)).status).toBe(200);
  expect((await me(env, userA)).status).toBe(401);
  expect((await me(env, admin)).status).toBe(200);
});

test('fail-open: without the session_revocations table sessions stay valid and logout answers 200', async () => {
  const { DB, raw } = makeD1({ skipMigrations: ['0003'] });
  const env = { ...makeEnv(), DB, raw };
  seedUser(raw, 'u_a', 'a@example.com', 'client');
  const old = await sessionFor('u_a', 'client', Date.now() - 5000);
  expect((await readSession('__Host-pinna_session=' + old, env))?.uid).toBe('u_a');
  expect(await db.revokeSessions(DB, 'u_a')).toBe(false);
  expect((await logout(env, old, true)).status).toBe(200);
  expect((await me(env, old)).status).toBe(200);
});
