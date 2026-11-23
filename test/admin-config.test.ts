/**
 * Pinna - ADMIN_EMAILS missing or malformed.
 *
 * Updating an existing instance (admin u_admin created by an old seed) without
 * ADMIN_EMAILS, with an empty list or one written with ";", must not demote
 * the admin and lock them out on the first request (widget included) or in the
 * 03:00 cron; with another address listed first, /entra must not sign into a
 * new account under that other address. A list without any valid address is
 * missing configuration (roles come from the DB), the separators are , ;
 * spaces and newlines, and /entra prefers the address that already has an
 * admin account.
 */
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import app from '../worker/index';
import { signTyped, verifyTyped, adminEmails } from '../worker/auth';
import { syncAdmins } from '../worker/admins';
import { notifyEvent } from '../worker/notify';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

const KEY = 'k'.repeat(40);
const OLD = 'old-admin@seed.test';
type Env = ReturnType<typeof makeEnv>;

/** Instance as in production: u_admin is admin with the old seed's email. */
function prodEnv(over: Record<string, unknown> = {}): Env {
  const env = makeEnv({ ADMIN_EMAILS: undefined, ADMIN_KEY: KEY, ...over } as never);
  env.raw.query("UPDATE users SET email = ? WHERE id = 'u_admin'").run(OLD);
  return env;
}
const role = (env: Env, id: string) => (env.raw.query('SELECT role FROM users WHERE id = ?').get(id) as { role: string }).role;
const revocations = (env: Env) => (env.raw.query('SELECT COUNT(*) AS n FROM session_revocations').get() as { n: number }).n;
const session = (uid = 'u_admin') =>
  signTyped('session', { uid, role: 'admin', exp: Date.now() + 3600_000, iat: Date.now() - 1000 }, TEST_SECRET);

async function call(env: Env, req: Request) {
  const ctx = makeCtx();
  const res = await appFetch(req, env, ctx);
  await ctx.settle();
  return res;
}
const me = async (env: Env, tok: string) =>
  call(env, new Request('https://pinna.test/api/auth/me', { headers: { Cookie: '__Host-pinna_session=' + tok } }));
const entra = (env: Env) =>
  call(env, new Request('https://pinna.test/entra', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': String(('k=' + KEY).length), 'CF-Connecting-IP': '203.0.113.9' },
    body: 'k=' + KEY,
  }));

for (const [label, value] of [
  ['absent', undefined],
  ['empty', ''],
  ['only spaces', '   '],
  ['without valid addresses', 'admin, root'],
] as const) {
  test(`ADMIN_EMAILS ${label}: the existing admin stays admin, no revocation`, async () => {
    const env = prodEnv({ ADMIN_EMAILS: value });
    const r = await me(env, await session());
    expect(r.status).toBe(200);
    expect(((await r.json()) as { role: string }).role).toBe('admin');
    expect(role(env, 'u_admin')).toBe('admin');
    expect(revocations(env)).toBe(0);
  });
}

test('ADMIN_EMAILS absent: the admin widget works and the cron does not demote', async () => {
  const env = prodEnv();
  seedProject(env.raw, 'p1', 'site', 'https://staging.test');
  const wt = await signTyped('widget', { uid: 'u_admin', pid: 'p1', exp: Date.now() + 3600_000, iat: Date.now() - 1000 }, TEST_SECRET);
  const r = await call(env, new Request('https://pinna.test/api/projects/site/comments', { headers: { Authorization: 'Bearer ' + wt } }));
  expect(r.status).toBe(200);
  expect(await syncAdmins(env)).toBe(0);
  expect(role(env, 'u_admin')).toBe('admin');
  expect(revocations(env)).toBe(0);
});

test('separators: comma, semicolon, spaces and newlines', () => {
  const env = makeEnv({ ADMIN_EMAILS: ' A@example.com; b@example.com,c@example.com\n d@example.com  e@example.com ;; ' });
  expect(adminEmails(env)).toEqual(['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com', 'e@example.com']);
});

test('list written with ";": the listed admin stays admin', async () => {
  const env = prodEnv({ ADMIN_EMAILS: OLD + '; other@example.com' });
  const r = await me(env, await session());
  expect(r.status).toBe(200);
  expect(role(env, 'u_admin')).toBe('admin');
});

// A well-formed list that contains none of the DB admins (a typo, quotes) is
// missing configuration, not "no admin". Otherwise the admin would be demoted
// and /entra would create a phantom admin.
test('valid list that contains no DB admin: missing, no demotion', async () => {
  const env = prodEnv({ ADMIN_EMAILS: 'other@example.com' });
  const r = await me(env, await session());
  expect(r.status).toBe(200);
  expect(((await r.json()) as { role: string }).role).toBe('admin');
  expect(role(env, 'u_admin')).toBe('admin');
  expect(revocations(env)).toBe(0);
  expect(await syncAdmins(env)).toBe(0);
  // /entra does not sign in and does not create the phantom admin.
  const res = await entra(env);
  expect(res.headers.get('Location')).toContain('/login?err=user');
  expect(res.headers.get('Set-Cookie')).toBeNull();
  expect(env.raw.query("SELECT 1 FROM users WHERE email = 'other@example.com'").get()).toBeNull();
});

test('list that contains a DB admin: anyone not listed is demoted as before', async () => {
  const env = prodEnv({ ADMIN_EMAILS: OLD });
  seedUser(env.raw, 'u_ex', 'ex@example.com', 'admin');
  expect((await me(env, await session('u_ex'))).status).toBe(401);
  expect(role(env, 'u_ex')).toBe('client');
  expect(role(env, 'u_admin')).toBe('admin');
});

test('list pasted with the quotes from the README: the admin stays admin, /entra signs into it', async () => {
  for (const value of ['"' + OLD + ', other@example.com"', "'" + OLD + "'", 'Admin <' + OLD + '>', '\u201c' + OLD + '\u201d']) {
    const env = prodEnv({ ADMIN_EMAILS: value });
    const r = await me(env, await session());
    expect(r.status).toBe(200);
    expect(((await r.json()) as { role: string }).role).toBe('admin');
    expect(revocations(env)).toBe(0);
    const res = await entra(env);
    const cookie = (res.headers.get('Set-Cookie') || '').match(/__Host-pinna_session=([^;]+)/)?.[1] || '';
    expect((await verifyTyped<{ uid: string }>('session', cookie, TEST_SECRET))?.uid).toBe('u_admin');
  }
});

test('quotes, apostrophes, <> and parentheses removed from every entry', () => {
  const env = makeEnv({ ADMIN_EMAILS: '"you@example.com, partner@example.com" Name <a@example.com>; \u201cb@example.com\u201d (c@example.com) \'d@example.com\'' });
  expect(adminEmails(env)).toEqual(['you@example.com', 'partner@example.com', 'a@example.com', 'b@example.com', 'c@example.com', 'd@example.com']);
});

test('list with a typo: /auth/request does not create an admin with the typo', async () => {
  const env = prodEnv({ ADMIN_EMAILS: 'old-admn@seed.test' });
  const ctx = makeCtx();
  await appFetch(
    new Request('https://pinna.test/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.30' },
      body: JSON.stringify({ email: 'old-admn@seed.test' }),
    }),
    { ...env, RESEND_API_KEY: 're_test' } as never,
    ctx,
  );
  await ctx.settle();
  expect(env.raw.query("SELECT 1 FROM users WHERE email = 'old-admn@seed.test'").get()).toBeNull();
});

test('/entra with another address listed first: signs into the existing admin, does not create a new one', async () => {
  const env = prodEnv({ ADMIN_EMAILS: 'second@example.com, ' + OLD });
  const res = await entra(env);
  expect(res.status).toBe(303);
  const cookie = (res.headers.get('Set-Cookie') || '').match(/__Host-pinna_session=([^;]+)/)![1]!;
  const p = await verifyTyped<{ uid: string }>('session', cookie, TEST_SECRET);
  expect(p?.uid).toBe('u_admin');
  expect(env.raw.query("SELECT 1 FROM users WHERE email = 'second@example.com'").get()).toBeNull();
});

test('notifications: without a valid list the DB admin receives the emails', async () => {
  const env = prodEnv({ RESEND_API_KEY: 're_test' });
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
    await notifyEvent(env, project, actor, { id: 'c1', project_id: 'p1', body: 'hello' } as never, 'new', 'https://pinna.test');
  } finally {
    globalThis.fetch = realFetch;
  }
  expect(to).toEqual([OLD]);
});

test('README: ADMIN_EMAILS in the secret put commands without quotes', () => {
  const readme = readFileSync(join(import.meta.dir, '..', 'README.md'), 'utf-8');
  const lines = readme.split(/\r?\n/).filter((l) => l.includes('secret put ADMIN_EMAILS'));
  expect(lines.length).toBeGreaterThan(0);
  for (const l of lines) expect(l).not.toMatch(/["“”]/);
});
