/**
 * Pinna - orphan attachments. The purge runs in the cron (purgeRetention):
 * this test locks it in end to end, from the cron to the deletion of the R2
 * blobs.
 */
import { test, expect } from 'bun:test';
import worker from '../worker/index';
import { makeEnv, makeCtx } from './helpers/env';

test('cron: deletes rows and R2 blobs of orphan attachments older than 24h, keeps recent drafts and linked attachments', async () => {
  const env = makeEnv();
  const R2 = env.ATTACHMENTS as unknown as { keys: () => string[]; put: (k: string, v: Uint8Array) => Promise<unknown> };
  const old = Date.now() - 25 * 3600_000;
  const rows: [string, string | null, number][] = [
    ['orphan-old', null, old],
    ['draft-recent', null, Date.now() - 3600_000],
    ['linked-old', 'c1', old],
  ];
  for (const [id, commentId, at] of rows) {
    env.raw
      .query(
        'INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, commentId, 'p1', 'att/' + id, 'f.png', 'image/png', 1, at, 'u1');
    await R2.put('att/' + id, new Uint8Array([1]));
  }
  const ctx = makeCtx();
  await worker.scheduled({} as ScheduledController, env, ctx);
  await ctx.settle();
  const left = (env.raw.query('SELECT id FROM attachments ORDER BY id').all() as { id: string }[]).map((r) => r.id);
  expect(left).toEqual(['draft-recent', 'linked-old']);
  expect(R2.keys().sort()).toEqual(['att/draft-recent', 'att/linked-old']);
});
