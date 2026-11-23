/**
 * Pinna - admin role computed from ADMIN_EMAILS. If the list only promoted,
 * removing an email would not remove the admin (users.role would stay 'admin'
 * and the 30-day session would stay valid).
 */
import { test, expect } from 'bun:test';
import app from '../worker/index';
import { signTyped } from '../worker/auth';
import { syncAdmins } from '../worker/admins';
import { notifyEvent } from '../worker/notify';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

type Env = ReturnType<typeof makeEnv>;
const session = (uid: string, role: string, iat = Date.now() - 5_000) =>
  signTyped('session', { uid, role, exp: Date.now() + 3600_000, iat }, TEST_SECRET);

async function get(env: Env, path: string, headers: Record<string, string>) {
  const ctx = makeCtx();
  const res = await appFetch(new Request('https://pinna.test' + path, { headers }), env, ctx);
  await ctx.settle();
  return res;
}
const me = async (env: Env, token: string) => get(env, '/api/auth/me', { Cookie: '__Host-pinna_session=' + token });
const roleOf = (env: Env, id: string) => (env.raw.query('SELECT role FROM users WHERE id = ?').get(id) as { role: string }).role;

test('email removed from ADMIN_EMAILS: admin demoted, session revoked, signs back in as client', async () => {
  // The list always contains a DB admin (otherwise it is missing
  // configuration and nobody is demoted).
  const env = makeEnv({ ADMIN_EMAILS: 'admin@test.local, partner@example.com' });
  seedUser(env.raw, 'u_partner', 'partner@example.com', 'admin');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test');
  const tok = await session('u_partner', 'admin');
  expect(((await (await me(env, tok)).json()) as { role: string }).role).toBe('admin');

  env.ADMIN_EMAILS = 'admin@test.local';
  expect((await me(env, tok)).status).toBe(401);
  expect(roleOf(env, 'u_partner')).toBe('client');
  expect(env.raw.query("SELECT 1 FROM session_revocations WHERE user_id = 'u_partner'").get()).not.toBeNull();

  // New sign-in: client, and sees only the projects they are a member of (none).
  const fresh = await session('u_partner', 'admin', Date.now() + 1);
  const r = await me(env, fresh);
  expect(r.status).toBe(200);
  expect(((await r.json()) as { role: string }).role).toBe('client');
  const list = await get(env, '/api/projects', { Cookie: '__Host-pinna_session=' + fresh });
  expect(await list.json()).toEqual([]);
});

// Empty list = missing configuration, not "no admin" (otherwise the admin
// would be demoted and locked out). See admin-config.test.ts.
test('empty list: missing configuration, the admin stays admin', async () => {
  const env = makeEnv({ ADMIN_EMAILS: '' });
  const tok = await session('u_admin', 'admin');
  expect((await me(env, tok)).status).toBe(200);
  expect(roleOf(env, 'u_admin')).toBe('admin');
});

test('email added to ADMIN_EMAILS: promoted on the next request', async () => {
  const env = makeEnv({ ADMIN_EMAILS: 'admin@test.local, new@example.com' });
  seedUser(env.raw, 'u_n', 'new@example.com', 'client');
  const r = await me(env, await session('u_n', 'client'));
  expect(((await r.json()) as { role: string }).role).toBe('admin');
  expect(roleOf(env, 'u_n')).toBe('admin');
});

test('widget token of an admin removed from the list: no longer valid', async () => {
  const env = makeEnv({ ADMIN_EMAILS: 'admin@test.local' });
  seedUser(env.raw, 'u_ex', 'ex@example.com', 'admin');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test');
  const wt = await signTyped('widget', { uid: 'u_ex', pid: 'p1', exp: Date.now() + 3600_000, iat: Date.now() - 1000 }, TEST_SECRET);
  expect((await get(env, '/api/projects/site/comments', { Authorization: 'Bearer ' + wt })).status).toBe(401);
  expect(roleOf(env, 'u_ex')).toBe('client');
});

test('sign-in of an admin no longer listed: gets in right away as client (no 401 after sign-in)', async () => {
  const env = makeEnv({ ADMIN_EMAILS: 'admin@test.local' });
  seedUser(env.raw, 'u_ex', 'ex@example.com', 'admin');
  env.raw
    .query('INSERT INTO magic_links (token_hash, email, expires_at, used_at, code, created_at) VALUES (?, ?, ?, NULL, ?, ?)')
    .run('h', 'ex@example.com', Date.now() + 600_000, '123456', Date.now());
  const ctx = makeCtx();
  const res = await appFetch(
    new Request('https://pinna.test/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.5' },
      body: JSON.stringify({ email: 'ex@example.com', code: '123456' }),
    }),
    env,
    ctx,
  );
  await ctx.settle();
  expect(res.status).toBe(200);
  const cookie = (res.headers.get('Set-Cookie') || '').match(/__Host-pinna_session=([^;]+)/)![1]!;
  const r = await me(env, cookie);
  expect(r.status).toBe(200);
  expect(((await r.json()) as { role: string }).role).toBe('client');
});

test('cron: demotes admins not in the list even without requests', async () => {
  const env = makeEnv({ ADMIN_EMAILS: 'admin@test.local' });
  seedUser(env.raw, 'u_ex', 'ex@example.com', 'admin');
  expect(await syncAdmins(env)).toBe(1);
  expect(roleOf(env, 'u_ex')).toBe('client');
  expect(roleOf(env, 'u_admin')).toBe('admin');
});

test('notifications: an admin in the DB but no longer listed does not receive the emails', async () => {
  const env = makeEnv({ ADMIN_EMAILS: 'admin@test.local', RESEND_API_KEY: 're_test' });
  seedUser(env.raw, 'u_ex', 'ex@example.com', 'admin');
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  const to: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    to.push(JSON.parse(String(init?.body || '{}')).to);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const project = { id: 'p1', name: 'Site', slug: 'site', staging_url: 'https://staging.test', created_at: 0 };
    const actor = { id: 'u_c', email: 'c@example.com', role: 'client' as const, name: null, created_at: 0 };
    const comment = { id: 'c1', project_id: 'p1', body: 'hello' } as never;
    await notifyEvent(env, project, actor, comment, 'new', 'https://pinna.test');
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(to).toEqual(['admin@test.local']);
});
