/**
 * Pinna - /shot in html mode. JS off in the browser (checked by hand on a
 * local wrangler dev), filtered requests and a size cap: here the pure parts
 * and the cap on the route.
 */
import { test, expect } from 'bun:test';
import { shotRequestAllowed, prepareShotHtml, MAX_SHOT_BODY, MAX_SHOT_HTML } from '../worker/shot-guard';
import { signTyped } from '../worker/auth';
import app from '../worker/index';
import { appFetch, makeEnv, makeCtx, seedUser, seedProject, TEST_SECRET, sized } from './helpers/env';

const ST = 'https://staging.client.test';

test('shotRequestAllowed: the staging origin passes entirely', () => {
  expect(shotRequestAllowed(ST + '/app.js', 'script', ST)).toBe(true);
  expect(shotRequestAllowed(ST + '/x', 'xhr', ST)).toBe(true);
  expect(shotRequestAllowed(ST + '/', 'document', ST)).toBe(true);
});

const CDN = ['https://cdn.sanity.io', 'https://fonts.cdn.test', 'https://cdn.test'];

test('shotRequestAllowed: outside the staging only passive https assets from the allowed origins', () => {
  expect(shotRequestAllowed('https://cdn.sanity.io/img.jpg', 'image', ST, CDN)).toBe(true);
  expect(shotRequestAllowed('https://fonts.cdn.test/a.woff2', 'font', ST, CDN)).toBe(true);
  expect(shotRequestAllowed('https://cdn.test/a.css', 'stylesheet', ST, CDN)).toBe(true);
  // Without a list (or outside it) not even a public image.
  expect(shotRequestAllowed('https://cdn.sanity.io/img.jpg', 'image', ST)).toBe(false);
  expect(shotRequestAllowed('https://tracker.test/p.gif', 'image', ST, CDN)).toBe(false);
  // An allowed origin counts only for passive assets.
  expect(shotRequestAllowed('https://cdn.test/x.js', 'script', ST, CDN)).toBe(false);
  // Documents/iframes, scripts, fetch, websockets to third parties: blocked.
  expect(shotRequestAllowed('https://evil.test/', 'document', ST, CDN)).toBe(false);
  expect(shotRequestAllowed('https://evil.test/x.js', 'script', ST, CDN)).toBe(false);
  expect(shotRequestAllowed('https://evil.test/api', 'fetch', ST, CDN)).toBe(false);
  expect(shotRequestAllowed('wss://evil.test/ws', 'websocket', ST, CDN)).toBe(false);
  // Even an image, if it goes to internal hosts or over plain http: blocked.
  expect(shotRequestAllowed('https://169.254.169.254/latest', 'image', ST, CDN)).toBe(false);
  expect(shotRequestAllowed('https://localhost/x.png', 'image', ST, CDN)).toBe(false);
  expect(shotRequestAllowed('http://cdn.test/x.png', 'image', ST, CDN)).toBe(false);
  expect(shotRequestAllowed('file:///etc/passwd', 'image', ST, CDN)).toBe(false);
  expect(shotRequestAllowed('data:image/png;base64,AAAA', 'image', ST)).toBe(true);
});

test('prepareShotHtml: strips scripts, noscript and the document base, forces the staging base', () => {
  const out = prepareShotHtml(
    '<html><head><base href="https://evil.test/"><script>x()</script></head><body>' +
      '<noscript><iframe src="https://gtm.test"></iframe></noscript><SCRIPT >y()</SCRIPT ><p>ok</p></body></html>',
    ST,
  );
  expect(out).not.toMatch(/<script/i);
  expect(out).not.toMatch(/<noscript/i);
  expect(out).not.toContain('evil.test');
  expect(out).toContain('<head><base href="' + ST + '/">');
  expect(out).toContain('<p>ok</p>');
});

async function shotEnv() {
  const env = makeEnv({ BROWSER: {} as Fetcher });
  seedUser(env.raw, 'u_c', 'c@example.com', 'client');
  seedProject(env.raw, 'p1', 'site', ST + '/');
  env.raw.query("INSERT INTO memberships (user_id, project_id, created_at, role) VALUES ('u_c', 'p1', 0, 'client')").run();
  const wt = await signTyped('widget', { uid: 'u_c', pid: 'p1', exp: Date.now() + 3600_000, iat: Date.now() }, TEST_SECRET);
  const post = async (body: string) =>
    appFetch(
      await sized(new Request('https://pinna.test/api/projects/site/shot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + wt },
        body,
      })),
      env,
      makeCtx(),
    );
  return { post };
}

test('/shot: body above the cap -> 413 before opening the browser', async () => {
  const { post } = await shotEnv();
  const res = await post(JSON.stringify({ html: 'x'.repeat(MAX_SHOT_BODY + 10) }));
  expect(res.status).toBe(413);
});

test('/shot: html above MAX_SHOT_HTML is ignored (url mode, which stays bound to the staging origin)', async () => {
  const { post } = await shotEnv();
  const res = await post(JSON.stringify({ html: 'x'.repeat(MAX_SHOT_HTML + 10), url: 'https://evil.test/' }));
  expect(res.status).toBe(403);
});
