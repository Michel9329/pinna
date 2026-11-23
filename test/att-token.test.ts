/**
 * Pinna - read-only attachment URLs ('att' token) and revocations. A
 * 10-minute token that ignored revocations and demotion would let a signed-out
 * user or an admin removed from the list keep opening the files. The token
 * carries iat and goes through isRevoked, the role through applyAdminList and
 * the access through the membership.
 */
import { test, expect } from 'bun:test';
import { signAttachmentUrl, signTyped } from '../worker/auth';
import * as db from '../worker/db';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

type Env = ReturnType<typeof makeEnv>;

async function setup() {
  const env = makeEnv({ ADMIN_EMAILS: 'admin@test.local, partner@example.com' });
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedUser(env.raw, 'u_s', 'partner@example.com', 'admin');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test/');
  await db.addMembership(env.DB, 'u_c', 'p1', 'client');
  await env.ATTACHMENTS.put('att/a1', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  await db.createAttachment(env.DB, { id: 'a1', project_id: 'p1', r2_key: 'att/a1', filename: 'f.png', content_type: 'image/png', size: 4, created_by: 'u_c' });
  return env;
}
const open = async (env: Env, at: string) =>
  appFetch(new Request('https://pinna.test/api/attachments/a1?at=' + encodeURIComponent(at)), env, makeCtx());

test('valid att token: the file opens', async () => {
  const env = await setup();
  expect((await open(env, await signAttachmentUrl('p1', 'u_c', env))).status).toBe(200);
});

test('after the sessions are revoked (sign-out, disconnection) the att token is not valid', async () => {
  const env = await setup();
  const at = await signAttachmentUrl('p1', 'u_c', env);
  await new Promise((r) => setTimeout(r, 2));
  await db.revokeSessions(env.DB, 'u_c', Date.now());
  expect((await open(env, at)).status).toBe(401);
});

test('membership removed: the att token is not valid', async () => {
  const env = await setup();
  const at = await signAttachmentUrl('p1', 'u_c', env);
  await db.removeMembership(env.DB, 'u_c', 'p1');
  expect((await open(env, at)).status).toBe(403);
});

test('admin removed from ADMIN_EMAILS: their att token is not valid and they are demoted', async () => {
  const env = await setup();
  const at = await signAttachmentUrl('p1', 'u_s', env);
  expect((await open(env, at)).status).toBe(200);
  env.ADMIN_EMAILS = 'admin@test.local';
  expect((await open(env, at)).status).toBe(401);
  expect((env.raw.query("SELECT role FROM users WHERE id = 'u_s'").get() as { role: string }).role).toBe('client');
});

test('att token without iat (old format) is not valid', async () => {
  const env = await setup();
  const old = await signTyped('att', { aid: 'a1', uid: 'u_c', exp: Date.now() + 600_000 }, TEST_SECRET);
  expect((await open(env, old)).status).toBe(401);
});

test('attachment served with Cache-Control private, no-store', async () => {
  const env = await setup();
  const res = await open(env, await signAttachmentUrl('p1', 'u_c', env));
  expect(res.status).toBe(200);
  expect(res.headers.get('Cache-Control')).toBe('private, no-store');
});
