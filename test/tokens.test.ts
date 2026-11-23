/**
 * Pinna - typed tokens. A widget-token must not work as a session cookie, a
 * session must not work as a widget-token, and old untyped tokens are no
 * longer valid.
 */
import { test, expect } from 'bun:test';
import { signToken, signTyped, verifyTyped, readSession } from '../worker/auth';
import app from '../worker/index';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

const FUTURE = Date.now() + 3600_000;

test('signTyped/verifyTyped: roundtrip on the same type', async () => {
  const t = await signTyped('widget', { uid: 'u1', pid: 'p1', exp: FUTURE }, TEST_SECRET);
  const p = await verifyTyped<{ uid: string }>('widget', t, TEST_SECRET);
  expect(p?.uid).toBe('u1');
  expect(p?.typ).toBe('widget');
});

test('verifyTyped: a token of one type is not valid for the other types', async () => {
  const w = await signTyped('widget', { uid: 'u1', pid: 'p1', exp: FUTURE }, TEST_SECRET);
  const s = await signTyped('session', { uid: 'u1', role: 'admin', exp: FUTURE }, TEST_SECRET);
  const x = await signTyped('proxy', { uid: 'u1', pid: 'p1', o: 'https://a.test', exp: FUTURE }, TEST_SECRET);
  expect(await verifyTyped('session', w, TEST_SECRET)).toBeNull();
  expect(await verifyTyped('proxy', w, TEST_SECRET)).toBeNull();
  expect(await verifyTyped('widget', s, TEST_SECRET)).toBeNull();
  expect(await verifyTyped('session', x, TEST_SECRET)).toBeNull();
});

test('verifyTyped: an old token signed with the bare secret (even with typ) is not valid', async () => {
  const old = await signToken({ uid: 'u1', role: 'admin', exp: FUTURE }, TEST_SECRET);
  const oldWithTyp = await signToken({ uid: 'u1', role: 'admin', exp: FUTURE, typ: 'session' }, TEST_SECRET);
  expect(await verifyTyped('session', old, TEST_SECRET)).toBeNull();
  expect(await verifyTyped('session', oldWithTyp, TEST_SECRET)).toBeNull();
});

test('readSession refuses a widget-token put in the pinna_session cookie', async () => {
  const env = makeEnv();
  const w = await signTyped('widget', { uid: 'u_admin', pid: 'p1', exp: FUTURE }, TEST_SECRET);
  expect(await readSession('__Host-pinna_session=' + w, env)).toBeNull();
  const s = await signTyped('session', { uid: 'u_admin', role: 'admin', exp: FUTURE, iat: Date.now() }, TEST_SECRET);
  expect((await readSession('__Host-pinna_session=' + s, env))?.uid).toBe('u_admin');
});

test('route: /api/auth/me with a widget-token in the cookie -> 401', async () => {
  const env = makeEnv();
  const w = await signTyped('widget', { uid: 'u_admin', pid: 'p1', exp: FUTURE }, TEST_SECRET);
  const res = await appFetch(
    new Request('https://pinna.test/api/auth/me', { headers: { Cookie: '__Host-pinna_session=' + w } }),
    env,
    makeCtx(),
  );
  expect(res.status).toBe(401);
});

test('route: comments with a SESSION passed as widget-token -> 401', async () => {
  const env = makeEnv();
  seedProject(env.raw, 'p1', 'site', 'https://staging.test');
  const s = await signTyped('session', { uid: 'u_admin', role: 'admin', exp: FUTURE, iat: Date.now() }, TEST_SECRET);
  const res = await appFetch(
    new Request('https://pinna.test/api/projects/site/comments', { headers: { Authorization: 'Bearer ' + s } }),
    env,
    makeCtx(),
  );
  expect(res.status).toBe(401);
  // Counter-check: the real widget-token goes through (in the header).
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  const w = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: FUTURE, iat: Date.now() }, TEST_SECRET);
  const ok = await appFetch(
    new Request('https://pinna.test/api/projects/site/comments', { headers: { Authorization: 'Bearer ' + w } }),
    env,
    makeCtx(),
  );
  expect(ok.status).toBe(200);
});
