/**
 * Pinna - per-project role. If 'collab' were global, a collaborator invited as
 * a client on another project would become admin of that project too. The role
 * lives on memberships.role.
 */
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as db from '../worker/db';
import { signTyped } from '../worker/auth';
import app from '../worker/index';
import { appFetch, makeD1, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';
import type { User } from '../worker/types';

const MIG_0002 = readFileSync(join(import.meta.dir, '..', 'migrations', '0002_membership_roles.sql'), 'utf-8');

function user(raw: ReturnType<typeof makeD1>['raw'], id: string): User {
  return raw.query('SELECT * FROM users WHERE id = ?').get(id) as User;
}

test("migration 0002: a collab's memberships become collab, the others client, no access lost", () => {
  const { raw } = makeD1({ skipMigrations: ['0002'] });
  seedUser(raw, 'u_collab', 'collab@example.com', 'collab');
  seedUser(raw, 'u_cli', 'cli@example.com', 'client');
  for (const [u, p] of [['u_collab', 'pA'], ['u_collab', 'pB'], ['u_cli', 'pA']]) {
    raw.query('INSERT INTO memberships (user_id, project_id, created_at) VALUES (?, ?, 0)').run(u!, p!);
  }
  raw.exec(MIG_0002);
  const rows = raw.query('SELECT user_id, project_id, role FROM memberships ORDER BY user_id, project_id').all();
  expect(rows).toEqual([
    { user_id: 'u_cli', project_id: 'pA', role: 'client' },
    { user_id: 'u_collab', project_id: 'pA', role: 'collab' },
    { user_id: 'u_collab', project_id: 'pB', role: 'collab' },
  ]);
});

test('canAdmin reads the role OF THE PROJECT: a collab invited as a client elsewhere is not admin there', async () => {
  const { DB, raw } = makeD1();
  seedUser(raw, 'u_collab', 'collab@example.com', 'collab');
  await db.addMembership(DB, 'u_collab', 'pA', 'collab');
  await db.addMembership(DB, 'u_collab', 'pB', 'client');
  const collab = user(raw, 'u_collab');
  expect(await db.canAdmin(DB, collab, 'pA')).toBe(true);
  expect(await db.canAdmin(DB, collab, 'pB')).toBe(false);
  expect(await db.canAdmin(DB, collab, 'pC')).toBe(false);
  expect(await db.projectRole(DB, collab, 'pB')).toBe('client');
});

test('addMembership: an invite raises the role but never lowers it', async () => {
  const { DB, raw } = makeD1();
  seedUser(raw, 'u_x', 'x@example.com', 'client');
  await db.addMembership(DB, 'u_x', 'pA', 'client');
  await db.addMembership(DB, 'u_x', 'pA', 'collab');
  expect(await db.projectRole(DB, user(raw, 'u_x'), 'pA')).toBe('collab');
  await db.addMembership(DB, 'u_x', 'pA', 'client');
  expect(await db.projectRole(DB, user(raw, 'u_x'), 'pA')).toBe('collab');
});

test('route: a collab invited as a client on B cannot mark a comment on B as done', async () => {
  const env = makeEnv();
  seedUser(env.raw, 'u_collab', 'collab@example.com', 'collab');
  seedProject(env.raw, 'pA', 'site-a', 'https://a.test');
  seedProject(env.raw, 'pB', 'site-b', 'https://b.test');
  await db.addMembership(env.DB, 'u_collab', 'pA', 'collab');
  await db.addMembership(env.DB, 'u_collab', 'pB', 'client');
  env.raw
    .query("INSERT INTO comments (id, project_id, page_path, body, author_id, status, created_at) VALUES ('cB', 'pB', '/', 'x', 'u_admin', 'open', 0)")
    .run();
  env.raw
    .query("INSERT INTO comments (id, project_id, page_path, body, author_id, status, created_at) VALUES ('cA', 'pA', '/', 'x', 'u_admin', 'open', 0)")
    .run();
  // The status changes only from the app session (with CSRF), never with the
  // widget-token (see test/widget-token-powers.test.ts).
  const session = await signTyped(
    'session',
    { uid: 'u_collab', role: 'collab', exp: Date.now() + 3600_000, iat: Date.now() },
    TEST_SECRET,
  );
  const patch = (id: string) =>
    appFetch(
      new Request('https://pinna.test/api/comments/' + id, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Cookie: '__Host-pinna_session=' + session + '; __Host-pinna_csrf=t',
          'X-CSRF-Token': 't',
        },
        body: JSON.stringify({ status: 'done' }),
      }),
      env,
      makeCtx(),
    );
  expect((await patch('cB')).status).toBe(403);
  expect((await patch('cA')).status).toBe(200);
});

test("notifications: a project's collab gets the clients' comments ONLY where they are collab", async () => {
  const { DB, raw } = makeD1();
  seedUser(raw, 'u_collab', 'collab@example.com', 'collab');
  seedUser(raw, 'u_cli', 'cli@example.com', 'client');
  await db.addMembership(DB, 'u_collab', 'pA', 'collab');
  await db.addMembership(DB, 'u_collab', 'pB', 'client');
  await db.addMembership(DB, 'u_cli', 'pB', 'client');
  const toTeamB = (await db.listNotifyRecipients(DB, 'pB', 'client')).map((u) => u.id).sort();
  expect(toTeamB).toEqual(['u_admin']);
  const toClientsB = (await db.listNotifyRecipients(DB, 'pB', 'admin')).map((u) => u.id).sort();
  expect(toClientsB).toEqual(['u_cli', 'u_collab']);
  const toTeamA = (await db.listNotifyRecipients(DB, 'pA', 'client')).map((u) => u.id).sort();
  expect(toTeamA).toEqual(['u_admin', 'u_collab']);
});
