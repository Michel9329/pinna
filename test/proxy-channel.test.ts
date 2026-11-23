/**
 * Pinna - proxy-mode channel. Trusting pinna_pt alone is not enough, since it
 * sits in the URL: any "null" document that knew it would receive the
 * widget-token. So the hello is valid once per document and opens a channel
 * with a secret; external links in the proxy open in a new tab; the proxy
 * iframe has the sandbox attribute.
 */
import { test, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProxyChannel } from '../app/src/proxy-channel';
import app from '../worker/index';
import { makeProxyToken } from '../worker/proxy';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET } from './helpers/env';

test('hello: once per document, only with a pt issued here', () => {
  let n = 0;
  const ch = new ProxyChannel(() => 'secret-' + ++n);
  ch.issue('pt1');
  expect(ch.hello('pt-other')).toBeNull();
  expect(ch.hello('pt1')).toBe('secret-1');
  // A second document that knows the pt: refused.
  expect(ch.hello('pt1')).toBeNull();
  expect(ch.check('secret-1')).toBe(true);
  expect(ch.check('guessed')).toBe(false);
});

test('bye with the secret (internal navigation) or a new document announced by the app reopen a hello', () => {
  let n = 0;
  const ch = new ProxyChannel(() => 's' + ++n);
  ch.issue('pt1');
  ch.hello('pt1');
  expect(ch.bye('wrong')).toBe(false);
  expect(ch.hello('pt1')).toBeNull();
  expect(ch.bye('s1')).toBe(true);
  expect(ch.check('s1')).toBe(false); // the old secret no longer works
  expect(ch.hello('pt1')).toBe('s2');
  ch.expectNewDocument();
  expect(ch.hello('pt1')).toBe('s3');
});

test('default secret: random and long', () => {
  const a = new ProxyChannel();
  const b = new ProxyChannel();
  a.issue('p');
  b.issue('p');
  const sa = a.hello('p')!;
  expect(sa).toMatch(/^[0-9a-f]{32}$/);
  expect(b.hello('p')).not.toBe(sa);
});

test('the proxy-mode iframe has the sandbox attribute', () => {
  const vue = readFileSync(join(import.meta.dir, '..', 'app', 'src', 'views', 'ProjectView.vue'), 'utf-8');
  expect(vue).toContain(':sandbox="useProxy ? PROXY_SANDBOX : DIRECT_SANDBOX"');
  expect(vue).toMatch(/PROXY_SANDBOX = 'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox'/);
  expect(vue).not.toMatch(/PROXY_SANDBOX = '[^']*allow-same-origin/);
});

test('the direct-mode iframe is sandboxed too, without top navigation', () => {
  const vue = readFileSync(join(import.meta.dir, '..', 'app', 'src', 'views', 'ProjectView.vue'), 'utf-8');
  const m = vue.match(/DIRECT_SANDBOX =\s*'([^']*)'/);
  expect(m).not.toBeNull();
  expect(m![1]!.split(' ').sort()).toEqual(
    ['allow-downloads', 'allow-forms', 'allow-modals', 'allow-popups', 'allow-popups-to-escape-sandbox', 'allow-same-origin', 'allow-scripts'],
  );
  expect(vue).not.toContain('allow-top-navigation');
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('proxy: external links open in a new tab without opener or Referer', async () => {
  const ST = 'https://staging.client.test';
  globalThis.fetch = (async () =>
    new Response('<html><head></head><body><a href="/internal">i</a><a href="https://other.test/x" target="_self">e</a></body></html>', {
      headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch;
  const env = makeEnv({ PINNA_PROXY_ENABLED: '1' });
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', ST + '/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  const pt = (await makeProxyToken('u_c', 'p1', ST, TEST_SECRET))!;
  const res = await appFetch(
    new Request('https://pinna.test/_proxy?' + new URLSearchParams({ url: ST + '/', pinna_pt: pt })),
    env,
    makeCtx(),
  );
  const html = await res.text();
  expect(html).toMatch(/<a href="https:\/\/other\.test\/x" target="_blank" rel="noopener noreferrer">/);
  expect(html).toMatch(/<a href="https:\/\/pinna\.test\/_proxy\?[^"]*internal[^"]*">/);
});
