/**
 * Pinna - explicit dev mode. If /api/auth/request put the link and the code
 * in the response whenever RESEND_API_KEY was missing, anyone could sign in
 * with anyone's email. Only with PINNA_DEV_MODE=1 and on localhost; otherwise
 * 503 "email not configured", the same for everyone.
 */
import { test, expect } from 'bun:test';
import app from '../worker/index';
import { isDevMode } from '../worker/auth';
import { appFetch, makeEnv, makeCtx, seedUser } from './helpers/env';

function request(env: ReturnType<typeof makeEnv>, origin: string, email: string) {
  return appFetch(
    new Request(origin + '/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }),
    env,
    makeCtx(),
  );
}

test('isDevMode: needs the flag AND localhost', () => {
  expect(isDevMode({ PINNA_DEV_MODE: '1' } as never, 'http://localhost:8787/x')).toBe(true);
  expect(isDevMode({ PINNA_DEV_MODE: '1' } as never, 'http://127.0.0.1:8787/x')).toBe(true);
  expect(isDevMode({ PINNA_DEV_MODE: '1' } as never, 'https://pinna.example.com/x')).toBe(false);
  expect(isDevMode({} as never, 'http://localhost:8787/x')).toBe(false);
  expect(isDevMode({ PINNA_DEV_MODE: 'true' } as never, 'http://localhost/x')).toBe(false);
});

test('without an email key in production: 503, no link nor code, also for registered emails', async () => {
  const env = makeEnv();
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  for (const email of ['c@example.com', 'nobody@example.com']) {
    const res = await request(env, 'https://pinna.example.com', email);
    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe('email not configured');
    expect(body.devLink).toBeUndefined();
    expect(body.devCode).toBeUndefined();
  }
  // No magic link created.
  expect(env.raw.query('SELECT COUNT(*) AS n FROM magic_links').get()).toEqual({ n: 0 });
});

test('even with the flag on, on a real host no link in the response', async () => {
  const env = makeEnv({ PINNA_DEV_MODE: '1' });
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  const res = await request(env, 'https://pinna.example.com', 'c@example.com');
  expect(res.status).toBe(503);
  expect(((await res.json()) as Record<string, unknown>).devLink).toBeUndefined();
});

test('real dev mode (flag + localhost): link and code in the response', async () => {
  const env = makeEnv({ PINNA_DEV_MODE: '1' });
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  const res = await request(env, 'http://localhost:8787', 'c@example.com');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { devLink?: string; devCode?: string };
  expect(body.devLink).toContain('/api/auth/verify?token=');
  expect(body.devCode).toMatch(/^\d{6}$/);
});
