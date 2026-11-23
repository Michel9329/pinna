/**
 * Pinna - cost caps: /shot per user and per project with a time limit,
 * attachment storage quotas, and the proxy's pinna_sub=1 that does not apply
 * to HTML responses.
 */
import { test, expect, afterEach } from 'bun:test';
import app from '../worker/index';
import { signTyped } from '../worker/auth';
import { makeProxyToken } from '../worker/proxy';
import {
  withDeadline,
  SHOT_TOTAL_TIMEOUT_MS,
  SHOT_NAV_TIMEOUT_MS,
  SHOT_PER_USER_MIN,
  SHOT_PER_PROJECT_DAY,
} from '../worker/shot-guard';
import { PROJECT_QUOTA_BYTES, USER_DAILY_UPLOAD_BYTES } from '../worker/upload-guard';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET, sized } from './helpers/env';

const ST = 'https://staging.client.test';
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function seedCounter(env: ReturnType<typeof makeEnv>, k: string, windowSeconds: number, n: number): void {
  const now = Math.floor(Date.now() / 1000);
  env.raw.query('INSERT INTO rate_limits (k, win, n) VALUES (?, ?, ?)').run(k, now - (now % windowSeconds), n);
}

async function setup() {
  const env = makeEnv({ BROWSER: {} as Fetcher });
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', ST + '/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  return { env, wt };
}

async function shot(env: ReturnType<typeof makeEnv>, wt: string) {
  return appFetch(
    await sized(new Request('https://pinna.test/api/projects/site/shot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + wt },
      body: JSON.stringify({ url: ST + '/' }),
    })),
    env,
    makeCtx(),
  );
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(92).fill(0)]);

async function upload(env: ReturnType<typeof makeEnv>, wt: string) {
  const fd = new FormData();
  fd.append('file', new File([PNG], 'x.png', { type: 'image/png' }));
  return appFetch(
    await sized(new Request('https://pinna.test/api/projects/site/attachments', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + wt },
      body: fd,
    })),
    env,
    makeCtx(),
  );
}

test('shot: time limit around 10 s, navigation below the total', async () => {
  expect(SHOT_TOTAL_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  expect(SHOT_NAV_TIMEOUT_MS).toBeLessThan(SHOT_TOTAL_TIMEOUT_MS);
  await expect(withDeadline(new Promise(() => {}), 20, 'x')).rejects.toThrow('x after 20 ms');
  expect(await withDeadline(Promise.resolve(7), 1000)).toBe(7);
});

test('shot: at most 5 a minute per user', async () => {
  const { env, wt } = await setup();
  expect(SHOT_PER_USER_MIN).toBe(5);
  for (let i = 0; i < 5; i++) {
    // The fake browser fails (502), but the attempt counts.
    expect((await shot(env, wt)).status).not.toBe(429);
  }
  expect((await shot(env, wt)).status).toBe(429);
});

test('shot: daily cap per project', async () => {
  const { env, wt } = await setup();
  seedCounter(env, 'shot-project:p1', 86400, SHOT_PER_PROJECT_DAY);
  expect((await shot(env, wt)).status).toBe(429);
});

test('upload: project storage quota (200 MB)', async () => {
  const { env, wt } = await setup();
  expect(PROJECT_QUOTA_BYTES).toBe(200 * 1024 * 1024);
  expect((await upload(env, wt)).status).toBe(201);
  env.raw
    .query(
      "INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by) VALUES ('big', NULL, 'p1', 'att/big', 'b.png', 'image/png', ?, ?, 'u_c')",
    )
    .run(PROJECT_QUOTA_BYTES - 10, Date.now());
  expect((await upload(env, wt)).status).toBe(413);
  // The screenshot stops too (it would become an attachment).
  expect((await shot(env, wt)).status).toBe(413);
});

test('upload: bytes per day per user', async () => {
  const { env, wt } = await setup();
  seedCounter(env, 'upload-bytes-user:u_c', 86400, USER_DAILY_UPLOAD_BYTES - 10);
  expect((await upload(env, wt)).status).toBe(429);
});

function proxyGet(env: ReturnType<typeof makeEnv>, params: Record<string, string>, headers: Record<string, string> = {}) {
  return appFetch(
    new Request('https://pinna.test/_proxy?' + new URLSearchParams(params).toString(), { headers }),
    env,
    makeCtx(),
  );
}

function mockUpstream(ct: string, body: string): void {
  globalThis.fetch = (async () => new Response(body, { headers: { 'content-type': ct } })) as unknown as typeof fetch;
}

test('proxy: pinna_sub=1 with an HTML response counts as a page', async () => {
  const env = makeEnv({ PINNA_PROXY_ENABLED: '1' });
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', ST + '/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  const pt = (await makeProxyToken('u_c', 'p1', ST, TEST_SECRET))!;
  seedCounter(env, 'proxy-user:u_c', 60, 60); // page limit already reached
  mockUpstream('text/html', '<html><body>page</body></html>');
  expect((await proxyGet(env, { url: ST + '/', pinna_pt: pt, pinna_sub: '1' })).status).toBe(429);
  // A real subresource (image) passes even with the page limit full.
  mockUpstream('image/png', 'png');
  expect((await proxyGet(env, { url: ST + '/a.png', pinna_pt: pt, pinna_sub: '1' })).status).toBe(200);
});

test('proxy: a navigation with pinna_sub=1 is treated as a page (widget injected)', async () => {
  const env = makeEnv({ PINNA_PROXY_ENABLED: '1' });
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', ST + '/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  const pt = (await makeProxyToken('u_c', 'p1', ST, TEST_SECRET))!;
  mockUpstream('text/html', '<html><head></head><body>page</body></html>');
  const res = await proxyGet(env, { url: ST + '/', pinna_pt: pt, pinna_sub: '1' }, { 'Sec-Fetch-Dest': 'document' });
  expect(res.status).toBe(200);
  expect(await res.text()).toContain('data-pinna-proxy="1"');
});
