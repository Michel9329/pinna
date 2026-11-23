/**
 * Pinna - an unlinked upload (draft) older than DRAFT_TTL_MS is never linked
 * to a comment: the nightly sweep may be deleting its file at that moment, and
 * the comment would keep a row without the file. What the route does with an
 * attachment id it cannot link is unchanged: the comment is created without it
 * and attachments_linked reports how many were linked.
 */
import { test, expect } from 'bun:test';
import { signTyped } from '../worker/auth';
import { DRAFT_TTL_MS } from '../worker/db';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

async function setup() {
  const env = makeEnv();
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  const draft = env.raw.query(
    "INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by) VALUES (?, NULL, 'p1', ?, 'g.png', 'image/png', 3, ?, 'u_c')",
  );
  draft.run('a_old', 'att/a_old', Date.now() - DRAFT_TTL_MS - 60_000);
  draft.run('a_new', 'att/a_new', Date.now() - 60_000);
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  return { env, wt };
}

async function post(env: ReturnType<typeof makeEnv>, wt: string, ids: string[]) {
  const ctx = makeCtx();
  const res = await appFetch(
    new Request('https://pinna.test/api/projects/site/comments', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wt, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: 'with a file', page_path: '/', page_x: 1, page_y: 1, attachment_ids: ids }),
    }),
    env,
    ctx,
  );
  await ctx.settle();
  return res;
}

const linkedTo = (env: ReturnType<typeof makeEnv>, id: string) =>
  (env.raw.query('SELECT comment_id FROM attachments WHERE id = ?').get(id) as { comment_id: string | null }).comment_id;

test('a draft older than the sweep cutoff is not linked: comment created without it', async () => {
  const { env, wt } = await setup();
  const res = await post(env, wt, ['a_old']);
  expect(res.status).toBe(201);
  expect(((await res.json()) as { attachments_linked: number }).attachments_linked).toBe(0);
  expect(linkedTo(env, 'a_old')).toBeNull();
});

test('a recent draft is linked as before', async () => {
  const { env, wt } = await setup();
  const res = await post(env, wt, ['a_new', 'a_old']);
  expect(res.status).toBe(201);
  const body = (await res.json()) as { id: string; attachments_linked: number };
  expect(body.attachments_linked).toBe(1);
  expect(linkedTo(env, 'a_new')).toBe(body.id);
  expect(linkedTo(env, 'a_old')).toBeNull();
});
