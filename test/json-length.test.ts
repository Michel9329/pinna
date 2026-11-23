/**
 * Pinna - JSON and form bodies with a declared length. Without this,
 * c.req.json() and parseBody() read the whole body with no Content-Length,
 * even on anonymous routes. Now: 411 without it, 413 above 16 KB (64 KB for
 * comments), and the body is not read.
 */
import { test, expect } from 'bun:test';
import app from '../worker/index';
import { signTyped } from '../worker/auth';
import * as db from '../worker/db';
import { makeEnv, makeCtx, seedUser, seedProject, sized, TEST_SECRET } from './helpers/env';

type Env = ReturnType<typeof makeEnv>;

/** A body that records whether anyone read it. */
function watchedBody(text = '{}') {
  const seen = { read: false };
  const body = new ReadableStream({
    pull(ctrl) {
      seen.read = true;
      ctrl.enqueue(new TextEncoder().encode(text));
      ctrl.close();
    },
  }, { highWaterMark: 0 });
  return { body, seen };
}

async function setup() {
  const env = makeEnv({ RESEND_API_KEY: 're_test' });
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', 'https://staging.test/');
  await db.addMembership(env.DB, 'u_c', 'p1', 'client');
  const c = await db.createComment(env.DB, 'p1', 'u_c', { body: 'x', page_path: '/' } as never);
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  const s = await signTyped('session', { uid: 'u_admin', role: 'admin', exp: Date.now() + 3600_000, iat: Date.now() - 5 }, TEST_SECRET);
  return { env, wt, s, commentId: c.id };
}

const session = (s: string) => ({ Cookie: '__Host-pinna_session=' + s + '; __Host-pinna_csrf=t', 'X-CSRF-Token': 't' });

function routes(wt: string, s: string, commentId: string): [string, string, Record<string, string>][] {
  const json = { 'Content-Type': 'application/json' };
  return [
    ['POST', '/api/auth/request', json],
    ['POST', '/api/auth/verify-code', json],
    ['POST', '/api/projects', { ...json, ...session(s) }],
    ['POST', '/api/projects/p1/invite', { ...json, ...session(s) }],
    ['POST', '/api/projects/site/comments', { ...json, Authorization: 'Bearer ' + wt }],
    ['PATCH', '/api/comments/' + commentId, { ...json, Authorization: 'Bearer ' + wt }],
    ['POST', '/api/notifications/mute', { ...json, ...session(s) }],
    ['POST', '/api/auth/verify', { 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['POST', '/entra', { 'Content-Type': 'application/x-www-form-urlencoded' }],
  ];
}

test('without Content-Length: 411 and the body is not read, on every JSON and form route', async () => {
  const { env, wt, s, commentId } = await setup();
  for (const [method, path, headers] of routes(wt, s, commentId)) {
    const { body, seen } = watchedBody();
    const res = await app.fetch(
      new Request('https://pinna.test' + path, { method, headers, body, duplex: 'half' } as RequestInit),
      env,
      makeCtx(),
    );
    expect([path, res.status]).toEqual([path, 411]);
    expect([path, seen.read]).toEqual([path, false]);
  }
});

test('above the cap: 413 without reading the body (16 KB, 64 KB for comments)', async () => {
  const { env, wt, s, commentId } = await setup();
  for (const [method, path, headers] of routes(wt, s, commentId)) {
    const max = path.includes('comments') ? 64 * 1024 : 16 * 1024;
    const { body, seen } = watchedBody();
    const res = await app.fetch(
      new Request('https://pinna.test' + path, {
        method,
        headers: { ...headers, 'Content-Length': String(max + 1) },
        body,
        duplex: 'half',
      } as RequestInit),
      env,
      makeCtx(),
    );
    expect([path, res.status]).toEqual([path, 413]);
    expect([path, seen.read]).toEqual([path, false]);
  }
});

test('a valid comment (5,000 non-Latin characters + path and selector) above 16 KB goes through', async () => {
  const { env, wt } = await setup();
  // Selector within its 1,000-character cap; the long path takes the payload over 16 KB.
  const payload = JSON.stringify({ body: '漢'.repeat(5000), page_path: '/' + 'segment/'.repeat(180), anchor_selector: 'main > div '.repeat(90) });
  expect(new TextEncoder().encode(payload).byteLength).toBeGreaterThan(16 * 1024);
  const res = await app.fetch(
    await sized(new Request('https://pinna.test/api/projects/site/comments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + wt },
      body: payload,
    })),
    env,
    makeCtx(),
  );
  expect(res.status).toBe(201);
});

test('auth/request without Content-Length: no counter and no email', async (): Promise<void> => {
  const { env } = await setup();
  const res = await app.fetch(
    new Request('https://pinna.test/api/auth/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.4' },
      body: JSON.stringify({ email: 'c@example.com' }),
    }),
    env as Env,
    makeCtx(),
  );
  expect(res.status).toBe(411);
  expect(env.raw.query("SELECT COUNT(*) AS n FROM rate_limits WHERE k LIKE 'auth-email%'").get()).toEqual({ n: 0 });
  expect(env.raw.query('SELECT COUNT(*) AS n FROM magic_links').get()).toEqual({ n: 0 });
});
