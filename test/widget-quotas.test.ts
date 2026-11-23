/**
 * Pinna - quotas the widget-token can fill. The widget-token lives in the
 * staging document, readable by third-party scripts. Without these caps: no
 * limit on the number of attachments (tiny GIFs, 10 per minute, 50 per
 * comment), one HMAC signature per attachment on every GET of the list (CPU
 * that grows with the number of files), path and selector outside the
 * character quota, no per-user cap on the day's screenshots.
 */
import { test, expect } from 'bun:test';
import { signTyped } from '../worker/auth';
import { PROJECT_COMMENT_CHARS, COMMENT_ATT_MAX } from '../worker/schemas';
import { PROJECT_MAX_ATTACHMENTS, USER_DAILY_UPLOADS } from '../worker/upload-guard';
import { SHOT_PER_USER_DAY } from '../worker/shot-guard';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, sized, TEST_SECRET } from './helpers/env';

type Env = ReturnType<typeof makeEnv>;
const ST = 'https://staging.test';
// Minimal valid PNG (signature + IHDR), enough for validateUpload.
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
]);

async function setup(over: Record<string, unknown> = {}): Promise<{ env: Env; wt: string }> {
  const env = makeEnv(over as never);
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', ST + '/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  return { env, wt };
}

async function call(env: Env, method: string, path: string, wt: string, body?: BodyInit, ct?: string) {
  const headers: Record<string, string> = { Authorization: 'Bearer ' + wt };
  if (ct) headers['Content-Type'] = ct;
  const ctx = makeCtx();
  const res = await appFetch(await sized(new Request('https://pinna.test' + path, { method, headers, body })), env, ctx);
  await ctx.settle();
  return res;
}

const upload = (env: Env, wt: string) => {
  const fd = new FormData();
  fd.append('file', new File([PNG], 'g.png', { type: 'image/png' }));
  return call(env, 'POST', '/api/projects/site/attachments', wt, fd);
};

/** n attachments already in the project (D1 rows, as after n uploads). */
function seedAttachments(env: Env, n: number, linkedTo: string | null = null) {
  const ins = env.raw.query(
    'INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (let i = 0; i < n; i++) ins.run('s' + i, linkedTo, 'p1', 'att/s' + i, 'g.png', 'image/png', 30, 0, 'u_c');
}

/** A counter already at the cap in the current one-day window. */
function fillDay(env: Env, k: string, n: number) {
  const now = Math.floor(Date.now() / 1000);
  env.raw.query('INSERT INTO rate_limits (k, win, n) VALUES (?, ?, ?)').run(k, now - (now % 86400), n);
}

test('project attachments at the cap: upload refused (413)', async () => {
  const { env, wt } = await setup();
  seedAttachments(env, PROJECT_MAX_ATTACHMENTS - 1);
  expect((await upload(env, wt)).status).toBe(201);
  const res = await upload(env, wt);
  expect(res.status).toBe(413);
  expect(((await res.json()) as { error: string }).error).toContain('too many attachments');
});

test('/shot with the project at the attachment cap: 413 before opening the browser', async () => {
  const { env, wt } = await setup({ BROWSER: {} as Fetcher });
  seedAttachments(env, PROJECT_MAX_ATTACHMENTS);
  const res = await call(env, 'POST', '/api/projects/site/shot', wt, JSON.stringify({ url: ST + '/' }), 'application/json');
  expect(res.status).toBe(413);
});

test('/shot: daily per-user cap, before the project cap', async () => {
  const { env, wt } = await setup({ BROWSER: {} as Fetcher });
  fillDay(env, 'shot-user-day:u_c', SHOT_PER_USER_DAY);
  const res = await call(env, 'POST', '/api/projects/site/shot', wt, JSON.stringify({ url: ST + '/' }), 'application/json');
  expect(res.status).toBe(429);
  // The project cap has not moved.
  expect(env.raw.query("SELECT 1 FROM rate_limits WHERE k = 'shot-project:p1'").get()).toBeNull();
});

test('upload: per-user daily file cap (429)', async () => {
  const { env, wt } = await setup();
  fillDay(env, 'uploads-user-day:u_c', USER_DAILY_UPLOADS);
  expect((await upload(env, wt)).status).toBe(429);
});

test('attachments per comment: above COMMENT_ATT_MAX the comment is refused (400)', async () => {
  const { env, wt } = await setup();
  const ids = Array.from({ length: COMMENT_ATT_MAX + 1 }, (_, i) => 'x' + i);
  const res = await call(env, 'POST', '/api/projects/site/comments', wt, JSON.stringify({ body: 'ok', page_path: '/', attachment_ids: ids }), 'application/json');
  expect(res.status).toBe(400);
});

test('character quota: path and selector count too', async () => {
  const { env, wt } = await setup();
  env.raw
    .query("INSERT INTO comments (id, project_id, parent_id, page_path, body, author_id, status, created_at) VALUES ('c0', 'p1', NULL, '/', ?, 'u_c', 'open', 0)")
    .run('x'.repeat(PROJECT_COMMENT_CHARS - 100));
  const send = (page_path: string, anchor_selector: string | null) =>
    call(env, 'POST', '/api/projects/site/comments', wt, JSON.stringify({ body: 'ok', page_path, anchor_selector }), 'application/json');
  // A 2-character text, but a long path and selector: over the quota.
  expect((await send('/' + 'a'.repeat(60), 'div > ' + 'b'.repeat(60))).status).toBe(413);
  expect((await send('/' + 'a'.repeat(200), null)).status).toBe(413);
  // Short: within the quota.
  expect((await send('/', null)).status).toBe(201);
});

test('comment list: a single token for all the attachments of the project', async () => {
  const { env, wt } = await setup();
  env.raw.query("INSERT INTO comments (id, project_id, parent_id, page_path, body, author_id, status, created_at) VALUES ('c1', 'p1', NULL, '/', 'hello', 'u_c', 'open', 0)").run();
  seedAttachments(env, 50, 'c1');
  const res = await call(env, 'GET', '/api/projects/site/comments', wt);
  expect(res.status).toBe(200);
  const rows = (await res.json()) as { attachments: { url: string }[] }[];
  const urls = rows[0]!.attachments.map((a) => a.url);
  expect(urls.length).toBe(50);
  const tokens = new Set(urls.map((u) => new URL('https://pinna.test' + u).searchParams.get('at')));
  expect(tokens.size).toBe(1);
});
