/**
 * Pinna - "Proxy ON/OFF" button hidden when the proxy is off. Without this it
 * always showed up and led to a 503 page. The server says in the widget-token
 * response whether the proxy is on (proxy_enabled) and, when it is off, does
 * not even issue the proxy-token.
 */
import { test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import app from '../worker/index';
import { signTyped } from '../worker/auth';
import { appFetch, makeEnv, makeCtx, seedProject, TEST_SECRET } from './helpers/env';

async function widgetToken(enabled: boolean) {
  const env = makeEnv(enabled ? { PINNA_PROXY_ENABLED: '1' } : {});
  seedProject(env.raw, 'p1', 'site', 'https://staging.example.org/');
  const s = await signTyped('session', { uid: 'u_admin', role: 'admin', exp: Date.now() + 3600_000, iat: Date.now() - 1000 }, TEST_SECRET);
  const res = await appFetch(
    new Request('https://pinna.test/api/projects/site/widget-token', { headers: { Cookie: '__Host-pinna_session=' + s } }),
    env,
    makeCtx(),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { proxy_enabled: boolean; proxy_token: string | null };
}

test('proxy off: proxy_enabled false and no proxy-token', async () => {
  const body = await widgetToken(false);
  expect(body.proxy_enabled).toBe(false);
  expect(body.proxy_token).toBeNull();
});

test('proxy on: proxy_enabled true and a proxy-token', async () => {
  const body = await widgetToken(true);
  expect(body.proxy_enabled).toBe(true);
  expect(typeof body.proxy_token).toBe('string');
});

test('the app shows the Proxy button only if the server turned it on', () => {
  const vue = readFileSync(join(import.meta.dir, '..', 'app', 'src', 'views', 'ProjectView.vue'), 'utf-8');
  expect(vue).toContain('v-if="stagingUrlRaw && !isClient && proxyEnabled"');
  expect(vue).toContain('proxyEnabled.value = res.proxy_enabled === true;');
});
