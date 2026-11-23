/**
 * Pinna - isolated proxy. Every /_proxy response is sandboxed (opaque origin),
 * the proxy does not use the session cookie but a proxy-token bound to user,
 * project and staging origin, and it refuses URLs and redirects outside that
 * origin.
 */
import { test, expect, beforeEach, afterEach } from 'bun:test';
import app from '../worker/index';
import { signTyped } from '../worker/auth';
import { makeProxyToken, PROXY_CSP } from '../worker/proxy';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

const STAGING = 'https://staging.client.test';
const realFetch = globalThis.fetch;
let upstreamCalls: string[] = [];

function mockUpstream(handler: (url: string) => Response): void {
  upstreamCalls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    upstreamCalls.push(url);
    return handler(url);
  }) as typeof fetch;
}

beforeEach(() => {
  mockUpstream(
    () =>
      new Response(
        '<html><head><title>Site</title></head><body><a href="/about-us">About us</a>' +
          '<a href="https://other.test/x">External</a></body></html>',
        { headers: { 'content-type': 'text/html' } },
      ),
  );
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function setup() {
  const env = makeEnv({ PINNA_PROXY_ENABLED: '1' });
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', STAGING + '/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  return env;
}

async function proxyGet(env: ReturnType<typeof setup>, params: Record<string, string>, init: RequestInit = {}) {
  const qs = new URLSearchParams(params).toString();
  return appFetch(new Request('https://pinna.test/_proxy?' + qs, init), env, makeCtx());
}

function expectSandbox(res: Response): void {
  const csp = res.headers.get('Content-Security-Policy') || '';
  expect(csp).toBe(PROXY_CSP);
  expect(csp).toContain('sandbox allow-scripts allow-forms allow-popups');
  expect(csp).not.toContain('allow-same-origin');
  expect(csp).toContain("frame-ancestors 'self'");
}

test('proxied document: sandbox CSP without allow-same-origin + token carried into the links', async () => {
  const env = setup();
  const pt = (await makeProxyToken('u_c', 'p1', STAGING, TEST_SECRET))!;
  const res = await proxyGet(env, { url: STAGING + '/', pinna_pt: pt });
  expect(res.status).toBe(200);
  expectSandbox(res);
  expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
  const html = await res.text();
  // Internal link rewritten to /_proxy WITH the proxy-token; external link untouched.
  const m = html.match(/href="([^"]*about-us[^"]*)"/);
  expect(m).not.toBeNull();
  const rewritten = new URL(m![1]!.replace(/&amp;/g, '&'));
  expect(rewritten.pathname).toBe('/_proxy');
  expect(rewritten.searchParams.get('pinna_pt')).toBe(pt);
  expect(rewritten.searchParams.get('url')).toBe(STAGING + '/about-us');
  expect(html).toContain('href="https://other.test/x"');
  // The widget knows it is in proxy mode (pinna-hello handshake).
  expect(html).toContain('data-pinna-proxy="1"');
});

test('subresources and error responses carry the same sandbox CSP', async () => {
  const env = setup();
  const pt = (await makeProxyToken('u_c', 'p1', STAGING, TEST_SECRET))!;
  const sub = await proxyGet(env, { url: STAGING + '/api/x', pinna_pt: pt, pinna_sub: '1' });
  expectSandbox(sub);
  expect(sub.headers.get('Access-Control-Allow-Origin')).toBe('*');
  const denied = await proxyGet(env, { url: STAGING + '/' });
  expect(denied.status).toBe(403);
  expectSandbox(denied);
});

test('the session cookie does NOT authenticate the proxy', async () => {
  const env = setup();
  seedUser(env.raw, 'u_admin', 'm@example.com', 'admin');
  const session = await signTyped('session', { uid: 'u_admin', role: 'admin', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  const res = await proxyGet(env, { url: STAGING + '/' }, { headers: { Cookie: '__Host-pinna_session=' + session } });
  expect(res.status).toBe(403);
  expect(upstreamCalls.length).toBe(0);
});

test('a widget-token or a session instead of the proxy-token -> 403', async () => {
  const env = setup();
  const exp = Date.now() + 3600_000;
  const w = await signTyped('widget', { uid: 'u_c', pid: 'p1', o: STAGING, exp }, TEST_SECRET);
  const s = await signTyped('session', { uid: 'u_c', role: 'client', exp, iat: Date.now() }, TEST_SECRET);
  expect((await proxyGet(env, { url: STAGING + '/', pinna_pt: w })).status).toBe(403);
  expect((await proxyGet(env, { url: STAGING + '/', pinna_pt: s })).status).toBe(403);
  expect(upstreamCalls.length).toBe(0);
});

test("URL outside the project's staging origin -> 403 without touching the target", async () => {
  const env = setup();
  const pt = (await makeProxyToken('u_c', 'p1', STAGING, TEST_SECRET))!;
  for (const url of ['https://evil.test/', 'http://staging.client.test/', 'https://staging.client.test:8443/', 'https://x.staging.client.test/']) {
    const res = await proxyGet(env, { url, pinna_pt: pt });
    expect(res.status).toBe(403);
  }
  expect(upstreamCalls.length).toBe(0);
  // Subpaths of the same origin: ok.
  expect((await proxyGet(env, { url: STAGING + '/a/b/c?q=1', pinna_pt: pt })).status).toBe(200);
});

test('target redirect to another origin -> 403', async () => {
  const env = setup();
  const pt = (await makeProxyToken('u_c', 'p1', STAGING, TEST_SECRET))!;
  mockUpstream(() => new Response(null, { status: 302, headers: { location: 'https://evil.test/' } }));
  const res = await proxyGet(env, { url: STAGING + '/', pinna_pt: pt });
  expect(res.status).toBe(403);
  expect(upstreamCalls).toEqual([STAGING + '/']);
});

test('token issued for an origin the project no longer has -> 403', async () => {
  const env = setup();
  const pt = (await makeProxyToken('u_c', 'p1', STAGING, TEST_SECRET))!;
  env.raw.query("UPDATE projects SET staging_url = 'https://new.test/' WHERE id = 'p1'").run();
  expect((await proxyGet(env, { url: STAGING + '/', pinna_pt: pt })).status).toBe(403);
});

test('expired token: a page asking the app to reload (401), sub -> 401 text', async () => {
  const env = setup();
  const pt = (await makeProxyToken('u_c', 'p1', STAGING, TEST_SECRET, -1000))!;
  const res = await proxyGet(env, { url: STAGING + '/page', pinna_pt: pt });
  expect(res.status).toBe(401);
  expectSandbox(res);
  const html = await res.text();
  expect(html).toContain('pinna-proxy-expired');
  const sub = await proxyGet(env, { url: STAGING + '/x', pinna_pt: pt, pinna_sub: '1' });
  expect(sub.status).toBe(401);
  expect(upstreamCalls.length).toBe(0);
});

test('per-user rate limit on the proxy: counts pages -> 429 after 60', async () => {
  const env = setup();
  const pt = (await makeProxyToken('u_c', 'p1', STAGING, TEST_SECRET))!;
  mockUpstream(() => new Response('ok', { headers: { 'content-type': 'text/plain' } }));
  let last = 0;
  for (let i = 0; i < 61; i++) {
    last = (await proxyGet(env, { url: STAGING + '/x', pinna_pt: pt })).status;
  }
  expect(last).toBe(429);
  expect(upstreamCalls.length).toBe(60);
});

test('rate limit: subresources do not consume the limit (KV write quota)', async () => {
  const env = setup();
  const pt = (await makeProxyToken('u_c', 'p1', STAGING, TEST_SECRET))!;
  mockUpstream(() => new Response('ok', { headers: { 'content-type': 'text/plain' } }));
  let last = 0;
  for (let i = 0; i < 120; i++) {
    last = (await proxyGet(env, { url: STAGING + '/asset.png', pinna_pt: pt, pinna_sub: '1' })).status;
  }
  expect(last).toBe(200);
  expect(upstreamCalls.length).toBe(120);
});

test('OPTIONS preflight: 204 with open CORS and sandbox CSP, no call to the target', async () => {
  const env = setup();
  const res = await proxyGet(env, { url: STAGING + '/x' }, {
    method: 'OPTIONS',
    headers: { 'Access-Control-Request-Headers': 'content-type' },
  });
  expect(res.status).toBe(204);
  expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
  expect(res.headers.get('Access-Control-Allow-Headers')).toBe('content-type');
  expectSandbox(res);
  expect(upstreamCalls.length).toBe(0);
});

test('widget-token endpoint: also issues the project-bound proxy-token', async () => {
  const env = setup();
  const session = await signTyped('session', { uid: 'u_c', role: 'client', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  const res = await appFetch(
    new Request('https://pinna.test/api/projects/site/widget-token', { headers: { Cookie: '__Host-pinna_session=' + session } }),
    env,
    makeCtx(),
  );
  expect(res.status).toBe(200);
  const body = (await res.json()) as { proxy_token: string };
  expect(typeof body.proxy_token).toBe('string');
  expect((await proxyGet(env, { url: STAGING + '/', pinna_pt: body.proxy_token })).status).toBe(200);
});

test('membership removed: subresources stop at once too, not only pages', async () => {
  const env = setup();
  const pt = (await makeProxyToken('u_c', 'p1', STAGING, TEST_SECRET))!;
  mockUpstream(() => new Response('ok', { headers: { 'content-type': 'text/plain' } }));
  expect((await proxyGet(env, { url: STAGING + '/api/x', pinna_pt: pt, pinna_sub: '1' })).status).toBe(200);
  env.raw.query("DELETE FROM memberships WHERE user_id = 'u_c'").run();
  const sub = await proxyGet(env, { url: STAGING + '/api/x', pinna_pt: pt, pinna_sub: '1' });
  expect(sub.status).toBe(403);
  expect(upstreamCalls.length).toBe(1);
});

/** A body sent through the proxy, without the Content-Length the test helper adds. */
function rawProxy(env: ReturnType<typeof setup>, pt: string, init: RequestInit) {
  const qs = new URLSearchParams({ url: STAGING + '/form', pinna_pt: pt }).toString();
  return app.fetch(new Request('https://pinna.test/_proxy?' + qs, init), env, makeCtx());
}

test('request body through the proxy: Content-Length required (411) and at most 2 MB (413)', async () => {
  const env = setup();
  const pt = (await makeProxyToken('u_c', 'p1', STAGING, TEST_SECRET))!;
  mockUpstream(() => new Response('ok', { headers: { 'content-type': 'text/plain' } }));
  // A body without a declared length: refused before it is read.
  const noLength = await rawProxy(env, pt, { method: 'POST', body: 'a=1' });
  expect(noLength.status).toBe(411);
  // Declared above the cap: refused before it is read.
  const big = await rawProxy(env, pt, {
    method: 'POST',
    headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) },
    body: 'a=1',
  });
  expect(big.status).toBe(413);
  expect(upstreamCalls.length).toBe(0);
  // Within the cap: forwarded.
  const ok = await proxyGet(env, { url: STAGING + '/form', pinna_pt: pt }, { method: 'POST', body: 'a=1' });
  expect(ok.status).toBe(200);
  // No body at all (a plain DELETE): nothing to measure, forwarded.
  const del = await rawProxy(env, pt, { method: 'DELETE' });
  expect(del.status).toBe(200);
  expect(upstreamCalls.length).toBe(2);
});
