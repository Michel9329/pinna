/**
 * Pinna - comment caps: text at most 5,000 characters, daily cap per user and
 * per project, storage quota per project. A per-minute limit alone (30 a
 * minute) would still let a user fill the database.
 */
import { test, expect } from 'bun:test';
import app from '../worker/index';
import { signTyped } from '../worker/auth';
import { COMMENTS_PER_USER_DAY, COMMENTS_PER_PROJECT_DAY, PROJECT_COMMENT_CHARS } from '../worker/schemas';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

type Env = ReturnType<typeof makeEnv>;

function setup(): Env {
  const env = makeEnv();
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  return env;
}

async function send(env: Env, method: string, path: string, body: unknown) {
  const s = await signTyped('session', { uid: 'u_c', role: 'client', exp: Date.now() + 3600_000, iat: Date.now() - 1000 }, TEST_SECRET);
  const ctx = makeCtx();
  const res = await appFetch(
    new Request('https://pinna.test' + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Cookie: '__Host-pinna_session=' + s + '; __Host-pinna_csrf=t1',
        'X-CSRF-Token': 't1',
      },
      body: JSON.stringify(body),
    }),
    env,
    ctx,
  );
  await ctx.settle();
  return res;
}
const post = (env: Env, body: string) => send(env, 'POST', '/api/projects/site/comments', { body, page_path: '/' });

/** Puts the daily counter `rule:key` already at the cap. */
function fillDay(env: Env, k: string, n: number) {
  const now = Math.floor(Date.now() / 1000);
  env.raw.query('INSERT INTO rate_limits (k, win, n) VALUES (?, ?, ?)').run(k, now - (now % 86400), n);
}

test('text: 5,000 characters yes, 5,001 no (also when editing)', async () => {
  const env = setup();
  const ok = await post(env, 'a'.repeat(5000));
  expect(ok.status).toBe(201);
  expect((await post(env, 'a'.repeat(5001))).status).toBe(400);
  const id = ((await ok.json()) as { id: string }).id;
  expect((await send(env, 'PATCH', '/api/comments/' + id, { body: 'b'.repeat(5001) })).status).toBe(400);
});

test('daily cap per user', async () => {
  const env = setup();
  fillDay(env, 'comments-user-day:u_c', COMMENTS_PER_USER_DAY);
  const r = await post(env, 'hello');
  expect(r.status).toBe(429);
  expect((env.raw.query('SELECT COUNT(*) AS n FROM comments').get() as { n: number }).n).toBe(0);
});

test('daily cap per project', async () => {
  const env = setup();
  fillDay(env, 'comments-project-day:p1', COMMENTS_PER_PROJECT_DAY);
  expect((await post(env, 'hello')).status).toBe(429);
});

test('project storage quota: beyond it, no new comments nor longer texts', async () => {
  const env = setup();
  const first = await post(env, 'short');
  const id = ((await first.json()) as { id: string }).id;
  env.raw
    .query("INSERT INTO comments (id, project_id, page_path, body, author_id, status, created_at) VALUES ('big', 'p1', '/', ?, 'u_c', 'open', 0)")
    .run('x'.repeat(PROJECT_COMMENT_CHARS - 5));
  expect((await post(env, 'second')).status).toBe(413);
  expect((await send(env, 'PATCH', '/api/comments/' + id, { body: 'more text' })).status).toBe(413);
  // Shortening is always allowed.
  expect((await send(env, 'PATCH', '/api/comments/' + id, { body: 'c' })).status).toBe(200);
});
