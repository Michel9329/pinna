/**
 * Pinna - control characters in comments. SQLite's LENGTH() stops at the
 * first U+0000, so a text, path or selector starting with one would count as
 * zero characters against the project quota. Honest input carries some (a text
 * pasted from Word has U+000B and U+000C; a selector built from a data-* value
 * may hold a tab), so:
 * - text: control characters removed (tab, line feed, carriage return kept),
 *   on create and on edit; the cleaned text is stored and counted;
 * - selector: dropped (null) when it holds one, the pin keeps its coordinates;
 * - page path: refused.
 */
import { test, expect } from 'bun:test';
import { newCommentSchema, commentPatchSchema, PROJECT_COMMENT_CHARS } from '../worker/schemas';
import { signTyped } from '../worker/auth';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

const pin = { parent_id: null, page_path: '/', page_x: 1, page_y: 1, anchor_selector: 'main h1', body: 'text' };
const parse = (p: unknown) => newCommentSchema.safeParse(p);

test('text: control characters removed (tab, line feed, carriage return kept); empty after cleaning = empty', () => {
  const word = parse({ ...pin, body: 'First line\u000bsecond line\u000cnext page\u0000\u007f\tend\r\n' });
  expect(word.success).toBe(true);
  expect(word.data!.body).toBe('First linesecond linenext page\tend\r\n');
  expect(parse({ ...pin, body: '\u0000\u0001\u000b' }).success).toBe(false);
  expect(commentPatchSchema.parse({ body: 'a\u000bb\u0000c' }).body).toBe('abc');
});

test('selector with a control character: dropped, not refused; page_path: refused', () => {
  const tab = parse({ ...pin, anchor_selector: 'div[data-x="a\tb"]' });
  expect(tab.success).toBe(true);
  expect(tab.data!.anchor_selector).toBeNull();
  expect(parse({ ...pin, anchor_selector: '\u0000div' }).data!.anchor_selector).toBeNull();
  expect(parse(pin).data!.anchor_selector).toBe('main h1');
  expect(parse({ ...pin, page_path: '\u0000/' + 'p'.repeat(100) }).success).toBe(false);
  expect(parse({ ...pin, page_path: '/a\tb' }).success).toBe(false);
});

async function setup() {
  const env = makeEnv();
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  return { env, wt };
}

function send(env: ReturnType<typeof makeEnv>, wt: string, method: string, path: string, body: unknown) {
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

const usedChars = (env: ReturnType<typeof makeEnv>) =>
  (env.raw.query("SELECT SUM(LENGTH(body) + LENGTH(COALESCE(page_path, '')) + LENGTH(COALESCE(anchor_selector, ''))) AS n FROM comments").get() as { n: number }).n;

test('Word-style text is stored without the characters and counted at its cleaned length; a bad selector is stored as null', async () => {
  const { env, wt } = await setup();
  const res = await send(env, wt, 'POST', '/api/projects/site/comments', {
    ...pin,
    anchor_selector: 'div[data-x="a\nb"]',
    body: 'Hello\u000bworld\u000c!',
  });
  expect(res.status).toBe(201);
  const out = (await res.json()) as { id: string; body: string; anchor_selector: string | null; page_x: number };
  expect(out.body).toBe('Helloworld!');
  expect(out.anchor_selector).toBeNull();
  expect(out.page_x).toBe(1);
  expect(usedChars(env)).toBe('Helloworld!'.length + 1);
  const edit = await send(env, wt, 'PATCH', '/api/comments/' + out.id, { body: 'Edited\u000bagain' });
  expect(edit.status).toBe(200);
  expect(((await edit.json()) as { body: string }).body).toBe('Editedagain');
});

test('a NUL-led text cannot get past the cap', async () => {
  const { env, wt } = await setup();
  env.raw
    .query("INSERT INTO comments (id, project_id, page_path, body, author_id, status, created_at) VALUES ('big', 'p1', '/', ?, 'u_c', 'open', 0)")
    .run('x'.repeat(PROJECT_COMMENT_CHARS - 10));
  // Without the cleaning, a body starting with U+0000 would count as 0.
  const res = await send(env, wt, 'POST', '/api/projects/site/comments', { ...pin, anchor_selector: null, body: '\u0000' + 'y'.repeat(100) });
  expect(res.status).toBe(413);
  expect(usedChars(env)).toBe(PROJECT_COMMENT_CHARS - 9);
});

test('the cap binds on a project filled with normal text', async () => {
  const { env, wt } = await setup();
  env.raw
    .query("INSERT INTO comments (id, project_id, page_path, body, author_id, status, created_at) VALUES ('big', 'p1', '/', ?, 'u_c', 'open', 0)")
    .run('x'.repeat(PROJECT_COMMENT_CHARS - 6)); // + '/' = cap - 5
  // 4 characters of text + "/" = 5: exactly at the cap.
  expect((await send(env, wt, 'POST', '/api/projects/site/comments', { ...pin, anchor_selector: null, body: 'abcd' })).status).toBe(201);
  // One more character anywhere goes over it.
  const over = await send(env, wt, 'POST', '/api/projects/site/comments', { ...pin, anchor_selector: null, body: 'a' });
  expect(over.status).toBe(413);
  expect(((await over.json()) as { error: string }).error).toBe('comment storage for this project is full');
});
