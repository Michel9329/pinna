/**
 * Pinna - deleting a pin deletes its whole thread (replies and files), so the
 * pin's author can delete it directly only when the whole thread is theirs.
 * With a reply or a file by someone else in the thread, the admin rule applies
 * even to the author: the widget-token is refused (app only) and a session
 * needs to administer the project.
 */
import { test, expect } from 'bun:test';
import { signTyped } from '../worker/auth';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

const FUTURE = () => Date.now() + 3600_000;
const APP_ONLY = 'action reserved for the Pinna app (requires a session)';

async function setup() {
  const env = makeEnv();
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  return env;
}

/** A pin with the given replies, each reply with one attachment uploaded by its author. */
async function thread(
  env: Awaited<ReturnType<typeof setup>>,
  pin: { id: string; author: string },
  replies: { id: string; author: string }[],
) {
  env.raw
    .query("INSERT INTO comments (id, project_id, page_path, body, author_id, status, created_at) VALUES (?, 'p1', '/', 'pin', ?, 'open', 0)")
    .run(pin.id, pin.author);
  for (const r of replies) {
    env.raw
      .query("INSERT INTO comments (id, project_id, parent_id, page_path, body, author_id, status, created_at) VALUES (?, 'p1', ?, '', 'reply', ?, 'open', 1)")
      .run(r.id, pin.id, r.author);
  }
  for (const c of [pin, ...replies]) {
    const key = 'att/a_' + c.id;
    env.raw
      .query("INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by) VALUES (?, ?, 'p1', ?, 'f.png', 'image/png', 3, 0, ?)")
      .run('a_' + c.id, c.id, key, c.author);
    await env.ATTACHMENTS.put(key, new Uint8Array([1, 2, 3]));
  }
}

function widgetDelete(env: Awaited<ReturnType<typeof setup>>, uid: string, id: string) {
  return signTyped('widget', { uid, pid: 'p1', exp: FUTURE(), iat: Date.now() }, TEST_SECRET).then((wt) =>
    appFetch(
      new Request('https://pinna.test/api/comments/' + id, { method: 'DELETE', headers: { Authorization: 'Bearer ' + wt } }),
      env,
      makeCtx(),
    ),
  );
}

async function sessionDelete(env: Awaited<ReturnType<typeof setup>>, uid: string, role: string, id: string) {
  const s = await signTyped('session', { uid, role, exp: FUTURE(), iat: Date.now() }, TEST_SECRET);
  return appFetch(
    new Request('https://pinna.test/api/comments/' + id, {
      method: 'DELETE',
      headers: { Cookie: '__Host-pinna_session=' + s + '; __Host-pinna_csrf=t', 'X-CSRF-Token': 't' },
    }),
    env,
    makeCtx(),
  );
}

function counts(env: Awaited<ReturnType<typeof setup>>) {
  return {
    comments: (env.raw.query('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n,
    attachments: (env.raw.query('SELECT COUNT(*) AS n FROM attachments').get() as { n: number }).n,
    blobs: (env.ATTACHMENTS as unknown as { keys: () => string[] }).keys().length,
  };
}

test("client deletes their own pin that holds an admin's reply: 403, nothing deleted (widget-token and session)", async () => {
  const env = await setup();
  await thread(env, { id: 'c1', author: 'u_c' }, [{ id: 'r1', author: 'u_admin' }]);
  const before = counts(env);
  expect(before).toEqual({ comments: 2, attachments: 2, blobs: 2 });
  const wt = await widgetDelete(env, 'u_c', 'c1');
  expect(wt.status).toBe(403);
  expect(((await wt.json()) as { error: string }).error).toBe(APP_ONLY);
  const app = await sessionDelete(env, 'u_c', 'client', 'c1');
  expect(app.status).toBe(403);
  expect(((await app.json()) as { error: string }).error).toBe('forbidden');
  expect(counts(env)).toEqual(before);
});

test('a file in the thread uploaded by someone else (or by an unknown uploader) also needs the admin rule', async () => {
  const env = await setup();
  await thread(env, { id: 'c1', author: 'u_c' }, [{ id: 'r1', author: 'u_c' }]);
  env.raw.query("UPDATE attachments SET created_by = 'u_admin' WHERE id = 'a_r1'").run();
  expect((await widgetDelete(env, 'u_c', 'c1')).status).toBe(403);
  env.raw.query("UPDATE attachments SET created_by = NULL WHERE id = 'a_r1'").run();
  expect((await widgetDelete(env, 'u_c', 'c1')).status).toBe(403);
  expect(counts(env)).toEqual({ comments: 2, attachments: 2, blobs: 2 });
});

test('own pin with only own replies: the author deletes it with the widget-token (200), thread and files gone', async () => {
  const env = await setup();
  await thread(env, { id: 'c1', author: 'u_c' }, [{ id: 'r1', author: 'u_c' }]);
  expect((await widgetDelete(env, 'u_c', 'c1')).status).toBe(200);
  expect(counts(env)).toEqual({ comments: 0, attachments: 0, blobs: 0 });
});

test("the admin deletes the client's pin with the admin's reply from the app session: 200", async () => {
  const env = await setup();
  await thread(env, { id: 'c1', author: 'u_c' }, [{ id: 'r1', author: 'u_admin' }]);
  expect((await sessionDelete(env, 'u_admin', 'admin', 'c1')).status).toBe(200);
  expect(counts(env)).toEqual({ comments: 0, attachments: 0, blobs: 0 });
});

test("admin's own pin with a client's reply: the admin's widget-token is refused (app only)", async () => {
  const env = await setup();
  await thread(env, { id: 'c1', author: 'u_admin' }, [{ id: 'r1', author: 'u_c' }]);
  const res = await widgetDelete(env, 'u_admin', 'c1');
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: string }).error).toBe(APP_ONLY);
  expect(counts(env)).toEqual({ comments: 2, attachments: 2, blobs: 2 });
  // From the app session (confirmation bar) the admin deletes it.
  expect((await sessionDelete(env, 'u_admin', 'admin', 'c1')).status).toBe(200);
});

test("a reply is deleted alone: its author can delete it even when the pin is someone else's", async () => {
  const env = await setup();
  await thread(env, { id: 'c1', author: 'u_admin' }, [{ id: 'r1', author: 'u_c' }]);
  expect((await widgetDelete(env, 'u_c', 'r1')).status).toBe(200);
  expect(counts(env)).toEqual({ comments: 1, attachments: 1, blobs: 1 });
});

test("a bare reply by someone else (no file) is enough: the pin's author is refused", async () => {
  const env = await setup();
  env.raw.query("INSERT INTO comments (id, project_id, page_path, body, author_id, status, created_at) VALUES ('c1', 'p1', '/', 'pin', 'u_c', 'open', 0)").run();
  env.raw.query("INSERT INTO comments (id, project_id, parent_id, page_path, body, author_id, status, created_at) VALUES ('r1', 'p1', 'c1', '', 'reply', 'u_admin', 'open', 1)").run();
  const res = await widgetDelete(env, 'u_c', 'c1');
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error: string }).error).toBe(APP_ONLY);
  expect(counts(env)).toEqual({ comments: 2, attachments: 0, blobs: 0 });
});

test("a file with no recorded uploader on the pin itself is enough: the pin's author is refused", async () => {
  const env = await setup();
  env.raw.query("INSERT INTO comments (id, project_id, page_path, body, author_id, status, created_at) VALUES ('c1', 'p1', '/', 'pin', 'u_c', 'open', 0)").run();
  env.raw
    .query("INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by) VALUES ('a1', 'c1', 'p1', 'att/a1', 'f.png', 'image/png', 3, 0, NULL)")
    .run();
  const res = await widgetDelete(env, 'u_c', 'c1');
  expect(res.status).toBe(403);
  expect(counts(env).comments).toBe(1);
});
