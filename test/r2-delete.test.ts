/**
 * Pinna - R2 deletion in batches, and D1 rows removed only after R2.
 * R2.delete() accepts at most 1,000 keys, and without this ordering the error
 * would be ignored once the D1 rows were already gone.
 */
import { test, expect } from 'bun:test';
import worker from '../worker/index';
import { signTyped } from '../worker/auth';
import { deleteR2InBatches, R2_DELETE_BATCH } from '../worker/r2';
import { makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

/** Fake R2 that records the delete calls and refuses more than 1,000 keys. */
function recordingR2(fail = false) {
  const calls: number[] = [];
  const bucket = {
    delete: async (k: string | string[]) => {
      const n = Array.isArray(k) ? k.length : 1;
      if (n > 1000) throw new Error('too many keys');
      if (fail) throw new Error('R2 down');
      calls.push(n);
    },
    put: async () => ({}),
    get: async () => null,
  } as unknown as R2Bucket;
  return { bucket, calls };
}

test('deleteR2InBatches: batches of 1,000, the callback after each batch', async () => {
  const { bucket, calls } = recordingR2();
  const keys = Array.from({ length: 2500 }, (_, i) => 'att/' + i);
  const after: number[] = [];
  const r = await deleteR2InBatches(bucket, keys, async (b) => { after.push(b.length); });
  expect(R2_DELETE_BATCH).toBe(1000);
  expect(calls).toEqual([1000, 1000, 500]);
  expect(after).toEqual([1000, 1000, 500]);
  expect(r).toEqual({ deleted: 2500, failed: false });
});

function insertAtt(env: ReturnType<typeof makeEnv>, id: string, commentId: string | null, createdAt: number) {
  env.raw
    .query(
      'INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, commentId, 'p1', 'att/' + id, 'f.png', 'image/png', 1, createdAt, 'u_c');
}

test('cron: 1,500 orphans -> R2 in batches of 1,000 and all rows removed', async () => {
  const env = makeEnv();
  const { bucket, calls } = recordingR2();
  env.ATTACHMENTS = bucket;
  const old = Date.now() - 25 * 3600_000;
  for (let i = 0; i < 1500; i++) insertAtt(env, 'o' + i, null, old);
  const ctx = makeCtx();
  await worker.scheduled({} as ScheduledController, env, ctx);
  await ctx.settle();
  expect(calls).toEqual([1000, 500]);
  expect(env.raw.query('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 0 });
});

test('cron: if R2 fails the orphan rows stay (retried the next day)', async () => {
  const env = makeEnv();
  env.ATTACHMENTS = recordingR2(true).bucket;
  insertAtt(env, 'orphan', null, Date.now() - 25 * 3600_000);
  const ctx = makeCtx();
  await worker.scheduled({} as ScheduledController, env, ctx);
  await ctx.settle();
  expect(env.raw.query('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 1 });
});

async function sessionEnv(failR2: boolean) {
  const env = makeEnv();
  env.ATTACHMENTS = recordingR2(failR2).bucket;
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  env.raw.query("INSERT INTO comments (id, project_id, page_path, body, author_id, status, created_at) VALUES ('c1', 'p1', '/', 'x', 'u_c', 'open', 0)").run();
  insertAtt(env, 'a1', 'c1', Date.now());
  const s = await signTyped('session', { uid: 'u_c', role: 'client', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  const del = (path: string) =>
    worker.fetch(
      new Request('https://pinna.test' + path, {
        method: 'DELETE',
        headers: { Cookie: '__Host-pinna_session=' + s + '; __Host-pinna_csrf=t', 'X-CSRF-Token': 't' },
      }),
      env,
      makeCtx(),
    );
  return { env, del };
}

test('R2 down: deleting a comment or an attachment gives 502 and does not touch D1', async () => {
  const { env, del } = await sessionEnv(true);
  expect((await del('/api/attachments/a1')).status).toBe(502);
  expect((await del('/api/comments/c1')).status).toBe(502);
  expect(env.raw.query('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 1 });
  expect(env.raw.query('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 1 });
});

test('R2 up: comment and attachments removed from R2 and from D1', async () => {
  const { env, del } = await sessionEnv(false);
  expect((await del('/api/comments/c1')).status).toBe(200);
  expect(env.raw.query('SELECT COUNT(*) AS n FROM attachments').get()).toEqual({ n: 0 });
  expect(env.raw.query('SELECT COUNT(*) AS n FROM comments').get()).toEqual({ n: 0 });
});
