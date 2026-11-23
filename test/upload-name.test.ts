/**
 * Pinna - attachment file name and failed inserts. The name comes from the
 * client unchecked: it is stored without control characters and cut to 200
 * characters, keeping the extension. A failed D1 insert after the R2 put must
 * not leave the blob behind.
 */
import { test, expect } from 'bun:test';
import { signTyped } from '../worker/auth';
import { safeFilename, FILENAME_MAX } from '../worker/upload-guard';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, sized, TEST_SECRET } from './helpers/env';

type Env = ReturnType<typeof makeEnv>;
// Minimal valid PNG (signature + IHDR), enough for validateUpload.
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

async function upload(env: Env, wt: string, name: string) {
  const fd = new FormData();
  fd.append('file', new File([PNG], name, { type: 'image/png' }));
  const ctx = makeCtx();
  const req = new Request('https://pinna.test/api/projects/site/attachments', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + wt },
    body: fd,
  });
  const res = await appFetch(await sized(req), env, ctx);
  await ctx.settle();
  return res;
}

const blobs = (env: Env) => (env.ATTACHMENTS as unknown as { keys: () => string[] }).keys();

test('a 5,000-character name is stored as 200 characters with its extension', async () => {
  const { env, wt } = await setup();
  const res = await upload(env, wt, 'a'.repeat(4996) + '.png');
  expect(res.status).toBe(201);
  const att = (await res.json()) as { id: string; filename: string };
  expect(att.filename.length).toBe(200);
  expect(att.filename.endsWith('.png')).toBe(true);
  const row = env.raw.query('SELECT filename FROM attachments WHERE id = ?').get(att.id) as { filename: string };
  expect(row.filename).toBe(att.filename);
});

test('control characters are removed from the stored name', async () => {
  const { env, wt } = await setup();
  const res = await upload(env, wt, 'shot\u0000\u001b[31m\u007f\u0085.png');
  expect(res.status).toBe(201);
  expect(((await res.json()) as { filename: string }).filename).toBe('shot[31m.png');
});

test('a failed insert leaves no object in R2', async () => {
  const { env, wt } = await setup();
  env.raw.query("CREATE TRIGGER fail_att BEFORE INSERT ON attachments BEGIN SELECT RAISE(ABORT, 'insert failed'); END").run();
  const res = await upload(env, wt, 'g.png');
  expect(res.status).toBe(500);
  expect(blobs(env)).toEqual([]);
  expect((env.raw.query('SELECT COUNT(*) AS n FROM attachments').get() as { n: number }).n).toBe(0);
});

test('safeFilename: short names unchanged, long ones cut by character, odd extensions not kept', () => {
  expect(safeFilename('photo.png')).toBe('photo.png');
  expect(safeFilename('')).toBe('file');
  expect(safeFilename('\u0001\u0002')).toBe('file');
  // No extension: plain cut.
  expect(safeFilename('b'.repeat(500))).toBe('b'.repeat(FILENAME_MAX));
  // A 300-character "extension" is not one.
  const odd = safeFilename('x.' + 'y'.repeat(300));
  expect(Array.from(odd).length).toBe(FILENAME_MAX);
  expect(odd.startsWith('x.')).toBe(true);
  // Characters outside the BMP are not split (no lone surrogates).
  const emoji = safeFilename('\u{1F600}'.repeat(300) + '.pdf');
  expect(Array.from(emoji).length).toBe(FILENAME_MAX);
  expect(emoji.endsWith('.pdf')).toBe(true);
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emoji)).toBe(false);
});
