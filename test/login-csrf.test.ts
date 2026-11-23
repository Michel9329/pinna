/**
 * Pinna - login CSRF: the login routes accept only application/json (a form or
 * a text/plain fetch from a third-party site cannot get through without a
 * preflight).
 */
import { test, expect } from 'bun:test';
import app from '../worker/index';
import * as db from '../worker/db';
import { sha256hex } from '../worker/auth';
import { appFetch, makeEnv, makeCtx, seedUser } from './helpers/env';

function post(env: ReturnType<typeof makeEnv>, path: string, ct: string, body: string) {
  return appFetch(
    new Request('https://pinna.test' + path, { method: 'POST', headers: { 'Content-Type': ct }, body }),
    env,
    makeCtx(),
  );
}

test('verify-code with text/plain or a form -> 415, no cookie and no attempt used up', async () => {
  const env = makeEnv();
  seedUser(env.raw, 'u_a', 'a@example.com', 'client');
  await db.createMagicLink(env.DB, 'a@example.com', await sha256hex('tok'), '123456');
  const body = JSON.stringify({ email: 'a@example.com', code: '123456' });
  for (const ct of ['text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    const res = await post(env, '/api/auth/verify-code', ct, body);
    expect(res.status).toBe(415);
    expect(res.headers.get('Set-Cookie')).toBeNull();
  }
  const row = env.raw.query("SELECT attempts, used_at FROM magic_links WHERE email = 'a@example.com'").get() as { attempts: number; used_at: number | null };
  expect(row).toEqual({ attempts: 0, used_at: null });
  // Counter-check: as JSON the code gets in.
  const ok = await post(env, '/api/auth/verify-code', 'application/json; charset=utf-8', body);
  expect(ok.status).toBe(200);
  expect(ok.headers.get('Set-Cookie')).toContain('__Host-pinna_session=');
});

test('auth/request with text/plain -> 415', async () => {
  const env = makeEnv();
  const res = await post(env, '/api/auth/request', 'text/plain', JSON.stringify({ email: 'a@example.com' }));
  expect(res.status).toBe(415);
});
