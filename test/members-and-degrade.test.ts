/**
 * Pinna - route to remove a membership, fail-closed revocations except when
 * the table is missing, and a Worker that does not return 500 without
 * migration 0002.
 */
import { test, expect } from 'bun:test';
import app from '../worker/index';
import { signTyped } from '../worker/auth';
import * as db from '../worker/db';
import { makeProxyToken } from '../worker/proxy';
import { appFetch, makeEnv, makeD1, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

const FUTURE = () => Date.now() + 3600_000;
const session = (uid: string, role: string) =>
  signTyped('session', { uid, role, exp: FUTURE(), iat: Date.now() }, TEST_SECRET);

async function setup() {
  const env = makeEnv({ PINNA_PROXY_ENABLED: '1' });
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedUser(env.raw, 'u_c2', 'c2@example.com', 'client');
  seedUser(env.raw, 'u_collab', 'collab@example.com', 'collab');
  seedUser(env.raw, 'u_collab2', 'collab2@example.com', 'collab');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test/');
  await db.addMembership(env.DB, 'u_c', 'p1', 'client');
  await db.addMembership(env.DB, 'u_c2', 'p1', 'client');
  await db.addMembership(env.DB, 'u_collab', 'p1', 'collab');
  await db.addMembership(env.DB, 'u_collab2', 'p1', 'collab');
  return env;
}

async function removeMember(env: ReturnType<typeof makeEnv>, actorUid: string, actorRole: string, target: string, csrf = true) {
  const s = await session(actorUid, actorRole);
  return appFetch(
    new Request('https://pinna.test/api/projects/p1/members/' + target, {
      method: 'DELETE',
      headers: { Cookie: '__Host-pinna_session=' + s + '; __Host-pinna_csrf=t', ...(csrf ? { 'X-CSRF-Token': 't' } : {}) },
    }),
    env,
    makeCtx(),
  );
}

test('removing a membership: the admin removes a client and their tokens stop working', async () => {
  const env = await setup();
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: FUTURE(), iat: Date.now() }, TEST_SECRET);
  const pt = (await makeProxyToken('u_c', 'p1', 'https://staging.test/', TEST_SECRET))!;
  globalThis.fetch = (async () => new Response('<html><head></head><body>x</body></html>', { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
  const comments = () =>
    appFetch(new Request('https://pinna.test/api/projects/site/comments', { headers: { Authorization: 'Bearer ' + wt } }), env, makeCtx());
  const proxied = () => appFetch(new Request('https://pinna.test/_proxy?url=' + encodeURIComponent('https://staging.test/') + '&pinna_pt=' + encodeURIComponent(pt)), env, makeCtx());
  expect((await comments()).status).toBe(200);
  expect((await proxied()).status).toBe(200);

  expect((await removeMember(env, 'u_admin', 'admin', 'u_c', false)).status).toBe(403); // without CSRF
  expect((await removeMember(env, 'u_admin', 'admin', 'u_c')).status).toBe(200);
  expect((await comments()).status).toBe(401);
  expect((await proxied()).status).toBe(403);
  // With a session too, access to the project is gone.
  const s = await session('u_c', 'client');
  const viaSession = await appFetch(
    new Request('https://pinna.test/api/projects/site/comments', { headers: { Cookie: '__Host-pinna_session=' + s } }),
    env,
    makeCtx(),
  );
  expect(viaSession.status).toBe(403);
});

test('removing a membership: a collab removes only clients, a client removes nobody', async () => {
  const env = await setup();
  expect((await removeMember(env, 'u_collab', 'collab', 'u_collab2')).status).toBe(403);
  expect((await removeMember(env, 'u_collab', 'collab', 'u_c2')).status).toBe(200);
  expect((await removeMember(env, 'u_c', 'client', 'u_collab')).status).toBe(401);
  expect((await removeMember(env, 'u_admin', 'admin', 'u_nobody')).status).toBe(404);
  expect((await removeMember(env, 'u_admin', 'admin', 'u_collab2')).status).toBe(200);
});

test('project member list: only for whoever administers the project', async () => {
  const env = await setup();
  const get = async (uid: string, role: string) =>
    appFetch(
      new Request('https://pinna.test/api/projects/p1/members', { headers: { Cookie: '__Host-pinna_session=' + (await session(uid, role)) } }),
      env,
      makeCtx(),
    );
  const ok = await get('u_collab', 'collab');
  expect(ok.status).toBe(200);
  const rows = (await ok.json()) as { id: string; role: string }[];
  expect(rows.find((r) => r.id === 'u_collab2')?.role).toBe('collab');
  expect(rows.find((r) => r.id === 'u_c')?.role).toBe('client');
  expect((await get('u_c', 'client')).status).toBe(401);
});

/** D1 that fails only on the revocation queries. */
function breakRevocations(env: ReturnType<typeof makeEnv>, message: string) {
  const real = env.DB;
  const boom = async () => { throw new Error(message); };
  env.DB = {
    ...real,
    prepare: (sql: string) =>
      sql.includes('session_revocations') ? ({ bind: () => ({ first: boom, run: boom, all: boom }) } as never) : real.prepare(sql),
  } as D1Database;
}

test('revocations: any D1 error = fail-closed, missing table = fail-open', async () => {
  const env = makeEnv();
  seedUser(env.raw, 'u_a', 'a@example.com', 'client');
  const s = await session('u_a', 'client');
  const me = () => appFetch(new Request('https://pinna.test/api/auth/me', { headers: { Cookie: '__Host-pinna_session=' + s } }), env, makeCtx());
  expect((await me()).status).toBe(200);
  breakRevocations(env, 'D1_ERROR: Network connection lost');
  expect((await me()).status).toBe(401);
  const env2 = makeEnv();
  seedUser(env2.raw, 'u_a', 'a@example.com', 'client');
  breakRevocations(env2, 'D1_ERROR: no such table: session_revocations');
  const me2 = await appFetch(new Request('https://pinna.test/api/auth/me', { headers: { Cookie: '__Host-pinna_session=' + s } }), env2, makeCtx());
  expect(me2.status).toBe(200);
});

test('without migration 0002 the Worker does not return 500: client role and a log line', async () => {
  const env = makeEnv();
  const { DB, raw } = makeD1({ skipMigrations: ['0002'] });
  env.DB = DB;
  (env as { raw: unknown }).raw = raw;
  seedUser(raw, 'u_collab', 'collab@example.com', 'collab');
  seedProject(raw, 'p1', 'site', 'https://staging.test/');
  raw.query("INSERT INTO memberships (user_id, project_id, created_at) VALUES ('u_collab', 'p1', 0)").run();
  const s = await session('u_collab', 'collab');
  const cookie = { Cookie: '__Host-pinna_session=' + s + '; __Host-pinna_csrf=t', 'X-CSRF-Token': 't', 'Content-Type': 'application/json' };
  const projects = await appFetch(new Request('https://pinna.test/api/projects', { headers: cookie }), env, makeCtx());
  expect(projects.status).toBe(200);
  const list = (await projects.json()) as { my_role: string; can_admin: boolean }[];
  expect(list[0]).toMatchObject({ my_role: 'client', can_admin: false });
  const wt = await appFetch(new Request('https://pinna.test/api/projects/site/widget-token', { headers: cookie }), env, makeCtx());
  expect(wt.status).toBe(200);
  expect(((await wt.json()) as { role: string }).role).toBe('client');
  // A comment (notifications in waitUntil) and an invite from the admin: no 500.
  const ctx = makeCtx();
  const post = await appFetch(
    new Request('https://pinna.test/api/projects/site/comments', {
      method: 'POST',
      headers: cookie,
      body: JSON.stringify({ body: 'hello', page_path: '/', page_x: 1, page_y: 1 }),
    }),
    env,
    ctx,
  );
  expect(post.status).toBe(201);
  await ctx.settle();
  const ms = await session('u_admin', 'admin');
  const invite = await appFetch(
    new Request('https://pinna.test/api/projects/p1/invite', {
      method: 'POST',
      headers: { Cookie: '__Host-pinna_session=' + ms + '; __Host-pinna_csrf=t', 'X-CSRF-Token': 't', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', role: 'collab' }),
    }),
    env,
    makeCtx(),
  );
  expect(invite.status).toBe(201);
  expect(await db.listNotifyRecipients(DB, 'p1', 'client')).toBeArray();
  expect(await db.listNotifyRecipients(DB, 'p1', 'admin')).toBeArray();
});
