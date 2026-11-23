/**
 * Pinna - Content-Length required on upload and /shot: rejected BEFORE
 * reading the body and before consuming the limits. Otherwise the Worker
 * would read the whole body and only then look at its size.
 */
import { test, expect } from 'bun:test';
import app from '../worker/index';
import { signTyped } from '../worker/auth';
import { MAX_UPLOAD_BODY, declaredLength } from '../worker/upload-guard';
import { MAX_SHOT_BODY } from '../worker/shot-guard';
import { makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

async function setup() {
  const env = makeEnv({ BROWSER: {} as Fetcher });
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  return { env, wt };
}

/** Body that records whether anyone read it. */
function watchedBody() {
  const seen = { read: false };
  const body = new ReadableStream({
    pull(ctrl) {
      seen.read = true;
      ctrl.enqueue(new TextEncoder().encode('{}'));
      ctrl.close();
    },
  }, { highWaterMark: 0 }); // no read-ahead: pull only if someone reads
  return { body, seen };
}

async function post(env: ReturnType<typeof makeEnv>, path: string, headers: Record<string, string>, body: BodyInit) {
  const ctx = makeCtx();
  const res = await app.fetch(
    new Request('https://pinna.test' + path, { method: 'POST', headers, body, duplex: 'half' } as RequestInit),
    env,
    ctx,
  );
  await ctx.settle();
  return res;
}

const rlRows = (env: ReturnType<typeof makeEnv>) =>
  (env.raw.query('SELECT COUNT(*) AS n FROM rate_limits').get() as { n: number }).n;

test('declaredLength: only valid integers', () => {
  expect(declaredLength('123')).toBe(123);
  expect(declaredLength(undefined)).toBeNull();
  expect(declaredLength('')).toBeNull();
  expect(declaredLength('12abc')).toBeNull();
  expect(declaredLength('-5')).toBeNull();
});

for (const path of ['/api/projects/site/attachments', '/api/projects/site/shot']) {
  test(path + ': without Content-Length 411, body not read, no counter', async () => {
    const { env, wt } = await setup();
    const { body, seen } = watchedBody();
    const res = await post(env, path, { Authorization: 'Bearer ' + wt, 'Content-Type': 'application/json' }, body);
    expect(res.status).toBe(411);
    expect(seen.read).toBe(false);
    expect(rlRows(env)).toBe(0);
  });
}

test('upload: Content-Length over the cap 413 without reading the body', async () => {
  const { env, wt } = await setup();
  const { body, seen } = watchedBody();
  const res = await post(env, '/api/projects/site/attachments', { Authorization: 'Bearer ' + wt, 'Content-Length': String(MAX_UPLOAD_BODY + 1) }, body);
  expect(res.status).toBe(413);
  expect(seen.read).toBe(false);
  expect(rlRows(env)).toBe(0);
});

test('/shot: Content-Length over the cap 413 without reading the body or consuming the limits', async () => {
  const { env, wt } = await setup();
  const { body, seen } = watchedBody();
  const res = await post(env, '/api/projects/site/shot', { Authorization: 'Bearer ' + wt, 'Content-Length': String(MAX_SHOT_BODY + 1) }, body);
  expect(res.status).toBe(413);
  expect(seen.read).toBe(false);
  expect(rlRows(env)).toBe(0);
});
