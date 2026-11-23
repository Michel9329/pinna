/**
 * Pinna - no default admin. If a migration or a schema file created an admin
 * user with a fixed email, whoever installs Pinna would hand the admin of
 * their instance to that address. No user is created by the schema; the
 * admin comes from ADMIN_EMAILS, and /entra signs into the account of the
 * FIRST address in the list.
 */
import { test, expect } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import app from '../worker/index';
import { appFetch, makeD1, makeEnv, makeCtx } from './helpers/env';

const KEY = 'k'.repeat(40);
const ROOT = join(import.meta.dir, '..');

async function entra(env: ReturnType<typeof makeEnv>) {
  const ctx = makeCtx();
  const res = await appFetch(
    new Request('https://pinna.test/entra', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '203.0.113.9' },
      body: 'k=' + KEY,
    }),
    env,
    ctx,
  );
  await ctx.settle();
  return res;
}

test('the migrations create no user (no default admin)', () => {
  const { raw } = makeD1({ bare: true });
  expect((raw.query('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n).toBe(0);
});

// A separate schema.sql can drift from the migrations (missing rate_limits or
// session_revocations), and an install through db:init would then run the
// limits fail-open. The migrations are the only way: no schema.sql, no
// db:init.
test('one way to create the DB: the migrations (no schema.sql nor db:init)', () => {
  expect(existsSync(join(ROOT, 'schema.sql'))).toBe(false);
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')) as { scripts: Record<string, string> };
  expect(Object.keys(pkg.scripts).some((k) => k.startsWith('db:init'))).toBe(false);
  expect(Object.values(pkg.scripts).some((v) => v.includes('schema.sql'))).toBe(false);
  expect(pkg.scripts['db:migrate']).toBe('wrangler d1 migrations apply pinna --remote');
  expect(pkg.scripts['db:migrate:local']).toBe('wrangler d1 migrations apply pinna --local');
  // The migrations also create the tables of the limits and the revocations.
  const { raw } = makeD1({ bare: true });
  for (const t of ['rate_limits', 'session_revocations', 'memberships']) {
    expect(raw.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)).not.toBeNull();
  }
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf-8');
  expect(readme).not.toContain('db:init');
});

test('no INSERT of users in the migrations', () => {
  const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).map((f) => 'migrations/' + f);
  for (const f of files) {
    expect(readFileSync(join(ROOT, f), 'utf-8')).not.toMatch(/INSERT\s+(OR\s+\w+\s+)?INTO\s+users/i);
  }
});

test('no personal email address in the migrations', () => {
  const files = readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql')).map((f) => 'migrations/' + f);
  for (const f of files) {
    expect(readFileSync(join(ROOT, f), 'utf-8')).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  }
});

test('/entra signs into the first address of ADMIN_EMAILS, created as admin on first sign-in', async () => {
  const env = makeEnv({ ADMIN_KEY: KEY, ADMIN_EMAILS: 'Boss@Example.org, other@example.org' });
  // New instance: no admin in the DB (with admins that are not in the list,
  // the list counts as missing).
  env.raw.query('DELETE FROM users').run();
  const res = await entra(env);
  expect(res.status).toBe(303);
  expect(res.headers.get('Set-Cookie')).toContain('__Host-pinna_session=');
  const row = env.raw.query("SELECT role FROM users WHERE email = 'boss@example.org'").get() as { role: string } | null;
  expect(row?.role).toBe('admin');
});

test('/entra without ADMIN_EMAILS: no account, back to the login (does not sign into u_admin)', async () => {
  const env = makeEnv({ ADMIN_KEY: KEY, ADMIN_EMAILS: '' });
  const res = await entra(env);
  expect(res.status).toBe(303);
  expect(res.headers.get('Location')).toContain('/login?err=user');
  expect(res.headers.get('Set-Cookie')).toBeNull();
});

test('/entra with an existing user for the first address: same account, no duplicate', async () => {
  const env = makeEnv({ ADMIN_KEY: KEY, ADMIN_EMAILS: 'admin@test.local' });
  expect((await entra(env)).status).toBe(303);
  const rows = env.raw.query("SELECT id FROM users WHERE email = 'admin@test.local'").all() as { id: string }[];
  expect(rows.map((r) => r.id)).toEqual(['u_admin']);
});
