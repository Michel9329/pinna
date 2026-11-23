/**
 * Pinna - /shot: passive assets only from the staging, from data: and from
 * PINNA_SHOT_ASSET_ORIGINS; the staging name must not resolve to internal
 * addresses (127.0.0.1.nip.io); in url mode WebSocket, WebRTC and workers are
 * off (puppeteer does not intercept them).
 */
import { test, expect, afterEach } from 'bun:test';
import vm from 'node:vm';
import app from '../worker/index';
import { signTyped } from '../worker/auth';
import { setResolver } from '../worker/dns-guard';
import { shotAssetOrigins, SHOT_BLOCK_SOCKETS_JS, guardShotPage } from '../worker/shot-guard';
import type { ShotPageLike } from '../worker/shot-guard';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET, sized, publicResolver } from './helpers/env';

afterEach(() => setResolver(publicResolver));

async function shot(staging: string) {
  const env = makeEnv({ BROWSER: {} as Fetcher });
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', staging);
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  const ctx = makeCtx();
  const res = await appFetch(
    await sized(
      new Request('https://pinna.test/api/projects/site/shot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + wt },
        body: JSON.stringify({ url: new URL(staging).origin + '/' }),
      }),
    ),
    env,
    ctx,
  );
  await ctx.settle();
  return res;
}

test('/shot: a staging whose name points to an internal address -> 400 before the browser', async () => {
  setResolver(async (h) => (h === '127.0.0.1.nip.io' ? ['127.0.0.1'] : ['93.184.216.34']));
  const res = await shot('https://127.0.0.1.nip.io/');
  expect(res.status).toBe(400);
  expect(((await res.json()) as { error: string }).error).toContain('not allowed');
});

test('/shot: a staging that does not resolve -> 400 (fail-closed)', async () => {
  setResolver(async () => []);
  expect((await shot('https://gone.example.org/')).status).toBe(400);
});

test('/shot: a public staging reaches the browser (fake here: 502)', async () => {
  expect((await shot('https://staging.example.org/')).status).toBe(502);
});

test('PINNA_SHOT_ASSET_ORIGINS: only public https origins, normalized', () => {
  const env = makeEnv({
    PINNA_SHOT_ASSET_ORIGINS: ' https://cdn.sanity.io/something , http://cdn.test, https://localhost, nonurl, https://cdn.shopify.com',
  });
  expect(shotAssetOrigins(env)).toEqual(['https://cdn.sanity.io', 'https://cdn.shopify.com']);
  expect(shotAssetOrigins(makeEnv())).toEqual([]);
});

test('document-start script: WebSocket, WebRTC and workers cannot be used or restored', () => {
  class FakeWS {}
  const win: Record<string, unknown> = { WebSocket: FakeWS, Worker: FakeWS, navigator: { serviceWorker: { register: () => 'ok' } } };
  win.window = win;
  vm.runInNewContext(SHOT_BLOCK_SOCKETS_JS, win);
  expect(() => new (win.WebSocket as new (u: string) => unknown)('wss://x.test')).toThrow('connection blocked');
  expect(() => new (win.Worker as new (u: string) => unknown)('/w.js')).toThrow('connection blocked');
  expect(() => new (win.RTCPeerConnection as new () => unknown)()).toThrow('connection blocked');
  // A page script cannot put it back.
  vm.runInNewContext('try { window.WebSocket = function(){} } catch (e) {}', win);
  expect(() => new (win.WebSocket as new (u: string) => unknown)('wss://x.test')).toThrow('connection blocked');
  const reg = (win.navigator as { serviceWorker: { register: () => Promise<unknown> } }).serviceWorker.register();
  return expect(reg).rejects.toThrow('blocked');
});

test('guardShotPage: ws:// also blocked via CDP when the session exists', async () => {
  const sent: [string, unknown][] = [];
  const page: ShotPageLike = {
    setJavaScriptEnabled: async () => {},
    setRequestInterception: async () => {},
    on: () => page,
    evaluateOnNewDocument: async () => {},
    createCDPSession: async () => ({
      send: async (m: string, p?: object) => {
        sent.push([m, p]);
        return {};
      },
    }),
  };
  await guardShotPage(page, 'https://staging.example.org', 'url');
  // Network.enable before the block (without it the block has no effect).
  expect(sent).toEqual([
    ['Network.enable', undefined],
    ['Network.setBlockedURLs', { urls: ['ws://*', 'wss://*'] }],
  ]);
});

test('guardShotPage: JavaScript off in url mode too, service workers bypassed, before navigating', async () => {
  for (const mode of ['url', 'html'] as const) {
    const calls: string[] = [];
    const page: ShotPageLike = {
      setJavaScriptEnabled: async (on: boolean) => {
        calls.push('js:' + on);
      },
      setBypassServiceWorker: async (b: boolean) => {
        calls.push('bypass-sw:' + b);
      },
      setRequestInterception: async () => {
        calls.push('intercept');
      },
      on: () => page,
      evaluateOnNewDocument: async () => {
        calls.push('script');
      },
    };
    await guardShotPage(page, 'https://staging.example.org', mode);
    expect([mode, calls]).toEqual([mode, ['js:false', 'bypass-sw:true', 'script', 'intercept']]);
  }
});
