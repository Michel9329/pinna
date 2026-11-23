/**
 * Pinna - the invite response says nothing about the user. Without this it
 * carried the invitee's id, email and global role: a collab inviting an
 * address could find out whether it was registered and whether it was an
 * admin.
 */
import { test, expect } from 'bun:test';
import { signTyped } from '../worker/auth';
import * as db from '../worker/db';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

test('a collab invites an existing admin: the response is only {ok:true}', async () => {
  const env = makeEnv();
  seedUser(env.raw, 'u_col', 'col@example.com', 'collab');
  seedUser(env.raw, 'u_adm', 'm@example.com', 'admin');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test/');
  await db.addMembership(env.DB, 'u_col', 'p1', 'collab');
  const s = await signTyped('session', { uid: 'u_col', role: 'collab', exp: Date.now() + 3600_000, iat: Date.now() - 1000 }, TEST_SECRET);
  const ctx = makeCtx();
  const res = await appFetch(
    new Request('https://pinna.test/api/projects/p1/invite', {
      method: 'POST',
      headers: { Cookie: '__Host-pinna_session=' + s + '; __Host-pinna_csrf=t', 'X-CSRF-Token': 't', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'm@example.com' }),
    }),
    env,
    ctx,
  );
  await ctx.settle();
  expect(res.status).toBe(201);
  const text = await res.text();
  expect(JSON.parse(text)).toEqual({ ok: true });
  expect(text).not.toContain('admin');
  expect(text).not.toContain('u_adm');
});
