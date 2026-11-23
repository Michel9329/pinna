/**
 * Pinna - powers of the widget-token. The token lives in the document of the
 * site under review, where third-party scripts can read it: it must not act as
 * project admin for an hour, nor travel in the ?wt= query. So: only the
 * Authorization header; it reads the comments, creates, edits and deletes its
 * own, attaches to its own; everything else only from the app session with
 * CSRF. iat + revocations, membership checked.
 */
import { test, expect } from 'bun:test';
import app from '../worker/index';
import { signTyped } from '../worker/auth';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

const FUTURE = () => Date.now() + 3600_000;

async function setup() {
  const env = makeEnv();
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  // c_mine: the client's; c_other: the admin's. a_mine / a_other: linked attachments.
  env.raw.query(
    "INSERT INTO comments (id, project_id, page_path, body, author_id, status, created_at) VALUES ('c_mine', 'p1', '/', 'mine', 'u_c', 'open', 0), ('c_other', 'p1', '/', 'by the admin', 'u_admin', 'open', 0)",
  ).run();
  env.raw.query(
    "INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by) VALUES " +
      "('a_mine', 'c_mine', 'p1', 'att/a_mine', 'm.png', 'image/png', 3, 0, 'u_c'), " +
      "('a_other', 'c_other', 'p1', 'att/a_other', 'o.png', 'image/png', 3, 0, 'u_admin')",
  ).run();
  await env.ATTACHMENTS.put('att/a_mine', new Uint8Array([1, 2, 3]));
  await env.ATTACHMENTS.put('att/a_other', new Uint8Array([4, 5, 6]));
  return env;
}

/** Widget-token of the global admin: the worst case if someone reads it. */
async function adminWidget(iat = Date.now()) {
  return signTyped('widget', { uid: 'u_admin', pid: 'p1', exp: FUTURE(), iat }, TEST_SECRET);
}

function call(env: ReturnType<typeof makeEnv>, method: string, path: string, wt: string, body?: unknown, bearer = true) {
  const url = 'https://pinna.test' + path + (bearer ? '' : (path.includes('?') ? '&' : '?') + 'wt=' + encodeURIComponent(wt));
  return appFetch(
    new Request(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(bearer ? { Authorization: 'Bearer ' + wt } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
    env,
    makeCtx(),
  );
}

test('the ?wt= query is worth nothing: only the Authorization header', async () => {
  const env = await setup();
  const wt = await adminWidget();
  expect((await call(env, 'GET', '/api/projects/site/comments', wt, undefined, false)).status).toBe(401);
  expect((await call(env, 'GET', '/api/projects/site/comments', wt)).status).toBe(200);
});

test("an admin's widget-token: does not resolve, does not delete other people's comments or attachments", async () => {
  const env = await setup();
  const wt = await adminWidget();
  // c_mine and a_mine belong to the client: for the admin's widget-token they are "someone else's".
  expect((await call(env, 'PATCH', '/api/comments/c_mine', wt, { status: 'done' })).status).toBe(403);
  expect((await call(env, 'PATCH', '/api/comments/c_other', wt, { status: 'done' })).status).toBe(403);
  expect((await call(env, 'DELETE', '/api/comments/c_mine', wt)).status).toBe(403);
  expect((await call(env, 'DELETE', '/api/attachments/a_mine', wt)).status).toBe(403);
  // Nothing changed.
  expect(env.raw.query("SELECT COUNT(*) AS n FROM comments WHERE status = 'open'").get()).toEqual({ n: 2 });
  expect(env.raw.query('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 2 });
});

test('widget-token: can read, create, edit and delete its OWN', async () => {
  const env = await setup();
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: FUTURE(), iat: Date.now() }, TEST_SECRET);
  expect((await call(env, 'GET', '/api/projects/site/comments', wt)).status).toBe(200);
  expect((await call(env, 'POST', '/api/projects/site/comments', wt, { body: 'new', page_path: '/', page_x: 1, page_y: 1 })).status).toBe(201);
  expect((await call(env, 'PATCH', '/api/comments/c_mine', wt, { body: 'edited' })).status).toBe(200);
  // Someone else's text: no.
  expect((await call(env, 'PATCH', '/api/comments/c_other', wt, { body: 'x' })).status).toBe(403);
  expect((await call(env, 'DELETE', '/api/attachments/a_mine', wt)).status).toBe(200);
  expect((await call(env, 'DELETE', '/api/comments/c_mine', wt)).status).toBe(200);
});

test('admin actions go through the app session with CSRF', async () => {
  const env = await setup();
  const s = await signTyped('session', { uid: 'u_admin', role: 'admin', exp: FUTURE(), iat: Date.now() }, TEST_SECRET);
  const headers = {
    'Content-Type': 'application/json',
    Cookie: '__Host-pinna_session=' + s + '; __Host-pinna_csrf=t',
    'X-CSRF-Token': 't',
  };
  const req = (method: string, path: string, body?: unknown) =>
    appFetch(
      new Request('https://pinna.test' + path, { method, headers, body: body ? JSON.stringify(body) : undefined }),
      env,
      makeCtx(),
    );
  expect((await req('PATCH', '/api/comments/c_mine', { status: 'done' })).status).toBe(200);
  expect((await req('DELETE', '/api/attachments/a_mine')).status).toBe(200);
  expect((await req('DELETE', '/api/comments/c_mine')).status).toBe(200);
});

test('revoked widget-token (iat before the cutoff) or without iat -> 401', async () => {
  const env = await setup();
  const old = await adminWidget(Date.now() - 10_000);
  env.raw.query("INSERT INTO session_revocations (user_id, revoked_before) VALUES ('u_admin', ?)").run(Date.now() - 5_000);
  expect((await call(env, 'GET', '/api/projects/site/comments', old)).status).toBe(401);
  const noIat = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: FUTURE() }, TEST_SECRET);
  expect((await call(env, 'GET', '/api/projects/site/comments', noIat)).status).toBe(401);
});

test('widget-token of a user removed from the project -> 401 at once', async () => {
  const env = await setup();
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: FUTURE(), iat: Date.now() }, TEST_SECRET);
  expect((await call(env, 'GET', '/api/projects/site/comments', wt)).status).toBe(200);
  env.raw.query("DELETE FROM memberships WHERE user_id = 'u_c'").run();
  expect((await call(env, 'GET', '/api/projects/site/comments', wt)).status).toBe(401);
});

test('attachments: read-only URLs per project and user, short-lived, GET only', async () => {
  const env = await setup();
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: FUTURE(), iat: Date.now() }, TEST_SECRET);
  const rows = (await (await call(env, 'GET', '/api/projects/site/comments', wt)).json()) as {
    id: string;
    attachments: { id: string; url: string }[];
  }[];
  const att = rows.find((r) => r.id === 'c_mine')!.attachments[0]!;
  expect(att.url).toContain('/api/attachments/a_mine?at=');
  // GET with the URL: ok, with no other credentials (like an <img>).
  const get = await appFetch(new Request('https://pinna.test' + att.url), env, makeCtx());
  expect(get.status).toBe(200);
  // One token per project and user, the same in every URL of the list; it
  // opens the attachments of THAT project, not those of another one.
  const at = new URL('https://pinna.test' + att.url).searchParams.get('at')!;
  const same = await appFetch(new Request('https://pinna.test/api/attachments/a_other?at=' + encodeURIComponent(at)), env, makeCtx());
  expect(same.status).toBe(200);
  seedProject(env.raw, 'p2', 'other', 'https://other.test/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p2', 0, 'client')").run();
  env.raw.query("INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by) VALUES ('a_p2', NULL, 'p2', 'att/a_mine', 'x.png', 'image/png', 3, 0, 'u_c')").run();
  const cross = await appFetch(new Request('https://pinna.test/api/attachments/a_p2?at=' + encodeURIComponent(at)), env, makeCtx());
  expect(cross.status).toBe(403);
  // ...does not delete...
  const del = await appFetch(new Request('https://pinna.test' + att.url, { method: 'DELETE' }), env, makeCtx());
  expect(del.status).toBe(401);
  // ...and does not work as a widget-token.
  expect((await call(env, 'GET', '/api/projects/site/comments', at)).status).toBe(401);
  // Expired: 401.
  const expired = await signTyped('att', { pid: 'p1', uid: 'u_c', exp: Date.now() - 1, iat: Date.now() - 2 }, TEST_SECRET);
  const exp = await appFetch(new Request('https://pinna.test/api/attachments/a_mine?at=' + encodeURIComponent(expired)), env, makeCtx());
  expect(exp.status).toBe(401);
});

test('widget-token issued by the route: carries iat', async () => {
  const env = await setup();
  const s = await signTyped('session', { uid: 'u_c', role: 'client', exp: FUTURE(), iat: Date.now() }, TEST_SECRET);
  const res = await appFetch(
    new Request('https://pinna.test/api/projects/site/widget-token', { headers: { Cookie: '__Host-pinna_session=' + s } }),
    env,
    makeCtx(),
  );
  const { token } = (await res.json()) as { token: string };
  const body = JSON.parse(Buffer.from(token.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  expect(typeof body.iat).toBe('number');
});
