/**
 * Pinna - CSRF on the routes that change state with the cookie: comments,
 * PATCH/DELETE, mute, attachments, shot.
 */
import { test, expect } from 'bun:test';
import { signTyped } from '../worker/auth';
import app from '../worker/index';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

async function setup() {
  const env = makeEnv();
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  env.raw
    .query("INSERT INTO comments (id, project_id, page_path, body, author_id, status, created_at) VALUES ('c1', 'p1', '/', 'x', 'u_c', 'open', 0)")
    .run();
  const session = await signTyped('session', { uid: 'u_c', role: 'client', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  const cookie = '__Host-pinna_session=' + session + '; __Host-pinna_csrf=tok123';
  const call = (method: string, path: string, opts: { csrf?: string; body?: unknown } = {}) =>
    appFetch(
      new Request('https://pinna.test' + path, {
        method,
        headers: {
          Cookie: cookie,
          'Content-Type': 'application/json',
          ...(opts.csrf ? { 'X-CSRF-Token': opts.csrf } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      }),
      env,
      makeCtx(),
    );
  return { env, call };
}

const NEW_COMMENT = { body: 'hello', page_path: '/', page_x: 1, page_y: 1 };

test('with the cookie and without X-CSRF-Token the state-changing routes answer 403', async () => {
  const { call } = await setup();
  expect((await call('POST', '/api/projects/site/comments', { body: NEW_COMMENT })).status).toBe(403);
  expect((await call('PATCH', '/api/comments/c1', { body: { body: 'new' } })).status).toBe(403);
  expect((await call('DELETE', '/api/comments/c1')).status).toBe(403);
  expect((await call('POST', '/api/notifications/mute', { body: { muted: true } })).status).toBe(403);
  expect((await call('POST', '/api/projects/site/attachments')).status).toBe(403);
  expect((await call('DELETE', '/api/attachments/a1')).status).toBe(403);
  expect((await call('POST', '/api/projects/site/shot', { body: {} })).status).toBe(403);
  // Wrong token: same.
  expect((await call('POST', '/api/projects/site/comments', { csrf: 'other', body: NEW_COMMENT })).status).toBe(403);
});

test('with the cookie and the right X-CSRF-Token they pass', async () => {
  const { call } = await setup();
  expect((await call('POST', '/api/projects/site/comments', { csrf: 'tok123', body: NEW_COMMENT })).status).toBe(201);
  expect((await call('PATCH', '/api/comments/c1', { csrf: 'tok123', body: { body: 'new' } })).status).toBe(200);
  expect((await call('POST', '/api/notifications/mute', { csrf: 'tok123', body: { muted: true } })).status).toBe(200);
  expect((await call('DELETE', '/api/comments/c1', { csrf: 'tok123' })).status).toBe(200);
});

test('with the widget token (Authorization header) CSRF is not needed', async () => {
  const { env } = await setup();
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  const res = await appFetch(
    new Request('https://pinna.test/api/projects/site/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + wt },
      body: JSON.stringify(NEW_COMMENT),
    }),
    env,
    makeCtx(),
  );
  expect(res.status).toBe(201);
});
