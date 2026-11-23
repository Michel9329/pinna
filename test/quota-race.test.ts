/**
 * Pinna - project caps checked inside the write. A cap read first and written
 * after lets requests sent in parallel all pass: each one reads the same
 * "still room" and writes. The comment-character quota and the attachment
 * caps (number of files, bytes) are conditions of the INSERT / UPDATE itself:
 * the write that would cross a cap changes no row and the route answers with
 * the quota error. The read before stays as an early exit.
 */
import { test, expect } from 'bun:test';
import * as db from '../worker/db';
import { signTyped } from '../worker/auth';
import { PROJECT_COMMENT_CHARS } from '../worker/schemas';
import { PROJECT_MAX_ATTACHMENTS, PROJECT_QUOTA_BYTES } from '../worker/upload-guard';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, sized, TEST_SECRET } from './helpers/env';

type Env = ReturnType<typeof makeEnv>;
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89,
]);

async function setup(): Promise<{ env: Env; wt: string }> {
  const env = makeEnv();
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  return { env, wt };
}

/** A comment row of exactly `chars` quota characters (text + "/"). */
function seedChars(env: Env, id: string, chars: number) {
  env.raw
    .query("INSERT INTO comments (id, project_id, page_path, body, author_id, status, created_at) VALUES (?, 'p1', '/', ?, 'u_c', 'open', 0)")
    .run(id, 'x'.repeat(chars - 1));
}

const usedChars = (env: Env) =>
  (env.raw.query("SELECT SUM(LENGTH(body) + LENGTH(COALESCE(page_path, '')) + LENGTH(COALESCE(anchor_selector, ''))) AS n FROM comments").get() as { n: number }).n;
const attCount = (env: Env) => (env.raw.query('SELECT COUNT(*) AS n FROM attachments').get() as { n: number }).n;

/**
 * D1 with real latency: every statement still runs at once, but its result
 * arrives on a later turn of the event loop. Two requests sent together then
 * advance in step, so both read a cap before either writes, as they can on
 * Cloudflare.
 */
function laggy(env: Env): void {
  const real = env.DB;
  const later = <T>(p: Promise<T>) => new Promise<T>((ok, ko) => setTimeout(() => p.then(ok, ko), 1));
  const wrap = (st: D1PreparedStatement): D1PreparedStatement =>
    ({
      bind: (...a: unknown[]) => wrap(st.bind(...a)),
      first: (col?: string) => later(st.first(col as never)),
      all: () => later(st.all()),
      run: () => later(st.run()),
    }) as unknown as D1PreparedStatement;
  env.DB = new Proxy(real, {
    get: (t, k) => (k === 'prepare' ? (sql: string) => wrap(t.prepare(sql)) : Reflect.get(t, k)),
  });
}

async function call(env: Env, method: string, path: string, wt: string, body?: BodyInit, json = true) {
  const headers: Record<string, string> = { Authorization: 'Bearer ' + wt };
  if (json) headers['Content-Type'] = 'application/json';
  const ctx = makeCtx();
  const res = await appFetch(await sized(new Request('https://pinna.test' + path, { method, headers, body })), env, ctx);
  await ctx.settle();
  return res;
}

// --- At the cap minus one unit: the write that would cross it writes nothing ---

test('comment insert at the cap minus one character: no row, null', async () => {
  const { env } = await setup();
  seedChars(env, 'big', PROJECT_COMMENT_CHARS - 1);
  const before = usedChars(env);
  const c = await db.createComment(env.DB, 'p1', 'u_c', { body: 'ab', page_path: '' } as never, PROJECT_COMMENT_CHARS);
  expect(c).toBeNull();
  expect(usedChars(env)).toBe(before);
  // One character still fits.
  expect(await db.createComment(env.DB, 'p1', 'u_c', { body: 'a', page_path: '' } as never, PROJECT_COMMENT_CHARS)).not.toBeNull();
});

test('comment edit at the cap minus one character: a longer text is not written, a shorter one is', async () => {
  const { env } = await setup();
  seedChars(env, 'big', PROJECT_COMMENT_CHARS - 4);
  env.raw.query("INSERT INTO comments (id, project_id, page_path, body, author_id, status, created_at) VALUES ('e1', 'p1', '', 'abc', 'u_c', 'open', 0)").run();
  expect(usedChars(env)).toBe(PROJECT_COMMENT_CHARS - 1);
  expect(await db.updateComment(env.DB, 'e1', { body: 'abcde' }, PROJECT_COMMENT_CHARS)).toBe('over-quota');
  expect((env.raw.query("SELECT body FROM comments WHERE id = 'e1'").get() as { body: string }).body).toBe('abc');
  expect(await db.updateComment(env.DB, 'e1', { body: 'abcd' }, PROJECT_COMMENT_CHARS)).not.toBe('over-quota');
  expect(await db.updateComment(env.DB, 'e1', { body: 'a' }, PROJECT_COMMENT_CHARS)).not.toBe('over-quota');
});

test('attachment insert (upload and screenshot) at the file cap or the byte cap minus one: no row, null', async () => {
  const { env } = await setup();
  const limits = { maxCount: PROJECT_MAX_ATTACHMENTS, maxBytes: PROJECT_QUOTA_BYTES };
  const ins = env.raw.query(
    "INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by) VALUES (?, NULL, 'p1', ?, 'g.png', 'image/png', ?, 0, 'u_c')",
  );
  // Bytes: one byte left, a 2-byte screenshot does not fit.
  ins.run('big', 'att/big', PROJECT_QUOTA_BYTES - 1);
  const shot = await db.createAttachment(env.DB, { id: 's1', project_id: 'p1', r2_key: 'att/s1', filename: 'pinna-screenshot.jpg', content_type: 'image/jpeg', size: 2, created_by: 'u_c' }, limits);
  expect(shot).toBeNull();
  expect(attCount(env)).toBe(1);
  // Files: at the cap, even a tiny file does not fit.
  env.raw.query('DELETE FROM attachments').run();
  for (let i = 0; i < PROJECT_MAX_ATTACHMENTS; i++) ins.run('s' + i, 'att/s' + i, 1);
  const up = await db.createAttachment(env.DB, { id: 'u1', project_id: 'p1', r2_key: 'att/u1', filename: 'g.png', content_type: 'image/png', size: 1, created_by: 'u_c' }, limits);
  expect(up).toBeNull();
  expect(attCount(env)).toBe(PROJECT_MAX_ATTACHMENTS);
});

// --- Requests sent in parallel through the routes: only the ones that fit are written ---

test('two comments in parallel that fit one at a time but not together: one 201, one 413', async () => {
  const { env, wt } = await setup();
  seedChars(env, 'big', PROJECT_COMMENT_CHARS - 10);
  laggy(env);
  const post = () => call(env, 'POST', '/api/projects/site/comments', wt, JSON.stringify({ body: 'hello', page_path: '/', page_x: 1, page_y: 1 }));
  const res = await Promise.all([post(), post()]);
  expect(res.map((r) => r.status).sort()).toEqual([201, 413]);
  const refused = res.find((r) => r.status === 413)!;
  expect(((await refused.json()) as { error: string }).error).toBe('comment storage for this project is full');
  expect(usedChars(env)).toBeLessThanOrEqual(PROJECT_COMMENT_CHARS);
});

test('two edits in parallel that grow the text past the cap together: one 200, one 413', async () => {
  const { env, wt } = await setup();
  seedChars(env, 'big', PROJECT_COMMENT_CHARS - 10);
  env.raw.query("INSERT INTO comments (id, project_id, page_path, body, author_id, status, created_at) VALUES ('e1', 'p1', '', 'a', 'u_c', 'open', 0), ('e2', 'p1', '', 'b', 'u_c', 'open', 0)").run();
  laggy(env);
  const patch = (id: string) => call(env, 'PATCH', '/api/comments/' + id, wt, JSON.stringify({ body: 'abcdefg' }));
  const res = await Promise.all([patch('e1'), patch('e2')]);
  expect(res.map((r) => r.status).sort()).toEqual([200, 413]);
  expect(usedChars(env)).toBeLessThanOrEqual(PROJECT_COMMENT_CHARS);
});

test('two uploads in parallel with one file left: one 201, one 413, no blob for the refused one', async () => {
  const { env, wt } = await setup();
  const ins = env.raw.query(
    "INSERT INTO attachments (id, comment_id, project_id, r2_key, filename, content_type, size, created_at, created_by) VALUES (?, NULL, 'p1', ?, 'g.png', 'image/png', 1, 0, 'u_c')",
  );
  for (let i = 0; i < PROJECT_MAX_ATTACHMENTS - 1; i++) ins.run('s' + i, 'att/s' + i);
  laggy(env);
  const upload = () => {
    const fd = new FormData();
    fd.append('file', new File([PNG], 'g.png', { type: 'image/png' }));
    return call(env, 'POST', '/api/projects/site/attachments', wt, fd, false);
  };
  const res = await Promise.all([upload(), upload()]);
  expect(res.map((r) => r.status).sort()).toEqual([201, 413]);
  const refused = res.find((r) => r.status === 413)!;
  expect(((await refused.json()) as { error: string }).error).toBe('too many attachments in the project (max ' + PROJECT_MAX_ATTACHMENTS + ')');
  expect(attCount(env)).toBe(PROJECT_MAX_ATTACHMENTS);
  expect((env.ATTACHMENTS as unknown as { keys: () => string[] }).keys().length).toBe(1);
});

test('a project already over the cap: an edit that does not grow the text still passes (shorter text, status only)', async () => {
  const { env, wt } = await setup();
  seedChars(env, 'big', PROJECT_COMMENT_CHARS + 100);
  env.raw.query("INSERT INTO comments (id, project_id, page_path, body, author_id, status, created_at) VALUES ('e1', 'p1', '', 'abcdef', 'u_c', 'open', 0)").run();
  expect(await db.updateComment(env.DB, 'e1', { body: 'abc' }, PROJECT_COMMENT_CHARS)).not.toBe('over-quota');
  expect(await db.updateComment(env.DB, 'e1', { body: 'xyz' }, PROJECT_COMMENT_CHARS)).not.toBe('over-quota');
  expect(await db.updateComment(env.DB, 'e1', { status: 'done' }, PROJECT_COMMENT_CHARS)).not.toBe('over-quota');
  expect((env.raw.query("SELECT body, status FROM comments WHERE id = 'e1'").get() as { body: string; status: string })).toEqual({ body: 'xyz', status: 'done' });
  // Through the route too.
  expect((await call(env, 'PATCH', '/api/comments/e1', wt, JSON.stringify({ body: 'x' }))).status).toBe(200);
});

test('upload: if the file cannot be stored, the row written before it is removed', async () => {
  const { env, wt } = await setup();
  const r2 = env.ATTACHMENTS as unknown as { put: unknown };
  r2.put = async () => {
    throw new Error('R2 down');
  };
  const fd = new FormData();
  fd.append('file', new File([PNG], 'g.png', { type: 'image/png' }));
  const res = await call(env, 'POST', '/api/projects/site/attachments', wt, fd, false);
  expect(res.status).toBe(500);
  expect(attCount(env)).toBe(0);
});
