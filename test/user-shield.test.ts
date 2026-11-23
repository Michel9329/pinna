/**
 * Pinna - routes that write without a limit. Without the shield, PATCH of a
 * comment and mute let 300 out of 300 through, each with a D1 write, and the
 * D1 limits wrote even when they refused. So: an in-memory per-user shield
 * (USER_RL) before every route that writes, no write if the value does not
 * change, and a refusal does not increment the counter.
 */
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import app from '../worker/index';
import { signTyped } from '../worker/auth';
import * as db from '../worker/db';
import { consumeRateLimit, consumeSliding, USER_LIMIT, USER_PERIOD } from '../worker/rate-limit';
import { appFetch, makeEnv, makeD1, makeCtx, seedUser, seedProject, sized, TEST_SECRET } from './helpers/env';

type Env = ReturnType<typeof makeEnv>;
const FUT = () => Date.now() + 3600_000;

async function setup() {
  const env = makeEnv();
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test/');
  await db.addMembership(env.DB, 'u_c', 'p1', 'client');
  const c = await db.createComment(env.DB, 'p1', 'u_c', { body: 'x', page_path: '/' } as never);
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: FUT(), iat: Date.now() }, TEST_SECRET);
  const s = await signTyped('session', { uid: 'u_c', role: 'client', exp: FUT(), iat: Date.now() - 5 }, TEST_SECRET);
  return { env, commentId: c.id, wt, s };
}

async function call(env: Env, req: Request) {
  return appFetch(await sized(req), env, makeCtx());
}
const patch = (env: Env, id: string, wt: string, body: string) =>
  call(env, new Request('https://pinna.test/api/comments/' + id, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + wt, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  }));
const mute = (env: Env, s: string, muted: boolean) =>
  call(env, new Request('https://pinna.test/api/notifications/mute', {
    method: 'POST',
    headers: { Cookie: '__Host-pinna_session=' + s + '; __Host-pinna_csrf=t', 'X-CSRF-Token': 't', 'Content-Type': 'application/json' },
    body: JSON.stringify({ muted }),
  }));

/** Counts the SQL statements that write (UPDATE/INSERT/DELETE) to a table. */
function spyWrites(env: Env, table: string): { n: number } {
  const box = { n: 0 };
  const orig = env.DB.prepare.bind(env.DB);
  (env.DB as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
    if (new RegExp('^\\s*(UPDATE|INSERT[^(]*INTO|DELETE FROM)\\s+' + table + '\\b', 'i').test(sql)) box.n++;
    return orig(sql);
  };
  return box;
}

test('300 PATCHes in a row with the widget-token: USER_LIMIT go through, then 429', async () => {
  const { env, commentId, wt } = await setup();
  const codes: Record<number, number> = {};
  for (let i = 0; i < 300; i++) {
    const r = await patch(env, commentId, wt, 'y' + (i % 2));
    codes[r.status] = (codes[r.status] || 0) + 1;
  }
  expect(codes).toEqual({ 200: USER_LIMIT, 429: 300 - USER_LIMIT });
});

test('300 mutes in a row: USER_LIMIT go through, then 429', async () => {
  const { env, s } = await setup();
  const codes: Record<number, number> = {};
  for (let i = 0; i < 300; i++) {
    const r = await mute(env, s, i % 2 === 0);
    codes[r.status] = (codes[r.status] || 0) + 1;
  }
  expect(codes).toEqual({ 200: USER_LIMIT, 429: 300 - USER_LIMIT });
});

test('the shield is per user: another user can still write', async () => {
  const { env, commentId, wt } = await setup();
  for (let i = 0; i < USER_LIMIT; i++) await patch(env, commentId, wt, 'y' + (i % 2));
  expect((await patch(env, commentId, wt, 'z')).status).toBe(429);
  seedUser(env.raw, 'u_d', 'd@example.com', 'client');
  await db.addMembership(env.DB, 'u_d', 'p1', 'client');
  const c2 = await db.createComment(env.DB, 'p1', 'u_d', { body: 'x', page_path: '/' } as never);
  const wt2 = await signTyped('widget', { uid: 'u_d', pid: 'p1', exp: FUT(), iat: Date.now() }, TEST_SECRET);
  expect((await patch(env, c2.id, wt2, 'new')).status).toBe(200);
});

test("with the USER_RL binding the shield uses the binding with the user's key", async () => {
  const { env, commentId, wt } = await setup();
  const keys: string[] = [];
  env.USER_RL = { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } as unknown as RateLimit;
  expect((await patch(env, commentId, wt, 'y')).status).toBe(429);
  expect(keys).toEqual(['u:u_c']);
});

test('PATCH with the same text and mute with the same value: no write', async () => {
  const { env, commentId, wt, s } = await setup();
  const comments = spyWrites(env, 'comments');
  expect((await patch(env, commentId, wt, 'x')).status).toBe(200);
  expect(comments.n).toBe(0);
  expect((await patch(env, commentId, wt, 'new')).status).toBe(200);
  expect(comments.n).toBe(1);
  const prefs = spyWrites(env, 'notification_prefs');
  expect((await mute(env, s, false)).status).toBe(200); // already not muted
  expect(prefs.n).toBe(0);
  expect((await mute(env, s, true)).status).toBe(200);
  expect((await mute(env, s, true)).status).toBe(200);
  expect(prefs.n).toBe(1);
});

test('consumeRateLimit in a burst: the counter does not exceed the threshold (refusals do not increment)', async () => {
  const { DB, raw } = makeD1();
  const r = await Promise.all(Array.from({ length: 20 }, () => consumeRateLimit(DB, 'burst', 'k', 3, 60)));
  expect(r.filter((x) => x.allowed).length).toBe(3);
  expect((raw.query("SELECT n FROM rate_limits WHERE k = 'burst:k'").get() as { n: number }).n).toBe(3);
  // amount above the threshold: refused without a row.
  expect((await consumeRateLimit(DB, 'big', 'k', 10, 60, { amount: 11 })).allowed).toBe(false);
  expect(raw.query("SELECT 1 FROM rate_limits WHERE k = 'big:k'").get()).toBeNull();
});

test('consumeSliding in a burst: the bucket does not exceed the threshold', async () => {
  const { DB, raw } = makeD1();
  const r = await Promise.all(Array.from({ length: 20 }, () => consumeSliding(DB, 'slide', 'k', 4, 86400)));
  expect(r.filter((x) => x.allowed).length).toBe(4);
  expect((raw.query("SELECT SUM(n) AS n FROM rate_limits WHERE k = 'slide:k'").get() as { n: number }).n).toBe(4);
});

test('wrangler.toml: USER_RL with limit/period equal to USER_LIMIT/USER_PERIOD', () => {
  const toml = readFileSync(join(import.meta.dir, '..', 'wrangler.toml'), 'utf-8');
  const block = toml.slice(toml.indexOf('name = "USER_RL"'));
  expect(block).toMatch(new RegExp('limit = ' + USER_LIMIT + '\\s'));
  expect(block).toMatch(new RegExp('period = ' + USER_PERIOD + '\\s'));
});
