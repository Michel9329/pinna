/**
 * Pinna - shape of GET /api/projects/:slug/comments. Only the fields the widget
 * and the app read: no storage key (r2_key), no uploader or author id, no
 * project id. author_role is the role ON THIS PROJECT, never the global role
 * of a user who is only a client here. The same shape on every route that
 * answers with a comment (list, create, edit), and each file says whether the
 * caller uploaded it (mine) without exposing who did.
 */
import { test, expect } from 'bun:test';
import { signTyped } from '../worker/auth';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

const COMMENT_KEYS = [
  'anchor_selector', 'anchor_x', 'anchor_y', 'attachments', 'author_role', 'body', 'created_at', 'id', 'mine',
  'page_path', 'page_x', 'page_y', 'parent_id', 'resolved_at', 'status', 'viewport', 'viewport_w',
].sort();
const ATTACHMENT_KEYS = ['content_type', 'filename', 'id', 'mine', 'url'].sort();

async function setup() {
  const env = makeEnv();
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  // Global role 'collab' (collaborator elsewhere), but only a client on this project.
  seedUser(env.raw, 'u_g', 'g@example.com', 'collab');
  seedUser(env.raw, 'u_col', 'col@example.com', 'collab');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test/');
  env.raw.query(
    "INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client'), ('u_g', 'p1', 0, 'client'), ('u_col', 'p1', 0, 'collab')",
  ).run();
  const authors = { c_c: 'u_c', c_g: 'u_g', c_col: 'u_col', c_adm: 'u_admin' } as const;
  for (const [id, author] of Object.entries(authors)) {
    env.raw
      .query("INSERT INTO comments (id, project_id, page_path, body, author_id, status, created_at) VALUES (?, 'p1', '/', 'text', ?, 'open', 0)")
      .run(id, author);
    env.raw
      .query("INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by) VALUES (?, ?, 'p1', ?, 'f.png', 'image/png', 3, 0, ?)")
      .run('a_' + id, id, 'att/secret-key-' + id, author);
  }
  return env;
}

async function list(env: Awaited<ReturnType<typeof setup>>, uid: string) {
  const wt = await signTyped('widget', { uid, pid: 'p1', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  const res = await appFetch(
    new Request('https://pinna.test/api/projects/site/comments', { headers: { Authorization: 'Bearer ' + wt } }),
    env,
    makeCtx(),
  );
  expect(res.status).toBe(200);
  const text = await res.text();
  return { text, rows: JSON.parse(text) as Record<string, unknown>[] };
}

test("a client's list: explicit fields only, no r2_key, no created_by, no project or author id", async () => {
  const env = await setup();
  const { text, rows } = await list(env, 'u_c');
  expect(rows.length).toBe(4);
  for (const r of rows) {
    expect(Object.keys(r).sort()).toEqual(COMMENT_KEYS);
    for (const a of r.attachments as Record<string, unknown>[]) {
      expect(Object.keys(a).sort()).toEqual(ATTACHMENT_KEYS);
    }
  }
  expect(text).not.toContain('r2_key');
  expect(text).not.toContain('secret-key');
  expect(text).not.toContain('created_by');
  expect(text).not.toContain('project_id');
  expect(text).not.toContain('author_id');
  expect(text).not.toContain('u_g');
});

test('author_role is the role on this project, not the global one', async () => {
  const env = await setup();
  const { rows } = await list(env, 'u_c');
  const role = (id: string) => rows.find((r) => r.id === id)?.author_role;
  expect(role('c_g')).toBe('client');
  expect(role('c_col')).toBe('collab');
  expect(role('c_adm')).toBe('admin');
  expect(role('c_c')).toBe('client');
  // 'mine' still follows the requesting user.
  expect(rows.filter((r) => r.mine).map((r) => r.id)).toEqual(['c_c']);
});

test('an author who is no longer a member shows as client', async () => {
  const env = await setup();
  env.raw.query("DELETE FROM memberships WHERE user_id = 'u_col'").run();
  const { rows } = await list(env, 'u_c');
  expect(rows.find((r) => r.id === 'c_col')?.author_role).toBe('client');
});

async function send(env: Awaited<ReturnType<typeof setup>>, uid: string, method: string, path: string, body: unknown) {
  const wt = await signTyped('widget', { uid, pid: 'p1', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  return appFetch(
    new Request('https://pinna.test' + path, {
      method,
      headers: { Authorization: 'Bearer ' + wt, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
    makeCtx(),
  );
}

test("create and edit answer with the same shape as the list (also an empty patch on someone else's comment)", async () => {
  const env = await setup();
  const created = await send(env, 'u_c', 'POST', '/api/projects/site/comments', { body: 'new', page_path: '/', page_x: 1, page_y: 1 });
  expect(created.status).toBe(201);
  const c = (await created.json()) as Record<string, unknown>;
  expect(Object.keys(c).sort()).toEqual([...COMMENT_KEYS, 'attachments_linked', 'attachments_requested'].sort());
  // An empty patch passes every check: it must not return the stored row.
  const empty = await send(env, 'u_c', 'PATCH', '/api/comments/c_adm', {});
  expect(empty.status).toBe(200);
  const e = (await empty.json()) as Record<string, unknown>;
  expect(Object.keys(e).sort()).toEqual(COMMENT_KEYS);
  for (const a of e.attachments as Record<string, unknown>[]) expect(Object.keys(a).sort()).toEqual(ATTACHMENT_KEYS);
  expect(JSON.stringify(e)).not.toContain('u_admin');
  expect(JSON.stringify(e)).not.toContain('secret-key');
  const edited = await send(env, 'u_c', 'PATCH', '/api/comments/c_c', { body: 'edited text' });
  expect(edited.status).toBe(200);
  expect(Object.keys((await edited.json()) as object).sort()).toEqual(COMMENT_KEYS);
});

test("each file says whether the caller uploaded it (mine), without the uploader's id", async () => {
  const env = await setup();
  // A legacy file with no recorded uploader on the client's own comment.
  env.raw
    .query("INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by) VALUES ('a_legacy', 'c_c', 'p1', 'att/legacy', 'old.png', 'image/png', 3, 0, NULL)")
    .run();
  const { rows } = await list(env, 'u_c');
  const files = (id: string) => (rows.find((r) => r.id === id)!.attachments as { id: string; mine: boolean }[]);
  expect(files('c_c').map((a) => [a.id, a.mine]).sort()).toEqual([['a_c_c', true], ['a_legacy', false]]);
  expect(files('c_adm').map((a) => a.mine)).toEqual([false]);
});

test('author_role on the create and edit answers is the role on this project', async () => {
  const env = await setup();
  const byCollab = await send(env, 'u_col', 'POST', '/api/projects/site/comments', { body: 'from the collab', page_path: '/', page_x: 1, page_y: 1 });
  expect(((await byCollab.json()) as { author_role: string }).author_role).toBe('collab');
  // u_g is 'collab' globally but a client here.
  const byG = await send(env, 'u_g', 'POST', '/api/projects/site/comments', { body: 'from g', page_path: '/', page_x: 1, page_y: 1 });
  expect(((await byG.json()) as { author_role: string }).author_role).toBe('client');
  // The edit answer carries the AUTHOR's role, not the editor's.
  const onAdmin = await send(env, 'u_c', 'PATCH', '/api/comments/c_adm', {});
  expect(((await onAdmin.json()) as { author_role: string }).author_role).toBe('admin');
  const onG = await send(env, 'u_g', 'PATCH', '/api/comments/c_g', { body: 'edited by g' });
  expect(((await onG.json()) as { author_role: string }).author_role).toBe('client');
});
