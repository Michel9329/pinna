/**
 * Pinna - anti-SSRF filter and /shot in url mode. A plain list of regexes lets
 * [::ffff:169.254.169.254], [::], 100.64.0.0/10 and ".internal." with the
 * trailing dot through; and /shot in url mode must not run with the page's JS
 * and without a filter.
 */
import { test, expect } from 'bun:test';
import { isBlockedHost } from '../worker/proxy';
import { guardShotPage, shotRequestAllowed } from '../worker/shot-guard';
import type { ShotPageLike, ShotRequestLike } from '../worker/shot-guard';

/** How hosts really arrive: after new URL(). */
const host = (u: string) => new URL(u).hostname;

test('blocked: the addresses that slip past a regex list', () => {
  for (const u of [
    'http://[::ffff:169.254.169.254]/latest',
    'http://[::ffff:127.0.0.1]/',
    'http://[::]/',
    'http://[::1]/',
    'http://100.64.0.1/',
    'http://100.127.255.254/',
    'http://metadata.google.internal./',
    'http://metadata.google.internal/',
    'http://[64:ff9b::a9fe:a9fe]/',
    'http://2130706433/', // 127.0.0.1 in decimal
    'http://0x7f.1/',
    'http://foo.localhost/',
    'http://localhost./',
  ]) {
    expect([u, isBlockedHost(host(u))]).toEqual([u, true]);
  }
});

test('blocked: the usual ranges', () => {
  for (const h of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '255.255.255.255', 'fd00::1', 'fe80::1', 'ff02::1', '[fc12::1]']) {
    expect([h, isBlockedHost(h)]).toEqual([h, true]);
  }
});

test('allowed: public hosts and addresses', () => {
  for (const h of ['staging.client.test', 'cdn.sanity.io', '8.8.8.8', '100.63.255.255', '100.128.0.1', '172.32.0.1', host('http://[2606:4700::1111]/'), host('http://[::ffff:8.8.8.8]/'), 'internal.example.com']) {
    expect([h, isBlockedHost(h)]).toEqual([h, false]);
  }
});

function fakePage() {
  const calls: string[] = [];
  let handler: ((r: ShotRequestLike) => void) | null = null;
  const page: ShotPageLike = {
    setJavaScriptEnabled: async (v) => { calls.push('js:' + v); },
    setRequestInterception: async (v) => { calls.push('intercept:' + v); },
    on: (_e, h) => { handler = h; return page; },
    evaluateOnNewDocument: async () => { calls.push('init-script'); },
  };
  const send = (url: string, type: string) => {
    let out = '';
    handler!({ url: () => url, resourceType: () => type, continue: async () => { out = 'continue'; }, abort: async () => { out = 'abort'; } });
    return out;
  };
  return { page, calls, send };
}

const ST = 'https://staging.client.test';

test('/shot url mode: request filter on, no navigation outside the staging', async () => {
  const { page, calls, send } = fakePage();
  await guardShotPage(page, ST, 'url', ['https://cdn.sanity.io']);
  // JavaScript is off in url mode too (shot-guard.ts).
  expect(calls).toEqual(['js:false', 'init-script', 'intercept:true']);
  expect(send(ST + '/', 'document')).toBe('continue');
  expect(send(ST + '/app.js', 'script')).toBe('continue');
  expect(send('https://cdn.sanity.io/img.jpg', 'image')).toBe('continue');
  expect(send('https://other-cdn.test/img.jpg', 'image')).toBe('abort');
  // Navigation (of an iframe too) outside the staging, third-party fetch and scripts: no.
  expect(send('https://evil.test/', 'document')).toBe('abort');
  expect(send('http://169.254.169.254/latest/meta-data', 'xhr')).toBe('abort');
  expect(send('http://[::ffff:a9fe:a9fe]/', 'image')).toBe('abort');
  expect(send('https://evil.test/x.js', 'script')).toBe('abort');
});

test('/shot html mode: JS off and the same filter', async () => {
  const { page, calls, send } = fakePage();
  await guardShotPage(page, ST, 'html');
  expect(calls).toEqual(['js:false', 'init-script', 'intercept:true']);
  expect(send('https://evil.test/', 'document')).toBe('abort');
});

test('shotRequestAllowed: even the staging itself, if it is an internal host, does not pass', () => {
  expect(shotRequestAllowed('http://10.0.0.5/x', 'document', 'http://10.0.0.5')).toBe(false);
});
